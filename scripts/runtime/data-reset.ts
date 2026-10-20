// A release boundary: preserve the existing ledger, entrance credentials and accepted administrator settings; discard old session formats.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { DATA_VERSION, VERSION_FILE, readDataVersion, readMetadata } from "../../src/core/data-version.ts";
import { ADVANCED_RUNTIME_KEYS, validateRuntimeConfig } from "../../src/core/runtime-schema.ts";
import { readAuxiliaryConfig } from "../../src/core/auxiliary-config.ts";
import { readMcpConfig } from "../../src/core/mcp-config.ts";
import { readRelayConfigFile } from "../../src/integrations/relay-s3.ts";
import { readRelayIndex } from "../../src/integrations/relay-index.ts";
import { digest, publishJson } from "../lib/atomic-file.ts";

const credentials = ["webhook-secret", "cloudflared-token"];
/**
 * Administrator settings cross a reset only when the target version's own reader accepts them; there are no
 * converters. Each check is the reader the target runs, so a kept file cannot fail later in the preview.
 * A setting whose meaning changes must change its format too, so the old file fails and is dropped.
 * The reset runs before dependencies are installed on Windows: these readers must stay built-in only.
 */
const settings: Record<string, (path: string) => unknown> = {
  "relay.json": path => readRelayConfigFile(path),
  "auxiliary.json": path => readAuxiliaryConfig(path),
  "mcp.json": path => readMcpConfig(path),
  "cloudflared-logging": path => choice(path, ["off", "on"]),
  "cloudflared-protocol": path => choice(path, ["auto", "http2", "quic"]),
};
/**
 * Mirrors scripts/lib/tunnel-logging.{sh,ps1}. Linux: sed trims ASCII blanks on each line and $(…) drops trailing
 * newlines; a BOM stays. Windows: Get-Content drops a UTF-8 BOM, then Trim() strips whitespace at both ends.
 * JavaScript trim() also strips U+FEFF, so it stands in for neither.
 */
function choice(path: string, values: string[]) {
  const text = readFileSync(path, "utf8");
  const value = process.platform === "win32" ? text.replace(/^\uFEFF/, "").replace(/^[^\S\uFEFF]+|[^\S\uFEFF]+$/g, "")
    : text.split("\n").map(line => line.replace(/^[ \t\v\f\r]+|[ \t\v\f\r]+$/g, "")).join("\n").replace(/\n+$/, "");
  if (!values.includes(value)) throw new Error(`只接受 ${values.join("、")}`);
}
/** Built from the release's task image; the deployment supplies them again. */
const runtimeDropped = new Set(["BOT_TASK_IMAGE", "BOT_TASK_CONTROL_ROOT"]);
const relayLedger = ["relay.sqlite", "relay.sqlite-wal", "relay.sqlite-shm", "relay.sqlite-journal"];
const tables = { stats_schema: "id", sources: "id", activity: "source, day", tool_counts: "source, day, kind, tool",
  usage_totals: "source, day, kind, provider, model", meta: "key" };
const stateKept = new Set(["service.lock", "deploy.lock", "deploy-transaction", "upgrade-transaction", "data-plan.json",
  "verify-only", "bot-port", "bot-domain", "deploy-mode", "group-data-root", "task-runtime", "cloudflared.pid", "cloudflared-managed"]);
export interface ResetPlan { from: number; markers: (string | null)[]; inputs: string; draft: string }
interface Move { area: "project" | "groups"; name: string; existed: boolean }
interface Journal { format: 2; deployment: string; groups: string; phase: "moving" | "prepared" | "restoring" | "restored";
  moves: Move[]; stats: string; draft: string; credentials: Record<string, string | null> }
const hash = (path: string) => digest(existsSync(path) ? readFileSync(path) : null);
const markers = (project: string, groups: string) => [hash(join(project, "data/state", VERSION_FILE)), hash(join(groups, VERSION_FILE))];

