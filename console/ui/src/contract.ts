// JSON shapes exchanged between the console host and the page. Types only: the host imports this file with
// `import type`, so nothing here may need DOM, Node or Bun.

export interface SessionView {
  /** Not secret: names this login in the audit records. */
  label: string;
  createdAt: number;
  /** The session ends here unless a user action renews it. */
  idleExpiresAt: number;
  /** Absolute end of the session, whatever the activity. */
  expiresAt: number;
}

export interface SessionResponse { session: SessionView; now: number }

export interface ReadPage { checkedAt: number; columns: string[]; rows: string[][]; note: string }

export interface ConsoleInfo {
  version: string;
  build: string;
  hostname: string;
  platform: "windows" | "linux" | "macos";
  port: number;
  pid: number;
  startedAt: number;
}

export type ServiceState = "ready" | "verifying" | "stopping" | "unreachable";

export interface ServiceView {
  state: ServiceState;
  pid?: number;
  latency?: number;
  startedAt?: number;
  stream?: { connected: boolean; reconnects: number; disconnectedSince?: number; lastDisconnectReason?: string };
  /**
   * scope: the saved scope; state: whether it is in effect (applying: the previous list still is; failed: the same, retried
   * automatically; unset: no scope is saved and nothing syncs), stateText says which and when; failure: the last routine sync
   * that did not complete; recheck: members missing in large numbers, rechecked before they are revoked.
   */
  directory?: { mappings: number; lastCompleteAt?: number; running?: string; scope: string; state: "applying" | "effective" | "failed" | "unset"; stateText: string;
    failure?: string; recheck?: string };
  attention: { kind: string; recent: boolean; text: string }[];
}

export interface DeploymentView {
  platform: "windows" | "linux" | "macos";
  runtime: "scheduled-task" | "docker" | "launchd";
  mode: string;
  port: number;
  dataRoot: string;
  workspaceRoot: string;
}

export interface Overview {
  checkedAt: number;
  console: ConsoleInfo;
  deployment: DeploymentView | null;
  deploymentError: string | null;
  /** Set when only continue/rollback/diagnose is possible (recovery view or CLI). */
  recovery: string | null;
  pending: { subject: string; record: string[] } | null;
  service: ServiceView;
  versions: [string, string][];
}

export type ApiErrorCode = "session" | "guard" | "input" | "internal" | "not-found" | "version-changed"
  /** The bot is not running (or not the recorded instance): live conversations are unavailable. */
  | "bot-offline"
  /** The space's database was replaced since the view opened; open the space again. */
  | "space-changed" | "space-absent"
  /** The view is gone (closed, evicted, or the console restarted); open it again. */
  | "view-gone"
  | "busy" | "too-large" | "timeout" | "bot-error"
  /** The audit record could not be written, so the action was not performed. */
  | "audit";

export interface ApiError { error: string; code?: ApiErrorCode }

// ─── Identity ──────────────────────────────────────────────────────────────

/** Chosen for one view or one export; it never becomes the default. */
export type IdentityMode = "default" | "full" | "anonymous";

/**
 * named: the current directory cache has this number; missing: it does not (no reason is inferred); summary: the identity
 * is a digest, there is no number to look up; offline: the bot is not running; failed: the lookup failed or is unavailable.
 */
export type NameState = "named" | "missing" | "summary" | "offline" | "failed";

/** A member as the chosen mode allows the page to see it; built by the console host, never masked in the page. */
export interface Identity {
  /** Opaque and random within its view; never derived from the number. Use it as the DOM key and in requests. */
  key: string;
  /** Display text: 张三（138****1234）, 138****1234, or 成员 A3 in anonymous mode. */
  label: string;
  /** Masked (default), complete (full), absent (anonymous). */
  phone?: string;
  /** Only when the directory has it and the mode is not anonymous. */
  name?: string;
  /** Absent in anonymous mode. */
  nameState?: NameState;
  /** Why there is no name, when there is none (absent in anonymous mode). */
  nameNote?: string;
  /** When the name lookup ran: the name is the directory's name at that time, not at the time of the conversation. */
  nameObservedAt?: number;
}

