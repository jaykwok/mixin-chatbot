// The host console's read requests to the bot: a closed list of operations with bounded parameters, checked before
// anything is queued. Spaces are named by their storage path (`direct`, `groups/<segment>`) and pinned to the database
// generation the console saw first, so a replaced database is never read as the same space.
import { isSegment } from "../../core/layout.ts";

export const READ_LIMITS = {
  spaces: 2_000, members: 500, conversations: 500, entries: 200, entryBudget: 1_000_000,
  boundaries: 500, searchScan: 500, searchHits: 50, searchText: 200, requests: 500, names: 200,
} as const;

/** Parts of a history a search can look in: member messages, answers, thinking, tool calls and output, summaries, push notes. */
export const SEARCH_KINDS = ["question", "answer", "thinking", "tool", "summary", "push"] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
/** Terms of one search at most; later ones are ignored. */
export const SEARCH_TERMS = 8;

type Space = { space: string; generation: string };
export type ReadOp =
  | { op: "spaces" }
  | Space & { op: "members"; after: number; limit: number }
  | Space & { op: "activity" | "bounds"; conversations: number[] }
  | Space & { op: "entries"; conversation: number; older: boolean; cursor: number | null; upper: number | null; limit: number }
  | Space & { op: "entry"; conversation: number; id: number }
  | Space & { op: "boundaries"; conversation: number; after: number; limit: number }
  | Space & { op: "search"; conversation: number | null; text: string; cursor: number | null; upper: number | null;
    kinds?: SearchKind[] | null; from?: number | null; to?: number | null }
  | Space & { op: "requests"; conversation: number; phone: string }
  | { op: "names"; phones: string[] }
  /** The registered group names (src/push/store.ts), by storage segment. */
  | { op: "groups" };

// Between the client (main thread) and the read worker. `cancel` holds one flag per in-flight slot; the worker checks
// it, and the deadline, between statements.
export type WorkerInit = { conversations: string; state: string; cancel: SharedArrayBuffer };
export type ReadMessage = { request: number; slot: number; deadline: number; op: ReadOp };

/** Names of the worker errors the route answers specially. */
export const READ_ERRORS = { expired: "ReadExpired", cancelled: "ReadCancelled", changed: "SpaceChanged", absent: "SpaceAbsent" } as const;

/** A request the bot refuses as malformed (HTTP 400). */
export class ReadRequestError extends Error { override name = "ReadRequestError"; }

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Phones are whatever the platform confirmed; they only reach SQL as parameters, so any short printable string round-trips.
const phone = (value: unknown) => typeof value === "string" && value.length >= 1 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);

function fail(message: string): never { throw new ReadRequestError(message); }
function id(value: unknown, name: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${name} 必须是非负整数`);
}
const optionalId = (value: unknown, name: string) => value === null || value === undefined ? null : id(value, name);
function limit(value: unknown, max: number, name: string): number {
  const n = id(value ?? max, name);
  return n >= 1 && n <= max ? n : fail(`${name} 超出范围 1–${max}`);
}
function ids(value: unknown, max: number, name: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) fail(`${name} 必须是 1–${max} 个编号`);
  return value.map(item => id(item, name));
}

export function spaceName(value: unknown): string {
  if (value === "direct") return value;
  const segment = typeof value === "string" && value.startsWith("groups/") ? value.slice("groups/".length) : undefined;
  return segment !== undefined && isSegment(segment) ? value as string : fail("space 不是会话空间名");
}

/** The operation of a request body, or ReadRequestError. */
export function parseReadOp(body: unknown): ReadOp {
  if (typeof body !== "object" || body === null) fail("请求体必须是对象");
  const b = body as Record<string, unknown>;
  if (b.op === "spaces") return { op: "spaces" };
  if (b.op === "groups") return { op: "groups" };
  if (b.op === "names") {
    if (!Array.isArray(b.phones) || b.phones.length === 0 || b.phones.length > READ_LIMITS.names) fail(`phones 必须是 1–${READ_LIMITS.names} 个号码`);
    return { op: "names", phones: b.phones.map(item => phone(item) ? item as string : fail("phones 含无效号码")) };
  }
  const space = { space: spaceName(b.space), generation: typeof b.generation === "string" && GENERATION.test(b.generation) ? b.generation : fail("generation 无效") };
  switch (b.op) {
    case "members": return { op: "members", ...space, after: id(b.after ?? 0, "after"), limit: limit(b.limit, READ_LIMITS.members, "limit") };
    case "activity": case "bounds": return { op: b.op, ...space, conversations: ids(b.conversations, READ_LIMITS.conversations, "conversations") };
    case "entries":
      if (typeof b.older !== "boolean") fail("older 必须是布尔值");
      return { op: "entries", ...space, conversation: id(b.conversation, "conversation"), older: b.older, cursor: optionalId(b.cursor, "cursor"),
        upper: optionalId(b.upper, "upper"), limit: limit(b.limit, READ_LIMITS.entries, "limit") };
    case "entry": return { op: "entry", ...space, conversation: id(b.conversation, "conversation"), id: id(b.id, "id") };
    case "boundaries": return { op: "boundaries", ...space, conversation: id(b.conversation, "conversation"), after: id(b.after ?? 0, "after"),
      limit: limit(b.limit, READ_LIMITS.boundaries, "limit") };
    case "search": {
      const text = typeof b.text === "string" ? b.text : fail("text 必须是字符串");
      if (!text.trim() || text.length > READ_LIMITS.searchText) fail(`搜索内容须为 1–${READ_LIMITS.searchText} 个字符`);
      const kinds = b.kinds === null || b.kinds === undefined ? null
        : Array.isArray(b.kinds) && b.kinds.length > 0 && b.kinds.every(kind => (SEARCH_KINDS as readonly unknown[]).includes(kind))
          ? [...new Set(b.kinds as SearchKind[])] : fail(`kinds 必须是 ${SEARCH_KINDS.join("、")} 中的若干项`);
      const from = optionalId(b.from, "from"), to = optionalId(b.to, "to");
      if (from !== null && to !== null && from >= to) fail("from 必须早于 to");
      return { op: "search", ...space, conversation: optionalId(b.conversation, "conversation"), text, cursor: optionalId(b.cursor, "cursor"), upper: optionalId(b.upper, "upper"),
        kinds, from, to };
    }
    case "requests": return { op: "requests", ...space, conversation: id(b.conversation, "conversation"),
      phone: phone(b.phone) ? b.phone as string : fail("phone 无效") };
    default: return fail("未知的读取操作");
  }
}
