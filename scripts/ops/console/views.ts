// Conversation views. A view is one space opened in one identity mode by one console session: it pins the space's
// database generation, gives each member a random key (the page never sees a number it is not allowed to), and maps
// those keys back to members for the bot's read requests. Views live in memory only, a few per session, and go when the
// session ends or the console exits; reopening a space, switching it or logging in again starts over in default mode.
import type {
  EntryPage, GlobalSearchHit, GlobalSearchResponse, GlobalSearchViewResponse, IdentityMode, MemberRow, MembersResponse, NamesStatus,
  RequestsResponse, RequestView, SearchResponse, SpaceSummary, SpacesResponse, SpaceViewResponse, ViewInfo, Identity,
} from "../../../ui/console/src/contract.ts";
import { READ_LIMITS, ReadRequestError, SEARCH_KINDS, type SearchKind, spaceName } from "../../../src/durable/read/protocol.ts";
import { maskUser } from "../shared/format.ts";
import type { AuditLog } from "./audit.ts";
import { groupTitles, type GroupTitles } from "./group-titles.ts";
import { BotReadError, type BotReader } from "./bot.ts";
import { identityOf, lookupNames, MemberCodes, opaqueKey, redactPhones, type NameInfo } from "./identity.ts";
import { ApiProblem, input, problemOf, type Route, type RouteContext } from "./routes.ts";

/** Members one space view loads; a larger space lists the first ones and says so. */
export const MAX_VIEW_MEMBERS = 10_000;
/** Views per session; opening another drops the oldest. */
const MAX_VIEWS = 8;
/** Entries per page in the reader. */
export const ENTRY_PAGE = 50;

export interface Member {
  key: string; phone: string; conversation: number; createdAt: number | null;
  lastAt: number | null; lastEntry: number | null; code?: string;
  /** Its conversation has been opened in this view (recorded in the audit once). */
  opened: boolean;
}

interface BaseView { id: string; session: string; mode: IdentityMode; createdAt: number; codes: MemberCodes; names: Map<string, NameInfo> }
export interface SpaceView extends BaseView {
  kind: "space"; space: string; generation: string;
  /** As the page shows it (a registered group's name), fixed at opening; exports name their file by it. */
  title: string;
  members: Map<string, Member>; byConversation: Map<number, Member>;
  /** The space has more members than one view loads. */
  truncated: boolean;
  /** The member document read last: members who join later come after it. */
  lastDocument: number;
}
export interface StatsView extends BaseView {
  kind: "stats";
  /** Ledger identity → its key (and code in anonymous mode) in this view. */
  keys: Map<string, { key: string; code?: string }>;
}
/** A search over every space: the spaces it reads, pinned at opening, and the members of each met so far. */
export interface SearchView extends BaseView {
  kind: "search";
  spaces: { space: string; generation: string; title: string }[];
  /** Per space: conversation → member; absent until a hit in that space needs it. */
  members: Map<string, Map<number, SearchMember>>;
  /** Member key → its conversation, so opening a hit keeps the member (`keep`). */
  byKey: Map<string, { space: string; generation: string; conversation: number }>;
}
interface SearchMember { key: string; phone: string; code?: string }
type View = SpaceView | StatsView | SearchView;

export const viewInfo = (view: View): ViewInfo => ({ id: view.id, kind: view.kind, mode: view.mode, createdAt: view.createdAt });

export class Views {
  readonly #sessions = new Map<string, Map<string, View>>();

  add(view: View): void {
    let views = this.#sessions.get(view.session);
    if (!views) this.#sessions.set(view.session, views = new Map());
    views.set(view.id, view);
    for (const id of views.keys()) { if (views.size <= MAX_VIEWS) break; views.delete(id); }
  }

  get<K extends View["kind"]>(session: string, id: unknown, kind: K): Extract<View, { kind: K }> {
    const view = typeof id === "string" ? this.#sessions.get(session)?.get(id) : undefined;
    if (!view || view.kind !== kind) throw new ApiProblem(410, "view-gone", "这个视图已关闭或过期，请重新打开");
    return view as Extract<View, { kind: K }>;
  }

  close(session: string, id: unknown): void {
    if (typeof id === "string") this.#sessions.get(session)?.delete(id);
  }

  /** Drops everything a session held (Auth.onEnd). */
  end(session: string): void {
    this.#sessions.delete(session);
  }

