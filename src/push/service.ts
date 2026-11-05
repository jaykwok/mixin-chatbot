// Pushes (push-plan-20261103.md): a pusher asks the model, the model calls push_prepare (./tools.ts), the pusher confirms
// on a preview card, cards go to the recipients, and their clicks and replies are collected here without the model.
//
// Flow of one push:
// - prepare: the people are checked against the address book (in the sync scope, name and phone matching) and the
//   pusher's grants; the push is stored as `preview` and the preview card goes to the pusher's direct chat.
// - 「确认推送」 on the preview (only the pusher's click counts): `sending`; every recipient's card is sent (pending →
//   sending → sent | failed | uncertain; uncertain counts as sent and is never resent, failed is tried again twice).
//   Once no card is pending the push is `open`.
// - Clicks come back over the event stream with the card's ID; the first click gives the card's ID, after which the
//   service updates the card whenever the recipient's state changes (also on each reply message).
// - Replies (mode `reply`): 「回复」 starts a draft revision; while it is open the member's direct messages and attachments
//   are recorded into it (the inbound router asks `directText` / `directAttachment` first) instead of reaching the model;
//   「已回复」 or /完成 submits it, 「取消」 or /取消 drops it, 「修改回复」 starts a new revision. The last submitted
//   revision is the reply.
// - Deadline, or everyone answered: `closed`; an open draft with content is submitted; the summary (message and
//   package) goes to the pusher and the CCs; then the held reply attachments are released.
// - Conversation notes (section 7) go through an outbox in the state database into the members' conversations as passive
//   entries, so the model later knows what happened.
//
// Groups (section 5): the bot learns a group only when someone there @-mentions it (`groupText`, every group text the
// inbound router has); an admin names it with /登记群 (or the console does), and only registered groups take pushes. A
// group gets one card and one recipient row (`group:<ID>`), answered by anyone there: clicks cannot be traced to people,
// so 「已收到」 counts clicks, and options are refused. While the group replies, every text @-mentioning the bot is a
// reply item with its sender; group members' conversations learn of a live push the next time they @-mention the bot.
//
// All state is in the state database (./store.ts); what runs in the background (sends, card updates, notes, the summary)
// picks up from there after a restart.
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { canonicalCommand, isSlashCommandMessage } from "../agent/commands.ts";
import { SendNotConfirmed, transferFile } from "../agent/send-tools.ts";
import { DIRECT_SCOPE, groupScope, parseScopeKey, scopeKey, userTmp, type Layout, type Scope } from "../core/layout.ts";
import { log } from "../core/log.ts";
import { NATIVE_FILE_MAX_BYTES } from "../core/transfer-limits.ts";
import type { AttachmentEvent } from "../durable/attachments.ts";
import { type Outbound, sendNotice } from "../durable/outbound.ts";
import type { MemberRecords, ReplyContext } from "../durable/records.ts";
import { sendChannel } from "../durable/send.ts";
import type { AttachResult, InboundAttachment } from "../durable/service.ts";
import type { DepartmentTree } from "../integrations/open-platform/department-tree.ts";
import type { DirectoryIdentity } from "../integrations/open-platform/identity-directory.ts";
import { cardMessage, type CardContent, splitText, type Target, textMessage } from "../integrations/open-platform/messages.ts";
import type { StreamEvent } from "../integrations/open-platform/stream.ts";
import type { RelayConfig } from "../integrations/relay.ts";
import { PUSH_NOTE_KIND } from "./note.ts";
import { CARD_MAX_CHARS, clickData, type ClickData, countsText, type Counts, groupReplyText, phoneTail, previewCard, type Reach, reachText, recipientCard,
  requirementText, shortTime, summaryCard } from "./cards.ts";
import { buildSummary, effectiveItems, type HeldFile, maskPhone, replyText, senders, type SummaryPackage } from "./summary.ts";
import { type ChatGroup, type Grants, groupMember, LIVE_STATES, memberGroup, type Person, type Push, type PushMode, type PushRole, type PushState, type PushStore,
  type PushTarget, type PushTotals, type Recipient, type RecipientCounts, type ReplyItem, type TargetDepartment, type TargetGroup } from "./store.ts";

export const PUSH_LIMITS = {
  defaultDeadlineMs: 3 * 24 * 3600_000,
  maxDeadlineMs: 30 * 24 * 3600_000,
  minDeadlineMs: 10 * 60_000,
  /** A preview not confirmed within this is void. */
  previewMs: 24 * 3600_000,
  /** A reply with content left open this long gets one reminder to press 「已回复」. */
  idleReminderMs: 30 * 60_000,
  /** The "you have a push to reply to" notice: at most once per push and member within this. */
  hintMs: 12 * 3600_000,
  /** Card sends: attempts, and the waits before the second and third. */
  sendAttempts: 3,
  sendRetryMs: [60_000, 5 * 60_000] as readonly number[],
  summaryRetryMs: [60_000, 5 * 60_000, 30 * 60_000] as readonly number[],
  tickMs: 15_000,
  /** Cards sent at once (the message sender also limits the rate): a large push never queues ahead of other replies by more. */
  concurrency: 4,
  /** The preview card shows the sending progress at most this often (the end of sending always updates it). */
  progressMs: 5000,
  /** People named one by one, and everyone a push reaches once its departments and everyone are expanded. */
  people: 500,
  recipients: 5000,
  departments: 50,
  groups: 50,
  groupNameChars: 30,
  /** A known group's "last @-mentioned" time is written at most this often. */
  groupSeenMs: 10 * 60_000,
  cc: 10,
  subjectChars: 40,
  bodyChars: 3000,
  options: [2, 6] as readonly [number, number],
  optionChars: 10,
};
export type PushLimits = typeof PUSH_LIMITS;

/** What the push needs from the message service (src/durable/service.ts). */
export interface PushHost {
  attach(message: InboundAttachment): Promise<AttachResult>;
  records(scope: Scope, phone: string): Promise<Readonly<MemberRecords>>;
  releaseAttachments(scope: Scope, phone: string, holder: string, ids: readonly string[]): Promise<number>;
  note(scope: Scope, phone: string, requestId: string, entry: EntryDraft): Promise<void>;
}

export interface PushDirectory {
  lookup(imUserId: string): DirectoryIdentity | undefined;
  byPhone(phone: string): DirectoryIdentity | undefined;
  /** The synced department tree (department-tree.ts): department targets, everyone, department grants. */
  readonly departments: Pick<DepartmentTree, "updatedAt" | "get" | "all" | "find" | "within" | "members" | "everyone">;
}

export interface PushOptions {
  store: PushStore;
  directory: PushDirectory;
  outbound: Outbound;
  layout: Pick<Layout, "tmp">;
  relay: RelayConfig | null;
  signal: AbortSignal;
  limits?: Partial<PushLimits>;
  now?: () => number;
  /** Failures that do not fail the calling operation. Must not throw. */
  onReport?: (error: unknown) => void;
}

/** What push_prepare passes on (./tools.ts). */
export type PrepareInput = {
  recipients?: readonly { name: string; phone: string }[];
  /** By name or path; `children: false` leaves the sub-departments out. */
  departments?: readonly { name: string; children?: boolean }[];
  everyone?: boolean;
  /** Registered groups by name. */
  groups?: readonly { name: string }[];
  subject: string;
  body: string;
  mode: PushMode;
  options?: readonly string[];
  deadline?: string;
  cc?: readonly { name: string; phone: string }[];
};

/** A refusal the model passes on to the pusher. */
export class PushRefused extends Error { override name = "PushRefused"; }
/** The settings name people outside the synced address book; `phones` (at most 10) go back as a list, for the console to mask. */
export class PushSettingsRefused extends Error {
  override name = "PushSettingsRefused";
  constructor(message: string, readonly phones: readonly string[]) { super(message); }
}

/** The console's list filter: pushes waiting for 确认推送, out, closed, or never sent. */
export const PUSH_GROUPS = { preview: ["preview"], live: ["sending", "open"], closed: ["closed"], void: ["cancelled", "expired"] } as const satisfies
  Record<string, readonly PushState[]>;
export type PushGroup = keyof typeof PUSH_GROUPS;

/** Recipient rows; `groups` of them are groups. */
export type PushCounts = Omit<RecipientCounts, "unsettled">;
export type PushListItem = Pick<Push, "id" | "subject" | "mode" | "state" | "pusher" | "pusherName" | "createdAt" | "confirmedAt" | "deadline" | "closedAt"
  | "closeReason" | "summaryState" | "followUp"> & { of: string | null; counts: PushCounts };
export type PushRecipientDetail = Pick<Recipient, "member" | "name" | "sendState" | "sendError" | "sentAt" | "ackedAt" | "clicks" | "choiceAt" | "replyState"
  | "submittedAt"> & {
  choice: string | null;
  answered: boolean;
  /** The reply in effect: its text (at most 2000 characters here), attachments and, for a group, who sent it. */
  reply: { text: string; files: { name: string; size: number | null; kind: ReplyItem["kind"] }[]; senders: string[] } | null;
  /** What the open reply holds so far. */
  drafting: Counts | null;
};
export type PushDetail = { push: PushListItem & Pick<Push, "body" | "options" | "defaultDeadline" | "target" | "cc" | "summaryError" | "summaryAt">;
  recipients: PushRecipientDetail[] };

/** A group as the console lists it: who registered it by name (null: the console did, or nobody yet). */
export type PushGroupRow = ChatGroup & { registeredByName: string | null };

/** What the local control interface offers the console (src/server/http-app.ts `/_admin/push/*`). */
export type PushAdmin = Pick<PushService, "settings" | "saveSettings" | "list" | "detail" | "remind" | "setCc" | "remove" | "package" | "groups" | "saveGroup">;

export const holderOf = (pushId: string) => `push:${pushId}`;
const sameName = (a: string, b: string) => a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
const chars = (text: string) => [...text].length;
const truncate = (text: string, max: number) => chars(text) > max ? [...text].slice(0, max).join("") + "…" : text;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const NO_DEPARTMENT_GRANT = "你没有按部门推送的权限，请联系管理员在控制台授权";
const NO_GROUP_GRANT = "你没有推送到群的权限，请联系管理员在控制台授权";
/** How a group gets registered (the bot's refusals and the console say so). */
export const GROUP_STEPS = "登记方法：把机器人拉进群，推送管理员在群里发送“@机器人 /登记群 群名”；有人 @ 过机器人的群，也可以在控制台推送页的群名单里补群名";
const GROUP_ID = /^[0-9]{1,64}$/;
/** The console's packages, each in its own directory directly under data/tmp (`package`). */
const PACKAGE_DIR = "push-console-";

/** Who a push reaches: a person (by phone) or a group (`group:<ID>`), with the name and where the card goes. */
type Reached = { member: string; name: string; receiveId: string };
const personReached = (person: DirectoryIdentity): Reached => ({ member: person.phone, name: person.name, receiveId: person.imUserId });
const groupReached = (group: TargetGroup): Reached => ({ member: groupMember(group.id), name: group.name, receiveId: group.id });
const reachOf = (rows: readonly { member: string }[]): Reach => {
  const groups = rows.filter(row => memberGroup(row.member) !== undefined).length;
  return { people: rows.length - groups, groups };
};

/** `2026-11-07 18:00`, `2026-11-07T18:00`, or a date alone (the end of that day), in the service's time zone. */
export function parseDeadline(text: string): number | undefined {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(text);
  if (!match) return undefined;
  const [y, m, d, hh, mm] = [match[1], match[2], match[3], match[4], match[5]].map(part => part === undefined ? undefined : Number(part));
  const at = hh === undefined ? new Date(y!, m! - 1, d!, 23, 59) : new Date(y!, m! - 1, d!, hh, mm!);
  // A date that rolled over (02-30) is not what was meant.
  if (at.getFullYear() !== y || at.getMonth() !== m! - 1 || at.getDate() !== d || (hh !== undefined && (at.getHours() !== hh || at.getMinutes() !== mm))) return undefined;
  return at.getTime();
}

