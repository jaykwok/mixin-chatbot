// Export file formats: the conversation JSON (one document written piece by piece, so a partial file still parses up to
// its explicit `complete: false`) and Markdown, and the statistics CSV. Pure functions; exports.ts streams them.
import type { EntryPart, EntryView, IdentityMode, NamesStatus, RequestView } from "../ui/src/contract.ts";
import { IDENTITY_SCOPE_NOTE, MODE_LABELS } from "./identity.ts";

export const EXPORT_SCHEMA_VERSION = 1;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** The host's UTC offset at `at`, as +08:00. */
export function utcOffset(at: number): string {
  const minutes = -new Date(at).getTimezoneOffset(), sign = minutes >= 0 ? "+" : "-", abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Local time with its offset: 2026-10-27T15:30:12.345+08:00. */
export function isoLocal(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${utcOffset(at)}`;
}

/** Local time for reading: 2026-10-27 15:30:12. */
export function localTime(at: number): string {
  return isoLocal(at).slice(0, 19).replace("T", " ");
}

export const timezoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "本机时区";

const optionalTime = (at: number | null | undefined) => at === null || at === undefined ? null : isoLocal(at);

// ─── File names ─────────────────────────────────────────────────────────────

/** Header line and file-name mark of a mode: real names make a file personal information. */
export function personalMark(mode: IdentityMode): { file: string; banner: string } {
  if (mode === "anonymous") return { file: "匿名身份", banner: "匿名身份：成员只用本次导出内的编号表示；正文中的姓名、号码等不会被替换，本文件不是匿名化数据" };
  return { file: `含个人信息-${mode === "full" ? "完整身份" : "默认身份"}`, banner: `含个人信息 · ${MODE_LABELS[mode]}` };
}

/** A file name without path separators or characters Windows refuses. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180);
}

/** `Content-Disposition` for a download, with an ASCII fallback and the UTF-8 name. */
export function attachment(name: string, fallback: string): string {
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function stampOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ─── Shared shapes ──────────────────────────────────────────────────────────

/** A member as an export shows it: its in-export number plus what the mode allows. */
export interface ExportIdentity {
  number: string; label: string; phone?: string; name?: string; nameState?: string; nameNote?: string; nameObservedAt?: number;
}

export interface ConversationHeader {
  mode: IdentityMode; exportedAt: number; space: string; title: string; generation: string;
  scope: "member" | "space"; members: number; truncatedMembers: boolean;
  since: number | null; until: number | null;
  /** When each conversation's last entry was fixed; null when the export failed before that. */
  fixedAt: number | null; names: NamesStatus;
}

export interface MemberHeader { identity: ExportIdentity; memberSince: number | null; upperEntry: number | null }

export interface RunRecords { observedAt: number; total: number; items: RequestView[] }

export interface Trailer { complete: boolean; endedAt: number; members: number; entries: number; error?: string }

export interface ExportWriter {
  readonly type: string;
  readonly extension: string;
  header(header: ConversationHeader): string;
  member(member: MemberHeader): string;
  entry(entry: EntryView): string;
  /** Closes the member's entries and writes its run records. */
  memberEnd(records: RunRecords | null): string;
  /** Closes whatever is open and writes the completion mark (or its absence, with the reason). */
  end(trailer: Trailer): string;
}

const HISTORY_NOTE = "历史条目只追加、不可变；每个会话导出到导出开始时的最后一条（upperEntry），之后的新消息不在本文件。多个会话分别取上界，不是跨会话的原子快照。";
const MUTABLE_NOTE = "姓名是读取时的通讯录姓名（不代表对话发生时的名字），运行记录（交付状态）是读取时状态，各自带读取时间；已结束的运行记录 24 小时后由机器人清除。";
const RANGE_NOTE = "时间范围按条目时间筛选；没有时间的分隔条目（如 /clear）随前一条判断。";

// ─── JSON ───────────────────────────────────────────────────────────────────

/** Entry fields an export keeps: no internal `data`, no stored size. */
function entryJson(entry: EntryView): Record<string, unknown> {
  const out: Record<string, unknown> = { id: entry.id, kind: entry.kind, time: optionalTime(entry.at) };
  if (entry.role) out.role = entry.role;
  if (entry.head !== undefined) out.head = entry.head;
  if (entry.system) out.system = { ...entry.system, note: "系统提示只导出段名与字数" };
  else out.parts = entry.parts;
  if (entry.assistant) out.assistant = entry.assistant;
  if (entry.tool) out.tool = entry.tool;
  return out;
}

function identityJson(identity: ExportIdentity): Record<string, unknown> {
  const { nameObservedAt, ...rest } = identity;
  return nameObservedAt === undefined ? rest : { ...rest, nameObservedAt: isoLocal(nameObservedAt) };
}

export function jsonWriter(): ExportWriter {
  let members = 0, entries = 0, inMember = false;
  const close = () => inMember ? "]}" : "";
  return {
    type: "application/json; charset=utf-8",
    extension: "json",
    header(h) {
      const head = {
        schemaVersion: EXPORT_SCHEMA_VERSION, kind: "mixin-console/conversations",
        personalInformation: personalMark(h.mode).banner,
        identityMode: h.mode, identityNote: IDENTITY_SCOPE_NOTE,
        exportedAt: isoLocal(h.exportedAt), timezone: timezoneName(), utcOffset: utcOffset(h.exportedAt),
        space: { path: h.space, title: h.title, generation: h.generation },
        scope: h.scope, memberCount: h.members, ...(h.truncatedMembers ? { membersNote: "空间成员超过一次载入的上限，只导出已载入的成员" } : {}),
        range: { since: optionalTime(h.since), until: optionalTime(h.until), note: RANGE_NOTE },
        history: { fixedAt: optionalTime(h.fixedAt), note: HISTORY_NOTE },
        mutable: MUTABLE_NOTE,
        names: { ...h.names, ...(h.names.observedAt === undefined ? {} : { observedAt: isoLocal(h.names.observedAt) }) },
      };
      return `${JSON.stringify(head, null, 1).slice(0, -2)},\n "members": [`;
    },
    member(m) {
      const text = `${members++ ? "," : ""}\n  {"member": ${JSON.stringify(identityJson(m.identity))}, "memberSince": ${JSON.stringify(optionalTime(m.memberSince))}, "upperEntry": ${JSON.stringify(m.upperEntry)},\n   "entries": [`;
      inMember = true;
      entries = 0;
      return text;
    },
    entry(entry) {
      return `${entries++ ? "," : ""}\n    ${JSON.stringify(entryJson(entry))}`;
    },
    memberEnd(records) {
      inMember = false;
      const runs = records && { observedAt: isoLocal(records.observedAt), total: records.total, items: records.items };
      return `\n   ],\n   "runRecords": ${JSON.stringify(runs)}}`;
    },
    end(t) {
      const tail = { complete: t.complete, endedAt: isoLocal(t.endedAt), counts: { members: t.members, entries: t.entries }, ...(t.error ? { error: t.error } : {}) };
      return `${close()}\n ],\n${JSON.stringify(tail, null, 1).slice(2)}\n`;
    },
  };
}

// ─── Markdown ───────────────────────────────────────────────────────────────

/** A fence longer than any backtick run inside, so message text can never close it. */
export function fenced(text: string, info = "text"): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Inline text in headings and lists: no line breaks, Markdown punctuation and HTML escaped. */
export function inline(text: string): string {
  return text.replace(/\s+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\`*_[\]{}()#+!|~-]/g, "\\$&");
}

const ROLE: Record<string, string> = { user: "用户", assistant: "助手", toolResult: "工具结果", system: "系统提示" };
const kb = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

function partText(part: EntryPart): string {
  switch (part.type) {
    case "text": return fenced(part.text);
    case "thinking": return `思考${part.redacted ? "（已隐去）" : ""}：\n\n${fenced(part.text)}`;
    case "image": return `［图片 ${inline(part.mimeType)}，${kb(part.bytes)}，导出不含图片内容］`;
    case "toolCall": return `调用工具 \`${inline(part.name)}\`${part.invalid ? `（参数无效：${inline(part.invalid)}）` : ""}：\n\n${fenced(part.arguments, "json")}`;
  }
}