  /** Views held now, for tests and diagnostics. */
  count(session: string): number {
    return this.#sessions.get(session)?.size ?? 0;
  }
}

// ─── Input ─────────────────────────────────────────────────────────────────

export const record = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : input("请求内容应为对象");
const int = (value: unknown, name: string) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : input(`${name} 应为非负整数`);
const optionalInt = (value: unknown, name: string) => value === null || value === undefined ? null : int(value, name);

/** The identity mode of a request; complete numbers need this request's explicit confirmation. */
export function parseMode(value: unknown, confirm: unknown): IdentityMode {
  if (value === undefined || value === "default") return "default";
  if (value === "anonymous") return value;
  if (value === "full") return confirm === true ? value : input("完整身份模式需要在本次操作中勾选确认");
  return input("身份模式应为 default、full 或 anonymous");
}

function parseSpace(value: unknown): string {
  try { return spaceName(value); }
  catch (error) { if (error instanceof ReadRequestError) input("不是会话空间名"); throw error; }
}

/** Rewrites the view's member numbers in a message the bot wrote (errors), as the mode shows numbers. */
export function cleanFor(view: { mode: IdentityMode; phones: () => Iterable<string> }): (text: string) => string {
  if (view.mode === "full") return text => text;
  return text => redactPhones(text, view.phones(), view.mode === "anonymous" ? () => "[成员号码]" : maskUser);
}

const spacePhones = (view: SpaceView) => () => [...view.members.values()].map(member => member.phone);

/** The filters of a search request; the bot checks them again. Times are ms, `to` exclusive. */
function searchFilters(body: Record<string, unknown>): { kinds: SearchKind[] | null; from: number | null; to: number | null } {
  const kinds = body.kinds === null || body.kinds === undefined ? null
    : Array.isArray(body.kinds) && body.kinds.length && body.kinds.every(kind => (SEARCH_KINDS as readonly unknown[]).includes(kind))
      ? [...new Set(body.kinds as SearchKind[])] : input("搜索内容类型无效");
  const from = optionalInt(body.from, "from"), to = optionalInt(body.to, "to");
  if (from !== null && to !== null && from >= to) input("起始时间应早于结束时间");
  return { kinds, from, to };
}

/** The space list's order: direct chats first, then the most recently active groups. */
const spaceOrder = <T extends { space: string; lastAt?: number | null }>(spaces: T[]) =>
  spaces.sort((a, b) => Number(b.space === "direct") - Number(a.space === "direct") || (b.lastAt ?? -1) - (a.lastAt ?? -1));

// ─── Routes ────────────────────────────────────────────────────────────────

export interface ConversationDeps { bot: BotReader; audit: AuditLog; views: Views; now?: () => number }

type SpaceRow = { space: string; state: "ready" | "empty" | "unreadable"; generation?: string; members?: number; lastEntry?: number | null; lastAt?: number | null; error?: string };
type MemberInfo = { phone: string; conversationId: number; createdAt: number | null; document: number };
type Activity = { conversationId: number; lastEntry: number | null; lastAt: number | null };

function summary(row: SpaceRow, titles: GroupTitles): SpaceSummary {
  const out: SpaceSummary = { space: row.space, title: titles.space(row.space), state: row.state };
  if (row.generation !== undefined) out.generation = row.generation;
  if (row.members !== undefined) out.members = row.members;
  if (row.lastEntry !== undefined) out.lastEntry = row.lastEntry;
  if (row.lastAt !== undefined) out.lastAt = row.lastAt;
  if (row.error !== undefined) out.error = row.error;
  return out;
}

function memberIdentity(view: SpaceView, member: Member): Identity {
  return identityOf(view.mode, member.key, member.phone, view.names.get(member.phone), member.code);
}

/** Newest activity first; members without any entry last, newest member first. */
export const membersInOrder = (view: SpaceView): Member[] =>
  [...view.members.values()].sort((a, b) => (b.lastAt ?? -1) - (a.lastAt ?? -1) || (b.createdAt ?? 0) - (a.createdAt ?? 0));

function memberRows(view: SpaceView): MemberRow[] {
  return membersInOrder(view)
    .map(member => ({ identity: memberIdentity(view, member), createdAt: member.createdAt, lastAt: member.lastAt, lastEntry: member.lastEntry }));
}