/** The role list a settings save carries (the console, through the local control interface). */
export function parseRoles(value: unknown): Omit<PushRole, "updatedAt">[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("名单必须是不超过 1000 项的数组");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const at = `第 ${index + 1} 项`;
    if (!item || typeof item.phone !== "string" || !/^[A-Za-z0-9_+\-]{1,32}$/.test(item.phone)) throw new Error(`${at}的手机号无效`);
    if (seen.has(item.phone)) throw new Error(`${at}的手机号重复`);
    seen.add(item.phone);
    if (typeof item.admin !== "boolean" || typeof item.pusher !== "boolean") throw new Error(`${at}缺少管理员或推送人标记`);
    const limit = item.dailyLimit ?? null;
    if (limit !== null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new Error(`${at}的频次上限必须是 1 到 1000 的整数`);
    return { phone: item.phone, admin: item.admin, pusher: item.pusher, grants: parseGrants(item.grants, at), dailyLimit: limit };
  });
}

function parseGrants(value: unknown, at: string): Grants {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}的授权无效`);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["department", "all", "group"].includes(key))) throw new Error(`${at}的授权含未知项`);
  const grants: Grants = {};
  if (raw.all === true) grants.all = true; else if (raw.all !== undefined && raw.all !== false) throw new Error(`${at}的全员授权无效`);
  if (raw.group === true) grants.group = true; else if (raw.group !== undefined && raw.group !== false) throw new Error(`${at}的群授权无效`);
  const department = raw.department as Record<string, unknown> | undefined | null;
  if (department !== undefined && department !== null) {
    if (department.any === true && Object.keys(department).length === 1) grants.department = { any: true };
    else if (Array.isArray(department.departments) && Object.keys(department).length === 1 && department.departments.length >= 1 && department.departments.length <= 200
      && department.departments.every(id => typeof id === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(id))) grants.department = { departments: [...new Set(department.departments as string[])] };
    else throw new Error(`${at}的部门授权无效`);
  }
  return grants;
}

type Click = { event: StreamEvent; data: ClickData; userId: string; card: string };

export class PushService {
  readonly #store: PushStore;
  readonly #directory: PushDirectory;
  readonly #outbound: Outbound;
  readonly #limits: PushLimits;
  readonly #now: () => number;
  readonly #signal: AbortSignal;
  readonly #work = new Set<Promise<unknown>>();
  readonly #refreshing = new Map<string, { again: boolean }>();
  readonly #clicks = new Set<string>();
  readonly #progressAt = new Map<string, number>();
  /** When each group's "last @-mentioned" time was last written. */
  readonly #seenAt = new Map<string, number>();
  /** `<push>|<group>|<phone>`: the member's group conversation has the push's note queued (a restart queues it again; the write is deduplicated). */
  readonly #groupNoted = new Set<string>();
  #host?: PushHost;
  #timer?: ReturnType<typeof setInterval>;
  #pumping = false;
  #pumpAgain = false;
  #ticking = false;
  #closing = false;

  constructor(private readonly options: PushOptions) {
    this.#store = options.store;
    this.#directory = options.directory;
    this.#outbound = options.outbound;
    this.#limits = { ...PUSH_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal;
  }

  /** The message service, once it exists (it is built with this service's tools). */
  bind(host: PushHost): void { this.#host = host; }

  /** Startup: sends an ended process left `sending` are uncertain; then the background work resumes. */
  start(): void {
    const settled = this.#store.settleInterruptedSends();
    if (settled) log.warn(`推送：${settled} 张卡片在上次服务中断时正在发送，结果未知，按已发出处理`);
    this.#sweepPackages();
    this.#track(this.#reconcileItems());
    this.#timer = setInterval(() => this.tick(), this.#limits.tickMs);
    this.#timer.unref?.();
    this.tick();
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  /** Packages an ended process left: the tmp cleanup looks only under the members' directories. Listed before any new one can exist. */
  #sweepPackages(): void {
    const tmp = this.options.layout.tmp;
    let names: string[] = [];
    try { names = readdirSync(tmp); } catch { return; }
    const left = names.filter(name => name.startsWith(PACKAGE_DIR)).map(name => rm(join(tmp, name), { recursive: true, force: true }));
    if (left.length) this.#track(Promise.all(left));
  }

  // ---- permissions ----------------------------------------------------------------------------------------------------

  isPusher(phone: string): boolean {
    return this.#store.role(phone)?.pusher === true;
  }

  isAdmin(phone: string): boolean {
    return this.#store.role(phone)?.admin === true;
  }

  /** The settings page: every role, with the person's current name (null: not in the synced address book), and the synced departments for grants. */
  settings(): { roles: (PushRole & { name: string | null })[]; departments: { id: string; path: string }[] } {
    return { roles: this.#store.roles().map(role => ({ ...role, name: this.#directory.byPhone(role.phone)?.name ?? null })),
      departments: this.#directory.departments.all().map(({ id, path }) => ({ id, path })) };
  }

  /** Replace the role list; everyone on it must be in the synced address book. */
  saveSettings(value: unknown): void {
    const roles = parseRoles(value);
    const unknown = roles.filter(role => (role.admin || role.pusher) && !this.#directory.byPhone(role.phone));
    if (unknown.length) throw new PushSettingsRefused(`${unknown.length} 个手机号不在同步的通讯录里`, unknown.map(role => role.phone).slice(0, 10));
    this.#store.replaceRoles(roles, this.#now());
    log.info(`推送设置已保存：推送人 ${roles.filter(role => role.pusher).length} 人，管理员 ${roles.filter(role => role.admin).length} 人`);
  }

  // ---- groups ---------------------------------------------------------------------------------------------------------

  /** The console's group list: registered and disabled groups, and groups seen but not named yet. */
  groups(): { groups: PushGroupRow[]; steps: string } {
    return { groups: this.#store.groups().map(group => ({ ...group, registeredByName: group.registeredBy ? this.#directory.byPhone(group.registeredBy)?.name ?? null : null })),
      steps: GROUP_STEPS };
  }

  /** Name (register), rename, disable or enable a group the bot has seen (the console); no `name` keeps the current one. */
  saveGroup(id: string, change: { name?: string; state: "registered" | "disabled" }): ChatGroup {
    const group = this.#store.group(id);
    if (!group) throw new PushRefused("机器人没有这个群的记录：要先有人在群里 @ 过机器人");
    const named = change.name === undefined ? group.name : this.#groupName(id, change.name);
    if (change.state === "registered" && named === null) throw new PushRefused("登记群要写群名");
    return this.#saveGroup(group, named, change.state, null);
  }

  #saveGroup(group: ChatGroup, name: string | null, state: "registered" | "disabled", by: string | null): ChatGroup {
    const registered = state === "registered" && group.state !== "registered";
    const change = { name, state, registeredAt: registered ? this.#now() : group.registeredAt, registeredBy: registered ? by : group.registeredBy };
    this.#store.saveGroup(group.id, change);
    log.info(`群 ${group.id} ${state === "disabled" ? "已停用" : registered ? "已登记" : "已改名"}`);
    return { ...group, ...change };
  }

  /** A group name: one line of 1 to 30 characters, used by no other group. */
  #groupName(id: string, raw: string): string {
    const name = oneLine(raw);
    if (!name) throw new PushRefused("群名不能为空");
    if (chars(name) > this.#limits.groupNameChars) throw new PushRefused(`群名不能超过 ${this.#limits.groupNameChars} 个字`);
    const other = this.#store.groups().find(group => group.id !== id && group.name !== null && sameName(group.name, name));
    if (other) throw new PushRefused(`群名「${name}」已经用于另一个群${other.state === "disabled" ? "（已停用）" : ""}，请换一个`);
    return name;
  }

  /** A text in a group (any member's, before anything else): the group is known; its time moves on now and then. */
  #groupSeen(groupId: string): void {
    const now = this.#now(), last = this.#seenAt.get(groupId);
    if (last !== undefined && now - last < this.#limits.groupSeenMs) return;
    if (this.#seenAt.size >= 10_000) this.#seenAt.clear();
    this.#seenAt.set(groupId, now);
    this.#store.groupSeen(groupId, now, this.#limits.groupSeenMs);
  }

  /** `/登记群 <名称>` in a group: admins only. */
  #registerCommand(groupId: string, identity: DirectoryIdentity, reply: ReplyContext, text: string): void {
    if (!this.isAdmin(identity.phone)) { this.#notice(reply, "只有推送管理员可以登记群；管理员名单在控制台的推送设置里。"); return; }
    const raw = text.trim().slice(text.trim().split(/\s+/, 1)[0]!.length);
    if (!oneLine(raw)) { this.#notice(reply, "请在指令后写上群名，例如：@机器人 /登记群 销售一部"); return; }
    try {
      // Seen a moment ago, unless the write was skipped as too recent; the row is there either way.
      const group = this.#store.group(groupId) ?? (this.#store.groupSeen(groupId, this.#now(), 0), this.#store.group(groupId)!);
      const saved = this.#saveGroup(group, this.#groupName(groupId, raw), "registered", identity.phone);
      this.#notice(reply, `已登记为 ${saved.name}。有群推送权限的推送人现在可以按这个群名推送到本群。`);
    } catch (error) {
      if (!(error instanceof PushRefused)) throw error;
      this.#notice(reply, error.message);
    }
  }

  // ---- prepare (push_prepare) -----------------------------------------------------------------------------------------

  /** Check the request, store the push as a preview and send the preview card to the pusher; the model's answer. */
  async prepare(caller: { phone: string; reply: ReplyContext }, input: PrepareInput): Promise<string> {
    const role = this.#store.role(caller.phone);
    if (!role?.pusher) throw new PushRefused("你没有推送权限，请联系管理员在控制台设置。");
    const now = this.#now(), limits = this.#limits;
    const subject = oneLine(input.subject ?? ""), body = (input.body ?? "").trim();
    const problems: string[] = [];
    if (!subject || chars(subject) > limits.subjectChars) problems.push(`主题必须是 1 到 ${limits.subjectChars} 个字`);
    if (!body || chars(body) > limits.bodyChars) problems.push(`正文必须是 1 到 ${limits.bodyChars} 个字；更长的内容请改为附件`);
    if (!["ack", "options", "reply"].includes(input.mode)) problems.push("要求必须是 ack（确认收到）、options（选项）或 reply（需要回复）");
    const options = input.mode === "options" ? (input.options ?? []).map(oneLine) : [];
    if (input.mode === "options") {
      const [min, max] = limits.options;
      if (options.length < min || options.length > max) problems.push(`选项必须有 ${min} 到 ${max} 个`);
      if (options.some(option => !option || chars(option) > limits.optionChars)) problems.push(`每个选项必须是 1 到 ${limits.optionChars} 个字`);
      if (new Set(options).size !== options.length) problems.push("选项不能重复");
    }
    let deadline = now + limits.defaultDeadlineMs, defaultDeadline = true;
    if (input.deadline !== undefined && input.deadline.trim()) {
      const parsed = parseDeadline(input.deadline);
      if (parsed === undefined) problems.push(`截止时间「${input.deadline}」无法识别，请写成 2026-11-07 18:00 这样的格式`);
      else if (parsed < now + limits.minDeadlineMs) problems.push("截止时间至少要在 10 分钟之后");
      else if (parsed > now + limits.maxDeadlineMs) problems.push("截止时间不能超过 30 天之后");
      else { deadline = parsed; defaultDeadline = false; }
    }
    const before = problems.length;
    const target = this.#checkTarget(role, input, problems);
    const people = problems.length > before ? [] : this.#expand(target, caller.phone);
    if (problems.length === before && !people.length) {
      problems.push(target.departments.length || target.everyone ? "按部门或全员展开后没有可以接收的人（不含你自己）" : "至少要有一个推送对象");
    }
    if (people.length > limits.recipients) {
      problems.push(`一次最多推送 ${limits.recipients} 人，现在是 ${reachText(reachOf(people))}${reachOf(people).groups ? "（一个群算一人）" : ""}`);
    }
    // The pusher gets the summary anyway.
    const cc = this.#checkPeople(input.cc ?? [], "抄送人", problems).filter(person => person.phone !== caller.phone);
    if (cc.length > limits.cc) problems.push(`抄送人最多 ${limits.cc} 个`);
    if (problems.length) throw new PushRefused(`推送未准备：\n- ${problems.join("\n- ")}`);
    this.#checkLimit(role, now);
    const pusher = this.#directory.byPhone(caller.phone);
    const push = this.#newPush({ pusher: caller.phone, pusherName: pusher?.name ?? caller.reply.name ?? caller.phone, pusherIm: pusher?.imUserId ?? caller.reply.receiveId,
      subject, body, mode: input.mode, options, deadline, defaultDeadline, target, cc: cc.map(({ phone, name }) => ({ phone, name })) });
    const outcome = await this.#createPreview(push, people);
    log.info(`推送 ${push.id} 已准备：${reachText(reachOf(people))}，等待推送人确认`);
    return `已把推送预览卡片发给你（推送编号 ${push.id}，${reachText(reachOf(people))}${cc.length ? `，抄送 ${cc.length} 人` : ""}，截止 ${defaultDeadline ? "确认发出后 3 天（未指定截止时间）" : shortTime(deadline, now)}）。`
      + "请在卡片上核对，点「确认推送」才会发出；点之前不会发给任何人。"
      + (target.departments.length || target.everyone ? "部门和全员的名单在点「确认推送」时按当时的通讯录重新展开。" : "")
      + (outcome === "uncertain" ? "（预览卡片的发送结果不确定，如果没有收到，请重新提出。）" : "");
  }

  /** A push in `preview`, with nothing confirmed, sent or summarised yet. */
  #newPush(fields: Pick<Push, "pusher" | "pusherName" | "pusherIm" | "subject" | "body" | "mode" | "options" | "deadline" | "defaultDeadline" | "target" | "cc">): Push {
    return { id: this.#newId(), ...fields, state: "preview", createdAt: this.#now(), confirmedAt: null, closedAt: null, closeReason: null, previewCard: null,
      previewVersion: 0, summaryState: null, summaryAttempts: 0, summaryAt: null, summaryError: null, summaryDone: [], summaryText: null, summaryCard: null,
      summaryVersion: 0, followUp: null, released: false };
  }

  #recipientRow(pushId: string, reached: Reached): Recipient {
    return { pushId, ...reached, sendState: "pending", sendAttempts: 0, sendError: null, sentAt: null, retryAt: null, card: null, version: 0, ackedAt: null,
      clicks: 0, choice: null, choiceAt: null, replyState: "none", draft: 0, submitted: 0, submittedAt: null, activityAt: null, remindedAt: null, hintedAt: null };
  }

  /**
   * Store the push with its list (`also`: in the same transaction) and send the preview card to the pusher; a preview
   * that could not be sent is cancelled. Synchronous up to the send.
   */
  async #createPreview(push: Push, people: readonly Reached[], also?: () => void): Promise<"sent" | "uncertain"> {
    const recipients = people.map(person => this.#recipientRow(push.id, person));
    // The card must fit (measured ~5000 characters).
    const sample = recipientCard({ push, recipient: recipients[0]!, draft: { texts: 0, files: 0 }, submitted: { texts: 0, files: 0 } }, this.#now());
    if (chars(sample.content) > CARD_MAX_CHARS) throw new PushRefused("正文太长，卡片放不下，请精简或改为附件");
    this.#store.transaction(() => { this.#store.create(push, recipients); also?.(); });
    const outcome = await this.#outbound.send(this.#pusherTarget(push), cardMessage(this.#previewCard(push)), { signal: this.#signal });
    if (outcome.status === "failed") {
      this.#store.updatePush(push.id, { state: "cancelled" });
      throw new Error(`预览卡片没有发出（${outcome.reason}），推送未准备，请稍后再试`);
    }
    return outcome.status;
  }

  /** The target as asked: people checked against the address book, departments found by name or path, all within the grants. */
  #checkTarget(role: PushRole, input: PrepareInput, problems: string[]): PushTarget {
    const people = this.#checkPeople(input.recipients ?? [], "对象", problems);
    if (people.length > this.#limits.people) problems.push(`一次最多列出 ${this.#limits.people} 个人；更多的人请按部门推送`);
    const asked = input.departments ?? [], tree = this.#directory.departments;
    const departments: TargetDepartment[] = [];
    if (asked.length > this.#limits.departments) problems.push(`一次最多列出 ${this.#limits.departments} 个部门；请改选它们的上级部门`);
    else if (asked.length && !role.grants.department) problems.push(NO_DEPARTMENT_GRANT);
    else if (asked.length && tree.updatedAt === undefined) problems.push("机器人还没有同步到部门信息，请稍后再试");
    else {
      for (const entry of asked) {
        const name = oneLine(String(entry?.name ?? ""));
        const { matches, similar } = tree.find(name);
        if (!matches.length) { problems.push(`找不到部门「${name}」${similar.length ? `，是不是：${similar.map(department => department.path).join("、")}` : ""}`); continue; }
        if (matches.length > 1) { problems.push(`有 ${matches.length} 个部门叫「${name}」，请用完整路径说明是哪一个：${matches.map(department => department.path).join("；")}`); continue; }
        const found = matches[0]!;
        if (!departments.some(department => department.id === found.id)) departments.push({ id: found.id, path: found.path, children: entry?.children !== false });
      }
    }
    const groups = this.#checkGroups(role, input, problems);
    const target: PushTarget = { people: people.map(({ phone, name }) => ({ phone, name })), departments, everyone: input.everyone === true,
      ...(groups.length ? { groups } : {}) };
    problems.push(...this.#grantProblems(role, target));
    return target;
  }

  /** Groups by registered name; options are refused for them (a click in a group cannot be traced to a person). */
  #checkGroups(role: PushRole, input: PrepareInput, problems: string[]): TargetGroup[] {
    const asked = input.groups ?? [], groups: TargetGroup[] = [];
    if (!asked.length) return groups;
    if (asked.length > this.#limits.groups) { problems.push(`一次最多列出 ${this.#limits.groups} 个群`); return groups; }
    if (!role.grants.group) { problems.push(NO_GROUP_GRANT); return groups; }
    if (input.mode === "options") problems.push("推送到群不支持选项：群里的点击对应不到人。请改为确认收到（ack）或需要回复（reply），或改为按人、按部门推送");
    const registered = this.#store.groups().filter(group => group.state === "registered" && group.name !== null);
    if (!registered.length) { problems.push(`还没有登记任何群。${GROUP_STEPS}`); return groups; }
    for (const entry of asked) {
      const name = oneLine(String(entry?.name ?? ""));
      const found = registered.find(group => sameName(group.name!, name));
      if (!found) {
        problems.push(`没有登记名为「${name}」的群（已登记：${registered.slice(0, 20).map(group => group.name).join("、")}${registered.length > 20 ? ` 等 ${registered.length} 个` : ""}）。没有登记的群不能推送，${GROUP_STEPS}`);
        continue;
      }
      if (!groups.some(group => group.id === found.id)) groups.push({ id: found.id, name: found.name! });
    }
    return groups;
  }

  /** What in the target the pusher may not reach (any more): departments outside the grant or gone from the tree, everyone, groups no longer registered. */
  #grantProblems(role: PushRole, target: PushTarget): string[] {
    const problems: string[] = [], tree = this.#directory.departments, grant = role.grants.department;
    if (target.departments.length && !grant) problems.push(NO_DEPARTMENT_GRANT);
    for (const department of target.departments) {
      if (!grant) break;
      if (!tree.get(department.id)) problems.push(`部门「${department.path}」已不在同步的通讯录里`);
      else if ("departments" in grant && !tree.within(department.id, grant.departments)) {
        problems.push(`部门「${department.path}」不在你可以推送的部门里（可以推送：${grant.departments.map(id => tree.get(id)?.path ?? `部门 ${id}`).join("、")}，含下级）`);
      }
    }
    if (target.everyone && !role.grants.all) problems.push("你没有推送给全员的权限，请联系管理员在控制台授权");
    if (target.groups?.length && !role.grants.group) problems.push(NO_GROUP_GRANT);
    else for (const group of target.groups ?? []) if (this.#store.group(group.id)?.state !== "registered") problems.push(`群「${group.name}」已停用`);
    return problems;
  }

  /**
   * Who the target reaches now: the people named (still in the address book), then the departments' and everyone's
   * members but the pusher, then the groups (by their current names).
   */
  #expand(target: PushTarget, pusher: string): Reached[] {
    const list = new Map<string, DirectoryIdentity>(), tree = this.#directory.departments;
    for (const person of target.people) {
      const found = this.#directory.byPhone(person.phone);
      if (found) list.set(found.phone, found);
    }
    const add = (people: readonly DirectoryIdentity[]) => { for (const person of people) if (person.phone !== pusher && !list.has(person.phone)) list.set(person.phone, person); };
    for (const department of target.departments) add(tree.members([department.id], department.children));
    if (target.everyone) add(tree.everyone());
    const groups = (target.groups ?? []).map(group => groupReached({ id: group.id, name: this.#store.group(group.id)?.name ?? group.name }));
    return [...[...list.values()].map(personReached), ...groups];
  }

  #checkPeople(list: readonly { name: string; phone: string }[], label: string, problems: string[]): (Person & { imUserId: string })[] {
    const people = new Map<string, Person & { imUserId: string }>();
    for (const entry of list) {
      const phone = String(entry?.phone ?? "").replace(/[\s-]/g, ""), name = oneLine(String(entry?.name ?? ""));
      if (!phone) { problems.push(`${label}「${name || "（无姓名）"}」缺少手机号`); continue; }
      const found = this.#directory.byPhone(phone);
      if (!found) { problems.push(`${label} ${name || ""}（${phone}）不在机器人同步的通讯录范围内`); continue; }
      if (name && !sameName(name, found.name)) { problems.push(`${label}手机号 ${phone} 在通讯录里是「${found.name}」，与「${name}」不符`); continue; }
      people.set(phone, { phone, name: found.name, imUserId: found.imUserId });
    }
    return [...people.values()];
  }

  #checkLimit(role: PushRole, now: number): void {
    if (role.dailyLimit === null) return;
    const used = this.#store.confirmedSince(role.phone, now - 24 * 3600_000);
    if (used >= role.dailyLimit) throw new PushRefused(`你 24 小时内最多推送 ${role.dailyLimit} 条，已达上限，请稍后再推送。`);
  }

  #newId(): string {
    for (;;) {
      const id = [...randomBytes(8)].map(byte => "abcdefghjkmnpqrstuvwxyz23456789"[byte % 31]).join("");
      if (!this.#store.exists(id)) return id;
    }
  }

  // ---- push_status ----------------------------------------------------------------------------------------------------

  /** The pusher's own pushes: the latest few, or one in detail. */
  status(phone: string, id?: string): string {
    if (!this.isPusher(phone)) throw new PushRefused("你没有推送权限。");
    const now = this.#now();
    if (id) {
      const push = this.#store.push(id.trim().toLowerCase());
      if (!push || push.pusher !== phone) throw new PushRefused(`没有你发起的推送 ${id}。`);
      const recipients = this.#store.recipients(push.id), items = this.#store.items(push.id);
      const lines = [this.#statusLine(push, recipients, now), ""];
      for (const recipient of recipients.slice(0, 100)) {
        const who = memberGroup(recipient.member) === undefined ? `${recipient.name}（尾号 ${phoneTail(recipient.member)}）` : `群 ${recipient.name}`;
        lines.push(`- ${who}：${this.#personState(push, recipient, items)}`);
      }
      if (recipients.length > 100) lines.push(`……共 ${reachText(reachOf(recipients))}，其余见控制台推送页。`);
      return lines.join("\n");
    }
    const pushes = this.#store.pushesOf(phone, 5);
    if (!pushes.length) return "你还没有发起过推送。";
    return ["你最近的推送（新的在前）：", ...pushes.map(push => `- ${this.#statusLine(push, this.#store.recipients(push.id), now)}`),
      "", "要看某条推送每个人的情况，用推送编号再查一次。"].join("\n");
  }

  #statusLine(push: Push, recipients: readonly Recipient[], now: number): string {
    const state = push.state === "preview" ? "待确认" : push.state === "sending" ? "发送中" : push.state === "open" ? "进行中"
      : push.state === "cancelled" ? "已取消" : push.state === "expired" ? "已失效" : push.closeReason === "complete" ? "已全部答复" : "已截止";
    return `推送编号 ${push.id}「${push.subject}」${state}，${push.confirmedAt ? `${shortTime(push.confirmedAt, now)} 发出` : `${shortTime(push.createdAt, now)} 准备`}，`
      + `截止 ${shortTime(push.deadline, now)}；${this.#tally(push, recipients)}`;
  }

  /** Counts of a push, as the summary and push_status word them. */
  #tally(push: Push, recipients: readonly Recipient[]): string {
    const delivered = recipients.filter(recipient => recipient.sendState === "sent" || recipient.sendState === "uncertain");
    const failed = recipients.filter(recipient => recipient.sendState === "failed").length;
    const head = `共 ${reachText(reachOf(recipients))}${failed ? `（发送失败 ${failed}）` : ""}`;
    if (push.mode === "ack") {
      const acked = delivered.filter(recipient => recipient.ackedAt !== null).length;
      return `${head}；已确认 ${acked}，未确认 ${delivered.length - acked}`;
    }
    if (push.mode === "options") {
      const counts = push.options.map((option, index) => `${option} ${delivered.filter(recipient => recipient.choice === index).length}`);
      return `${head}；${counts.join("，")}，未选择 ${delivered.filter(recipient => recipient.choice === null).length}`;
    }
    const acked = delivered.filter(recipient => recipient.ackedAt !== null).length, replied = delivered.filter(recipient => recipient.submitted > 0).length;
    return `${head}；已确认 ${acked}，已回复 ${replied}，未回复 ${delivered.length - replied}`;
  }

  #personState(push: Push, recipient: Recipient, items: readonly ReplyItem[]): string {
    if (recipient.sendState === "failed") return `发送失败（${recipient.sendError ?? "原因未知"}）`;
    if (recipient.sendState === "pending" || recipient.sendState === "sending") return "未发出";
    const clicks = memberGroup(recipient.member) === undefined ? "" : `，群里共点击 ${recipient.clicks} 次`;
    if (push.mode === "ack") return recipient.ackedAt === null ? "未确认" : `已确认（${shortTime(recipient.ackedAt, this.#now())}${clicks}）`;
    if (push.mode === "options") return recipient.choice === null ? "未选择" : `选择「${push.options[recipient.choice]}」`;
    const own = effectiveItems(recipient, items);
    const replying = recipient.replyState === "replying" ? "（正在回复中）" : "";
    if (!own.length) return (recipient.ackedAt === null ? "未确认，未回复" : "已确认，未回复") + replying;
    const text = replyText(own), files = own.filter(item => item.kind !== "text").map(item => item.name ?? "附件");
    return `已回复：${text ? truncate(oneLine(text), 200) : "（没有文字）"}${files.length ? `；附件：${files.join("、")}` : ""}${replying}`;
  }

  // ---- clicks ---------------------------------------------------------------------------------------------------------

  /** A card click from the event stream (callback:card_interaction). Synchronous decisions; sends run in the background. */
  click(event: StreamEvent): void {
    const payload = event.payload;
    const data = clickData(payload.content);
    if (!data) { log.info("忽略不属于推送的卡片点击"); return; }
    const userId = typeof payload.userId === "string" ? payload.userId : "", card = typeof payload.msgUid === "string" ? payload.msgUid : "";
    const groupId = typeof payload.groupId === "string" ? payload.groupId : "";
    if (!/^[\x21-\x7e]{1,128}$/.test(userId) || !/^[\x21-\x7e]{1,128}$/.test(card)) { log.warn("推送卡片点击缺少有效的 userId 或 msgUid，已丢弃"); return; }
    if (groupId && !GROUP_ID.test(groupId)) { log.warn("推送卡片点击的群号无效，已丢弃"); return; }
    // The same click delivered twice (a reconnect): its stamp, card, button and version repeat.
    const key = `${card}|${event.sentAt ?? ""}|${data.action}|${data.version}|${data.option ?? ""}|${userId}|${groupId}`;
    if (this.#clicks.has(key)) return;
    if (this.#clicks.size >= 20_000) this.#clicks.delete(this.#clicks.values().next().value!);
    this.#clicks.add(key);
    const push = this.#store.push(data.push);
    if (!push) { log.info(`推送 ${data.push} 不存在，忽略点击`); return; }
    const click: Click = { event, data, userId, card };
    try {
      // Previews and summaries go to the pusher's direct chat only.
      if (groupId) {
        if (data.action === "confirm" || data.action === "cancel" || data.action === "remind") log.warn(`推送 ${push.id} 的预览或汇总按钮出现在群里，忽略`);
        else this.#recipientClick(push, click, groupId);
      }
      else if (data.action === "confirm" || data.action === "cancel") this.#previewClick(push, click);
      else if (data.action === "remind") this.#summaryClick(push, click);
      else this.#recipientClick(push, click);
    } catch (error) { this.#report(error); }
  }

  #previewClick(push: Push, click: Click): void {
    const clicker = this.#directory.lookup(click.userId);
    if (clicker?.phone !== push.pusher && click.userId !== push.pusherIm) { log.warn(`推送 ${push.id} 的预览卡片被推送人以外的人点击，忽略`); return; }
    if (push.previewCard !== click.card) this.#store.updatePush(push.id, { previewCard: click.card });
    const current = this.#store.push(push.id)!;
    if (current.state !== "preview" || click.data.version !== current.previewVersion) { this.#refreshPreview(push.id); return; }
    if (click.data.action === "cancel") {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      log.info(`推送 ${push.id} 已由推送人取消`);
      this.#previewSettled(push.id);
      return;
    }
    const role = this.#store.role(push.pusher), now = this.#now();
    if (!role?.pusher) {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      this.#previewSettled(push.id);
      this.#text(this.#pusherTarget(push), "你已没有推送权限，这条推送已取消。");
      return;
    }
    // A given deadline was checked when the push was prepared, up to a day ago. A default one starts now, as the card says.
    if (!current.defaultDeadline && current.deadline < now + this.#limits.minDeadlineMs) {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      this.#previewSettled(push.id);
      this.#text(this.#pusherTarget(push), "这条推送没有发出，已取消：截止时间已经过了，或离现在不到 10 分钟。请重新准备。");
      return;
    }
    try { this.#checkLimit(role, now); }
    catch (error) { this.#text(this.#pusherTarget(push), (error as Error).message); return; }
    // The list is expanded again: the address book and the grants of this moment.
    const problems = this.#grantProblems(role, current.target);
    const people = problems.length ? [] : this.#expand(current.target, push.pusher);
    if (problems.length || !people.length || people.length > this.#limits.recipients) {
      this.#store.movePush(push.id, ["preview"], { state: "cancelled", previewVersion: current.previewVersion + 1 });
      this.#previewSettled(push.id);
      const reach = reachOf(people);
      this.#text(this.#pusherTarget(push), `这条推送没有发出，已取消：${problems.length ? problems.join("；") : !people.length ? "按现在的通讯录没有可以接收的人"
        : `现在是 ${reachText(reach)}${reach.groups ? "（一个群算一人）" : ""}，超过一次 ${this.#limits.recipients} 人的上限`}。`);
      return;
    }
    const confirmed = this.#store.transaction(() => {
      if (!this.#store.movePush(push.id, ["preview"], { state: "sending", confirmedAt: now, previewVersion: current.previewVersion + 1,
        ...(current.defaultDeadline ? { deadline: now + this.#limits.defaultDeadlineMs } : {}) })) return false;
      this.#store.replaceRecipients(push.id, people.map(person => this.#recipientRow(push.id, person)));
      return true;
    });
    if (!confirmed) return;
    log.info(`推送 ${push.id} 已确认，开始发送 ${people.length} 张卡片`);
    this.#previewSettled(push.id);
    this.#pump();
  }

  /** The preview's state changed: its card, and for a follow-up the summary card of the push it reminds. */
  #previewSettled(pushId: string): void {
    this.#refreshPreview(pushId);
    const of = this.#store.push(pushId)?.target.of;
    if (of) this.#refreshSummary(of);
  }

  /** 「提醒未回复」 on the pusher's summary card (only the pusher's click counts): a follow-up push, as a preview. */
  #summaryClick(push: Push, click: Click): void {
    const clicker = this.#directory.lookup(click.userId);
    if (clicker?.phone !== push.pusher && click.userId !== push.pusherIm) { log.warn(`推送 ${push.id} 的汇总卡片被推送人以外的人点击，忽略`); return; }
    if (push.summaryCard !== click.card) this.#store.updatePush(push.id, { summaryCard: click.card });
    const current = this.#store.push(push.id)!;
    if (current.state !== "closed" || click.data.version !== current.summaryVersion || this.#followUpOf(current)) { this.#refreshSummary(push.id); return; }
    this.#track(this.#prepareFollowUp(current).catch(error => {
      this.#text(this.#pusherTarget(push), error instanceof PushRefused ? error.message : `补推送没有准备好：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => this.#refreshSummary(push.id)));
  }

  /** The follow-up of a push that is not void (cancelled or expired): one at a time. */
  #followUpOf(push: Push): Push | undefined {
    const followUp = push.followUp ? this.#store.push(push.followUp) : undefined;
    return followUp && followUp.state !== "cancelled" && followUp.state !== "expired" ? followUp : undefined;
  }

  /**
   * A follow-up of a closed push: the same content and CCs to the recipients who did not answer (`members`: only these of
   * them), with the default deadline, as a preview the pusher confirms. Returns its ID. Synchronous up to the preview's
   * send: the summary card's version moves on with it, so a second click or a console call meanwhile is refused.
   */
  async #prepareFollowUp(original: Push, members?: readonly string[]): Promise<string> {
    const role = this.#store.role(original.pusher);
    if (!role?.pusher) throw new PushRefused("你已没有推送权限，不能补推送。");
    const existing = this.#followUpOf(original);
    if (existing) throw new PushRefused(`「${original.subject}」已经准备过补推送（推送编号 ${existing.id}）${existing.state === "preview" ? "，请在预览卡片上确认或取消" : ""}。`);
    this.#checkLimit(role, this.#now());
    const chosen = this.#unanswered(original).filter(recipient => !members || members.includes(recipient.member));
    // People still in the address book, groups still registered (by their current names).
    const people = chosen.flatMap(recipient => memberGroup(recipient.member) === undefined ? this.#directory.byPhone(recipient.member) ?? [] : []);
    const groups = chosen.flatMap(recipient => {
      const group = this.#store.group(memberGroup(recipient.member) ?? "");
      return group?.state === "registered" && group.name !== null ? [{ id: group.id, name: group.name }] : [];
    });
    const reached = [...people.map(personReached), ...groups.map(groupReached)];
    if (!reached.length) throw new PushRefused(`「${original.subject}」没有需要补推送的对象：没有答复的人都已不在同步的通讯录里（群已停用），或已经全部答复。`);
    const pusher = this.#directory.byPhone(original.pusher), now = this.#now();
    const push = this.#newPush({ pusher: original.pusher, pusherName: pusher?.name ?? original.pusherName, pusherIm: pusher?.imUserId ?? original.pusherIm,
      subject: original.subject, body: original.body, mode: original.mode, options: original.options, deadline: now + this.#limits.defaultDeadlineMs,
      defaultDeadline: true, target: { people: people.map(({ phone, name }) => ({ phone, name })), departments: [], everyone: false, ...(groups.length ? { groups } : {}),
        of: original.id }, cc: original.cc });
    await this.#createPreview(push, reached, () => this.#store.updatePush(original.id, { followUp: push.id, summaryVersion: original.summaryVersion + 1 }));
    log.info(`推送 ${original.id} 的补推送 ${push.id} 已准备：${reachText(reachOf(reached))}`);
    return push.id;
  }

  /** Recipients without an answer: delivered and not answered, or never reached. */
  #unanswered(push: Push): Recipient[] {
    return this.#store.recipients(push.id).filter(recipient => recipient.sendState === "failed" || !this.#answered(push, recipient));
  }

  #answered(push: Push, recipient: Recipient): boolean {
    return push.mode === "ack" ? recipient.ackedAt !== null : push.mode === "options" ? recipient.choice !== null
      : recipient.submitted > 0 && recipient.replyState !== "replying";
  }

  // ---- the console: 补推送 and CCs ------------------------------------------------------------------------------------

  /**
   * 补推送 (the console): a live push sends its card again to the chosen recipients who have not answered (default: all of
   * them, failed cards included); a closed one prepares a follow-up push, as its summary card does.
   */
  async remind(pushId: string, members?: readonly string[]): Promise<{ resent: number } | { followUp: string }> {
    const push = this.#store.push(pushId);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "closed") {
      try { return { followUp: await this.#prepareFollowUp(push, members) }; }
      finally { this.#refreshSummary(pushId); }
    }
    if (!LIVE_STATES.includes(push.state)) throw new PushRefused("这条推送没有发出，不能补推送");
    const chosen = this.#unanswered(push).filter(recipient => (!members || members.includes(recipient.member))
      && recipient.sendState !== "pending" && recipient.sendState !== "sending");
    // A new card message each (`card: null`); the old card keeps working, a click on it makes it the one updated again.
    for (const recipient of chosen) this.#store.updateRecipient(pushId, recipient.member, { sendState: "pending", sendAttempts: 0, retryAt: null, sendError: null, card: null });
    if (chosen.length) { log.info(`推送 ${pushId}：补推送 ${chosen.length} 张卡片`); this.#pump(); }
    return { resent: chosen.length };
  }

  /** Change the CCs until the summary goes out (the console); the people are checked as push_prepare checks them. */
  setCc(pushId: string, people: readonly { name: string; phone: string }[]): void {
    const push = this.#store.push(pushId);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "cancelled" || push.state === "expired") throw new PushRefused("这条推送没有发出");
    if ((push.state === "closed" && push.summaryState !== "pending") || this.#refreshing.has(`summary:${pushId}`)) throw new PushRefused("汇总已经在发或已经发出，不能再改抄送人");
    const problems: string[] = [];
    const cc = this.#checkPeople(people, "抄送人", problems).filter(person => person.phone !== push.pusher);
    if (cc.length > this.#limits.cc) problems.push(`抄送人最多 ${this.#limits.cc} 个`);
    if (problems.length) throw new PushRefused(problems.join("；"));
    this.#store.updatePush(pushId, { cc: cc.map(({ phone, name }) => ({ phone, name })) });
    if (push.state === "preview") this.#refreshPreview(pushId);
  }

  /** The console's list: newest first; `before`: older than this creation time. With the totals over all pushes. */
  list(query: { group: PushGroup | null; before: number | null; limit: number }): { pushes: PushListItem[]; more: boolean; totals: PushTotals } {
    const page = this.#store.page(query.group ? PUSH_GROUPS[query.group] : null, query.before, query.limit + 1), shown = page.slice(0, query.limit);
    const counts = this.#store.recipientCounts(shown.map(push => push.id));
    return { pushes: shown.map(push => this.#listItem(push, counts.get(push.id))), more: page.length > query.limit, totals: this.#store.totals() };
  }

  #listItem(push: Push, counts: RecipientCounts | undefined): PushListItem {
    const { total = 0, groups = 0, delivered = 0, failed = 0, answered = 0, replying = 0 } = counts ?? {};
    return { id: push.id, subject: push.subject, mode: push.mode, state: push.state, pusher: push.pusher, pusherName: push.pusherName, createdAt: push.createdAt,
      confirmedAt: push.confirmedAt, deadline: push.deadline, closedAt: push.closedAt, closeReason: push.closeReason, summaryState: push.summaryState,
      followUp: push.followUp, of: push.target.of ?? null,
      counts: { total, groups, delivered, failed, answered, replying } };
  }

  /** One push for the console: its content and every recipient's state and reply. */
  detail(id: string): PushDetail {
    const push = this.#store.push(id);
    if (!push) throw new PushRefused("推送不存在");
    const recipients = this.#store.recipients(id), items = this.#store.items(id);
    return {
      push: { ...this.#listItem(push, this.#store.recipientCounts([id]).get(id)), body: push.body, options: push.options, defaultDeadline: push.defaultDeadline, target: push.target, cc: push.cc,
        summaryError: push.summaryError, summaryAt: push.summaryAt },
      recipients: recipients.map(recipient => {
        const own = effectiveItems(recipient, items), text = replyText(own);
        return { member: recipient.member, name: recipient.name, sendState: recipient.sendState, sendError: recipient.sendError, sentAt: recipient.sentAt,
          ackedAt: recipient.ackedAt, clicks: recipient.clicks, choice: recipient.choice === null ? null : push.options[recipient.choice] ?? null, choiceAt: recipient.choiceAt,
          replyState: recipient.replyState, submittedAt: recipient.submittedAt,
          answered: (recipient.sendState === "sent" || recipient.sendState === "uncertain") && this.#answered(push, recipient),
          reply: own.length ? { text: chars(text) > 2000 ? truncate(text, 2000) : text,
            files: own.filter(item => item.kind !== "text").map(item => ({ name: item.name ?? "附件", size: item.size, kind: item.kind })), senders: senders(own) } : null,
          drafting: recipient.replyState === "replying" ? countsOf(items.filter(item => item.member === recipient.member && item.revision === recipient.draft)) : null };
      }),
    };
  }

  /**
   * Delete a push that is over (the console): closed with its summary sent or given up, cancelled, or expired. Held
   * reply attachments are released first; conversation notes stay in the conversations.
   */
  async remove(id: string): Promise<void> {
    const push = this.#store.push(id);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "preview" || LIVE_STATES.includes(push.state)) throw new PushRefused("推送还没有结束，不能删除；未确认的预览会在 24 小时后失效");
    if (push.state === "closed" && (push.summaryState === "pending" || this.#refreshing.has(`summary:${id}`))) throw new PushRefused("汇总还没有发出，请稍后再删除");
    if (!push.released && this.#store.items(id).some(item => item.attachment)) {
      await this.#releasePush(id);
      if (!this.#store.push(id)?.released) throw new PushRefused("回复附件的占用没有解除，请稍后再删除");
    }
    this.#store.remove(id);
    log.info(`推送 ${id} 已在控制台删除`);
  }

  /**
   * The console's package: the summary workbook and the replies with their attachments, of the whole push or one
   * recipient (`member`), phones masked, as one archive in its own directory; `done` removes it.
   */
  async package(id: string, member?: string, signal?: AbortSignal): Promise<{ path: string; name: string; size: number; done(): Promise<void> }> {
    const push = this.#store.push(id);
    if (!push) throw new PushRefused("推送不存在");
    if (push.state === "preview" || push.state === "cancelled" || push.state === "expired") throw new PushRefused("这条推送没有发出");
    const recipients = this.#store.recipients(id).filter(recipient => member === undefined || recipient.member === member);
    if (!recipients.length) throw new PushRefused("这条推送没有这个接收人");
    const items = this.#store.items(id).filter(item => member === undefined || item.member === member);
    const dir = join(this.options.layout.tmp, `${PACKAGE_DIR}${randomBytes(8).toString("hex")}`);
    const done = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const pack = await buildSummary({ push, recipients, items, files: await this.#heldFiles(id, items), dir, partBytes: Number.MAX_SAFE_INTEGER, now: this.#now(),
        phone: maskPhone, signal: signal ? AbortSignal.any([this.#signal, signal]) : this.#signal });
      if (pack.parts.length !== 1) throw new PushRefused("回复附件合计超过 4 GiB，请按人下载");
      const part = pack.parts[0]!, person = recipients[0]!;
      return { path: part.path, size: part.size, done,
        name: member === undefined ? part.name
          : part.name.replace(/\.zip$/, memberGroup(person.member) === undefined ? `-${person.name}-${person.member.slice(-4)}.zip` : `-群-${person.name}.zip`) };
    } catch (error) { await done(); throw error; }
  }

  /** The held attachments of these items, as the members' records have them now. */
  async #heldFiles(pushId: string, items: readonly ReplyItem[]): Promise<Map<string, HeldFile>> {
    const files = new Map<string, HeldFile>();
    for (const member of new Set(items.filter(item => item.attachment).map(item => item.member))) {
      for (const [id, attachment] of Object.entries((await this.#host!.records(DIRECT_SCOPE, member)).attachments)) {
        if (attachment.heldBy === holderOf(pushId)) files.set(id, attachment);
      }
    }
    return files;
  }

  /** A click on a recipient's card: a person's (found by the clicker), or a group's (`groupId`: anyone there counts). */
  #recipientClick(push: Push, click: Click, groupId?: string): void {
    let recipient;
    if (groupId !== undefined) recipient = this.#store.recipient(push.id, groupMember(groupId));
    else {
      const member = this.#directory.lookup(click.userId)?.phone;
      recipient = member === undefined ? undefined : this.#store.recipient(push.id, member);
      recipient ??= this.#store.recipients(push.id).find(each => each.receiveId === click.userId && memberGroup(each.member) === undefined);
    }
    if (!recipient) { log.warn(`推送 ${push.id} 的卡片被${groupId === undefined ? "非接收人" : "不是接收群的群里"}点击，忽略`); return; }
    const { member: phone } = recipient;
    if (recipient.card !== click.card) this.#store.updateRecipient(push.id, phone, { card: click.card });
    recipient = this.#store.recipient(push.id, phone)!;
    const now = this.#now(), { action, option } = click.data;
    // A group's 「已收到」 counts every click, also one on a card version since passed (the button stays).
    if (groupId !== undefined && action === "ack" && LIVE_STATES.includes(push.state) && push.mode !== "options") {
      this.#store.updateRecipient(push.id, phone, { clicks: recipient.clicks + 1, ackedAt: recipient.ackedAt ?? now });
      this.#refreshCard(push.id, phone);
      this.#checkComplete(push.id);
      return;
    }
    if (!LIVE_STATES.includes(push.state) || click.data.version !== recipient.version) { this.#refreshCard(push.id, phone); return; }
    const bump = (change: Partial<Recipient>) => this.#store.updateRecipient(push.id, phone, { ...change, version: recipient!.version + 1 });
    switch (action) {
      case "ack":
        if (recipient.ackedAt === null && push.mode !== "options") bump({ ackedAt: now });
        break;
      case "choose":
        if (push.mode !== "options" || option === undefined || option >= push.options.length) break;
        bump({ choice: option, choiceAt: now, ackedAt: recipient.ackedAt ?? now });
        break;
      case "reply":
      case "edit":
        if (push.mode !== "reply" || recipient.replyState === "replying") break;
        if (action === "reply" ? recipient.submitted > 0 : recipient.submitted === 0) break;
        if (!this.#startReply(push, recipient, now)) break;
        break;
      case "done":
        if (recipient.replyState === "replying") this.#submit(push, recipient, "button");
        break;
      case "abandon":
        if (recipient.replyState === "replying") this.#abandon(push, recipient);
        break;
    }
    this.#refreshCard(push.id, phone);
    this.#checkComplete(push.id);
  }

  /** Open a draft revision; false when another reply with content is open (the member is told to end it first). */
  #startReply(push: Push, recipient: Recipient, now: number): boolean {
    const other = this.#store.replying(recipient.member), group = memberGroup(recipient.member) !== undefined;
    if (other && other.pushId !== push.id) {
      const otherPush = this.#store.push(other.pushId)!;
      if (this.#store.items(other.pushId, other.member, other.draft).length) {
        this.#text(this.#memberTarget(recipient), group
          ? `本群正在回复「${otherPush.subject}」，还没有提交。请先在那张卡片上点「已回复」或「取消」（也可以发送 @机器人 /完成 或 /取消），再点这张卡片的「回复」。`
          : `你正在回复「${otherPush.subject}」，还没有提交。请先在那张卡片上点「已回复」或「取消」（也可以发送 /完成 或 /取消），再点这张卡片的「回复」。`);
        return false;
      }
      // Nothing was sent into it yet: switching loses nothing.
      this.#store.updateRecipient(other.pushId, other.member, { replyState: other.submitted > 0 ? "submitted" : "none", draft: 0, version: other.version + 1 });
      this.#refreshCard(other.pushId, other.member);
    }
    const revision = Math.max(recipient.draft, recipient.submitted, this.#lastRevision(push.id, recipient.member)) + 1;
    this.#store.updateRecipient(push.id, recipient.member, { replyState: "replying", draft: revision, ackedAt: recipient.ackedAt ?? now, activityAt: now,
      remindedAt: null, version: recipient.version + 1 });
    this.#text(this.#memberTarget(recipient), group
      ? `推送「${push.subject}」回复中：请 @机器人 发送回复文字，可以分多条、由多人发；发完点卡片上的「已回复」，或发送 @机器人 /完成。这期间 @机器人 的消息都记为回复。`
      : `请发送「${push.subject}」的回复内容，文字和附件都可以，可以分多条发；发完点卡片上的「已回复」，或发送 /完成。`
        + "回复期间你发的消息都记入回复，不会交给机器人回答。");
    return true;
  }

  #lastRevision(pushId: string, member: string): number {
    return this.#store.items(pushId, member).reduce((max, item) => Math.max(max, item.revision), 0);
  }

  /** Submit the open draft; one without content is refused with a notice. */
  #submit(push: Push, recipient: Recipient, how: "button" | "command" | "deadline"): boolean {
    const items = this.#store.items(push.id, recipient.member, recipient.draft), group = memberGroup(recipient.member);
    if (!items.length) {
      if (how !== "deadline") {
        this.#text(this.#memberTarget(recipient), group === undefined ? "还没有收到回复内容。请先发送文字或附件，再点「已回复」；不回复了请点「取消」。"
          : "还没有收到回复内容。请先 @机器人 发送回复文字，再点「已回复」；不回复了请点「取消」。");
      }
      return false;
    }
    const now = this.#now();
    const previous = recipient.submitted;
    this.#store.updateRecipient(push.id, recipient.member, { replyState: "submitted", submitted: recipient.draft, draft: 0, submittedAt: now, activityAt: now,
      version: recipient.version + 1 });
    if (previous > 0) this.#release(push.id, recipient.member, this.#store.items(push.id, recipient.member, previous));
    const counts = group === undefined ? countsText(countsOf(items)) : groupReplyText(senders(items), countsOf(items));
    if (how === "command") this.#text(this.#memberTarget(recipient), `已提交「${push.subject}」的${group === undefined ? "" : "群"}回复（${counts}）。`);
    if (how === "deadline") this.#text(this.#memberTarget(recipient), `「${push.subject}」已到截止时间，${group === undefined ? "你" : "群里"}已发送的内容（${counts}）按已回复提交。`);
    const data = { push: push.id, event: "reply", revision: recipient.draft };
    if (group === undefined) {
      const text = replyText(items), files = items.filter(item => item.kind !== "text").map(item => item.name ?? "附件");
      this.#note(DIRECT_SCOPE, recipient.member, `reply:${push.id}:${recipient.draft}`, `[推送回复] 已${previous > 0 ? "修改" : ""}回复 ${push.pusherName} 推送的「${push.subject}」：`
        + `${text ? truncate(oneLine(text), 500) : "（没有文字）"}${files.length ? `；附件：${files.join("、")}` : ""}。推送编号 ${push.id}`, data);
    } else {
      // Each sender's group conversation gets what they sent, never the others' texts.
      for (const sender of new Set(items.flatMap(item => item.sender ?? []))) {
        const own = items.filter(item => item.sender === sender).map(item => item.text ?? "").join("\n\n");
        this.#note(groupScope(group), sender, `reply:${push.id}:${recipient.draft}`, `[推送回复] 本群已${previous > 0 ? "修改" : ""}回复 ${push.pusherName} 推送的「${push.subject}」`
          + `（${counts}），其中你发的：${truncate(oneLine(own), 500)}。推送编号 ${push.id}`, data);
      }
    }
    log.info(`推送 ${push.id}：${group === undefined ? "一位接收人" : "一个群"}${previous > 0 ? "修改了" : "提交了"}回复（${how === "deadline" ? "截止时自动提交" : how === "command" ? "命令" : "按钮"}）`);
    return true;
  }

  #abandon(push: Push, recipient: Recipient): void {
    const items = this.#store.items(push.id, recipient.member, recipient.draft), group = memberGroup(recipient.member);
    this.#store.updateRecipient(push.id, recipient.member, { replyState: recipient.submitted > 0 ? "submitted" : "none", draft: 0, activityAt: this.#now(),
      version: recipient.version + 1 });
    this.#release(push.id, recipient.member, items);
    const requestId = `abandon:${push.id}:${recipient.draft}`, data = { push: push.id, event: "abandon", revision: recipient.draft };
    const kept = recipient.submitted > 0 ? "修改，之前提交的回复仍然有效" : "";
    if (items.length && group === undefined) {
      this.#note(DIRECT_SCOPE, recipient.member, requestId, `[推送回复] 放弃了这次对 ${push.pusherName} 推送的「${push.subject}」的回复${kept}。推送编号 ${push.id}`, data);
    }
    for (const sender of group === undefined ? [] : new Set(items.flatMap(item => item.sender ?? []))) {
      this.#note(groupScope(group!), sender, requestId, `[推送回复] 本群放弃了这次对 ${push.pusherName} 推送的「${push.subject}」的回复${kept}，你在其中发的内容不算回复。`
        + `推送编号 ${push.id}`, data);
    }
  }

  // ---- the member's direct messages -----------------------------------------------------------------------------------

  /** The message is already a reply item (a redelivery after a restart). */
  seen(msgUid: string): boolean {
    return this.#store.hasItem(msgUid);
  }

  /**
   * A direct-chat text of a member (the inbound router asks before admitting it): true when the push took it, as a reply
   * or as /完成 or /取消, or /登记群 (answered with where to send it). Other commands keep their meaning while replying.
   * Synchronous: call it in arrival order.
   */
  directText(identity: DirectoryIdentity, reply: ReplyContext, text: string): boolean {
    const command = isSlashCommandMessage(text) ? canonicalCommand(text) : undefined;
    if (command === "/登记群") { this.#notice(reply, "请在要登记的群里发送“@机器人 /登记群 群名”。"); return true; }
    const replying = this.#store.replying(identity.phone);
    if (command === "/完成" || command === "/取消") {
      if (!replying) this.#notice(reply, "当前没有回复中的推送。");
      else this.#endReply(replying, command, reply);
      return true;
    }
    if (!replying) {
      if (command === undefined) this.#hint(identity.phone, reply);
      return false;
    }
    if (command !== undefined) return false;
    const push = this.#store.push(replying.pushId)!;
    const id = this.#store.addItem({ pushId: push.id, member: identity.phone, revision: replying.draft, msgUid: reply.msgUid, kind: "text", text,
      attachment: null, name: null, size: null, error: null, receivedAt: reply.receivedAt, sender: null, senderName: null });
    if (id === undefined) return true;
    this.#recorded(push, replying, reply);
    return true;
  }

  /** A direct-chat attachment: true when it is a reply (registered as held by the push), false for the member's next request. */
  directAttachment(identity: DirectoryIdentity, reply: ReplyContext, attachment: AttachmentEvent): boolean {
    const replying = this.#store.replying(identity.phone);
    if (!replying) return false;
    const push = this.#store.push(replying.pushId)!;
    // The item first: a crash before the registration commits leaves an item the startup reconciliation settles.
    const id = this.#store.addItem({ pushId: push.id, member: identity.phone, revision: replying.draft, msgUid: reply.msgUid, kind: attachment.kind, text: null,
      attachment: null, name: attachment.name, size: attachment.size ?? null, error: null, receivedAt: reply.receivedAt, sender: null,
      senderName: null });
    if (id === undefined) return true;
    const host = this.#host!;
    this.#track(host.attach({ scope: DIRECT_SCOPE, phone: identity.phone, reply, attachment, hold: holderOf(push.id) }).then(result => {
      if (result.status === "accepted") this.#store.updateItem(id, { attachment: result.attachment });
      else if (result.status === "duplicate") return this.#reconcileItem({ ...this.#store.items(push.id, identity.phone).find(item => item.id === id)! });
      else this.#store.updateItem(id, { error: result.message });
    }, error => {
      if (this.#signal.aborted) return;
      this.#report(error);
      this.#store.updateItem(id, { error: "附件未能登记" });
      this.#notice(reply, "⚠️ 附件未能登记，请重新发送。");
    }).finally(() => this.#refreshCard(push.id, identity.phone)));
    this.#recorded(push, replying, reply);
    return true;
  }

  /** /完成 or /取消 of the open reply (a person's, or a group's). */
  #endReply(replying: Recipient, command: "/完成" | "/取消", reply: ReplyContext): void {
    const push = this.#store.push(replying.pushId)!;
    if (command === "/完成") this.#submit(push, replying, "command");
    else {
      this.#abandon(push, replying);
      this.#notice(reply, `已放弃这次对「${push.subject}」的${memberGroup(replying.member) === undefined ? "" : "群"}回复${replying.submitted > 0 ? "修改，之前提交的回复仍然有效" : ""}。`);
    }
    this.#refreshCard(push.id, replying.member);
    this.#checkComplete(push.id);
  }

  /**
   * A group text that @-mentions the bot (the inbound router asks before admitting it): the group is known from it. True
   * when the push took it: /登记群, /完成 or /取消, or a reply text while the group is replying (with its sender; other
   * commands keep their meaning). Otherwise the member's group conversation learns of the group's live pushes first.
   * Synchronous: call it in arrival order.
   */
  groupText(groupId: string, identity: DirectoryIdentity, reply: ReplyContext, text: string): boolean {
    this.#groupSeen(groupId);
    const command = isSlashCommandMessage(text) ? canonicalCommand(text) : undefined;
    if (command === "/登记群") { this.#registerCommand(groupId, identity, reply, text); return true; }
    const member = groupMember(groupId), replying = this.#store.replying(member);
    if (command === "/完成" || command === "/取消") {
      if (!replying) this.#notice(reply, "本群当前没有回复中的推送。");
      else this.#endReply(replying, command, reply);
      return true;
    }
    this.#groupNotes(groupId, identity.phone);
    if (!replying || command !== undefined) return false;
    const push = this.#store.push(replying.pushId)!;
    const id = this.#store.addItem({ pushId: push.id, member, revision: replying.draft, msgUid: reply.msgUid, kind: "text", text, attachment: null, name: null,
      size: null, error: null, receivedAt: reply.receivedAt, sender: identity.phone, senderName: identity.name });
    if (id === undefined) return true;
    this.#store.updateRecipient(push.id, member, { activityAt: this.#now() });
    // Every text gets a receipt: whoever @-mentioned the bot for something else learns it became a reply.
    const count = this.#store.items(push.id, member, replying.draft).length;
    this.#notice(reply, `已记为「${push.subject}」的回复（第 ${count} 段）。发完点卡片上的「已回复」，或发送 @机器人 /完成。`);
    this.#refreshCard(push.id, member);
    return true;
  }

  /** The group's live pushes, noted once in this member's group conversation (they may not have seen the card). */
  #groupNotes(groupId: string, phone: string): void {
    for (const recipient of this.#store.reached(groupMember(groupId))) {
      const key = `${recipient.pushId}|${groupId}|${phone}`;
      if (this.#groupNoted.has(key)) continue;
      if (this.#groupNoted.size >= 20_000) this.#groupNoted.delete(this.#groupNoted.values().next().value!);
      this.#groupNoted.add(key);
      this.#cardNote(this.#store.push(recipient.pushId)!, groupScope(groupId), phone);
    }
  }

  /** The note of a card: in a recipient's direct conversation when it is sent, in a group member's when they next speak. */
  #cardNote(push: Push, scope: Scope, phone: string): void {
    const now = this.#now(), group = scope.kind === "group";
    this.#note(scope, phone, `card:${push.id}`, `[推送] ${push.pusherName} ${shortTime(push.confirmedAt ?? now, now)} 推送${group ? "到本群" : ""}「${push.subject}」：`
      + `${truncate(oneLine(push.body), 500)}${chars(push.body) > 500 ? "（全文见卡片）" : ""}；要求：${group && push.mode === "reply" ? "需要回复（群里只能回复文字）" : requirementText(push)}；`
      + `截止 ${shortTime(push.deadline, now)}。${push.mode !== "reply" ? "" : group ? "回复请先点卡片上的「回复」，再 @机器人 发送文字。" : "回复请点卡片上的「回复」。"}推送编号 ${push.id}`,
    { push: push.id, event: "card" });
  }

  /** After a reply item was recorded: activity, the first item's receipt, the card. */
  #recorded(push: Push, replying: Recipient, reply: ReplyContext): void {
    this.#store.updateRecipient(push.id, replying.member, { activityAt: this.#now(), remindedAt: null });
    if (this.#store.items(push.id, replying.member, replying.draft).length === 1) {
      this.#notice(reply, `已记入「${push.subject}」的回复。可以继续发送文字或附件，发完点卡片上的「已回复」，或发送 /完成。`);
    }
    this.#refreshCard(push.id, replying.member);
  }

  /** Not replying: a member with a push waiting for their reply is told once in a while how to reply. */
  #hint(phone: string, reply: ReplyContext): void {
    const now = this.#now();
    const waiting = this.#store.awaitingReply(phone).filter(recipient => recipient.hintedAt === null || now - recipient.hintedAt >= this.#limits.hintMs);
    if (!waiting.length) return;
    for (const recipient of waiting) this.#store.updateRecipient(recipient.pushId, phone, { hintedAt: now });
    const subjects = waiting.map(recipient => `「${this.#store.push(recipient.pushId)!.subject}」`).join("、");
    this.#notice(reply, `你有 ${waiting.length} 条推送待回复：${subjects}。回复请先点卡片上的「回复」，再发送内容；这条消息按普通提问处理。`);
  }

  // ---- background: sends, deadlines, summaries, notes -----------------------------------------------------------------

  /** One maintenance pass (also on a timer): due sends, expired previews, deadlines, reminders, notes, summaries. */
  tick(): void {
    if (this.#closing || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const push of this.#store.pushesIn(["preview"])) {
        if (now - push.createdAt >= this.#limits.previewMs && this.#store.movePush(push.id, ["preview"], { state: "expired", previewVersion: push.previewVersion + 1 })) {
          this.#previewSettled(push.id);
        }
      }
      for (const push of this.#store.pushesIn(LIVE_STATES)) {
        if (now >= push.deadline) { this.#close(push.id, "deadline"); continue; }
        // Groups get no reminder: their reply stays open until someone ends it or the deadline (section 5).
        for (const recipient of this.#store.unreminded(push.id)) {
          if (now - recipient.activityAt! < this.#limits.idleReminderMs || !this.#store.items(push.id, recipient.member, recipient.draft).length) continue;
          this.#store.updateRecipient(push.id, recipient.member, { remindedAt: now });
          this.#text(this.#memberTarget(recipient), `「${push.subject}」的回复还没有提交。发完了请点卡片上的「已回复」或发送 /完成；截止时已发送的内容也会按已回复提交。`);
        }
      }
      this.#pump();
      this.#track(this.#drainNotes());
      for (const push of this.#store.summariesDue()) this.#track(this.#summarize(push.id));
      for (const push of this.#store.unreleased()) this.#track(this.#releasePush(push.id));
    } catch (error) { this.#report(error); }
    finally { this.#ticking = false; }
  }

  /** Send the cards that are due; one pump at a time. */
  #pump(): void {
    if (this.#closing) return;
    if (this.#pumping) { this.#pumpAgain = true; return; }
    this.#pumping = true;
    this.#track((async () => {
      try {
        do {
          this.#pumpAgain = false;
          const due = this.#store.sendsDue(this.#now());
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(this.#limits.concurrency, due.length) }, async () => {
            while (next < due.length && !this.#closing) await this.#send(due[next++]!);
          }));
          for (const push of this.#store.pushesIn(["sending"])) this.#settleSending(push.id);
          for (const pushId of new Set(due.map(recipient => recipient.pushId))) if (this.#progressAt.delete(pushId)) this.#refreshPreview(pushId);
          // A retry that reached someone late may complete an open push.
          for (const pushId of new Set(due.map(recipient => recipient.pushId))) this.#checkComplete(pushId);
        } while (this.#pumpAgain && !this.#closing);
      } finally { this.#pumping = false; }
    })());
  }

  async #send(due: Recipient): Promise<void> {
    const push = this.#store.push(due.pushId);
    const recipient = this.#store.recipient(due.pushId, due.member);
    if (!push || !recipient || !LIVE_STATES.includes(push.state) || (recipient.sendState !== "pending" && recipient.sendState !== "failed")) return;
    const attempts = recipient.sendAttempts + 1;
    this.#store.updateRecipient(push.id, recipient.member, { sendState: "sending", sendAttempts: attempts, retryAt: null });
    let outcome;
    try {
      outcome = await this.#outbound.send(this.#memberTarget(recipient), cardMessage(this.#recipientCard(push.id, recipient.member)!), { signal: this.#signal });
    } catch (error) { outcome = { status: "failed" as const, reason: String(error) }; }
    if (outcome.status === "failed" && this.#signal.aborted) {
      // Never dispatched: the next start sends it.
      this.#store.updateRecipient(push.id, recipient.member, { sendState: "pending", sendAttempts: recipient.sendAttempts });
      return;
    }
    const now = this.#now();
    if (outcome.status === "failed") {
      const retry = attempts < this.#limits.sendAttempts ? now + (this.#limits.sendRetryMs[attempts - 1] ?? this.#limits.sendRetryMs.at(-1)!) : null;
      this.#store.updateRecipient(push.id, recipient.member, { sendState: "failed", sendError: outcome.reason, retryAt: retry });
      if (retry === null) log.warn(`推送 ${push.id}：一张卡片发送失败（已试 ${attempts} 次）：${outcome.reason}`);
    } else {
      this.#store.updateRecipient(push.id, recipient.member, { sendState: outcome.status, sentAt: now, sendError: outcome.status === "uncertain" ? outcome.reason : null });
      // A group's members get the note when they next @-mention the bot (#groupNotes).
      if (memberGroup(recipient.member) === undefined) this.#cardNote(push, DIRECT_SCOPE, recipient.member);
    }
    this.#progress(push.id);
  }

  /** The preview card's sending progress, at most every `progressMs`: a large push spends its sends on the cards. */
  #progress(pushId: string): void {
    const now = this.#now(), last = this.#progressAt.get(pushId);
    if (last !== undefined && now - last < this.#limits.progressMs) return;
    this.#progressAt.set(pushId, now);
    this.#refreshPreview(pushId);
  }

  /** A sending push with no card left pending is open; the pusher's note records what went out. */
  #settleSending(pushId: string): void {
    const recipients = this.#store.recipients(pushId);
    if (recipients.some(recipient => recipient.sendState === "pending" || recipient.sendState === "sending")) return;
    if (!this.#store.movePush(pushId, ["sending"], { state: "open" })) return;
    this.#progressAt.delete(pushId);
    const push = this.#store.push(pushId)!;
    const failed = recipients.filter(recipient => recipient.sendState === "failed").length;
    log.info(`推送 ${pushId} 已发出：${recipients.length - failed} 张，失败 ${failed} 张`);
    const cc = push.cc.length ? `，抄送 ${push.cc.map(person => person.name).join("、")}` : "";
    this.#note(DIRECT_SCOPE, push.pusher, `sent:${pushId}`, `[推送已发出]「${push.subject}」${shortTime(push.confirmedAt!, this.#now())} 发出，`
      + `共 ${reachText(reachOf(recipients))}${failed ? `（发送失败 ${failed} 个）` : ""}${cc}；要求：${requirementText(push)}；截止 ${shortTime(push.deadline, this.#now())}。推送编号 ${pushId}`,
    { push: pushId, event: "sent" });
    this.#refreshPreview(pushId);
    this.#checkComplete(pushId);
  }

  /** Everyone the card reached has answered (and no card is still to go): close early. */
  #checkComplete(pushId: string): void {
    const push = this.#store.push(pushId);
    if (push?.state !== "open") return;
    const counts = this.#store.recipientCounts([pushId]).get(pushId);
    if (counts && !counts.unsettled && counts.delivered > 0 && counts.answered === counts.delivered) this.#close(pushId, "complete");
  }

  /** Close a live push: open drafts with content are submitted, the cards show the end, the summary is due. */
  #close(pushId: string, reason: "deadline" | "complete"): void {
    const push = this.#store.push(pushId);
    if (!push || !LIVE_STATES.includes(push.state)) return;
    for (const recipient of this.#store.recipients(pushId)) {
      if (recipient.replyState === "replying" && !this.#submit(push, recipient, "deadline")) {
        this.#store.updateRecipient(pushId, recipient.member, { replyState: recipient.submitted > 0 ? "submitted" : "none", draft: 0 });
      }
      if (recipient.sendState === "pending" || (recipient.sendState === "failed" && recipient.retryAt !== null)) {
        this.#store.updateRecipient(pushId, recipient.member, { sendState: "failed", retryAt: null, sendError: recipient.sendError ?? "截止前没有发出" });
      }
    }
    if (!this.#store.movePush(pushId, LIVE_STATES, { state: "closed", closedAt: this.#now(), closeReason: reason, summaryState: "pending" })) return;
    log.info(`推送 ${pushId} 已${reason === "deadline" ? "截止" : "全部答复，提前结束"}`);
    for (const recipient of this.#store.recipients(pushId)) {
      this.#store.updateRecipient(pushId, recipient.member, { version: recipient.version + 1 });
      this.#refreshCard(pushId, recipient.member);
    }
    this.#refreshPreview(pushId);
    this.#track(this.#summarize(pushId));
  }

  /** Build and send the summary to the pusher and the CCs. One person's failure holds nobody else back; a retry sends only what did not go out. */
  async #summarize(pushId: string): Promise<void> {
    const key = `summary:${pushId}`;
    if (this.#refreshing.has(key) || this.#closing) return;
    const push = this.#store.push(pushId);
    if (push?.summaryState !== "pending" || (push.summaryAt !== null && push.summaryAt > this.#now())) return;
    this.#refreshing.set(key, { again: false });
    const dir = join(userTmp(this.options.layout, DIRECT_SCOPE, push.pusher), `push-${push.id}`);
    try {
      const recipients = this.#store.recipients(pushId), items = this.#store.items(pushId);
      const files = push.mode === "reply" ? await this.#heldFiles(pushId, items) : new Map<string, HeldFile>();
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const pack = await buildSummary({ push, recipients, items, files, dir, partBytes: this.options.relay?.maxBytes ?? NATIVE_FILE_MAX_BYTES, now: this.#now(), signal: this.#signal });
      const tally = this.#tally(push, recipients);
      const missing = recipients.filter(recipient => (recipient.sendState === "sent" || recipient.sendState === "uncertain") && (push.mode === "ack"
        ? recipient.ackedAt === null : push.mode === "options" ? recipient.choice === null : recipient.submitted === 0))
        .map(recipient => memberGroup(recipient.member) === undefined ? recipient.name : `群 ${recipient.name}`);
      const lines = [`推送「${push.subject}」${push.closeReason === "complete" ? "已全部答复" : "已截止"}（推送编号 ${push.id}）`, tally,
        ...(missing.length ? [`${push.mode === "reply" ? "未回复" : push.mode === "ack" ? "未确认" : "未选择"}：${missing.slice(0, 30).join("、")}${missing.length > 30 ? ` 等 ${missing.length} 个` : ""}`] : []),
        ...(pack.missingFiles ? [`有 ${pack.missingFiles} 个附件没能打包（原因见汇总表）`] : []),
        pack.parts.length > 1 ? `汇总表和回复内容分成 ${pack.parts.length} 个压缩包，见下面。` : "汇总表和回复内容见下面的压缩包。"];
      this.#store.updatePush(pushId, { summaryText: lines.join("\n") });
      const failures: { name: string; reason: string }[] = [];
      for (const person of [{ phone: push.pusher, name: push.pusherName, im: push.pusherIm }, ...push.cc.map(cc => ({ ...cc, im: this.#directory.byPhone(cc.phone)?.imUserId }))]) {
        if (push.summaryDone.includes(person.phone)) continue;
        if (!person.im) { log.warn(`推送 ${push.id}：一位抄送人已不在同步的通讯录里，没有给这位抄送人发汇总`); continue; }
        const cc = person.phone !== push.pusher;
        try {
          // The pusher's summary is a card (its 「提醒未回复」 button); the CCs get text.
          await this.#sendSummary(pushId, person.phone, { kind: "direct", receiveId: person.im }, cc ? { text: `${push.pusherName} 推送的汇总抄送给你：\n${lines.join("\n")}` }
            : { card: this.#summaryCard(this.#store.push(pushId)!) }, pack, dir);
        } catch (error) {
          if (this.#signal.aborted) throw error;
          failures.push({ name: person.name, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        this.#store.updatePush(pushId, { summaryDone: [...this.#store.push(pushId)!.summaryDone.filter(done => !done.startsWith(`${person.phone}|`)), person.phone] });
        this.#note(DIRECT_SCOPE, person.phone, `summary:${push.id}`, cc
          ? `[推送汇总抄送] ${push.pusherName} 推送的「${push.subject}」：${tally}，汇总包已发出。推送编号 ${push.id}`
          : `[推送汇总]「${push.subject}」：${tally}，汇总包已发出。推送编号 ${push.id}`, { push: push.id, event: cc ? "summary-cc" : "summary" });
      }
      if (failures.length) {
        // The log names no one.
        this.#summaryFailed(push, failures.map(({ name, reason }) => `${name}：${reason}`).join("；"), `${failures.length} 人没有发出，${failures[0]!.reason}`);
        return;
      }
      this.#store.updatePush(pushId, { summaryState: "sent", summaryAt: this.#now(), summaryError: null });
      log.info(`推送 ${pushId} 的汇总已发出`);
      this.#track(this.#releasePush(pushId));
    } catch (error) {
      if (this.#signal.aborted) return;
      this.#summaryFailed(push, String(error), String(error));
    } finally {
      this.#refreshing.delete(key);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Another try after this attempt's delay, or the last one was. */
  #summaryFailed(push: Push, reason: string, logged: string): void {
    const attempts = push.summaryAttempts + 1, delay = this.#limits.summaryRetryMs[attempts - 1];
    this.#store.updatePush(push.id, delay === undefined
      ? { summaryState: "failed", summaryAttempts: attempts, summaryError: reason, summaryAt: this.#now() }
      : { summaryAttempts: attempts, summaryError: reason, summaryAt: this.#now() + delay });
    log.warn(`推送 ${push.id} 的汇总没有发出（第 ${attempts} 次）：${logged}`);
  }

  /**
   * One person's summary: the message and the archives (each by link when above the native size; only a relay allows
   * that). What went out is recorded under `<phone>|<step>`, so a retry sends the rest. An uncertain send counts as sent,
   * as for cards; a process that ends between a send and its record sends that step again.
   */
  async #sendSummary(pushId: string, phone: string, target: Target, message: { text: string } | { card: CardContent }, pack: SummaryPackage, dir: string): Promise<void> {
    const step = async (name: string, send: () => Promise<void>) => {
      const done = `${phone}|${name}`;
      if (this.#store.push(pushId)!.summaryDone.includes(done)) return;
      await send();
      this.#store.updatePush(pushId, { summaryDone: [...this.#store.push(pushId)!.summaryDone, done] });
    };
    const messages = "card" in message ? [cardMessage(message.card)] : splitText(message.text).map(textMessage);
    for (const [index, each] of messages.entries()) {
      await step(`message-${index}`, async () => {
        const outcome = await this.#outbound.send(target, each, { signal: this.#signal });
        if (outcome.status === "failed") throw new Error(`汇总消息没有发出：${outcome.reason}`);
      });
    }
    const reply: ReplyContext = { kind: "direct", receiveId: target.receiveId, senderImUserId: target.receiveId, msgUid: "", summary: "", receivedAt: this.#now() };
    const options = { channel: sendChannel(this.#outbound, reply), relay: this.options.relay, tempDir: dir };
    for (const part of pack.parts) {
      await step(part.name, async () => {
        let transfer;
        try { transfer = await transferFile({ kind: "local", path: part.path, size: part.size }, part.name, options, this.#signal); }
        catch (error) {
          if (!(error instanceof SendNotConfirmed && error.uncertain)) throw error;
          log.warn(`推送 ${pushId} 的一个汇总包发送结果不确定，按已发出处理`);
          return;
        }
        if (transfer.mode === "relay") {
          const outcome = await this.#outbound.send(target, textMessage(transfer.note), { signal: this.#signal });
          if (outcome.status === "failed") throw new Error(`汇总外链没有发出：${outcome.reason}`);
        }
      });
    }
  }

  /** Release every held attachment of a push whose summary is done (sent or given up). */
  async #releasePush(pushId: string): Promise<void> {
    const key = `release:${pushId}`;
    if (this.#refreshing.has(key)) return;
    this.#refreshing.set(key, { again: false });
    try {
      const byMember = new Map<string, ReplyItem[]>();
      for (const item of this.#store.items(pushId)) if (item.attachment) byMember.set(item.member, [...byMember.get(item.member) ?? [], item]);
      // The records go; where the files are stays with the items, for the console's downloads until the tmp cleanup takes them.
      const files = await this.#heldFiles(pushId, [...byMember.values()].flat());
      for (const item of [...byMember.values()].flat()) {
        const file = files.get(item.attachment!);
        if (file?.state === "ready" && file.path && item.path !== file.path) this.#store.updateItem(item.id, { path: file.path });
      }
      for (const [member, items] of byMember) await this.#host!.releaseAttachments(DIRECT_SCOPE, member, holderOf(pushId), items.map(item => item.attachment!));
      this.#store.updatePush(pushId, { released: true });
    } catch (error) { if (!this.#signal.aborted) this.#report(error); }
    finally { this.#refreshing.delete(key); }
  }

  /** Release the attachments of replaced or dropped revisions now (best effort; the summary release covers what is left). */
  #release(pushId: string, member: string, items: readonly ReplyItem[]): void {
    const ids = items.flatMap(item => item.attachment ? [item.attachment] : []);
    if (!ids.length || !this.#host) return;
    this.#track(this.#host.releaseAttachments(DIRECT_SCOPE, member, holderOf(pushId), ids).catch(error => { if (!this.#signal.aborted) this.#report(error); }));
  }

  /** Attachment items a process left half registered: find the registration by the message, or mark it failed. */
  async #reconcileItems(): Promise<void> {
    for (const item of this.#store.unregistered()) await this.#reconcileItem(item).catch(error => this.#report(error));
  }

  async #reconcileItem(item: ReplyItem): Promise<void> {
    const records = await this.#host!.records(DIRECT_SCOPE, item.member);
    const found = Object.values(records.attachments).find(attachment => attachment.msgUid === item.msgUid && attachment.heldBy === holderOf(item.pushId));
    this.#store.updateItem(item.id, found ? { attachment: found.id } : { error: "附件登记中断，请重新发送" });
  }

  // ---- notes ----------------------------------------------------------------------------------------------------------

  /** A note for the member's conversation in `scope` (their direct chat, or a group). */
  #note(scope: Scope, phone: string, requestId: string, text: string, data: Record<string, string | number>): void {
    this.#store.addNote({ scope: scopeKey(scope), requestId: `push-note:${requestId}`, phone, text, data: JSON.stringify(data) }, this.#now());
    this.#track(this.#drainNotes());
  }

  #draining = false;
  async #drainNotes(): Promise<void> {
    if (this.#draining || !this.#host || this.#closing) return;
    this.#draining = true;
    try {
      for (let due = this.#store.notesDue(this.#now(), 20); due.length && !this.#closing; due = this.#store.notesDue(this.#now(), 20)) {
        for (const note of due) {
          try {
            const scope = parseScopeKey(note.scope);
            if (!scope) { this.#store.dropNote(note); log.error("推送会话备注的会话无法识别，已丢弃"); continue; }
            await this.#host.note(scope, note.phone, note.requestId, { kind: PUSH_NOTE_KIND, data: JSON.parse(note.data),
              model: [{ role: "user", content: [{ type: "text", text: note.text }], timestamp: note.createdAt }] });
            this.#store.dropNote(note);
          } catch (error) {
            if (this.#signal.aborted) return;
            if (note.attempts >= 20) { this.#store.dropNote(note); log.error(`推送会话备注多次写入失败，已放弃：${String(error)}`); continue; }
            this.#store.deferNote(note, this.#now() + Math.min(3600_000, 30_000 * 2 ** note.attempts));
            this.#report(error);
          }
        }
      }
    } finally { this.#draining = false; }
  }

  // ---- cards and messages ---------------------------------------------------------------------------------------------

  #pusherTarget(push: Push): Target { return { kind: "direct", receiveId: push.pusherIm }; }
  #memberTarget(recipient: Recipient): Target {
    return { kind: memberGroup(recipient.member) === undefined ? "direct" : "group", receiveId: recipient.receiveId };
  }

  #previewCard(push: Push): CardContent {
    const recipients = this.#store.recipients(push.id);
    const done = recipients.filter(recipient => recipient.sendState !== "pending" && recipient.sendState !== "sending").length;
    const failed = recipients.filter(recipient => recipient.sendState === "failed");
    const delivered = recipients.filter(recipient => recipient.sendState === "sent" || recipient.sendState === "uncertain");
    return previewCard({ push, people: recipients.map(recipient => ({ name: recipient.name, member: recipient.member })),
      ...(push.state === "preview" || push.state === "cancelled" || push.state === "expired" ? {}
        : { sent: { done, total: recipients.length, delivered: reachOf(delivered), failed: reachOf(failed) } }) }, this.#now());
  }

  #recipientCard(pushId: string, member: string): CardContent | undefined {
    const push = this.#store.push(pushId), recipient = this.#store.recipient(pushId, member);
    if (!push || !recipient) return undefined;
    const draft = recipient.draft ? this.#store.items(pushId, member, recipient.draft) : [];
    const submitted = recipient.submitted ? this.#store.items(pushId, member, recipient.submitted) : [];
    return recipientCard({ push, recipient, draft: countsOf(draft), submitted: countsOf(submitted),
      ...(memberGroup(member) === undefined ? {} : { senders: { draft: senders(draft), submitted: senders(submitted) } }) }, this.#now());
  }

  /** The pusher's summary card: the summary text, and 「提醒未回复」 while there is someone to remind and no follow-up yet. */
  #summaryCard(push: Push): CardContent {
    const followUp = this.#followUpOf(push);
    return summaryCard({ push, lines: (push.summaryText ?? "").split("\n"), unanswered: reachOf(this.#unanswered(push)), ...(followUp ? { followUp } : {}) });
  }

  #refreshSummary(pushId: string): void {
    this.#refresh(`summary-card:${pushId}`, () => {
      const push = this.#store.push(pushId);
      return push?.summaryCard ? { target: this.#pusherTarget(push), card: this.#summaryCard(push) } : undefined;
    });
  }

  #refreshPreview(pushId: string): void {
    this.#refresh(`preview:${pushId}`, () => {
      const push = this.#store.push(pushId);
      return push?.previewCard ? { target: this.#pusherTarget(push), card: this.#previewCard(push) } : undefined;
    });
  }

  #refreshCard(pushId: string, member: string): void {
    this.#refresh(`card:${pushId}:${member}`, () => {
      const recipient = this.#store.recipient(pushId, member);
      if (!recipient?.card) return undefined;
      return { target: this.#memberTarget(recipient), card: this.#recipientCard(pushId, member)! };
    });
  }

  /** Update a card in place with its state at send time; updates asked for meanwhile coalesce into one more. */
  #refresh(key: string, build: () => { target: Target; card: CardContent } | undefined): void {
    const running = this.#refreshing.get(key);
    if (running) { running.again = true; return; }
    const state = { again: false };
    this.#refreshing.set(key, state);
    this.#track((async () => {
      try {
        do {
          state.again = false;
          const next = build();
          if (!next || this.#signal.aborted) break;
          let outcome = await this.#outbound.send(next.target, cardMessage(next.card), { signal: this.#signal });
          if (outcome.status === "failed" && !this.#signal.aborted && !state.again) {
            await pause(3000, this.#signal);
            const retry = build();
            if (retry) outcome = await this.#outbound.send(retry.target, cardMessage(retry.card), { signal: this.#signal });
          }
          if (outcome.status === "failed" && !this.#signal.aborted) log.warn(`推送卡片没有更新：${outcome.reason}`);
        } while (state.again && !this.#signal.aborted);
      } finally { this.#refreshing.delete(key); }
    })());
  }

  #text(target: Target, text: string): void {
    this.#track(this.#outbound.send(target, textMessage(text), { signal: this.#signal }).then(outcome => {
      if (outcome.status === "failed" && !this.#signal.aborted) log.warn(`推送提示没有发出：${outcome.reason}`);
    }));
  }

  #notice(reply: ReplyContext, text: string): void {
    this.#track(sendNotice(this.#outbound, reply, text, { signal: this.#signal }));
  }

  #track(work: Promise<unknown>): void {
    const tracked = work.catch(error => { if (!this.#signal.aborted) this.#report(error); });
    this.#work.add(tracked);
    void tracked.finally(() => this.#work.delete(tracked));
  }

  #report(error: unknown): void {
    try { this.options.onReport?.(error); } catch {}
  }
}

/** Wait `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  });
}

function countsOf(items: readonly ReplyItem[]): Counts {
  return { texts: items.filter(item => item.kind === "text").length, files: items.filter(item => item.kind !== "text").length };
}
