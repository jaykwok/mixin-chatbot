// Frozen historical transformation. Only built-ins and migrations/lib are allowed here.
//
// Data version 3: the Durable engine. Each member's Pi session file (`<group>/users/<member>/session.jsonl`) becomes
// the member's conversation in the group's Durable database (`<group>/durable.sqlite`), through the import protocol of
// lib/durable.ts:
// - the active context as the old engine sent it (Pi's tree, compaction, branch summaries and context edits, read by
//   lib/pi-sessions.ts), with message content, thinking, tool call ids, times and recorded usage unchanged; entries off
//   the active path stay only in the file;
// - a tool call without a result gets an error result saying so, a result without its call is left out; nothing is
//   executed, generated or sent, and a history that ended mid-turn is marked interrupted;
// - the codemode store values on the active path;
// - an import record per conversation: the statistics count only entries after it (the old ledger keeps counting the
//   file itself, which stays where it is, so nothing is counted twice).
// A member is known by the storage identity the service recorded (data/state/agent.sqlite) or, for a readable directory
// name, by the name itself; a directory that cannot be attributed is reported and left alone. A line that is not a
// JSON object is skipped and counted, as the old engine skipped it when it loaded the file (a final line cut off by a
// crash is reported apart); a file without a readable session header stops the migration. Pending deliveries keep their
// rows: the old and the new engine key them alike. Cache warming has no Durable counterpart: the setting becomes "off".
//
// The preview uses built-ins only: the updater runs it before stopping the service, from the target's exported scripts
// with the dependencies still installed. apply and validate run on the target installation and load Pi's session reader
// (lib/pi-sessions.ts) and the Durable writer (lib/durable.ts) only then.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, MemberImport } from "./lib/durable.ts";
import { bytes, info, json, ordinaryPath, publishJson } from "./lib/io.ts";
import type { FileEntries } from "./lib/pi-sessions.ts";
import type { Context, Migration, PreviewContext } from "./lib/types.ts";

const DATABASE = "durable.sqlite";
const SETTINGS = "data/runtime/pi/settings.json";
const SAFE = /^[A-Za-z0-9_+\-]{1,64}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Frozen copies of src/agent/paths.ts.
const groupSegment = (id: string) => SAFE.test(id) && !RESERVED.test(id) ? id : `sha256-${sha256(id)}`;
const userSegment = (phone: string) => SAFE.test(phone) && !RESERVED.test(phone) ? phone : `sha256-user-${sha256(phone)}`;
const readable = (segment: string) => SAFE.test(segment) && !RESERVED.test(segment);

type Message = MemberImport["messages"][number];
interface Located { group: string; user: string; source: string }

/** Group directories (never the lease directory) and their members' session files, through a lister of directories. */
async function sessions(directories: (path: string) => Promise<string[]>, present: (path: string) => Promise<boolean>): Promise<Located[]> {
  const found: Located[] = [];
  for (const group of (await directories(".")).filter((name) => !name.startsWith(".")).sort()) {
    if (!(await directories(group)).includes("users")) continue;
    for (const user of (await directories(`${group}/users`)).sort()) {
      const source = `${group}/users/${user}/session.jsonl`;
      if (await present(source)) found.push({ group, user, source });
    }
  }
  return found;
}

/** The file's entries without its unreadable lines (`bad`, and `torn` for a final line without its newline). */
function parse(content: Buffer, source: string): { entries: FileEntries; bad: number; torn: boolean } {
  const lines = content.toString("utf8").split("\n");
  const last = lines.pop()!;
  const entries: FileEntries = [];
  const read = (line: string, index: number) => {
    const value = JSON.parse(index === 0 && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    entries.push(value);
  };
  let bad = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try { read(line, index); } catch { bad++; }
  });
  let torn = false;
  if (last.trim()) { try { read(last, lines.length); } catch { torn = true; } }
  const header = entries[0];
  if (header?.type !== "session" || ![1, 2, 3].includes((header.version as number | undefined) ?? 1)) throw new Error(`会话头格式无法识别：${source}`);
  return { entries, bad, torn };
}

/** Results for every call of an answered turn, in call order; see the header. */
function paired(messages: Message[]): { messages: Message[]; synthetic: number; dropped: number } {
  const out: Message[] = [];
  let synthetic = 0, dropped = 0;
  let open: { calls: { id: string; name: string }[]; answered: Set<string>; at: number } | undefined;
  const close = () => {
    for (const call of open?.calls ?? []) {
      if (open!.answered.has(call.id)) continue;
      out.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp: open!.at,
        content: [{ type: "text", text: "（升级前的旧会话里，这次工具调用没有结果：调用被中断或结果没有保存。）" }] });
      synthetic++;
    }
    open = undefined;
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (open?.calls.some((call) => call.id === message.toolCallId) && !open.answered.has(message.toolCallId)) {
        open.answered.add(message.toolCallId);
        out.push(message);
      } else dropped++;
      continue;
    }
    close();
    if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
      const calls = message.content.flatMap((block) => block.type === "toolCall" ? [{ id: block.id, name: block.name }] : []);
      if (calls.length) open = { calls, answered: new Set(), at: message.timestamp };
    }
    out.push(message);
  }
  close();
  return { messages: out, synthetic, dropped };
}