function entryMarkdown(entry: EntryView): string {
  const when = entry.at === null ? "" : `${localTime(entry.at)} · `;
  if (entry.kind === "pi.reset") return `\n---\n\n**${when}/clear：此后开始新的上下文**（#${entry.id}）\n`;
  if (entry.system) {
    return `\n#### ${when}系统提示 · #${entry.id}\n\n${entry.system.chars} 字；段：${entry.system.sections.map(inline).join("、") || "—"}（导出不含全文）\n`;
  }
  const lines: string[] = [];
  let title = ROLE[entry.role ?? ""] ?? inline(entry.kind);
  if (entry.kind === "pi.compaction") title = `压缩摘要（此后上下文从 #${entry.head} 起保留）`;
  if (entry.assistant) title += `（${inline(entry.assistant.provider)}/${inline(entry.assistant.model)}）`;
  if (entry.tool) title += ` \`${inline(entry.tool.name)}\`${entry.tool.isError ? "（失败）" : ""}`;
  lines.push(`\n#### ${when}${title} · #${entry.id}\n`);
  for (const part of entry.parts) lines.push(partText(part), "");
  if (entry.assistant?.error) lines.push(`> 错误：${inline(entry.assistant.error)}`, "");
  if (entry.assistant?.usage) {
    const u = entry.assistant.usage;
    lines.push(`<sub>token：输入 ${u.input}，输出 ${u.output}，缓存读 ${u.cacheRead}，缓存写 ${u.cacheWrite}${entry.assistant.durationMs === undefined ? "" : `；耗时 ${(entry.assistant.durationMs / 1000).toFixed(1)} 秒`}</sub>`, "");
  }
  return lines.join("\n");
}