/** How the batch name lookup of a response went; failures never fail the response itself. */
export interface NamesStatus { state: "ok" | "partial" | "failed" | "offline" | "skipped"; observedAt?: number; note?: string }

// ─── Conversations ─────────────────────────────────────────────────────────

export interface SpaceSummary {
  /** Storage path: `direct` or `groups/<segment>`. */
  space: string;
  title: string;
  state: "ready" | "empty" | "unreadable";
  generation?: string;
  members?: number;
  lastEntry?: number | null;
  lastAt?: number | null;
  error?: string;
}

export interface SpacesResponse { spaces: SpaceSummary[]; observedAt: number }

export interface MemberRow {
  identity: Identity;
  createdAt: number | null;
  /** Mutable: read at `observedAt` of the view. */
  lastAt: number | null;
  lastEntry: number | null;
}

export interface ViewInfo {
  id: string;
  kind: "space" | "stats" | "search";
  mode: IdentityMode;
  createdAt: number;
}

/** A space view's member list read again: the newest activity, and members who joined since the view opened. */
export interface MembersResponse {
  members: MemberRow[];
  /** Members added to the view by this read. */
  added: number;
  truncated: boolean;
  observedAt: number;
}

export interface SpaceViewResponse {
  view: ViewInfo;
  space: SpaceSummary;
  members: MemberRow[];
  /** More members than one view loads; the rest are not listed. */
  truncated: boolean;
  names: NamesStatus;
  observedAt: number;
  /** The new key of the member named in the request's `keep` (the same member in the view this one replaces). */
  kept?: string;
}

export type EntryPart =
  | { type: "text"; text: string; truncated?: number }
  | { type: "thinking"; text: string; redacted?: boolean; truncated?: number }
  | { type: "image"; mimeType: string; bytes: number }
  | { type: "toolCall"; callId: string; name: string; arguments: string; truncated?: number; invalid?: string };

export interface EntryUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number | null }

export interface EntryView {
  id: number;
  kind: string;
  at: number | null;
  chars: number;
  /** A reset (`/clear`, head = itself) or a compaction (head = first kept entry) starts a new active context here. */
  head?: number;
  role?: "user" | "assistant" | "toolResult" | "system";
  parts: EntryPart[];
  assistant?: { provider: string; model: string; stopReason: string; error?: string; durationMs?: number; usage: EntryUsage | null };
  tool?: { callId: string; name: string; isError: boolean; durationMs?: number; nested?: number };
  system?: { chars: number; sections: string[]; toolsAdded: string[]; toolsRemoved: string[] };
  data?: unknown;
}

export interface EntryPage { items: EntryView[]; next: number | null }

export interface Boundary { id: number; head: number; kind: string; at: number | null }

export interface RequestView {
  requestId: string; createdAt: number | null; closedAt: number | null; cancelled: boolean;
  summary: string; receivedAt: number | null; sentAt: number | null;
  entry: number | null; answer: number | null; status: string | null;
  /**
   * Part states: pending, sending, sent (the platform accepted it; nothing says it was read), uncertain, failed (retried
   * at `retryAt`; final without it). abandonedReason: withdrawn (a /stop or /clear) or expired (the window passed).
   */
  delivery: { kind: string; abandoned: boolean; abandonedReason?: string;
    parts: { id: string; kind: string; state: string; attempts: number; retryAt?: number; error?: string; at?: number }[] } | null;
  files: { name: string; state: string; size: number; mode: string; error?: string }[];
  deliverables: { name: string; status: string; size: number; complete: boolean }[];
}

/** Run records still kept (closed ones are pruned after a day); mutable, read at `observedAt`. */
export interface RequestsResponse { items: RequestView[]; total: number; observedAt: number }

export interface SearchHitView {
  id: number;
  /** The member's key in this view; null for a conversation the view has not loaded. */
  member: string | null;
  kind: string;
  at: number | null;
  snippet: string;
}

