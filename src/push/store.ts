// Push records in the state database (data/state/agent.sqlite, src/core/state.ts): who may push, the groups the bot has
// seen and their registered names, the pushes, their recipients, the replies they collect and the conversation notes still
// to be written. Synchronous reads and writes on
// the service's main thread (bun:sqlite), like the identity directory: the inbound router decides from them while it
// handles an event, before its first await, so a member's messages keep their arrival order.
//
// Tables are created on open (`CREATE TABLE IF NOT EXISTS`); nothing here migrates. The address book copy elsewhere in
// the database is as sensitive as these rows: logs name counts and push IDs, never phones, names or reply text.
import type { Database, SQLQueryBindings } from "bun:sqlite";

export type PushMode = "ack" | "options" | "reply";
/**
 * preview: waiting for 「确认推送」 on the pusher's card. cancelled / expired: never sent. sending: cards going out (clicks
 * are already taken). open: every card has a final send state. closed: deadline passed or everyone answered.
 */
export type PushState = "preview" | "cancelled" | "expired" | "sending" | "open" | "closed";
/** As for delivery parts: uncertain counts as sent and is never resent (the platform does not deduplicate). */
export type SendState = "pending" | "sending" | "sent" | "failed" | "uncertain";
export type ReplyState = "none" | "replying" | "submitted";
export type SummaryState = "pending" | "sent" | "failed";

/** Beyond individuals, which a pusher may always reach. */
export type Grants = {
  /** Departments by ID (each with its sub-departments), or any department of the sync scope. */
  department?: { any: true } | { departments: string[] };
  all?: true;
  group?: true;
};

export type PushRole = {
  phone: string;
  admin: boolean;
  pusher: boolean;
  grants: Grants;
  /** Pushes confirmed within 24 hours; null: no limit. */
  dailyLimit: number | null;
  updatedAt: number;
};

export type Person = { phone: string; name: string };

/** A department the push goes to, as the pusher named it; `children`: with its sub-departments. */
export type TargetDepartment = { id: string; path: string; children: boolean };

/** A registered group the push goes to, with its name when the push was prepared. */
export type TargetGroup = { id: string; name: string };

/**
 * What the pusher asked for, as the preview card shows it: people by name and phone, departments, everyone in the sync scope,
 * registered groups. The recipient rows are the list it expands to, again at 「确认推送」 (the address book and the group
 * registrations of that moment). `of`: this push reminds the recipients of push `of` who did not answer (the 「提醒未回复」
 * button on its summary).
 */
export type PushTarget = { people: Person[]; departments: TargetDepartment[]; everyone: boolean; groups?: TargetGroup[]; of?: string };

/** A group's recipient row: one per group, answered by anyone in it (`member` is `group:<group ID>`). */
export const groupMember = (groupId: string) => `group:${groupId}`;
/** The group of a group's recipient row; undefined for a person. */
export const memberGroup = (member: string) => member.startsWith("group:") ? member.slice("group:".length) : undefined;

/**
 * seen: someone @-mentioned the bot there (the platform names groups only so). registered: an admin gave it a name (in the
 * group with /登记群, or in the console); only registered groups take pushes. disabled: takes no pushes, keeps its name.
 */
export type GroupState = "seen" | "registered" | "disabled";
export type ChatGroup = {
  id: string;
  name: string | null;
  state: GroupState;
  firstSeenAt: number;
  lastSeenAt: number;
  registeredAt: number | null;
  /** The admin's phone; null when named in the console. */
  registeredBy: string | null;
};

