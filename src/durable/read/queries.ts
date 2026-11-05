// Read-only views of one space database for the host console. Plain SQL on a read-only connection, never the official
// SqliteStorage: its open runs migrations, and a snapshot copy (diagnostics.ts) is too heavy per page.
//
// Every statement is bounded by an index range and a LIMIT. bun:sqlite cannot interrupt a running statement (a measured
// Worker.terminate waits for it to finish), so cancelling only means not starting the next one. The caller runs each
// operation in one short read transaction and releases it before the next page.
//
// Semantics this relies on (pi-durable 1.4.0, checked for W1a; rechecked on 1.5.0): entries are appended and never
// updated or deleted; `/clear` appends a reset entry (`head` = itself) and a compaction appends a summary (`head` = the
// first kept entry), so an entry number bounds a fixed history range. Documents, tasks and submissions change in place:
// what is read from them is the state stored at reading time (streamed progress is stored up to `persistWithinMs` after
// it is made).
import type { Database } from "bun:sqlite";
import { apply } from "@earendil-works/chord/delta";
import { PUSH_NOTE_KIND } from "../../push/note.ts";
import { SEARCH_TERMS, type SearchKind } from "./protocol.ts";

const key = (value: string) => JSON.stringify(value);
const MEMBER = key("mixin.member"), RECORDS = key("mixin.member-records"), SPACE = key("mixin.space");

/** Longest text part in a page; the single-entry view has the whole entry. */
export const PAGE_TEXT_CHARS = 32_000;
/** Revisions read per statement while materializing a document. */
const REVISION_CHUNK = 2_000;

export class ReadLimit extends Error { override name = "ReadLimit"; }

/** Called between statements of one operation; throws to stop it (deadline passed, caller gone). */
export type Guard = () => void;
const unguarded: Guard = () => {};

// ─── Documents ──────────────────────────────────────────────────────────────

type Revision = { seq: number; kind: "base" | "delta"; version: number; content: string };
export type DocumentLimits = { revisions: number; chars: number };
const DOCUMENT_LIMITS: DocumentLimits = { revisions: 500_000, chars: 256_000_000 };

/** Current value of a document: the latest base and the deltas after it, read in bounded chunks. */
export function documentValue(db: Database, id: number, guard = unguarded, limits = DOCUMENT_LIMITS): { value: unknown; revisions: number } {
  const base = db.query("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1")
    .get(id) as Revision | null;
  if (!base) throw new Error(`文档 ${id} 缺少基准版本`);
  let value: unknown = JSON.parse(base.content), after = base.seq, revisions = 1, chars = base.content.length;
  const chunk = db.query("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT ?");
  for (;;) {
    guard();
    const rows = chunk.all(id, after, REVISION_CHUNK) as Revision[];
    for (const row of rows) {
      if (row.kind !== "delta" || row.version !== base.version) throw new Error(`文档 ${id} 的修订跨越了版本边界`);
      revisions++; chars += row.content.length;
      if (revisions > limits.revisions || chars > limits.chars) throw new ReadLimit(`文档 ${id} 的修订链过长（${revisions} 条）`);
      value = apply(value, JSON.parse(row.content));
      after = row.seq;
    }
    if (rows.length < REVISION_CHUNK) return { value, revisions };
  }
}