const DELIVERY: Record<string, string> = { pending: "待发送", sending: "发送中", sent: "平台已接收", failed: "失败", uncertain: "结果不确定" };
const ABANDONED: Record<string, string> = { withdrawn: "/stop 或 /clear 撤回", expired: "超出发送时限" };

function recordsMarkdown(records: RunRecords | null): string {
  if (!records) return "";
  const head = `\n#### 运行记录（读取于 ${localTime(records.observedAt)}，共 ${records.total} 条；已结束的记录 24 小时后清除）\n`;
  if (!records.items.length) return `${head}\n无保留中的运行记录。\n`;
  const rows = records.items.map(item => {
    const parts = item.delivery?.parts.map(part => `${DELIVERY[part.state] ?? inline(part.state)}${part.state !== "failed" ? "" : part.retryAt === undefined ? "，不再重试" : `，计划 ${localTime(part.retryAt)} 重试`}${part.error ? `（${inline(part.error)}）` : ""}`).join("；") ?? "—";
    const files = item.files.map(file => `${inline(file.name)}（${inline(file.state)}）`).join("；") || "—";
    return `| ${item.createdAt === null ? "—" : localTime(item.createdAt)} | ${inline(item.status ?? "—")}${item.cancelled ? "，已取消" : ""} | ${item.delivery?.abandoned ? `已放弃（${ABANDONED[item.delivery.abandonedReason ?? ""] ?? "原因未记录"}）；` : ""}${parts} | ${files} | ${item.entry ?? "—"} |`;
  });
  return `${head}\n| 收到 | 处理 | 交付（没有平台已读证据） | 文件 | 条目 |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

export function markdownWriter(): ExportWriter {
  return {
    type: "text/markdown; charset=utf-8",
    extension: "md",
    header(h) {
      const mark = personalMark(h.mode);
      const range = h.since === null && h.until === null ? "全部" : `${h.since === null ? "最早" : localTime(h.since)} ~ ${h.until === null ? "导出时" : localTime(h.until)}`;
      return [
        `# 量子密信应用机器人会话导出：${inline(h.title)}`, "",
        `> **${inline(mark.banner)}**`, `>`, `> ${inline(IDENTITY_SCOPE_NOTE)}`, "",
        `- 导出时间：${localTime(h.exportedAt)}（${inline(timezoneName())}，UTC${utcOffset(h.exportedAt)}）`,
        `- 空间：${inline(h.title)}（${inline(h.space)}）`,
        `- 范围：${h.scope === "member" ? "1 位成员" : `整个空间，${h.members} 位成员（打开空间时载入的名单）${h.truncatedMembers ? "，超过上限的成员未导出" : ""}`}`,
        `- 时间：${inline(range)}。${inline(RANGE_NOTE)}`,
        `- 历史截点：${h.fixedAt === null ? "未能固定" : `各会话末条编号读取于 ${localTime(h.fixedAt)}`}。${inline(HISTORY_NOTE)}`,
        `- 可变字段：${inline(MUTABLE_NOTE)}`,
        "", "",
      ].join("\n");
    },
    member(m) {
      const id = m.identity;
      const facts = [`导出内编号 ${inline(id.number)}`];
      if (id.nameState) facts.push(`姓名：${id.nameState === "named" ? `读取于 ${id.nameObservedAt === undefined ? "—" : localTime(id.nameObservedAt)}` : inline(id.nameNote ?? "")}`);
      facts.push(`条目编号上界 ${m.upperEntry ?? "—（尚无对话）"}`);
      const title = id.nameState && id.nameState !== "named" && id.nameNote ? `${id.label}（${id.nameNote}）` : id.label;
      return `\n---\n\n## ${inline(title)}\n\n${facts.join(" · ")}\n`;
    },
    entry: entryMarkdown,
    memberEnd: recordsMarkdown,
    end(t) {
      const counts = `${t.members} 位成员，${t.entries} 条记录`;
      return t.complete
        ? `\n---\n\n**导出完成**：${counts}，结束于 ${localTime(t.endedAt)}。\n\n<!-- mixin-console-export: complete; members=${t.members}; entries=${t.entries} -->\n`
        : `\n---\n\n**导出未完成**：${inline(t.error ?? "原因未知")}。已写出 ${counts}；本文件不是完整导出。\n\n<!-- mixin-console-export: incomplete -->\n`;
    },
  };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/** One CSV cell: always quoted; text a spreadsheet would read as a formula gets a leading apostrophe. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export const csvRow = (cells: (string | number)[]) => cells.map(csvCell).join(",") + "\r\n";