/** One person on the push settings list (masked number); `key` names them within this read only. */
/** A pusher's grants: everyone, registered groups, and departments (none, any, or these department keys, each with its sub-departments). */
export interface PushGrantsView { all: boolean; group: boolean; department: "none" | "any" | string[] }
export interface PushRoleView {
  key: string; name: string | null; phone: string; admin: boolean; pusher: boolean; dailyLimit: number | null; grants: PushGrantsView; updatedAt: number;
}
/** A department of the synced address book by key; `gone`: named by a grant but no longer synced. */
export interface PushDepartmentView { key: string; path: string; gone?: true }
export interface PushSettingsResponse { view: string; departments: PushDepartmentView[]; roles: PushRoleView[] }

/**
 * A group chat the bot has been @ in, by key within this read: `seen` until an admin registers it, then pushable by name
 * until disabled. `registeredBy`: name and masked phone, 控制台, or null.
 */
export interface PushChatGroupView {
  key: string; name: string | null; state: "seen" | "registered" | "disabled";
  firstSeenAt: number; lastSeenAt: number; registeredAt: number | null; registeredBy: string | null;
}
/** `steps`: how a group gets registered, for the page to show. */
export interface PushChatGroupsResponse { view: string; groups: PushChatGroupView[]; steps: string }

/** The push page's list filter: waiting for 确认推送, out, closed, never sent (cancelled or expired). */
export type PushGroupKey = "preview" | "live" | "closed" | "void";
export type PushState = "preview" | "sending" | "open" | "closed" | "cancelled" | "expired";
export interface PushListItemView {
  id: string; subject: string; mode: "ack" | "options" | "reply"; state: PushState;
  /** Name and masked phone. */
  pusher: string;
  createdAt: number; confirmedAt: number | null; deadline: number; closedAt: number | null; closeReason: "deadline" | "complete" | null;
  summaryState: "pending" | "sent" | "failed" | null;
  /** This push reminds the people of push `of`; `followUp`: the push its summary's 「提醒未回复」 prepared. */
  of: string | null; followUp: string | null;
  /** `groups`: how many of `total` are group chats (one row each). */
  counts: { total: number; groups: number; delivered: number; failed: number; answered: number; replying: number };
}
/**
 * Totals over the pushes the bot keeps: `sent` went out (`followUps` of them 补推送, `live` not closed yet); over the
 * closed ones, `delivered` recipients (a person or a group each), `acked` of them confirmed (「已收到」, a choice or
 * 「回复」), and of the pushes asking for a reply `replied` of `replyDelivered`.
 */
export interface PushTotalsView { sent: number; followUps: number; live: number; delivered: number; acked: number; replyDelivered: number; replied: number }
export interface PushListResponse { pushes: PushListItemView[]; more: boolean; totals: PushTotalsView }
/** A person of a push view by key: name and masked phone. */
export interface PushPersonView { key: string; name: string; phone: string }
/**
 * One recipient: a person, or (`group`) a group chat by name with phone "群". In a group `ackedAt` is the first 「已收到」
 * and `clicks` counts them all; `senders` names who wrote the group's reply.
 */
export interface PushRecipientView extends PushPersonView {
  group: boolean;
  sendState: "pending" | "sending" | "sent" | "uncertain" | "failed"; sendError: string | null; sentAt: number | null;
  ackedAt: number | null; clicks: number; choice: string | null; choiceAt: number | null; replyState: "none" | "replying" | "submitted"; submittedAt: number | null;
  answered: boolean;
  reply: { text: string; files: { name: string; size: number | null; kind: string }[]; senders: string[] } | null;
  drafting: { texts: number; files: number } | null;
}
export interface PushDetailView extends PushListItemView {
  body: string; options: string[]; defaultDeadline: boolean;
  /** What the pusher asked for, one line each (everyone, departments, people). */
  target: string[];
  cc: PushPersonView[]; summaryError: string | null; summaryAt: number | null;
}
export interface PushDetailResponse { view: string; push: PushDetailView; recipients: PushRecipientView[] }
export interface PushTicket { url: string; filename: string; expiresAt: number }

/** Parts of a history a search looks in: member messages, answers, thinking, tool calls and output, summaries, push notes. */
export type SearchKind = "question" | "answer" | "thinking" | "tool" | "summary" | "push";