type StoreWrite = { set: Record<string, JsonValue>; delete: string[] };
const storeWrites = (entries: Record<string, unknown>[]) => entries.filter((entry) => entry.type === "custom" && entry.customType === "codemode-store");

/** Every codemode store write in the file, on any branch, must be one `load()` understands; otherwise the migration stops. */
function checkStore(entries: FileEntries, source: string): void {
  for (const entry of storeWrites(entries)) {
    const data = entry.data as { set?: unknown; delete?: unknown } | undefined;
    if (!data || typeof data.set !== "object" || data.set === null || Array.isArray(data.set) || !Array.isArray(data.delete)
      || !data.delete.every((key) => typeof key === "string")) throw new Error(`会话的 codemode store 记录无法识别：${source}`);
  }
}

/** The codemode store on the active path, as `load()` saw it. */
function store(path: Record<string, unknown>[]): Record<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  for (const entry of storeWrites(path)) {
    const data = entry.data as StoreWrite;
    for (const key of data.delete) values.delete(key);
    for (const [key, value] of Object.entries(data.set)) values.set(key, value);
  }
  return Object.fromEntries(values);
}

/** Read and check a session file with built-ins only (the preview). */
function inspect(content: Buffer, source: string) {
  const parsed = parse(content, source);
  checkStore(parsed.entries, source);
  return parsed;
}

type PiSessions = Pick<typeof import("./lib/pi-sessions.ts"), "activeMessages" | "activePath">;

/** Everything the import writes for one session file, plus what the report says about it. */
function convert(pi: PiSessions, content: Buffer, source: string): { messages: Message[]; store: Record<string, JsonValue>; interrupted: boolean; notes: string[] } {
  const { entries, bad, torn } = inspect(content, source);
  const { messages, synthetic, dropped } = paired(pi.activeMessages(entries));
  const last = messages.at(-1);
  const interrupted = last !== undefined && (last.role !== "assistant" || ["error", "aborted", "toolUse"].includes(last.stopReason));
  const notes = [bad ? `bad-lines=${bad}` : "", torn ? "torn-tail" : "", synthetic ? `unanswered-calls=${synthetic}` : "", dropped ? `orphan-results=${dropped}` : "",
    interrupted ? "interrupted" : ""].filter(Boolean);
  return { messages, store: store(pi.activePath(entries)), interrupted, notes };
}

/** Storage identities the service recorded: group segment → group id; "group/user" segments → [group id, phone]. */
function identities(project: string): { groups: Map<string, string>; users: Map<string, [string, string]> } {
  const groups = new Map<string, string>(), users = new Map<string, [string, string]>();
  const path = join(project, "data/state/agent.sqlite");
  let db: Database;
  try { db = new Database(path, { readonly: true }); } catch { return { groups, users }; }
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storage_identity'").get()) return { groups, users };
    for (const { identity } of db.query("SELECT identity FROM storage_identity").all() as { identity: string }[]) {
      let pair: unknown;
      try { pair = identity.startsWith("[") ? JSON.parse(identity) : undefined; } catch { pair = undefined; }
      if (Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string")) {
        const [groupId, phone] = pair as [string, string];
        users.set(`${groupSegment(groupId)}/${userSegment(phone)}`, [groupId, phone]);
        groups.set(groupSegment(groupId), groupId);
      } else groups.set(groupSegment(identity), identity);
    }
  } finally { db.close(); }
  return { groups, users };
}

/** The member a session belongs to, or undefined when the directories cannot be attributed. */
function member(located: Located, known: ReturnType<typeof identities>): { groupId: string; phone: string } | undefined {
  const groupId = readable(located.group) ? located.group : known.groups.get(located.group);
  const recorded = known.users.get(`${located.group}/${located.user}`);
  const phone = readable(located.user) ? located.user : recorded?.[1];
  if (groupId === undefined || phone === undefined) return undefined;
  if (groupSegment(groupId) !== located.group || userSegment(phone) !== located.user) return undefined;
  if (recorded && (recorded[0] !== groupId || recorded[1] !== phone)) return undefined;
  return { groupId, phone };
}