export type Push = {
  id: string;
  pusher: string;
  pusherName: string;
  /** The pusher's platform user ID when the push was prepared: where the preview, receipts and summary go. */
  pusherIm: string;
  subject: string;
  body: string;
  mode: PushMode;
  options: string[];
  deadline: number;
  /** The deadline was not given: the default applied. */
  defaultDeadline: boolean;
  target: PushTarget;
  cc: Person[];
  state: PushState;
  createdAt: number;
  confirmedAt: number | null;
  closedAt: number | null;
  closeReason: "deadline" | "complete" | null;
  /** The preview card's ID (from a click on it) and version. */
  previewCard: string | null;
  previewVersion: number;
  summaryState: SummaryState | null;
  summaryAttempts: number;
  summaryAt: number | null;
  summaryError: string | null;
  /** Phones the summary went to, and `<phone>|<step>` for what went out of one still unfinished (a retry skips them). */
  summaryDone: string[];
  /** The summary as the pusher's card shows it (lines), once made. */
  summaryText: string | null;
  /** The pusher's summary card's ID (from a click on it) and version. */
  summaryCard: string | null;
  summaryVersion: number;
  /** The push its summary's 「提醒未回复」 prepared. */
  followUp: string | null;
  /** Reply attachments were released (after the summary went out). */
  released: boolean;
};

export type Recipient = {
  pushId: string;
  /** The member's phone, or `group:<group ID>` for a group (groupMember). */
  member: string;
  name: string;
  /** Where the card goes: the member's platform user ID, or the group ID. */
  receiveId: string;
  sendState: SendState;
  sendAttempts: number;
  sendError: string | null;
  sentAt: number | null;
  retryAt: number | null;
  /** The card's ID, known from the first click on it. */
  card: string | null;
  version: number;
  /** A person's first 「已收到」, or the first one in a group. */
  ackedAt: number | null;
  /** 「已收到」 clicks in a group (the clickers cannot be told apart); 0 for a person. */
  clicks: number;
  choice: number | null;
  choiceAt: number | null;
  replyState: ReplyState;
  /** Revision being collected while replying; 0 otherwise. */
  draft: number;
  /** Revision in effect (the last submitted one); 0: none yet. */
  submitted: number;
  submittedAt: number | null;
  /** The last reply content or reply state change. */
  activityAt: number | null;
  remindedAt: number | null;
  hintedAt: number | null;
};

/** `sent`: pushes that went out (`followUps` of them 补推送, `live` not closed); the rest is over the closed ones. */
export type PushTotals = { sent: number; followUps: number; live: number; delivered: number; acked: number; replyDelivered: number; replied: number };

export type ItemKind = "text" | "image" | "file" | "video";
export type ReplyItem = {
  id: number;
  pushId: string;
  member: string;
  revision: number;
  msgUid: string;
  kind: ItemKind;
  text: string | null;
  /** The held attachment in the member's records (src/durable/attachments.ts); null until registered. */
  attachment: string | null;
  name: string | null;
  size: number | null;
  /** Registration of the attachment failed or was interrupted. */
  error: string | null;
  receivedAt: number;
  /** The attachment's file, recorded when the push released its hold (the record is gone then; the console still downloads it). */
  path: string | null;
  /** Who sent a group's reply text: phone and name; null in a direct chat. */
  sender: string | null;
  senderName: string | null;
};