/** What both searches accept besides the text: all parts and any time when absent; times in ms, `to` exclusive. */
export interface SearchFilters { kinds?: SearchKind[] | null; from?: number | null; to?: number | null }

/** `terms`: the words the search looked for (lower-cased; a quoted phrase is one), for highlighting. */
export interface SearchResponse { hits: SearchHitView[]; scanned: number; next: number | null; terms: string[] }

/** A search over every space: the view pins the spaces it reads, in the order of the space list. */
export interface GlobalSearchViewResponse { view: ViewInfo; spaces: number }

/** Where a search over every space goes on: a space of the view and an entry cursor in it. */
export interface GlobalSearchCursor { space: number; entry: number | null }

export interface GlobalSearchHit {
  id: number;
  space: string;
  title: string;
  /** The member as the view's mode shows them, keyed within this view; null for a conversation without a member record. */
  member: Identity | null;
  kind: string;
  at: number | null;
  snippet: string;
}

export interface GlobalSearchResponse {
  hits: GlobalSearchHit[];
  scanned: number;
  next: GlobalSearchCursor | null;
  terms: string[];
  /** The space this block read. */
  title: string;
  /** Spaces left out by this block: replaced or removed since the search began. */
  skipped: { title: string; reason: string }[];
}

// ─── Statistics ────────────────────────────────────────────────────────────

export type StatsPeriodKey = "all" | "today" | "yesterday" | "week" | "last-week" | "month" | "last-month" | "7d" | "30d" | "custom";
export type StatsGrain = "day" | "week" | "month";

export interface StatsTokens { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }

export interface StatsGroupRow {
  /** Ledger source: `direct` or the group's storage segment. */
  group: string;
  title: string;
  asks: number;
  people: number;
  activeDays: number;
  tokens: StatsTokens;
  firstAt: number | null;
  lastAt: number | null;
}

export interface StatsRankRow { identity: Identity; asks: number; activeDays: number; groups: number }

export interface StatsMemberRow { identity: Identity; asks: number; activeDays: number; firstAt: number; lastAt: number }

export interface StatsComparison { label: string; window: string; asks: number; people: number; average: number }

export interface StatsResponse {
  window: { label: string; since: number | null; until: number | null; period: StatsPeriodKey };
  /** The group filter, when one is selected. */
  group: string | null;
  /** Selected member in this view's identity mode; null means all members. */
  member: Identity | null;
  observedAt: number;
  names: NamesStatus;
  summary: { asks: number; people: number; average: number; activeDays: number; days: number; dailyAverage: number; activeRate: number;
    peak: { date: string; asks: number } | null; topFiveShare: number; tokens: StatsTokens };
  comparisons: StatsComparison[];
  trend: { date: string; asks: number; people: number; tokens: number }[];
  grain: StatsGrain;
  groups: StatsGroupRow[];
  ranking: StatsRankRow[];
  /** Members of the selected group. */
  members: StatsMemberRow[] | null;
  models: { key: string; tokens: StatsTokens }[];
  tools: { key: string; tokens: StatsTokens }[];
  notes: { stats: string; tokens: string; identity: string };
}

// ─── Exports ───────────────────────────────────────────────────────────────

export type ExportFormat = "json" | "markdown" | "html" | "csv";

/** Days are local YYYY-MM-DD; either end may be left open. The mode is chosen for this export only. */
export type ExportRequest =
  | { type: "conversation"; view: string; member: string | null; format: "json" | "markdown"; mode: IdentityMode; confirm?: boolean;
    since?: string; until?: string }
  | { type: "stats"; format: "html" | "csv"; mode: IdentityMode; confirm?: boolean; period: StatsPeriodKey; since?: string; until?: string;
    group?: string | null; view?: string; member?: string | null };

/** A one-time download link for this login, valid for a minute. */
export interface ExportTicket { id: string; url: string; filename: string; expiresAt: number }

export type ExportState = "ready" | "running" | "sent" | "interrupted" | "failed" | "expired";

export interface ExportStatus { id: string; state: ExportState; filename: string; rows: number; bytes: number; error?: string }