const segment = (name: string) => !!name && !name.startsWith(".") && !/[\\/\x00-\x1f:]/.test(name);
const groupDatabase = (name: string) => /\.sqlite(?:-wal|-shm|-journal)?$/i.test(name) && !/^stats\.sqlite(?:-wal|-shm|-journal)?$/i.test(name);
/** The hand-maintained index exclusion list survives resets; everything else under index/ is regenerated. */
const indexKept = (name: string) => name.toLowerCase() === "ignore.txt";
/** Explicit depths only: never traverse workspace, whole groups or arbitrary material folders. */
function resetGroupEntry(name: string): boolean {
  if (name === VERSION_FILE) return true;
  const parts = name.split("/");
  if (!parts.every(segment)) return false;
  return parts.length === 2 && (parts[1] === "index" || groupDatabase(parts[1]!))
    || parts.length === 3 && parts[1] === "index" && !indexKept(parts[2]!)
    || parts.length === 4 && parts[1] === "users" && ["session.jsonl", "tmp"].includes(parts[3]!);
}
/** Planning refuses unrecognised index entries; verify and rollback leave them in place instead of failing midway. */
function groupResetMoves(groups: string, planning = false): Move[] {
  const names = new Set([VERSION_FILE]), unknown: string[] = [];
  for (const group of readdirSync(groups, { withFileTypes: true })) {
    if (group.name.startsWith(".")) continue;
    const root = join(groups, group.name); plain(root);
    if (!group.isDirectory()) continue;
    if (!segment(group.name)) throw new Error(`群目录名称无效：${root}`);
    // A real index directory is cleared entry by entry so ignore.txt stays in place; a missing index, a link
    // (refused by plain()) or a file is listed whole as before.
    const index = join(root, "index"); plain(index);
    const info = existsSync(index) ? lstatSync(index) : null;
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      for (const entry of readdirSync(index)) {
        if (indexKept(entry)) continue;
        if (!segment(entry)) { unknown.push(join(index, entry)); continue; }
        names.add(`${group.name}/index/${entry}`);
      }
    } else names.add(group.name + "/index");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) names.add(group.name + "/durable.sqlite" + suffix);
    for (const entry of readdirSync(root)) if (groupDatabase(entry)) names.add(group.name + "/" + entry);
    const users = join(root, "users"); plain(users);
    if (!existsSync(users)) continue;
    for (const user of readdirSync(users, { withFileTypes: true })) {
      const path = join(users, user.name); plain(path);
      if (!user.isDirectory()) continue;
      if (!segment(user.name)) throw new Error(`成员目录名称无效：${path}`);
      for (const name of ["session.jsonl", "tmp"]) names.add(`${group.name}/users/${user.name}/${name}`);
    }
  }
  if (planning && unknown.length)
    throw new Error(`索引目录含无法识别的条目（如 .DS_Store），重置未移动任何数据。请删除或移出以下条目后重试：\n${unknown.join("\n")}`);
  return [...names].map(name => {
    const path = join(groups, name); plain(path);
    return { area: "groups", name, existed: existsSync(path) };
  });
}
/** A ledger the target version cannot read is reset with the sessions instead of blocking the upgrade. */
function keptRelayLedger(project: string, draft: string): boolean {
  const config = join(draft, "data/config/relay.json"), path = join(project, "data/state/relay.sqlite");
  plain(config); plain(path);
  if (!existsSync(config)) return false;
  for (const name of relayLedger) {
    const file = join(project, "data/state", name); plain(file);
    if (existsSync(file) && !lstatSync(file).isFile()) return false;
  }
  try { readRelayIndex(path); return true; } catch { return false; }
}
/** Only empty archive scaffolding can be discarded; unlisted files must never be recursively deleted. */
async function removeEmptyArchive(path: string): Promise<void> {
  plain(path);
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`重置归档含未列入清单的内容，保留待核查：${join(path, entry.name)}`);
    await removeEmptyArchive(join(path, entry.name));
  }
  await rmdir(path);
}