/** Run records with delivery and file errors (the bot's and the platform's own text) rewritten by `clean`. */
export function cleanRequests(items: RequestView[], clean: (text: string) => string): RequestView[] {
  return items.map(item => ({
    ...item,
    delivery: item.delivery && { ...item.delivery, parts: item.delivery.parts.map(part => part.error === undefined ? part : { ...part, error: clean(part.error) }) },
    files: item.files.map(file => file.error === undefined ? file : { ...file, error: clean(file.error) }),
  }));
}

/**
 * The new key of the member the page had open in another view of the same space and database (`keep: {view, member}`),
 * so switching the identity mode keeps the reader where it was. The page never learns more than both views showed it.
 */
function keptMember(views: Views, session: string, keep: unknown, view: SpaceView): string | undefined {
  if (typeof keep !== "object" || keep === null) return undefined;
  const { view: id, member: key } = keep as Record<string, unknown>;
  if (typeof key !== "string") return undefined;
  let found: { space: string; generation: string; conversation: number | undefined };
  try {
    const old = views.get(session, id, "space");
    found = { space: old.space, generation: old.generation, conversation: old.members.get(key)?.conversation };
  } catch {
    let search: SearchView;
    try { search = views.get(session, id, "search"); } catch { return undefined; }
    const at = search.byKey.get(key);
    if (!at) return undefined;
    found = at;
  }
  if (found.space !== view.space || found.generation !== view.generation || found.conversation === undefined) return undefined;
  return view.byConversation.get(found.conversation)?.key;
}

const describeMember = (view: SpaceView, member: Member) => `${view.space} ${view.mode === "anonymous" ? `成员 ${member.code}` : maskUser(member.phone)}`;