/** `scope`: the conversation's scope key (src/core/layout.ts scopeKey): `direct`, or `group:<ID>` for a member's group conversation. */
export type PushNote = { scope: string; requestId: string; phone: string; text: string; data: string; attempts: number; nextAt: number; createdAt: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_roles (
  phone TEXT PRIMARY KEY, admin INTEGER NOT NULL, pusher INTEGER NOT NULL, grants TEXT NOT NULL, daily_limit INTEGER,
  updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS chat_groups (
  group_id TEXT PRIMARY KEY, name TEXT UNIQUE, state TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  registered_at INTEGER, registered_by TEXT) STRICT;
CREATE TABLE IF NOT EXISTS pushes (
  id TEXT PRIMARY KEY, pusher TEXT NOT NULL, pusher_name TEXT NOT NULL, pusher_im TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, mode TEXT NOT NULL, options TEXT NOT NULL, deadline INTEGER NOT NULL, default_deadline INTEGER NOT NULL,
  target TEXT NOT NULL, cc TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER,
  closed_at INTEGER, close_reason TEXT, preview_card TEXT, preview_version INTEGER NOT NULL, summary_state TEXT,
  summary_attempts INTEGER NOT NULL, summary_at INTEGER, summary_error TEXT, summary_done TEXT NOT NULL, summary_text TEXT, summary_card TEXT,
  summary_version INTEGER NOT NULL, follow_up TEXT, released INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS pushes_by_pusher ON pushes (pusher, created_at);
CREATE INDEX IF NOT EXISTS pushes_by_state ON pushes (state);
CREATE TABLE IF NOT EXISTS push_recipients (
  push_id TEXT NOT NULL, member TEXT NOT NULL, name TEXT NOT NULL, receive_id TEXT NOT NULL, send_state TEXT NOT NULL,
  send_attempts INTEGER NOT NULL, send_error TEXT, sent_at INTEGER, retry_at INTEGER, card TEXT, version INTEGER NOT NULL,
  acked_at INTEGER, clicks INTEGER NOT NULL, choice INTEGER, choice_at INTEGER, reply_state TEXT NOT NULL, draft INTEGER NOT NULL,
  submitted INTEGER NOT NULL, submitted_at INTEGER, activity_at INTEGER, reminded_at INTEGER, hinted_at INTEGER,
  PRIMARY KEY (push_id, member)) STRICT;
CREATE INDEX IF NOT EXISTS push_recipients_by_member ON push_recipients (member, reply_state);
CREATE TABLE IF NOT EXISTS push_reply_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, push_id TEXT NOT NULL, member TEXT NOT NULL, revision INTEGER NOT NULL,
  msg_uid TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, text TEXT, attachment TEXT, name TEXT, size INTEGER, error TEXT,
  received_at INTEGER NOT NULL, path TEXT, sender TEXT, sender_name TEXT) STRICT;
CREATE INDEX IF NOT EXISTS push_reply_items_by_reply ON push_reply_items (push_id, member, revision);
CREATE TABLE IF NOT EXISTS push_notes (
  scope TEXT NOT NULL, phone TEXT NOT NULL, request_id TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (scope, phone, request_id)) STRICT;
`;

type Row = Record<string, string | number | null>;

const PUSH_COLUMNS = {
  id: "id", pusher: "pusher", pusherName: "pusher_name", pusherIm: "pusher_im", subject: "subject", body: "body", mode: "mode",
  options: "options", deadline: "deadline", defaultDeadline: "default_deadline", target: "target", cc: "cc", state: "state",
  createdAt: "created_at", confirmedAt: "confirmed_at", closedAt: "closed_at", closeReason: "close_reason", previewCard: "preview_card",
  previewVersion: "preview_version", summaryState: "summary_state", summaryAttempts: "summary_attempts", summaryAt: "summary_at",
  summaryError: "summary_error", summaryDone: "summary_done", summaryText: "summary_text", summaryCard: "summary_card", summaryVersion: "summary_version", followUp: "follow_up",
  released: "released",
} as const satisfies Record<keyof Push, string>;

const RECIPIENT_COLUMNS = {
  pushId: "push_id", member: "member", name: "name", receiveId: "receive_id", sendState: "send_state", sendAttempts: "send_attempts",
  sendError: "send_error", sentAt: "sent_at", retryAt: "retry_at", card: "card", version: "version", ackedAt: "acked_at", clicks: "clicks",
  choice: "choice", choiceAt: "choice_at", replyState: "reply_state", draft: "draft", submitted: "submitted",
  submittedAt: "submitted_at", activityAt: "activity_at", remindedAt: "reminded_at", hintedAt: "hinted_at",
} as const satisfies Record<keyof Recipient, string>;

const JSON_PUSH_FIELDS = new Set<keyof Push>(["options", "target", "cc", "summaryDone"]);
const BOOLEAN_PUSH_FIELDS = new Set<keyof Push>(["defaultDeadline", "released"]);

function encodePush<K extends keyof Push>(key: K, value: Push[K]): string | number | null {
  if (JSON_PUSH_FIELDS.has(key)) return JSON.stringify(value);
  if (BOOLEAN_PUSH_FIELDS.has(key)) return value ? 1 : 0;
  return value as string | number | null;
}

function decodePush(row: Row): Push {
  const push = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(PUSH_COLUMNS) as [keyof Push, string][]) {
    const value = row[column];
    push[key] = JSON_PUSH_FIELDS.has(key) ? JSON.parse(String(value)) : BOOLEAN_PUSH_FIELDS.has(key) ? value === 1 : value;
  }
  return push as Push;
}

function decodeRecipient(row: Row): Recipient {
  const recipient = {} as Record<string, unknown>;
  for (const [key, column] of Object.entries(RECIPIENT_COLUMNS)) recipient[key] = row[column];
  return recipient as Recipient;
}

const ITEM_SELECT = `SELECT id, push_id AS pushId, member, revision, msg_uid AS msgUid, kind, text, attachment, name, size, error,
  received_at AS receivedAt, path, sender, sender_name AS senderName FROM push_reply_items`;
const GROUP_SELECT = `SELECT group_id AS id, name, state, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, registered_at AS registeredAt,
  registered_by AS registeredBy FROM chat_groups`;

/** A push's recipient rows, counted: `groups` of them are groups, `delivered` were reached and `answered` of those answered, `unsettled` have a send still to come. */
export type RecipientCounts = { total: number; groups: number; delivered: number; failed: number; answered: number; replying: number; unsettled: number };

/** States in which a push still takes clicks and replies. */
export const LIVE_STATES: readonly PushState[] = ["sending", "open"];

export class PushStore {
  constructor(readonly db: Database) {
    db.exec(SCHEMA);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  // ---- roles ----------------------------------------------------------------------------------------------------------

  roles(): PushRole[] {
    return (this.db.query("SELECT * FROM push_roles ORDER BY phone").all() as Row[]).map(roleOf);
  }

  role(phone: string): PushRole | undefined {
    const row = this.db.query("SELECT * FROM push_roles WHERE phone = ?").get(phone) as Row | null;
    return row ? roleOf(row) : undefined;
  }

  /** Replace the whole list; people with neither role are left out. */
  replaceRoles(roles: readonly Omit<PushRole, "updatedAt">[], now: number): void {
    this.transaction(() => {
      const before = new Map(this.roles().map(role => [role.phone, role]));
      this.db.query("DELETE FROM push_roles").run();
      const insert = this.db.query("INSERT INTO push_roles (phone, admin, pusher, grants, daily_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const role of roles) {
        if (!role.admin && !role.pusher) continue;
        const previous = before.get(role.phone);
        const same = previous && previous.admin === role.admin && previous.pusher === role.pusher && previous.dailyLimit === role.dailyLimit
          && JSON.stringify(previous.grants) === JSON.stringify(role.grants);
        insert.run(role.phone, role.admin ? 1 : 0, role.pusher ? 1 : 0, JSON.stringify(role.grants), role.dailyLimit, same ? previous.updatedAt : now);
      }
    });
  }

  // ---- groups ---------------------------------------------------------------------------------------------------------

  /** Someone in the group @-mentioned the bot: a new group is `seen`; a known one's time moves on at most every `every` ms. */
  groupSeen(id: string, at: number, every: number): void {
    this.db.query(`INSERT INTO chat_groups (group_id, name, state, first_seen_at, last_seen_at) VALUES (?, NULL, 'seen', ?, ?)
      ON CONFLICT (group_id) DO UPDATE SET last_seen_at = excluded.last_seen_at WHERE excluded.last_seen_at - chat_groups.last_seen_at >= ?`).run(id, at, at, every);
  }

  group(id: string): ChatGroup | undefined {
    return (this.db.query(`${GROUP_SELECT} WHERE group_id = ?`).get(id) as ChatGroup | null) ?? undefined;
  }

  /** Registered, then disabled, then seen; most recently seen first in each. */
  groups(): ChatGroup[] {
    return this.db.query(`${GROUP_SELECT} ORDER BY CASE state WHEN 'registered' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END, last_seen_at DESC`).all() as ChatGroup[];
  }

  /** Name, register or disable a group that was seen; the caller checked the name is free. */
  saveGroup(id: string, change: Pick<ChatGroup, "name" | "state" | "registeredAt" | "registeredBy">): void {
    this.db.query("UPDATE chat_groups SET name = ?, state = ?, registered_at = ?, registered_by = ? WHERE group_id = ?")
      .run(change.name, change.state, change.registeredAt, change.registeredBy, id);
  }

  // ---- pushes ---------------------------------------------------------------------------------------------------------

  /** A new push in `preview` with its recipients, in one transaction. */
  create(push: Push, recipients: readonly Recipient[]): void {
    this.transaction(() => {
      const keys = Object.keys(PUSH_COLUMNS) as (keyof Push)[];
      this.db.query(`INSERT INTO pushes (${keys.map(key => PUSH_COLUMNS[key]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map(key => encodePush(key, push[key])));
      const columns = Object.keys(RECIPIENT_COLUMNS) as (keyof Recipient)[];
      const insert = this.db.query(`INSERT INTO push_recipients (${columns.map(key => RECIPIENT_COLUMNS[key]).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      for (const recipient of recipients) insert.run(...columns.map(key => recipient[key]));
    });
  }

  push(id: string): Push | undefined {
    const row = this.db.query("SELECT * FROM pushes WHERE id = ?").get(id) as Row | null;
    return row ? decodePush(row) : undefined;
  }

  exists(id: string): boolean {
    return this.db.query("SELECT 1 FROM pushes WHERE id = ?").get(id) !== null;
  }

  /** The pusher's pushes, newest first. */
  pushesOf(pusher: string, limit: number): Push[] {
    return (this.db.query("SELECT * FROM pushes WHERE pusher = ? AND state NOT IN ('cancelled', 'expired') ORDER BY created_at DESC LIMIT ?")
      .all(pusher, limit) as Row[]).map(decodePush);
  }

  pushesIn(states: readonly PushState[]): Push[] {
    return (this.db.query(`SELECT * FROM pushes WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at`)
      .all(...states) as Row[]).map(decodePush);
  }

  /** The console's list: newest first, before a creation time, optionally only some states. */
  page(states: readonly PushState[] | null, before: number | null, limit: number): Push[] {
    const where = [...(states ? [`state IN (${states.map(() => "?").join(", ")})`] : []), ...(before === null ? [] : ["created_at < ?"])];
    return (this.db.query(`SELECT * FROM pushes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ?`)
      .all(...states ?? [], ...(before === null ? [] : [before]), limit) as Row[]).map(decodePush);
  }

  /**
   * The console's totals (plan section 9) over the pushes kept here: those that went out, and over the closed ones the
   * delivered recipients (a person or a group each) that confirmed (「已收到」, a choice, or 「回复」) and, of the pushes
   * asking for a reply, that replied. A push deleted in the console no longer counts.
   */
  totals(): PushTotals {
    const pushes = this.db.query(`SELECT count(*) AS sent, coalesce(sum(json_extract(target, '$.of') IS NOT NULL), 0) AS followUps,
      coalesce(sum(state != 'closed'), 0) AS live FROM pushes WHERE state IN ('sending', 'open', 'closed')`).get() as Pick<PushTotals, "sent" | "followUps" | "live">;
    const answers = this.db.query(`SELECT count(*) AS delivered, coalesce(sum(r.acked_at IS NOT NULL), 0) AS acked,
      coalesce(sum(p.mode = 'reply'), 0) AS replyDelivered, coalesce(sum(p.mode = 'reply' AND r.submitted > 0 AND r.reply_state != 'replying'), 0) AS replied
      FROM push_recipients r JOIN pushes p ON p.id = r.push_id WHERE p.state = 'closed' AND r.send_state IN ('sent', 'uncertain')`).get() as
      Omit<PushTotals, "sent" | "followUps" | "live">;
    return { ...pushes, ...answers };
  }

  /** Delete a push with its recipients and reply items (the console). */
  remove(id: string): void {
    this.transaction(() => {
      for (const table of ["push_reply_items", "push_recipients"]) this.db.query(`DELETE FROM ${table} WHERE push_id = ?`).run(id);
      this.db.query("DELETE FROM pushes WHERE id = ?").run(id);
    });
  }

  /** Pushes with a summary still to send. */
  summariesDue(): Push[] {
    return (this.db.query("SELECT * FROM pushes WHERE state = 'closed' AND summary_state = 'pending' ORDER BY closed_at").all() as Row[]).map(decodePush);
  }

  /** Closed pushes whose held attachments are still to release. */
  unreleased(): Push[] {
    return (this.db.query("SELECT * FROM pushes WHERE state = 'closed' AND summary_state IN ('sent', 'failed') AND released = 0").all() as Row[]).map(decodePush);
  }

  /** Pushes the pusher confirmed since `since` (the frequency limit). */
  confirmedSince(pusher: string, since: number): number {
    return (this.db.query("SELECT count(*) AS n FROM pushes WHERE pusher = ? AND confirmed_at >= ?").get(pusher, since) as { n: number }).n;
  }

  updatePush(id: string, change: Partial<Omit<Push, "id">>): void {
    const keys = Object.keys(change) as (keyof typeof change)[];
    if (!keys.length) return;
    this.db.query(`UPDATE pushes SET ${keys.map(key => `${PUSH_COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map(key => encodePush(key, change[key] as never)), id);
  }

  /** Change the push only while it is in `from`; true when it was. */
  movePush(id: string, from: readonly PushState[], change: Partial<Omit<Push, "id">>): boolean {
    return this.transaction(() => {
      const current = this.push(id);
      if (!current || !from.includes(current.state)) return false;
      this.updatePush(id, change);
      return true;
    });
  }

  // ---- recipients -----------------------------------------------------------------------------------------------------

  /** The counts of these pushes (a push without rows is absent), without decoding what can be 5000 rows each. */
  recipientCounts(pushIds: readonly string[]): Map<string, RecipientCounts> {
    if (!pushIds.length) return new Map();
    const rows = this.db.query(`SELECT r.push_id AS pushId, count(*) AS total, sum(r.member LIKE 'group:%') AS groups,
      sum(r.send_state IN ('sent', 'uncertain')) AS delivered, sum(r.send_state = 'failed') AS failed,
      sum(r.send_state IN ('sent', 'uncertain') AND CASE p.mode WHEN 'ack' THEN r.acked_at IS NOT NULL WHEN 'options' THEN r.choice IS NOT NULL
        ELSE r.submitted > 0 AND r.reply_state != 'replying' END) AS answered,
      sum(r.reply_state = 'replying') AS replying,
      sum(r.send_state IN ('pending', 'sending') OR (r.send_state = 'failed' AND r.retry_at IS NOT NULL)) AS unsettled
      FROM push_recipients r JOIN pushes p ON p.id = r.push_id WHERE r.push_id IN (${pushIds.map(() => "?").join(", ")}) GROUP BY r.push_id`)
      .all(...pushIds) as (RecipientCounts & { pushId: string })[];
    return new Map(rows.map(({ pushId, ...counts }) => [pushId, counts]));
  }

  recipients(pushId: string): Recipient[] {
    return (this.db.query("SELECT * FROM push_recipients WHERE push_id = ? ORDER BY rowid").all(pushId) as Row[]).map(decodeRecipient);
  }

  recipient(pushId: string, member: string): Recipient | undefined {
    const row = this.db.query("SELECT * FROM push_recipients WHERE push_id = ? AND member = ?").get(pushId, member) as Row | null;
    return row ? decodeRecipient(row) : undefined;
  }

  /** A preview's list again (as expanded at 「确认推送」); the caller holds the transaction that confirms it. */
  replaceRecipients(pushId: string, recipients: readonly Recipient[]): void {
    this.transaction(() => {
      this.db.query("DELETE FROM push_recipients WHERE push_id = ?").run(pushId);
      const columns = Object.keys(RECIPIENT_COLUMNS) as (keyof Recipient)[];
      const insert = this.db.query(`INSERT INTO push_recipients (${columns.map(key => RECIPIENT_COLUMNS[key]).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      for (const recipient of recipients) insert.run(...columns.map(key => recipient[key]));
    });
  }

  updateRecipient(pushId: string, member: string, change: Partial<Omit<Recipient, "pushId" | "member">>): void {
    const keys = Object.keys(change) as (keyof typeof change)[];
    if (!keys.length) return;
    this.db.query(`UPDATE push_recipients SET ${keys.map(key => `${RECIPIENT_COLUMNS[key]} = ?`).join(", ")} WHERE push_id = ? AND member = ?`)
      .run(...keys.map(key => change[key] as SQLQueryBindings), pushId, member);
  }

  /** A push's people replying with activity and not reminded yet (the idle reminder; groups get none). */
  unreminded(pushId: string): Recipient[] {
    return (this.db.query(`SELECT * FROM push_recipients WHERE push_id = ? AND reply_state = 'replying' AND reminded_at IS NULL
      AND activity_at IS NOT NULL AND member NOT LIKE 'group:%' ORDER BY rowid`).all(pushId) as Row[]).map(decodeRecipient);
  }

  /** The member's reply in progress, if any (at most one: starting another first ends this one). */
  replying(member: string): Recipient | undefined {
    const row = this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE r.member = ? AND r.reply_state = 'replying' AND p.state IN ('sending', 'open') ORDER BY r.activity_at DESC LIMIT 1`).get(member) as Row | null;
    return row ? decodeRecipient(row) : undefined;
  }

  /** The member's (or group's) rows in live pushes whose card reached them. */
  reached(member: string): Recipient[] {
    return (this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE r.member = ? AND p.state IN ('sending', 'open') AND r.send_state IN ('sent', 'uncertain') ORDER BY p.created_at`).all(member) as Row[]).map(decodeRecipient);
  }

  /** Live pushes that want a reply from the member and have none yet. */
  awaitingReply(member: string): Recipient[] {
    return (this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE r.member = ? AND p.mode = 'reply' AND p.state IN ('sending', 'open') AND r.submitted = 0 AND r.reply_state = 'none'
      AND r.send_state IN ('sent', 'uncertain') ORDER BY p.created_at`).all(member) as Row[]).map(decodeRecipient);
  }

  /** Recipients whose card is due to be sent (pending, or failed with a retry time reached). */
  sendsDue(now: number): Recipient[] {
    return (this.db.query(`SELECT r.* FROM push_recipients r JOIN pushes p ON p.id = r.push_id
      WHERE p.state IN ('sending', 'open') AND (r.send_state = 'pending' OR (r.send_state = 'failed' AND r.retry_at IS NOT NULL AND r.retry_at <= ?))
      ORDER BY p.created_at, r.rowid`).all(now) as Row[]).map(decodeRecipient);
  }

  /** At startup: sends an ended process left `sending` may have reached the platform. */
  settleInterruptedSends(): number {
    return this.db.query("UPDATE push_recipients SET send_state = 'uncertain', send_error = '发送过程中服务中断，结果未知' WHERE send_state = 'sending'").run().changes;
  }

  // ---- reply items ----------------------------------------------------------------------------------------------------

  /** The new item's ID; undefined when the message was recorded before (a redelivery). */
  addItem(item: Omit<ReplyItem, "id" | "path">): number | undefined {
    const result = this.db.query(`INSERT OR IGNORE INTO push_reply_items (push_id, member, revision, msg_uid, kind, text, attachment, name, size, error,
      received_at, sender, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.pushId, item.member, item.revision, item.msgUid, item.kind,
      item.text, item.attachment, item.name, item.size, item.error, item.receivedAt, item.sender, item.senderName);
    return result.changes ? Number(result.lastInsertRowid) : undefined;
  }

  hasItem(msgUid: string): boolean {
    return this.db.query("SELECT 1 FROM push_reply_items WHERE msg_uid = ?").get(msgUid) !== null;
  }

  updateItem(id: number, change: Partial<Pick<ReplyItem, "attachment" | "error" | "path">>): void {
    const keys = Object.keys(change) as ("attachment" | "error" | "path")[];
    if (!keys.length) return;
    this.db.query(`UPDATE push_reply_items SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map(key => change[key] ?? null), id);
  }

  items(pushId: string, member?: string, revision?: number): ReplyItem[] {
    if (member === undefined) return this.db.query(`${ITEM_SELECT} WHERE push_id = ? ORDER BY received_at, id`).all(pushId) as ReplyItem[];
    if (revision === undefined) return this.db.query(`${ITEM_SELECT} WHERE push_id = ? AND member = ? ORDER BY received_at, id`).all(pushId, member) as ReplyItem[];
    return this.db.query(`${ITEM_SELECT} WHERE push_id = ? AND member = ? AND revision = ? ORDER BY received_at, id`).all(pushId, member, revision) as ReplyItem[];
  }

  /** Attachment items whose registration did not finish (a process ended between the two steps). */
  unregistered(): ReplyItem[] {
    return this.db.query(`${ITEM_SELECT} WHERE kind != 'text' AND attachment IS NULL AND error IS NULL ORDER BY id`).all() as ReplyItem[];
  }

  // ---- conversation notes ---------------------------------------------------------------------------------------------

  /** Queue a note for one member's conversation; one with the same request ID there is kept as it was. */
  addNote(note: Pick<PushNote, "scope" | "requestId" | "phone" | "text" | "data">, now: number): void {
    this.db.query("INSERT OR IGNORE INTO push_notes (scope, phone, request_id, text, data, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run(note.scope, note.phone, note.requestId, note.text, note.data, now, now);
  }

  notesDue(now: number, limit: number): PushNote[] {
    return this.db.query(`SELECT scope, request_id AS requestId, phone, text, data, attempts, next_at AS nextAt, created_at AS createdAt FROM push_notes
      WHERE next_at <= ? ORDER BY created_at, rowid LIMIT ?`).all(now, limit) as PushNote[];
  }

  dropNote(note: Pick<PushNote, "scope" | "phone" | "requestId">): void {
    this.db.query("DELETE FROM push_notes WHERE scope = ? AND phone = ? AND request_id = ?").run(note.scope, note.phone, note.requestId);
  }

  deferNote(note: Pick<PushNote, "scope" | "phone" | "requestId">, nextAt: number): void {
    this.db.query("UPDATE push_notes SET attempts = attempts + 1, next_at = ? WHERE scope = ? AND phone = ? AND request_id = ?")
      .run(nextAt, note.scope, note.phone, note.requestId);
  }
}

function roleOf(row: Row): PushRole {
  return { phone: String(row.phone), admin: row.admin === 1, pusher: row.pusher === 1, grants: JSON.parse(String(row.grants)) as Grants,
    dailyLimit: row.daily_limit === null ? null : Number(row.daily_limit), updatedAt: Number(row.updated_at) };
}