/** Malformed, half-written and newer pairs must never be interpreted as consent to reset. */
export function resetVersion(project: string, groups: string): number | null {
  const a = readDataVersion(join(project, "data/state", VERSION_FILE)), b = readDataVersion(join(groups, VERSION_FILE));
  if (!a && !b) return null;
  if (!a || !b || a.transaction !== b.transaction || a.dataVersion !== b.dataVersion)
    throw new Error("项目与群根的数据版本标记不成对；拒绝自动清理，请先恢复一致状态");
  if (a.dataVersion > DATA_VERSION) throw new Error("数据来自更新版本，禁止通过清理执行降级");
  return a.dataVersion < DATA_VERSION ? a.dataVersion : null;
}

/** Traversal never follows links; reset roots and drafts cannot redirect writes outside the deployment. */
function plain(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error(`重置路径不能经过链接：${p}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(p) === p) return;
  }
}

/** Windows denies a directory rename while any descendant is held without delete sharing. */
async function moveResetEntry(source: string, target: string): Promise<void> {
  const started = performance.now(), budget = process.platform === "win32" ? 10000 : 0;
  let attempts = 0;
  for (;;) {
    // Recheck boundaries after every wait; a retry must not follow a newly introduced link or overwrite an entry.
    plain(source); plain(target);
    if (existsSync(target)) throw new Error(`重置移动目标已存在，拒绝覆盖：${target}`);
    try {
      attempts++;
      await rename(source, target);
      if (attempts > 1) console.error(`重置路径重试后移动成功：${source} → ${target}（尝试 ${attempts} 次，耗时 ${Math.round(performance.now() - started)} ms）`);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? "unknown", elapsed = performance.now() - started;
      if (budget && ["EPERM", "EACCES", "EBUSY"].includes(code) && elapsed < budget) {
        if (attempts === 1) console.error(`Windows 拒绝移动重置路径（${code}），等待并重试，最多 10 秒：${source} → ${target}`);
        await sleep(Math.min(100 * 2 ** Math.min(attempts - 1, 4), 1000, budget - elapsed));
        continue;
      }
      const hint = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code)
        ? "；请关闭占用此目录或其子目录的程序/终端，并检查目录权限后重试；原件与回滚记录已保留"
        : "；事务保留供继续或回滚";
      throw new Error(`重置路径移动失败（错误码 ${code}，尝试 ${attempts} 次，耗时 ${Math.round(elapsed)} ms）：${source} → ${target}${hint}`, { cause });
    }
  }
}
function treeHash(path: string): string {
  const h = createHash("sha256");
  function walk(p: string, name: string) {
    if (!existsSync(p)) { h.update(JSON.stringify([name, "absent"])); return; }
    const info = lstatSync(p);
    if (info.isSymbolicLink()) throw new Error("配置草稿不能包含链接");
    if (info.isDirectory()) { h.update(JSON.stringify([name, "dir"])); for (const child of readdirSync(p).sort()) walk(join(p, child), name + "/" + child); }
    else if (info.isFile()) { h.update(JSON.stringify([name, "file", hash(p)])); }
    else throw new Error("配置不能包含特殊文件");
  }
  walk(path, ""); return h.digest("hex");
}
function inputHash(project: string): string {
  return createHash("sha256").update(treeHash(join(project, "data/config")))
    .update(hash(join(project, "data/runtime/pi/settings.json")) ?? "absent").digest("hex");
}
const secretHashes = (project: string) => Object.fromEntries(credentials.map(name => [name, hash(join(project, "data/config", name))]));
function assertSecrets(project: string) {
  const path = join(project, "data/config/webhook-secret"); plain(path);
  if (!existsSync(path) || !/^[a-f\d]{64}$/i.test(readFileSync(path, "utf8").trim())) throw new Error("升级重置必须保留有效的 webhook-secret，拒绝生成新密钥");
}

export async function prepareResetDraft(project: string, groups: string, draft: string): Promise<void> {
  if (resetVersion(project, groups) === null) throw new Error("只有较旧且成对的数据版本才允许重置");
  plain(project); plain(groups); plain(draft); assertSecrets(project);
  if (existsSync(draft)) throw new Error("重置配置目录已存在，请使用新的临时目录");
  await mkdir(join(draft, "data/config"), { recursive: true, mode: 0o700 });
  await mkdir(join(draft, "data/runtime/pi"), { recursive: true, mode: 0o700 });
  await mkdir(join(draft, "backup/rm"), { recursive: true, mode: 0o700 });
  const setting = (name: string, fallback: string) => existsSync(join(project, "data/state", name)) ? readFileSync(join(project, "data/state", name), "utf8").trim() : fallback;
  const kept: string[] = [], dropped: string[] = [];
  await publishJson(join(draft, "data/config/runtime.json"), { ...runtimeSettings(project, kept, dropped), GROUP_DATA_ROOT: groups,
    BOT_PORT: setting("bot-port", "1011"), BOT_HOST: setting("deploy-mode", "direct") === "cloudflare" ? "127.0.0.1" : "0.0.0.0" });
  for (const name of credentials) if (existsSync(join(project, "data/config", name))) await cp(join(project, "data/config", name), join(draft, "data/config", name));
  for (const [name, validate] of Object.entries(settings)) {
    const path = join(project, "data/config", name); plain(path);
    if (!existsSync(path)) continue;
    try {
      if (!lstatSync(path).isFile()) throw new Error("不是普通文件");
      validate(path); await cp(path, join(draft, "data/config", name)); kept.push(name);
    } catch (error) { dropped.push(`${name}（${(error as Error).message}）`); }
  }
  if (kept.length) console.log(`保留管理员设置：${kept.join("、")}`);
  if (dropped.length) console.log(`新版本不接受以下设置，已丢弃，升级后请重新设置：\n  ${dropped.join("\n  ")}`);
}

/** Read as src/core/runtime-config.ts does; each key is then judged alone, so one rejected key does not discard the others. */
function runtimeSettings(project: string, kept: string[], dropped: string[]): Record<string, string> {
  const path = join(project, "data/config/runtime.json"); plain(path);
  if (!existsSync(path)) return {};
  let old: Record<string, unknown>;
  try {
    const text = readFileSync(path, "utf8");
    try { old = JSON.parse(text); } catch { throw new Error("不是有效 JSON"); }
    if (!old || typeof old !== "object" || Array.isArray(old)) throw new Error("必须是对象");
  } catch (error) { dropped.push(`runtime.json 运行设置（${(error as Error).message}）`); return {}; }
  const result: Record<string, string> = {};
  for (const key of ADVANCED_RUNTIME_KEYS) {
    if (old[key] === undefined || runtimeDropped.has(key)) continue;
    try { Object.assign(result, validateRuntimeConfig({ [key]: old[key] })); kept.push(key); }
    catch (error) { dropped.push(`${key}（${(error as Error).message}）`); }
  }
  return result;
}

const modelFiles = ["data/config/models.json", "data/runtime/pi/settings.json", "data/runtime/models-store.json"];
/** Homes under replaced config/runtime/state trees must resolve from the draft too. Other paths stay unchanged. */
function resetModelEnvironment(project: string, draft: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const replaced = ["data/config", "data/runtime", "data/state"].map(name => join(project, name));
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    if (!env[key] || !isAbsolute(env[key])) continue;
    if (replaced.some(root => {
      const suffix = relative(root, env[key]!);
      return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
    })) env[key] = resolve(draft, relative(project, env[key]));
  }
  if (env.USERPROFILE && env.USERPROFILE !== process.env.USERPROFILE && /^[A-Za-z]:[\\/]/.test(env.USERPROFILE)) {
    env.HOMEDRIVE = env.USERPROFILE.slice(0, 2); env.HOMEPATH = env.USERPROFILE.slice(2);
  }
  return env;
}
/**
 * The old model configuration is offered for reuse only when the target Pi loads it, the selected model still
 * exists and Pi actually resolves its credentials — never because the files exist. checkAuth alone is not enough:
 * it treats `!command` keys as configured and skips header references, so the real getAuth runs here, including
 * those commands, in a child whose cwd and homes under replaced trees point at the draft. Absolute references to old
 * files cannot be hidden on every platform; commit checks the actual reset tree again before losing rollback.
 * Every failure exit removes all copies, so the wizard starts from an empty draft.
 * Pi changes that keep the format but alter meaning are not detectable here; the
 * administrator still chooses.
 */
export async function offerResetModels(project: string, draft: string): Promise<{ model: string } | { reason: string }> {
  project = resolve(project); draft = resolve(draft);
  for (const name of modelFiles) { plain(join(project, name)); plain(join(draft, name)); }
  try {
    for (const name of modelFiles.slice(0, 2)) if (!existsSync(join(project, name))) throw new Error(`缺少 ${name}`);
    for (const name of modelFiles) {
      const path = join(project, name);
      if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`${name} 不是普通文件`);
    }
    for (const name of modelFiles) {
      if (!existsSync(join(project, name))) continue;
      await mkdir(dirname(join(draft, name)), { recursive: true, mode: 0o700 });
      await cp(join(project, name), join(draft, name));
    }
    const { checkResetModels } = await import("./reset-model-check.ts");
    return { model: await checkResetModels(draft, resetModelEnvironment(project, draft)) };
  } catch (error) {
    await discardResetModels(draft);
    return { reason: (error as Error).message };
  }
}
/** Reconfiguring after an accepted offer starts the wizard from an empty draft, not from the old fields. */
export async function discardResetModels(draft: string): Promise<void> {
  for (const name of modelFiles) { const path = join(draft, name); plain(path); await rm(path, { force: true }); }
}

/**
 * auxiliary.json names models, which exist only once the reset's model configuration is done. A reference the
 * new configuration cannot resolve drops the whole file, like any other setting the new version rejects.
 */
export async function settleResetDraft(draft: string): Promise<void> {
  const path = join(draft, "data/config/auxiliary.json"); plain(path);
  const auxiliary = readAuxiliaryConfig(path);
  if (!auxiliary) return;
  const { openModelRuntime } = await import("../../src/core/model-config.ts");
  const runtime = await openModelRuntime({ modelsPath: join(draft, "data/config/models.json"), modelsStorePath: join(draft, "data/runtime/models-store.json") });
  const missing = (["classifier", "image"] as const).filter(type => auxiliary[type] && !runtime.getModelOfType(type, auxiliary[type]!.provider, auxiliary[type]!.modelId));
  if (!missing.length) return;
  await rm(path);
  console.log(`新模型配置中没有 auxiliary.json 引用的 ${missing.join("、")} 模型，已丢弃该文件，升级后请重新设置`);
}

export function makeResetPlan(project: string, groups: string, draft: string): ResetPlan {
  const from = resetVersion(project, groups);
  if (from === null) throw new Error("本次不需要数据重置");
  plain(draft); assertSecrets(project);
  if (JSON.stringify(secretHashes(project)) !== JSON.stringify(secretHashes(draft))) throw new Error("草稿改变了入口凭证，拒绝切换");
  // Old Pi files never cross by being present: they leave with data/config and data/runtime. The draft holds
  // either a copy the target Pi accepted (offerResetModels) or the wizard's output; the preview validates it.
  for (const name of modelFiles.slice(0, 2)) {
    const path = join(draft, name); plain(path);
    if (!existsSync(path)) throw new Error("草稿中没有模型配置：现有配置未被新版本接受时必须完成配置向导后重试");
  }
  return { from, markers: markers(project, groups), inputs: inputHash(project), draft: treeHash(join(draft, "data")) };
}

/** Stable full-row digest includes identities, source cursors, unknown flags and costs, not just totals. */
export function statsDigest(path: string): string {
  plain(path);
  if (!existsSync(path)) throw new Error("统计库缺失，拒绝以空统计代替历史数据");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("BEGIN");
    const schema = db.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number } | null;
    if (schema?.version !== 2) throw new Error("只接受统计 schema 2；保留原件，另行转换统计后重试");
    if (JSON.stringify(db.query("PRAGMA integrity_check").values()) !== '[["ok"]]' || db.query("PRAGMA foreign_key_check").all().length)
      throw new Error("统计库完整性检查失败");
    const h = createHash("sha256");
    for (const [table, order] of Object.entries(tables)) {
      h.update(table);
      for (const row of db.query(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) h.update(JSON.stringify(row) + "\n");
    }
    return h.digest("hex");
  } finally { db.close(); }
}

function snapshotPath(project: string, deployment: string): string {
  if (!/^deploy-[A-Za-z0-9]+$/.test(deployment)) throw new Error("重置必须属于发布事务");
  return join(project, "backup/snapshots", deployment);
}
function paths(project: string, groups: string, deployment: string) {
  const snapshot = snapshotPath(project, deployment);
  const archive = join(groups, ".reset-" + deployment);
  const projectArchive = join(project, "data", ".reset-" + deployment);
  for (const p of [project, groups, snapshot, archive, projectArchive, join(project, "backup/statistics", deployment), join(project, "data/state"), join(project, "data/config"), join(project, "data/runtime")]) plain(p);
  const inside = (child: string, root: string) => { const rel = relative(resolve(root), resolve(child)); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")); };
  if (inside(project, groups) || inside(join(project, "data"), groups) || inside(groups, projectArchive) || inside(projectArchive, groups)
    || ["backup", "data/config", "data/runtime", "data/state"].some(name => inside(groups, join(project, name)) || inside(join(project, name), groups)))
    throw new Error("群根与项目管理目录重叠，拒绝重置");
  return { snapshot, archive, projectArchive, journal: join(snapshot, "reset.json"), draft: join(snapshot, "reset-config"),
    permanent: join(project, "backup/statistics", deployment) };
}
function movePaths(project: string, groups: string, projectArchive: string, archive: string, move: Move) {
  const root = move.area === "groups" ? groups : project;
  const target = resolve(root, move.name);
  if (!relative(root, target) || isAbsolute(relative(root, target)) || relative(root, target).startsWith("..") || resolve(target) === resolve(root)) throw new Error("重置条目越界");
  if (move.area === "groups" && !resetGroupEntry(move.name)) throw new Error("重置群条目无效：只能清理群直属数据库、索引、成员会话和 tmp");
  if (move.area === "project" && !/^data\/(config|runtime|state\/[^/\\]+)$/.test(move.name)) throw new Error("重置项目条目无效");
  if (move.area === "project" && move.name.startsWith("data/state/") && stateKept.has(move.name.slice(11))) throw new Error("重置不能移动发布资源");
  const saved = move.area === "groups" ? join(archive, move.name) : join(projectArchive, move.name.slice("data/".length));
  plain(target); plain(saved);
  if (move.area === "groups" && move.name.split("/").length === 2 && groupDatabase(move.name.split("/")[1]!)) {
    for (const path of [target, saved]) if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`群数据库路径不是普通文件，拒绝清理：${path}`);
  }
  return { live: target, saved };
}
function readJournal(project: string, groups: string, deployment: string): Journal | null {
  // Ordinary upgrades also verify, finish and roll back. They have no reset paths to inspect.
  // lstat distinguishes an absent journal from an existing (including dangling) link.
  try { lstatSync(join(snapshotPath(project, deployment), "reset.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const p = paths(project, groups, deployment), journal = readMetadata(p.journal) as Journal | null;
  if (!journal || journal.format !== 2 || journal.deployment !== deployment || journal.groups !== resolve(groups)
    || !["moving", "prepared", "restoring", "restored"].includes(journal.phase) || !/^[a-f\d]{64}$/.test(journal.stats)
    || !/^[a-f\d]{64}$/.test(journal.draft) || !journal.credentials || !Array.isArray(journal.moves)) throw new Error("重置事务记录无效");
  const seen = new Set<string>();
  for (const move of journal.moves) {
    if (!move || !["project", "groups"].includes(move.area) || typeof move.name !== "string" || typeof move.existed !== "boolean") throw new Error("重置条目无效");
    const key = move.area + ":" + move.name;
    if (seen.has(key)) throw new Error("重置条目重复"); seen.add(key);
    movePaths(project, groups, p.projectArchive, p.archive, move);
  }
  return journal;
}

export async function applyReset(project: string, groups: string, deployment: string, plan?: ResetPlan): Promise<void> {
  const p = paths(project, groups, deployment);
  let journal = readJournal(project, groups, deployment);
  if (journal?.phase === "restored") throw new Error("该重置事务已回滚，请重新升级");
  if (!journal) {
    if (readdirSync(join(project, "data")).some(name => name.startsWith(".reset-"))) throw new Error("项目含未完成的重置，请先继续或回滚");
    if (!plan || JSON.stringify(makeResetPlan(project, groups, p.draft)) !== JSON.stringify(plan)) throw new Error("重置预览后配置、凭证或版本已变化，拒绝清理");
    const freeze = readMetadata(join(p.snapshot, "stats-frozen.json")) as { digest?: string; timezone?: string } | null;
    const stats = statsDigest(join(groups, "stats.sqlite"));
    if (freeze?.digest !== stats) throw new Error("缺少现有统计账本的冻结凭据，或统计在冻结后变化");
    if (freeze.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone) throw new Error(`新旧统计时区不同（${freeze.timezone} → ${Intl.DateTimeFormat().resolvedOptions().timeZone}），拒绝切换`);
    await mkdir(p.permanent, { recursive: true, mode: 0o700 });
    const backup = join(p.permanent, "stats.sqlite");
    if (!existsSync(backup)) {
      const db = new Database(join(groups, "stats.sqlite"), { readonly: true });
      try { db.query("VACUUM INTO ?").run(backup); } finally { db.close(); }
    }
    if (statsDigest(backup) !== stats) throw new Error("统计备份核对失败");
    const baseline = new Database(backup, { readonly: true });
    try {
      const incomplete = baseline.query("SELECT COUNT(*) AS sources, COALESCE(SUM(pending), 0) AS lines FROM sources WHERE pending > 0").get();
      await publishJson(join(p.permanent, "baseline.json"), { schema: 2, digest: stats, timezone: freeze.timezone,
        incompleteJsonl: incomplete, at: new Date().toISOString() });
    } finally { baseline.close(); }
    if (readdirSync(groups).some(name => name.startsWith(".reset-"))) throw new Error("群根含未完成的重置，请先继续或回滚");
    const moves: Move[] = groupResetMoves(groups, true);
    // The remote-object ledger follows its kept configuration, so objects uploaded before the reset are still swept.
    const ledger = keptRelayLedger(project, p.draft);
    for (const name of ["data/config", "data/runtime", ...readdirSync(join(project, "data/state"))
      .filter(name => !stateKept.has(name) && !(ledger && relayLedger.includes(name))).map(name => "data/state/" + name)])
      moves.push({ area: "project", name, existed: existsSync(join(project, name)) });
    for (const move of moves) movePaths(project, groups, p.projectArchive, p.archive, move);
    journal = { format: 2, deployment, groups: resolve(groups), phase: "moving", moves, stats, draft: plan.draft, credentials: secretHashes(project) };
    // Durable intent precedes every rename. A retry sees either the source or its own saved copy.
    await publishJson(p.journal, journal);
  }
  if (journal.deployment !== deployment || journal.groups !== resolve(groups)) throw new Error("重置事务身份不符");
  if (journal.phase === "prepared") { verifyReset(project, groups, deployment); return; }
  if (journal.phase !== "moving") throw new Error("重置事务阶段无效");
  if (treeHash(join(p.draft, "data")) !== journal.draft) throw new Error("重置配置草稿在确认后变化");
  // data/, backup/ and an external group root are independent Docker mounts. Each rename stays on its source mount.
  await mkdir(p.archive, { recursive: true, mode: 0o700 });
  await mkdir(p.projectArchive, { recursive: true, mode: 0o700 });
  for (const move of journal.moves) {
    const { live, saved } = movePaths(project, groups, p.projectArchive, p.archive, move);
    if (move.existed && !existsSync(saved)) { await mkdir(dirname(saved), { recursive: true }); await moveResetEntry(live, saved); }
  }
  // Copying an interrupted draft is repeatable; no service runs until this phase completes.
  for (const name of ["config", "runtime"]) await cp(join(p.draft, "data", name), join(project, "data", name), { recursive: true, force: true });
  // Generated host isolation metadata is a deployment resource, not user configuration.
  for (const name of ["data/config/task-deployment.json", "data/runtime/bot-launcher.ps1"]) {
    const saved = join(p.projectArchive, name.slice("data/".length));
    if (existsSync(saved)) { plain(saved); await cp(saved, join(project, name)); }
  }
  journal.phase = "prepared"; await publishJson(p.journal, journal);
  verifyReset(project, groups, deployment);
}

export function verifyReset(project: string, groups: string, deployment: string): boolean {
  const journal = readJournal(project, groups, deployment);
  if (!journal) return false;
  if (journal.phase !== "prepared" || statsDigest(join(groups, "stats.sqlite")) !== journal.stats) throw new Error("重置前后统计不一致，禁止提交");
  if (JSON.stringify(secretHashes(project)) !== JSON.stringify(journal.credentials)) throw new Error("入口凭证在重置后变化，禁止提交");
  if (groupResetMoves(groups).some(move => move.name !== VERSION_FILE && move.existed)) throw new Error("重置后仍有会话、索引或 tmp，禁止提交");
  return true;
}

export async function rollbackReset(project: string, groups: string, deployment: string): Promise<void> {
  const journal = readJournal(project, groups, deployment);
  if (!journal || journal.phase === "restored") return;
  const p = paths(project, groups, deployment);
  if (journal.groups !== resolve(groups) || journal.deployment !== deployment) throw new Error("重置恢复身份不符");
  if (statsDigest(join(groups, "stats.sqlite")) !== journal.stats) throw new Error("统计在冻结后变化，保持停机并保留原会话与统计备份，请先核查");
  journal.phase = "restoring"; await publishJson(p.journal, journal);
  for (const move of [...journal.moves].reverse()) {
    const { live, saved } = movePaths(project, groups, p.projectArchive, p.archive, move);
    if (existsSync(saved)) {
      await rm(live, { recursive: true, force: true }); await mkdir(dirname(live), { recursive: true }); await moveResetEntry(saved, live);
    } else if (!move.existed) await rm(live, { recursive: true, force: true });
  }
  // Discard only listed runtime paths created during verification, never their group or user parents.
  // A journal written before ignore.txt was kept lists g/index whole; its restored children are original too.
  const original = new Set(journal.moves.filter(m => m.area === "groups").map(m => m.name));
  const listed = (name: string) => name.split("/").some((_, i, parts) => original.has(parts.slice(0, i + 1).join("/")));
  for (const move of groupResetMoves(groups)) if (!listed(move.name) && move.existed)
    await rm(movePaths(project, groups, p.projectArchive, p.archive, move).live, { recursive: true, force: true });
  await removeEmptyArchive(p.archive);
  await rm(p.projectArchive, { recursive: true, force: true });
  journal.phase = "restored"; await publishJson(p.journal, journal);
}

/** Only after commit and successful activation. The independent statistics backup is never part of this cleanup. */
export async function finishReset(project: string, groups: string, deployment: string): Promise<void> {
  const journal = readJournal(project, groups, deployment);
  if (!journal) return;
  const p = paths(project, groups, deployment);
  if (journal.phase !== "prepared" || journal.groups !== resolve(groups)) throw new Error("重置清理身份不符");
  for (const move of journal.moves.filter(m => m.area === "groups"))
    await rm(movePaths(project, groups, p.projectArchive, p.archive, move).saved, { recursive: true, force: true });
  await removeEmptyArchive(p.archive);
  await rm(p.projectArchive, { recursive: true, force: true });
}

export function resetArchiveName(deployment: string): string { return ".reset-" + deployment; }