export function conversationRoutes({ bot, audit, views, now = Date.now }: ConversationDeps): Record<string, Route> {
  /** Runs `read` against a view, mapping failures with the view's numbers rewritten. */
  const withView = <T>(context: RouteContext, read: (view: SpaceView, body: Record<string, unknown>) => Promise<T>) => {
    const body = record(context.body);
    const view = views.get(context.session.label, body.view, "space");
    return read(view, body).catch(error => { throw problemOf(error, cleanFor({ mode: view.mode, phones: spacePhones(view) })); });
  };
  const memberOf = (view: SpaceView, key: unknown): Member => {
    const member = typeof key === "string" ? view.members.get(key) : undefined;
    return member ?? input("这个视图里没有该成员");
  };
  const at = (view: SpaceView) => ({ space: view.space, generation: view.generation });

  /** Members in document order after the member document `after`; more than `room` of them is a truncated list. */
  const readMembers = async (space: { space: string; generation: string }, after: number, room: number, signal: AbortSignal) => {
    const items: MemberInfo[] = [];
    for (;;) {
      const page = await bot.read<{ items: MemberInfo[]; next: number | null }>({ op: "members", ...space, after, limit: READ_LIMITS.members }, signal);
      items.push(...page.items);
      if (page.next === null) return { items, truncated: false };
      if (items.length >= room) return { items, truncated: true };
      after = page.next;
    }
  };
  /** The newest entry and time of each conversation, read in batches; `observedAt` is the time of the last batch. */
  const readActivity = async (space: { space: string; generation: string }, conversations: number[], signal: AbortSignal) => {
    const activity = new Map<number, Activity>();
    let observedAt: number | undefined;
    for (let start = 0; start < conversations.length; start += READ_LIMITS.conversations) {
      const result = await bot.read<{ items: Activity[]; observedAt: number }>(
        { op: "activity", ...space, conversations: conversations.slice(start, start + READ_LIMITS.conversations) }, signal);
      for (const item of result.items) activity.set(item.conversationId, item);
      observedAt = result.observedAt;
    }
    return { activity, observedAt };
  };
  /** Gives each new member a key (and a code in anonymous mode) in the view. */
  const addMembers = (view: SpaceView, infos: MemberInfo[], activity: Map<number, Activity>) => {
    for (const info of infos) {
      view.lastDocument = Math.max(view.lastDocument, info.document);
      if (view.byConversation.has(info.conversationId)) continue;
      const seen = activity.get(info.conversationId);
      const member: Member = { key: opaqueKey(), phone: info.phone, conversation: info.conversationId, createdAt: info.createdAt,
        lastAt: seen?.lastAt ?? null, lastEntry: seen?.lastEntry ?? null, opened: false };
      if (view.mode === "anonymous") member.code = view.codes.next();
      view.members.set(member.key, member);
      view.byConversation.set(member.conversation, member);
    }
  };

  return {
    "GET /api/spaces": {
      async run({ signal }) {
        try {
          const result = await bot.read<{ spaces: SpaceRow[]; observedAt: number }>({ op: "spaces" }, signal);
          const titles = await groupTitles(bot, signal);
          const spaces = spaceOrder(result.spaces.map(row => summary(row, titles)));
          return { spaces, observedAt: result.observedAt } satisfies SpacesResponse;
        } catch (error) { throw problemOf(error); }
      },
    },

    "POST /api/views/space": {
      slow: true,
      async run({ session, body: raw, signal }) {
        const body = record(raw);
        const space = parseSpace(body.space);
        const generation = typeof body.generation === "string" ? body.generation : input("缺少会话库代次");
        const mode = parseMode(body.mode, body.confirm);
        const view: SpaceView = { id: opaqueKey(), session: session.label, mode, createdAt: now(), codes: new MemberCodes(), names: new Map(),
          kind: "space", space, generation, title: "", members: new Map(), byConversation: new Map(), truncated: false, lastDocument: 0 };
        let names: NamesStatus = { state: "skipped" }, observedAt = view.createdAt;
        try {
          const { items: loaded, truncated } = await readMembers(at(view), 0, MAX_VIEW_MEMBERS, signal);
          view.truncated = truncated;
          const read = await readActivity(at(view), loaded.map(member => member.conversationId), signal);
          observedAt = read.observedAt ?? observedAt;
          if (mode !== "anonymous") {
            const looked = await lookupNames(bot, loaded.map(member => member.phone), signal);
            view.names = looked.names;
            names = looked.status;
          }
          addMembers(view, loaded, read.activity);
          view.title = (await groupTitles(bot, signal)).space(space);
          if (mode === "full") audit.write({ action: "identity-full", session: session.label, scope: space, mode });
          audit.write({ action: "view-open", session: session.label, scope: space, mode, rows: loaded.length });
        } catch (error) {
          throw problemOf(error, cleanFor({ mode, phones: spacePhones(view) }));
        }
        // Before adding: the new view may push the old one out.
        const kept = keptMember(views, session.label, body.keep, view);
        views.add(view);
        const lastAt = Math.max(-1, ...[...view.members.values()].map(member => member.lastAt ?? -1));
        const response: SpaceViewResponse = {
          view: viewInfo(view),
          space: { space, title: view.title, state: "ready", generation, members: view.members.size, lastAt: lastAt < 0 ? null : lastAt },
          members: memberRows(view), truncated: view.truncated, names, observedAt,
        };
        if (kept) response.kept = kept;
        return response;
      },
    },

    // The member list read again: each member's newest activity, and members who joined since the view opened (up to the
    // view's limit). Names are looked up for the new members only. The view changes only once every read has succeeded.
    "POST /api/conversation/activity": {
      slow: true,
      run: context => withView(context, async view => {
        let added: MemberInfo[] = [], truncated = view.truncated;
        if (!truncated) {
          const room = MAX_VIEW_MEMBERS - view.members.size;
          const more = await readMembers(at(view), view.lastDocument, Math.max(room, 1), context.signal);
          const fresh = more.items.filter(info => !view.byConversation.has(info.conversationId));
          added = fresh.slice(0, Math.max(room, 0));
          truncated = more.truncated || fresh.length > added.length;
        }
        const read = await readActivity(at(view), [...view.byConversation.keys(), ...added.map(info => info.conversationId)], context.signal);
        const looked = added.length && view.mode !== "anonymous" ? await lookupNames(bot, added.map(info => info.phone), context.signal) : undefined;
        for (const member of view.members.values()) {
          const seen = read.activity.get(member.conversation);
          if (seen) { member.lastAt = seen.lastAt; member.lastEntry = seen.lastEntry; }
        }
        for (const [phone, name] of looked?.names ?? []) view.names.set(phone, name);
        addMembers(view, added, read.activity);
        view.truncated = truncated;
        return { members: memberRows(view), added: added.length, truncated, observedAt: read.observedAt ?? now() } satisfies MembersResponse;
      }),
    },

    "POST /api/views/close": {
      async run({ session, body }) {
        views.close(session.label, record(body).view);
        return { ok: true };
      },
    },

    "POST /api/conversation/entries": {
      run: context => withView(context, async (view, body) => {
        const member = memberOf(view, body.member);
        if (typeof body.older !== "boolean") input("older 应为布尔值");
        const cursor = optionalInt(body.cursor, "cursor"), upper = optionalInt(body.upper, "upper");
        if (cursor === null && !member.opened) {
          audit.write({ action: "conversation-open", session: context.session.label, scope: describeMember(view, member), mode: view.mode });
          member.opened = true;
        }
        return bot.read<EntryPage>({ op: "entries", ...at(view), conversation: member.conversation, older: body.older as boolean, cursor, upper,
          limit: ENTRY_PAGE }, context.signal);
      }),
    },

    "POST /api/conversation/entry": {
      run: context => withView(context, async (view, body) => {
        const member = memberOf(view, body.member);
        const result = await bot.read<{ entry: unknown }>({ op: "entry", ...at(view), conversation: member.conversation, id: int(body.id, "id") }, context.signal);
        if (!result.entry) throw new ApiProblem(404, "not-found", "这条记录不在该成员的会话里");
        return result;
      }),
    },

    "POST /api/conversation/boundaries": {
      run: context => withView(context, async (view, body) => {
        const member = memberOf(view, body.member);
        return bot.read({ op: "boundaries", ...at(view), conversation: member.conversation, after: optionalInt(body.after, "after") ?? 0,
          limit: READ_LIMITS.boundaries }, context.signal);
      }),
    },

    "POST /api/conversation/requests": {
      run: context => withView(context, async (view, body) => {
        const member = memberOf(view, body.member);
        const result = await bot.read<{ items: RequestView[]; total: number; observedAt: number }>(
          { op: "requests", ...at(view), conversation: member.conversation, phone: member.phone }, context.signal);
        // Rewrite this member's number in the error texts as the mode shows it.
        const items = cleanRequests(result.items, cleanFor({ mode: view.mode, phones: () => [member.phone] }));
        return { items, total: result.total, observedAt: result.observedAt } satisfies RequestsResponse;
      }),
    },

    "POST /api/conversation/search": {
      run: context => withView(context, async (view, body) => {
        const member = body.member === null || body.member === undefined ? null : memberOf(view, body.member);
        const cursor = optionalInt(body.cursor, "cursor"), upper = optionalInt(body.upper, "upper");
        const text = typeof body.text === "string" ? body.text : input("搜索内容应为文字");
        const filters = searchFilters(body);
        if (cursor === null) {
          audit.write({ action: "search", session: context.session.label, scope: member ? describeMember(view, member) : view.space, mode: view.mode });
        }
        const result = await bot.read<BotSearch>({ op: "search", ...at(view), conversation: member?.conversation ?? null, text, cursor, upper, ...filters }, context.signal);
        return {
          hits: result.hits.map(hit => ({ id: hit.id, member: view.byConversation.get(hit.conversationId)?.key ?? null, kind: hit.kind, at: hit.at, snippet: hit.snippet })),
          scanned: result.scanned, next: result.next, terms: result.terms,
        } satisfies SearchResponse;
      }),
    },

    // A search over every space. Opening pins the ready spaces in the list's order; each search request reads one block
    // of one space and says where to go on. Members get keys of this view, in its mode, only once a hit names them.
    "POST /api/views/search": {
      async run({ session, body: raw, signal }) {
        const body = record(raw);
        const mode = parseMode(body.mode, body.confirm);
        if (mode === "full") input("全部空间搜索不提供完整身份模式；打开空间后可以切换");
        try {
          const result = await bot.read<{ spaces: SpaceRow[] }>({ op: "spaces" }, signal);
          const titles = await groupTitles(bot, signal);
          const spaces = spaceOrder(result.spaces.filter(row => row.state === "ready" && row.generation))
            .map(row => ({ space: row.space, generation: row.generation!, title: titles.space(row.space) }));
          const view: SearchView = { id: opaqueKey(), session: session.label, mode, createdAt: now(), codes: new MemberCodes(), names: new Map(),
            kind: "search", spaces, members: new Map(), byKey: new Map() };
          views.add(view);
          return { view: viewInfo(view), spaces: spaces.length } satisfies GlobalSearchViewResponse;
        } catch (error) { throw problemOf(error); }
      },
    },

    "POST /api/search": {
      slow: true,
      async run(context) {
        const body = record(context.body);
        const view = views.get(context.session.label, body.view, "search");
        const text = typeof body.text === "string" ? body.text : input("搜索内容应为文字");
        const filters = searchFilters(body);
        const cursor = body.cursor === null || body.cursor === undefined ? null : record(body.cursor);
        const index = cursor ? int(cursor.space, "cursor.space") : 0, entry = cursor ? optionalInt(cursor.entry, "cursor.entry") : null;
        const phones = () => [...view.members.values()].flatMap(members => [...members.values()].map(member => member.phone));
        try {
          if (!cursor) audit.write({ action: "search", session: context.session.label, scope: "全部空间", mode: view.mode });
          const target = view.spaces[index];
          if (!target) return { hits: [], scanned: 0, next: null, terms: [], title: "", skipped: [] } satisfies GlobalSearchResponse;
          const following = index + 1 < view.spaces.length ? { space: index + 1, entry: null } : null;
          let result: BotSearch;
          try {
            result = await bot.read<BotSearch>({ op: "search", space: target.space, generation: target.generation, conversation: null, text,
              cursor: entry, upper: null, ...filters }, context.signal);
          } catch (error) {
            // A space replaced or removed since the search began is left out; the search goes on with the next one.
            if (error instanceof BotReadError && (error.code === "SpaceChanged" || error.code === "SpaceAbsent")) {
              const reason = error.code === "SpaceChanged" ? "会话库已更换" : "空间已不存在";
              return { hits: [], scanned: 0, next: following, terms: [], title: target.title, skipped: [{ title: target.title, reason }] } satisfies GlobalSearchResponse;
            }
            throw error;
          }
          const members = await searchMembers(view, target, result.hits.map(hit => hit.conversationId), context.signal);
          const hits = result.hits.map((hit): GlobalSearchHit => {
            const member = members.get(hit.conversationId);
            return { id: hit.id, space: target.space, title: target.title, kind: hit.kind, at: hit.at, snippet: hit.snippet,
              member: member ? identityOf(view.mode, member.key, member.phone, view.names.get(member.phone), member.code) : null };
          });
          return { hits, scanned: result.scanned, next: result.next !== null ? { space: index, entry: result.next } : following,
            terms: result.terms, title: target.title, skipped: [] } satisfies GlobalSearchResponse;
        } catch (error) {
          throw problemOf(error, cleanFor({ mode: view.mode, phones }));
        }
      },
    },
  };

  /**
   * The members of a space a search view needs for these conversations: the space's member list is read the first time
   * (up to the view limit), names are looked up for the members hits name and the view has no name for yet.
   */
  async function searchMembers(view: SearchView, target: SearchView["spaces"][number], conversations: number[], signal: AbortSignal) {
    let members = view.members.get(target.space);
    if (!members && conversations.length) {
      const { items } = await readMembers(target, 0, MAX_VIEW_MEMBERS, signal);
      members = new Map();
      for (const info of items) {
        const member: SearchMember = { key: opaqueKey(), phone: info.phone };
        if (view.mode === "anonymous") member.code = view.codes.next();
        members.set(info.conversationId, member);
        view.byKey.set(member.key, { space: target.space, generation: target.generation, conversation: info.conversationId });
      }
      view.members.set(target.space, members);
    }
    if (!members) return new Map<number, SearchMember>();
    const known = members;
    if (view.mode !== "anonymous") {
      // A lookup that failed (or found the bot offline) is tried again when a later hit names the member.
      const settled = (phone: string) => { const state = view.names.get(phone)?.state; return state !== undefined && state !== "offline" && state !== "failed"; };
      const unnamed = [...new Set(conversations.flatMap(id => { const phone = known.get(id)?.phone; return phone && !settled(phone) ? [phone] : []; }))];
      if (unnamed.length) for (const [phone, name] of (await lookupNames(bot, unnamed, signal)).names) view.names.set(phone, name);
    }
    return known;
  }
}

type BotSearch = { hits: { id: number; conversationId: number; kind: string; at: number | null; snippet: string }[]; scanned: number; next: number | null; terms: string[] };