type DocumentRow = { id: number; key_value: string };
function sessionDocument(db: Database, kind: string, keyValue = ""): DocumentRow | undefined {
  return (db.query(`SELECT id, key_value FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = ?
    AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(kind, keyValue === "" ? 0 : 1, key(keyValue)) as DocumentRow | null) ?? undefined;
}

// ─── Space and members ─────────────────────────────────────────────────────

/** The space key (`scopeKey`) and the generation this database was created with; undefined for a database without one. */
export function spaceIdentity(db: Database): { space: string; generation: string } | undefined {
  const doc = sessionDocument(db, SPACE);
  if (!doc) return undefined;
  const state = documentValue(db, doc.id).value as { space?: unknown; generation?: unknown };
  if (typeof state.space !== "string" || typeof state.generation !== "string") throw new Error("会话库的空间记录无法识别");
  return { space: state.space, generation: state.generation };
}

export type SpaceInfo = { space: string; generation: string; members: number; lastEntry: number | null; lastAt: number | null };

export function spaceInfo(db: Database): SpaceInfo | undefined {
  const identity = spaceIdentity(db);
  if (!identity) return undefined;
  const members = (db.query("SELECT count(*) AS n FROM documents WHERE scope_kind = 'session' AND owner_id = 0 AND kind = ? AND retired_at IS NULL")
    .get(MEMBER) as { n: number }).n;
  const last = db.query("SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM entries ORDER BY id DESC LIMIT 4").all() as { id: number; at: number | null }[];
  return { ...identity, members, lastEntry: last[0]?.id ?? null, lastAt: last.find(row => typeof row.at === "number")?.at ?? null };
}

export type MemberInfo = { phone: string; conversationId: number; createdAt: number | null; document: number };

/** Members in document order after `after` (a document id). */
export function members(db: Database, after: number, limit: number, guard = unguarded): { items: MemberInfo[]; next: number | null } {
  const rows = db.query(`SELECT id, key_value FROM documents WHERE scope_kind = 'session' AND owner_id = 0 AND kind = ? AND id > ?
    AND retired_at IS NULL ORDER BY id LIMIT ?`).all(MEMBER, after, limit + 1) as DocumentRow[];
  const items = rows.slice(0, limit).map(row => {
    guard();
    const value = documentValue(db, row.id, guard).value as { conversationId?: unknown; createdAt?: unknown };
    if (typeof value.conversationId !== "number") throw new Error(`成员记录 ${row.id} 无法识别`);
    return { phone: JSON.parse(row.key_value) as string, conversationId: value.conversationId,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : null, document: row.id };
  });
  return { items, next: rows.length > limit ? items.at(-1)!.document : null };
}

export type Activity = { conversationId: number; lastEntry: number | null; lastAt: number | null };

/** The newest entry of each conversation and the newest time stamp among its last few entries. */
export function activity(db: Database, conversationIds: readonly number[], guard = unguarded): Activity[] {
  const query = db.query(`SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM entries WHERE conversation_id = ?
    ORDER BY id DESC LIMIT 4`);
  return conversationIds.map(conversationId => {
    guard();
    const rows = query.all(conversationId) as { id: number; at: number | null }[];
    const at = rows.find(row => typeof row.at === "number")?.at ?? null;
    return { conversationId, lastEntry: rows[0]?.id ?? null, lastAt: at };
  });
}

/** The newest entry number of each conversation: the fixed upper bound of an export. */
export function bounds(db: Database, conversationIds: readonly number[], guard = unguarded): Record<number, number | null> {
  const query = db.query("SELECT max(id) AS id FROM entries WHERE conversation_id = ?");
  return Object.fromEntries(conversationIds.map(id => { guard(); return [id, (query.get(id) as { id: number | null }).id]; }));
}

// ─── Entries ────────────────────────────────────────────────────────────────

export type Part =
  | { type: "text"; text: string; truncated?: number }
  | { type: "thinking"; text: string; redacted?: boolean; truncated?: number }
  | { type: "image"; mimeType: string; bytes: number }
  | { type: "toolCall"; callId: string; name: string; arguments: string; truncated?: number; invalid?: string };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number | null };
export type EntryView = {
  id: number; kind: string; at: number | null; chars: number;
  /** Where the active context starts from this entry on: itself for a reset, the first kept entry for a compaction. */
  head?: number;
  role?: "user" | "assistant" | "toolResult" | "system";
  parts: Part[];
  assistant?: { provider: string; model: string; stopReason: string; error?: string; durationMs?: number; usage: Usage | null };
  tool?: { callId: string; name: string; isError: boolean; durationMs?: number; nested?: number };
  /** System entries: section names and size; the text is only in the single-entry view. */
  system?: { chars: number; sections: string[]; toolsAdded: string[]; toolsRemoved: string[] };
  data?: unknown;
};

type EntryRow = { id: number; conversation_id: number; head: number | null; record: string };
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function cut(text: string, max: number): { text: string; truncated?: number } {
  return text.length <= max ? { text } : { text: text.slice(0, max), truncated: text.length };
}

function parts(content: unknown, max: number): Part[] {
  if (typeof content === "string") return [{ type: "text", ...cut(content, max) }];
  if (!Array.isArray(content)) return [];
  const out: Part[] = [];
  for (const item of content as Record<string, unknown>[]) {
    switch (item?.type) {
      case "text": out.push({ type: "text", ...cut(String(item.text ?? ""), max) }); break;
      case "thinking": out.push({ type: "thinking", ...cut(String(item.thinking ?? ""), max), ...(item.redacted === true ? { redacted: true } : {}) }); break;
      case "image": out.push({ type: "image", mimeType: String(item.mimeType ?? ""), bytes: Math.floor(String(item.data ?? "").length * 3 / 4) }); break;
      case "toolCall": {
        const args = cut(JSON.stringify(item.arguments ?? {}, null, 2), max);
        out.push({ type: "toolCall", callId: String(item.id ?? ""), name: String(item.name ?? ""), arguments: args.text,
          ...(args.truncated ? { truncated: args.truncated } : {}),
          ...(typeof item.argumentsError === "string" ? { invalid: item.argumentsError.slice(0, 2_000) } : {}) });
        break;
      }
    }
  }
  return out;
}

function usage(value: unknown): Usage | null {
  const u = value as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  return { input: num(u.input) ?? 0, output: num(u.output) ?? 0, cacheRead: num(u.cacheRead) ?? 0, cacheWrite: num(u.cacheWrite) ?? 0,
    total: num(u.totalTokens) ?? 0, cost: num((u.cost as Record<string, unknown> | undefined)?.total) ?? null };
}

/** A display view of one stored entry; `max` caps each text part. */
export function entryView(row: Pick<EntryRow, "id" | "head" | "record">, max: number): EntryView {
  const record = JSON.parse(row.record) as { kind?: unknown; model?: unknown; data?: unknown };
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  const message = (Array.isArray(record.model) ? record.model[0] : undefined) as Record<string, unknown> | undefined;
  const view: EntryView = { id: row.id, kind, at: num(message?.timestamp) ?? null, chars: row.record.length, parts: [] };
  if (row.head !== null) view.head = row.head;
  const role = message?.role;
  if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") view.role = role;
  if (role === "system") {
    const text = typeof message!.content === "string" ? message!.content : JSON.stringify(message!.content ?? "");
    const sections = (message!.sections ?? {}) as Record<string, string | null>;
    const names = (list: unknown) => Array.isArray(list) ? list.map(tool => String((tool as { name?: unknown }).name ?? "")) : [];
    view.system = { chars: text.length + Object.values(sections).reduce((n, s) => n + (s?.length ?? 0), 0), sections: Object.keys(sections),
      toolsAdded: names(message!.toolsAdded), toolsRemoved: names(message!.toolsRemoved) };
    if (max === Infinity) view.parts = [{ type: "text", text: [text, ...Object.entries(sections).map(([name, body]) => `<!-- ${name} -->\n${body ?? "（移除）"}`)].filter(Boolean).join("\n\n") }];
    return view;
  }
  if (message) view.parts = parts(message.content, max);
  if (role === "assistant") {
    view.assistant = { provider: String(message!.provider ?? ""), model: String(message!.model ?? ""), stopReason: String(message!.stopReason ?? ""),
      ...(typeof message!.errorMessage === "string" ? { error: message!.errorMessage.slice(0, 4_000) } : {}),
      ...(num(message!.durationMs) !== undefined ? { durationMs: num(message!.durationMs) } : {}), usage: usage(message!.usage) };
  }
  if (role === "toolResult") {
    const nested = (message!.nestedCalls as { calls?: unknown[] } | undefined)?.calls?.length;
    view.tool = { callId: String(message!.toolCallId ?? ""), name: String(message!.toolName ?? ""), isError: message!.isError === true,
      ...(num(message!.durationMs) !== undefined ? { durationMs: num(message!.durationMs) } : {}), ...(nested ? { nested } : {}) };
  }
  if (record.data !== undefined && kind !== "pi.tool-result") view.data = record.data;
  return view;
}

export type EntryPage = { items: EntryView[]; next: number | null };

/**
 * Entries of one conversation in id order, newest first (`older`) or oldest first, never past `upper`. Stops early once
 * `budget` characters of stored records are in the page (at least one entry).
 */
export function entries(db: Database, conversationId: number, options: { older: boolean; cursor: number | null; upper: number | null; limit: number; budget: number }): EntryPage {
  const upper = options.upper ?? Number.MAX_SAFE_INTEGER;
  const rows = (options.older
    ? db.query("SELECT id, head, record FROM entries WHERE conversation_id = ? AND id < ? AND id <= ? ORDER BY id DESC LIMIT ?")
      .all(conversationId, options.cursor ?? Number.MAX_SAFE_INTEGER, upper, options.limit + 1)
    : db.query("SELECT id, head, record FROM entries WHERE conversation_id = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?")
      .all(conversationId, options.cursor ?? 0, upper, options.limit + 1)) as EntryRow[];
  const items: EntryView[] = [];
  let used = 0;
  for (const row of rows.slice(0, options.limit)) {
    if (items.length && used + row.record.length > options.budget) break;
    used += row.record.length;
    items.push(entryView(row, PAGE_TEXT_CHARS));
  }
  const more = items.length < rows.length;
  return { items, next: more ? items.at(-1)!.id : null };
}

/** One whole entry of the conversation, or undefined. */
export function entry(db: Database, conversationId: number, id: number): EntryView | undefined {
  const row = db.query("SELECT id, head, record FROM entries WHERE id = ? AND conversation_id = ?").get(id, conversationId) as EntryRow | null;
  return row ? entryView(row, Infinity) : undefined;
}

/** Resets and compactions of a conversation, oldest first: the boundaries of its history generations. */
export function boundaries(db: Database, conversationId: number, after: number, limit: number): { items: { id: number; head: number; kind: string; at: number | null }[]; next: number | null } {
  const rows = db.query(`SELECT id, head, json_extract(record, '$.kind') AS kind, json_extract(record, '$.model[0].timestamp') AS at FROM entries
    WHERE conversation_id = ? AND head IS NOT NULL AND id > ? ORDER BY id LIMIT ?`).all(conversationId, after, limit + 1) as { id: number; head: number; kind: string; at: number | null }[];
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? items.at(-1)!.id : null };
}

// ─── Search ─────────────────────────────────────────────────────────────────

export type SearchHit = { id: number; conversationId: number; kind: string; at: number | null; snippet: string; offset: number };
export type SearchResult = { hits: SearchHit[]; scanned: number; next: number | null; terms: string[] };
export type SearchOptions = {
  conversationId: number | null; text: string;
  /** Parts of the history to look in; null for all of them. */
  kinds: readonly SearchKind[] | null;
  /** Entry time stamps in [from, to); entries without one are left out while either is set. */
  from: number | null; to: number | null;
  cursor: number | null; upper: number | null; scan: number; hits: number;
};

/** Words of a search, lower-cased: whitespace separates them and "double quotes" keep a phrase together. */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, SEARCH_TERMS);
}

/** Which part of the history a piece of an entry belongs to; compactions and other entries (but push notes) are summaries. */
function partKind(kind: string, part: Part): SearchKind {
  if (kind === "pi.user") return "question";
  if (kind === "pi.tool-result") return "tool";
  if (kind === PUSH_NOTE_KIND) return "push";
  if (kind === "pi.assistant") return part.type === "thinking" ? "thinking" : part.type === "toolCall" ? "tool" : "answer";
  return "summary";
}

/** Searchable text of an entry: message text, thinking, tool arguments and tool output, as `kinds` selects. */
function searchable(view: EntryView, kinds: ReadonlySet<SearchKind> | null): string {
  return view.parts.filter(part => kinds === null || kinds.has(partKind(view.kind, part)))
    .map(part => part.type === "text" || part.type === "thinking" ? part.text : part.type === "toolCall" ? `${part.name} ${part.arguments}` : "").join("\n");
}

/**
 * Entries are appended as the conversation goes, so their time stamps grow with the entry number up to small
 * differences (a message is stamped a little before its entry commits). Time bounds are widened by this much when they
 * decide where the scan starts and stops; the exact range is checked on each entry.
 */
const TIME_MARGIN_MS = 3600_000;

/**
 * The first entry number whose time stamp is at or after `time`, found by bisecting entry numbers; undefined when every
 * entry is older. Each probe is one bounded statement.
 */
function firstAtOrAfter(db: Database, conversationId: number | null, time: number, guard: Guard): number | undefined {
  const scoped = conversationId === null ? "" : "conversation_id = ? AND ";
  const scope = (...values: number[]) => conversationId === null ? values : [conversationId, ...values];
  const top = (db.query(`SELECT max(id) AS id FROM entries${conversationId === null ? "" : " WHERE conversation_id = ?"}`).get(...scope()) as { id: number | null }).id;
  if (top === null) return undefined;
  const probe = db.query(`SELECT id, json_extract(record, '$.model[0].timestamp') AS at FROM entries WHERE ${scoped}id >= ? ORDER BY id LIMIT 16`);
  let low = 0, high = top + 1;
  while (low < high) {
    guard();
    const middle = Math.floor((low + high) / 2);
    const rows = probe.all(...scope(middle)) as { id: number; at: unknown }[];
    // Nothing at or after the middle, or no stamped entry among the next ones: look lower.
    const stamped = rows.find(row => typeof row.at === "number") as { id: number; at: number } | undefined;
    if (!stamped || stamped.at >= time) high = middle;
    else low = stamped.id + 1;
  }
  return low > top ? undefined : low;
}

/**
 * One block of a search, newest first: reads at most `scan` entries below `cursor` (of one conversation, or the whole
 * space), then matches inside them; every term must occur. A block without hits still ends: the caller decides whether
 * to ask for the next. With `to`, the first block starts at that time; with `from`, the search ends there.
 */
export function search(db: Database, options: SearchOptions, guard = unguarded): SearchResult {
  const terms = searchTerms(options.text);
  if (!terms.length) throw new Error("搜索内容不能为空");
  const kinds = options.kinds ? new Set(options.kinds) : null;
  let below = Math.min(options.cursor ?? Number.MAX_SAFE_INTEGER, (options.upper ?? Number.MAX_SAFE_INTEGER - 1) + 1);
  if (options.cursor === null && options.to !== null) {
    below = Math.min(below, firstAtOrAfter(db, options.conversationId, options.to + TIME_MARGIN_MS, guard) ?? below);
  }
  guard();
  const columns = "id, conversation_id, head, record, json_extract(record, '$.model[0].timestamp') AS at";
  const rows = (options.conversationId === null
    ? db.query(`SELECT ${columns} FROM entries WHERE id < ? ORDER BY id DESC LIMIT ?`).all(below, options.scan)
    : db.query(`SELECT ${columns} FROM entries WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(options.conversationId, below, options.scan)) as (EntryRow & { at: unknown })[];
  // Stored records are JSON.stringify output: text without quotes, backslashes or control characters appears in them
  // verbatim, so the raw record is a safe prefilter that spares parsing most entries.
  const raw = terms.filter(term => !/["\\\u0000-\u001f]/.test(term));
  const timed = options.from !== null || options.to !== null;
  const hits: SearchHit[] = [];
  let scanned = 0, ended = false;
  for (const row of rows) {
    const at = typeof row.at === "number" ? row.at : undefined;
    if (options.from !== null && at !== undefined && at < options.from - TIME_MARGIN_MS) { ended = true; break; }
    scanned++;
    if (timed && (at === undefined || at < (options.from ?? -Infinity) || at >= (options.to ?? Infinity))) continue;
    if (raw.length) {
      const record = row.record.toLowerCase();
      if (!raw.every(term => record.includes(term))) continue;
    }
    const view = entryView(row, Infinity);
    if (view.role === "system") continue;
    const text = searchable(view, kinds), lower = text.toLowerCase();
    if (!terms.every(term => lower.includes(term))) continue;
    // The snippet shows the earliest of the terms.
    const [offset, length] = terms.map(term => [lower.indexOf(term), term.length] as const).sort((a, b) => a[0] - b[0])[0]!;
    const start = Math.max(0, offset - 60);
    hits.push({ id: row.id, conversationId: row.conversation_id, kind: view.kind, at: view.at, offset,
      snippet: (start ? "…" : "") + text.slice(start, offset + length + 60).replace(/\s+/g, " ") });
    if (hits.length >= options.hits) break;
  }
  // Rows past the last one examined are left for the next block; a short block that was examined to its end is the last,
  // and so is one that reached entries older than `from`.
  const done = ended || (scanned === rows.length && rows.length < options.scan);
  return { hits, scanned, next: done || scanned === 0 ? null : rows[scanned - 1]!.id, terms };
}

// ─── Run records ────────────────────────────────────────────────────────────

export type RequestView = {
  requestId: string; createdAt: number | null; closedAt: number | null; cancelled: boolean;
  summary: string; receivedAt: number | null; sentAt: number | null;
  /** The user entry and the answer entry of the request, when its submission still exists. */
  entry: number | null; answer: number | null; status: string | null;
  delivery: { kind: string; abandoned: boolean; abandonedReason?: string;
    parts: { id: string; kind: string; state: string; attempts: number; retryAt?: number; error?: string; at?: number }[] } | null;
  files: { name: string; state: string; size: number; mode: string; error?: string }[];
  deliverables: { name: string; status: string; size: number; complete: boolean }[];
};

/** Run records of one member that are still kept (closed ones are pruned after a day), with their submissions. */
export function requests(db: Database, phone: string, conversationId: number, limit: number, guard = unguarded): { items: RequestView[]; revisions: number; total: number } {
  const doc = sessionDocument(db, RECORDS, phone);
  if (!doc) return { items: [], revisions: 0, total: 0 };
  const { value, revisions } = documentValue(db, doc.id, guard);
  guard();
  const records = Object.values((value as { requests?: Record<string, Record<string, unknown>> }).requests ?? {});
  records.sort((a, b) => (num(b.createdAt) ?? 0) - (num(a.createdAt) ?? 0));
  const submission = db.query("SELECT status, record FROM submissions WHERE conversation_id = ? AND request_id = ?");
  const items = records.slice(0, limit).map(record => {
    const requestId = String(record.requestId ?? "");
    const reply = (record.reply ?? {}) as Record<string, unknown>;
    const sub = submission.get(conversationId, key(requestId)) as { status: string; record: string } | null;
    const stored = sub ? JSON.parse(sub.record) as { entry?: unknown; answer?: unknown } : undefined;
    const delivery = record.delivery as { kind?: unknown; abandoned?: { reason?: unknown }; parts?: Record<string, unknown>[] } | undefined;
    return {
      requestId, createdAt: num(record.createdAt) ?? null, closedAt: num(record.closedAt) ?? null, cancelled: record.cancelled !== undefined && record.cancelled !== false,
      summary: String(reply.summary ?? ""), receivedAt: num(reply.receivedAt) ?? null, sentAt: num(reply.sentAt) ?? null,
      entry: num(stored?.entry) ?? null, answer: num(stored?.answer) ?? null, status: sub?.status ?? null,
      delivery: delivery ? { kind: String(delivery.kind ?? ""), abandoned: delivery.abandoned !== undefined,
        ...(typeof delivery.abandoned?.reason === "string" ? { abandonedReason: delivery.abandoned.reason } : {}),
        parts: (delivery.parts ?? []).map(part => ({ id: String(part.id ?? ""), kind: String(part.kind ?? ""), state: String(part.state ?? ""), attempts: num(part.attempts) ?? 0,
          ...(num(part.retryAt) !== undefined ? { retryAt: num(part.retryAt) } : {}),
          ...(typeof part.error === "string" ? { error: part.error.slice(0, 2_000) } : {}), ...(num(part.at) !== undefined ? { at: num(part.at) } : {}) })) } : null,
      files: ((record.files ?? []) as Record<string, unknown>[]).map(file => ({ name: String(file.name ?? ""), state: String(file.state ?? ""), size: num(file.size) ?? 0,
        mode: String(file.mode ?? ""), ...(typeof file.error === "string" ? { error: file.error.slice(0, 2_000) } : {}) })),
      deliverables: ((record.deliverables ?? []) as Record<string, unknown>[]).map(item => ({ name: String(item.name ?? ""), status: String(item.status ?? ""),
        size: num(item.size) ?? 0, complete: item.complete === true })),
    };
  });
  return { items, revisions, total: records.length };
}