async function liveSessions(context: Context): Promise<Located[]> {
  const directories = async (path: string) => {
    const target = join(context.groups, path);
    await ordinaryPath(context.groups, target);
    const entries = await readdir(target, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error(`群数据含符号链接，请人工检查：${target}`);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  };
  return sessions(directories, async (path) => {
    const target = join(context.groups, path);
    await ordinaryPath(context.groups, target);
    const found = await info(target);
    if (found && (!found.isFile() || found.isSymbolicLink())) throw new Error(`会话不是普通文件：${target}`);
    return !!found;
  });
}

async function settingsChange(project: string): Promise<Record<string, unknown> | undefined> {
  const settings = await json(join(project, SETTINGS));
  if (!settings || settings.cacheWarming === undefined || settings.cacheWarming === "off") return undefined;
  return { ...settings, cacheWarming: "off" };
}

/** Attributed sessions per group directory, in order. */
async function plan(context: Context) {
  const known = identities(context.project);
  const groups = new Map<string, { groupId: string; members: (Located & { phone: string })[] }>();
  const unattributed: string[] = [];
  for (const located of await liveSessions(context)) {
    const owner = member(located, known);
    if (!owner) { unattributed.push(located.source); continue; }
    const group = groups.get(located.group) ?? { groupId: owner.groupId, members: [] };
    if (group.groupId !== owner.groupId) { unattributed.push(located.source); continue; }
    group.members.push({ ...located, phone: owner.phone });
    groups.set(located.group, group);
  }
  return { groups, unattributed };
}

export const v3: Migration = {
  to: 3,
  async preview(context: PreviewContext) {
    const found = await sessions((path) => context.groups.directories(path), async (path) => (await context.groups.read(path)) !== null);
    const files: { root: "groups"; path: string }[] = [];
    let hashed = 0;
    for (const located of found) {
      // An unreadable header or store record stops the preview, before anything is stopped or written.
      inspect((await context.groups.read(located.source))!, located.source);
      if (!readable(located.group) || !readable(located.user)) hashed++;
      if (!files.some((file) => file.path === `${located.group}/${DATABASE}`)) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) files.push({ root: "groups", path: `${located.group}/${DATABASE}${suffix}` });
      }
    }
    const settings = await settingsChange(context.project);
    const groups = new Set(found.map((located) => located.group)).size;
    return {
      files, decisions: [], ...(settings ? { configuration: { [SETTINGS]: settings } } : {}),
      steps: [
        `把 ${groups} 个群 ${found.length} 位成员的当前会话导入各群的 Durable 数据库（durable.sqlite）：只导入当前上下文，`
          + "不执行工具、不发消息；原会话文件原地保留，旧统计继续由它计" + (hashed ? `；其中 ${hashed} 位成员的目录名是摘要，按状态库的存储身份确认，无法确认的保留原文件、不导入并在迁移日志中列出` : ""),
        ...(settings ? ["缓存保温（cacheWarming）改为 off：Durable 引擎不支持"] : []),
        "完整校验配置与账本，登记项目和群根版本 3",
      ],
    };
  },
  async apply(context) {
    const settings = await settingsChange(context.project);
    if (settings) await publishJson(join(context.project, SETTINGS), settings);
    const { groups, unattributed } = await plan(context);
    const { activeMessages, activePath } = await import("./lib/pi-sessions.ts");
    const pi = { activeMessages, activePath };
    const { importGroup } = await import("./lib/durable.ts");
    for (const source of unattributed) context.report?.("durable-import", `skipped=${source}; reason=无法确认成员身份`);
    for (const [directory, group] of groups) {
      const path = join(context.groups, directory, DATABASE);
      await ordinaryPath(context.groups, path);
      await importGroup(path, group.groupId, async (put) => {
        for (const located of group.members) {
          const file = join(context.groups, located.source);
          await ordinaryPath(context.groups, file);
          const content = (await bytes(file))!;
          const converted = convert(pi, content, located.source);
          const outcome = await put({ phone: located.phone, messages: converted.messages, store: converted.store,
            record: { source: located.source, sha256: sha256(content), bytes: content.length, interrupted: converted.interrupted } });
          context.report?.("durable-import", [`${outcome}=${located.source}`, `messages=${converted.messages.length}`, ...converted.notes].join("; "));
        }
      });
    }
  },
  async validate(context) {
    if (await settingsChange(context.project)) throw new Error("v3 迁移校验失败：cacheWarming 不是 off");
    const { groups } = await plan(context);
    const { readGroupImports } = await import("./lib/durable.ts");
    for (const [directory, group] of groups) {
      const path = join(context.groups, directory, DATABASE);
      await ordinaryPath(context.groups, path);
      if (!await info(path)) throw new Error(`v3 迁移校验失败：缺少群数据库 ${directory}/${DATABASE}`);
      const { groupId, imports } = await readGroupImports(path, group.members.map((located) => located.phone));
      if (groupId !== group.groupId) throw new Error(`v3 迁移校验失败：群数据库不属于该群：${directory}`);
      for (const located of group.members) {
        const record = imports.get(located.phone), content = await bytes(join(context.groups, located.source));
        if (!record || !content || record.source !== located.source || record.sha256 !== sha256(content)) {
          throw new Error(`v3 迁移校验失败：会话没有按当前文件导入：${located.source}`);
        }
      }
    }
  },
};
