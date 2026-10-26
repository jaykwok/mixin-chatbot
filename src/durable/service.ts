// The message lifecycle on the Durable engine: admission, the member workers, controls, replies and their delivery, the
// watchdog, usage projection and maintenance. The inbound router (src/server/inbound.ts) hands every message and command
// of the app bot's event stream to it.
//
// Spaces and members. A space (`Scope`, src/core/layout.ts) is a group, or the one space all direct chats share; it has
// its own Durable database and member tmp directories, while the materials workspace is shared by the whole application.
// A member is (space, phone): its conversation, inbox and run
// records. Where an answer goes is not member state: every inbound message carries an immutable reply context
// (./records.ts), stored with its request or control, and everything sent for it uses that context.
//
// Admission. A message is committed to the member's inbox together with its receipt (`msgUid`) and its run record
// before `admit` resolves. The arrival order and the member's admission turn are taken synchronously when `admit` or
// `control` is called, so the stream's order holds across the asynchronous identity, open and commit steps. A
// redelivered message finds its receipt in that commit and is dropped without a reply.
//
// Workers. One per member, in memory: submit the inbox head to Durable (idempotent by its requestId), wait for it to
// settle, then in one commit remove the item and store the reply's delivery plan in the run record; then send the plan
// part by part (./records.ts: pending → sending → sent | failed | uncertain). A failed part is tried again with a
// growing wait until the delivery's window ends; an uncertain one counts as sent and is never resent.
//
// Controls. /stop and /clear are committed to the control stream (with their receipt) before they run; the request door
// holds the member's model requests from receipt until the removal is committed. /stop cancels the inbox and aborts the
// run. /clear also holds the worker (new messages are admitted but not submitted), waits until the conversation is idle
// (Durable's abort returns only then: no tool, codemode sub-call or store commit of the member is left), starts a new
// context, removes the member's codemode result directories, then releases the worker. A restart executes waiting
// controls again. Both end the sending of the member's earlier replies in the space.
//
// Watchdog. The total deadline counts from the item's first submission (stored, so it survives restarts); model
// progress is the committed partial of the current attempt (`pi.live`): no change for the idle limit, or one attempt
// running longer than the response limit, aborts the run like the previous engine's limits. Tool rounds, retry
// backoff, deferred polls and compactions are not model idleness.
//
// Startup. Spaces with work are opened by discovery; before scheduling resumes, the door gets the waiting controls,
// every member's storage identity is checked and delivery parts left `sending` become uncertain; then the controls run
// again, the workers start and open delivery parts are sent (failed ones when their retry is due).
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry, CompactionEntry, InboxDoc as PiInboxDoc, type Conversation, type ConversationId, createRegistry, defineExtension, type Extension, GenerationTask, type Harness,
  type HarnessOptions, hook, LiveDoc, type LiveState, type ReportInfo, type SettledSubmissionRecord, type Submission,
} from "@earendil-works/pi-durable";
import { canonicalCommand, HELP_TEXT, unknownCommandText } from "../agent/commands.ts";
import { clearRunning, markRunning } from "./running-requests.ts";
import { deleteSnapshots, fileDigest, releasableSnapshots } from "../agent/deliverables.ts";
import { SendNotConfirmed, transferFile } from "../agent/send-tools.ts";
import { closeoutExtension, closeoutTool, validateCloseout, type CloseoutTiming, type RecordWriter } from "./closeout.ts";
import { describeRequestFailure, modelRequestError } from "../agent/failure.ts";
import { ensureMaterialsIndex } from "../agent/materials-index.ts";
import type { AgentModuleDefinition } from "../agent/modules.ts";
import { ensureStorageIdentity } from "../agent/storage-identity.ts";
import { openStatsLedger, pruneAskIds, settledAsks } from "../agent/stats-ledger.ts";
import { Attention, type AttentionStatus } from "./attention.ts";
import { MAX_ACTIVE_REQUESTS, MEMBER_IDLE_MS } from "../core/config.ts";
import { scopeKey, scopeLabel, spaceDatabase, userTmp, type Layout, type Scope } from "../core/layout.ts";
import { waitFor } from "../core/lifecycle.ts";
import { AsyncSemaphore } from "../core/async-semaphore.ts";
import { type Send, type SendOutcome, splitText, textMessage } from "../integrations/open-platform/messages.ts";
import { LinkUnavailable, type RelayConfig } from "../integrations/relay.ts";
import { RequestDoor, type ControlTicket } from "./door.ts";
import { SpaceHarnesses } from "./spaces.ts";
import { IdentityDoc, memberConversation, MemberDirectory } from "./identity.ts";
import { type ControlCommand, ControlsDoc, InboxDoc, type InboxItem, inboxItems, pendingControls, receivedBefore } from "./inbox.ts";
import { spaceDoor, type ModelSelection } from "./models.ts";
import type { AuxiliaryConfig } from "../core/auxiliary-config.ts";
import { AuxiliaryBudget } from "./auxiliary.ts";
import type { McpTools } from "../integrations/mcp.ts";
import { queueManualCompaction } from "./manual-compaction.ts";
import { recoverOfficeProfiles } from "../agent/office-profiles.ts";
import { log } from "../core/log.ts";
import { ResultMaintenance } from "./results/maintenance.ts";
import { requestMemberExpiry } from "./results/ownership.ts";
import { resultReferences } from "./results/references.ts";
import { countAsk, syncMemberStats } from "./projection.ts";
import { spaceExtensions } from "./registry.ts";
import type { DurableStorageFailure } from "./storage-failure.ts";
import { memberPlaces } from "./tools.ts";
import { conversationIds, idleSpaceReferences } from "./conversations.ts";
import { lateMinutes, type Outbound, replyMessage, replySegments, sendNotice, targetOf } from "./outbound.ts";
import { sendChannel } from "./send.ts";
import { ATTACHMENT_LIMITS, AttachmentDownloads, type AttachmentEvent, type AttachmentLimits, type AttachmentSource, arrivedBefore, attachmentLabel,
  attachmentPrompt, bindAttachments, expireAttachments, newAttachmentId, removeAttachmentFiles, unconsumed, voidWhere } from "./attachments.ts";
import {
  type Attachment, type Delivery, DELIVERY_RETRY_DELAYS_MS, DELIVERY_WINDOW_MS, deliveryEnd, type DeliveryPart, type MemberRecords, memberRecords, openPart, pendingDeliveries, pruneReceipts,
  pruneRecords, ReceiptsDoc, recordsOf, deliveryRetryDelay, type ReplyContext, type RequestRecord, settleInterrupted, undelivered,
} from "./records.ts";

export const lateNotice = (minutes: number) => `这条消息约 ${minutes} 分钟前发出，服务维护后才收到，正在处理。`;
const QUEUE_FULL = "本会话已有 8 条消息排队，请稍后重发";
const CAPACITY_FULL = "⚠️ 机器人现在比较忙，这条消息未加入队列，不会自动处理，请稍后重新发送。";

export interface ServiceLimits {
  /** Ordinary requests from admission through cleanup, including queued messages. */
  activeRequests: number;
  runTimeoutMs: number;
  modelIdleMs: number;
  modelResponseMs: number;
  /** Messages waiting behind the running one. */
  queue: number;
  /** Watchdog tick. */
  tickMs: number;
  /** A running task is logged this often ("任务仍在运行"). */
  heartbeatMs: number;
  /** Codemode result directories older than this are removed by maintenance (idle members only). */
  resultRetentionMs: number;
  /** An idle member of an open group keeps its in-memory state this long after its last activity. */
  memberIdleMs: number;
  /** Waits before a failed delivery part is tried again, by attempts so far; the last one repeats. */
  deliveryRetryMs: readonly number[];
  /** Automatic sending of a delivery ends this long after its creation. */
  deliveryWindowMs: number;
}

export interface DurableServiceOptions {
  layout: Layout;
  selection: ModelSelection;
  modules: readonly AgentModuleDefinition[];
  relay: RelayConfig | null;
  /** The platform: sends, uploads and link refreshes. */
  outbound: Outbound;
  /** Direct-chat attachments (plan 5.5): the platform download. Without it attachments are registered as refused. */
  attachments?: { source: AttachmentSource; limits?: Partial<AttachmentLimits> };
  auxiliary?: AuxiliaryConfig;
  mcp?: McpTools;
  /** The document environment (BOT_DOCUMENT_ENV); default the layout's shared one. */
  venvDir?: string;
  limits: Omit<ServiceLimits, "activeRequests" | "queue" | "tickMs" | "heartbeatMs" | "resultRetentionMs" | "memberIdleMs" | "deliveryRetryMs" | "deliveryWindowMs"> & Partial<ServiceLimits>;
  /** Production supplies validated runtime settings; tiny lifecycle fixtures can omit closeout. */
  closeout?: CloseoutTiming;
  /** The storage identity table (src/core/state.ts by default). */
  stateDb?: Database;
  /** Extensions installed after the project's (tests). */
  extensions?: (scope: Scope) => readonly Extension[];
  /** Refresh the application's materials index before each run (default true). */
  materials?: boolean;
  maxIdleSpaces?: number;
  context?: Context;
  /** Failures that do not fail the calling operation. Must not throw. */
  onReport?: (error: unknown) => void;
  /** Uncertain group commit/SQL thread loss: the application must exit immediately, without ordinary shutdown writes. */
  onFatal?: (error: DurableStorageFailure) => void;
  /** Progress lines for the service log. Must not throw. */
  onLog?: (line: string) => void;
}

/** One inbound message or command of a member, as the router hands it over. */
export interface Inbound {
  scope: Scope;
  phone: string;
  content: string;
  reply: ReplyContext;
}

/** A direct-chat image, file or video. */
export type InboundAttachment = Omit<Inbound, "content"> & { attachment: AttachmentEvent };

type AbortReason = { kind: "task_timeout" | "model_idle" | "model_response_timeout"; error: Error };

/** Log labels of the watchdog's aborts, as the task log extraction (scripts/ops/task-logs.*) looks for them. */
const ABORT_LABELS: Record<AbortReason["kind"], string> = {
  task_timeout: "任务总时限到达",
  model_idle: "模型无有效进展超时",
  model_response_timeout: "单次模型响应超时",
};

type MemberState = {
  readonly key: string;
  readonly scope: Scope;
  readonly phone: string;
  conversationId?: number;
  worker?: Promise<void>;
  again: boolean;
  /** Admitted control boundary for this process, including messages whose admission is still in flight. */
  cancelBefore?: number;
  /**
   * Set from a /stop's or /clear's arrival until it ran: the worker starts nothing, so a message that arrives after the
   * control is never started before it and aborted by it.
   */
  gate?: Promise<void>;
  /**
   * /stop and /clear commands not yet past their receipt check. A redelivered one changes nothing, so a run that settles
   * meanwhile waits for the decision instead of reading the gate as a cancellation.
   */
  deciding: Set<Promise<void>>;
  /** A start in progress (from the gate check until the submission exists); a control waits for it before it cancels. */
  starting?: Promise<void>;
  /** Controls of this member run one at a time. */
  controls: Promise<unknown>;
  /** Admission order is reserved synchronously; controls have an independent cancellation boundary. */
  admission: AsyncSemaphore;
  /** Older controls found at open run before this process's newly received commands. */
  replaying?: Promise<void>;
  workProgress: number;
  workerRetry?: { attempt: number; nextAt: number; message: string };
  controlRetry?: { attempt: number; nextAt: number; message: string };
  /** The inbox item being run. */
  current?: { requestId: string; startedAt: number; deadlineError?: AbortReason };
  aborted: Map<string, AbortReason>;
  /** Raised by a committed /stop or /clear: automatic sending in progress stops before its next part. */
  withdrawals: number;
  /** Automatic and recovered delivery share one send boundary. */
  delivery: AsyncSemaphore;
  /** Public operations and automatic delivery still using this state. */
  uses: number;
  lastUsed: number;
};

type SpaceRuntime = { door: RequestDoor; holder: { harness?: Harness }; refreshed: Map<number, Promise<void>>; epoch: number };
type ControlReceipt = { scope: Scope; phone: string; requestId: string; ticket?: ControlTicket };
/** Held while maintenance reclaims a group's results. A waiting message or command sets `yield`. */
type ReclamationGate = { promise: Promise<void>; resolve: () => void; yield: boolean };

export type AdmitResult = { status: "accepted" } | { status: "duplicate" } | { status: "full"; message: string; reason?: "capacity" };

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("").trim();

/** Committed receipts this process has seen; an optimisation only, the durable receipt decides. */
const SEEN_LIMIT = 20_000;

/** The message service of the process (src/server/app.ts creates one). */
export class DurableService {
  readonly #options: DurableServiceOptions;
  readonly #auxiliaryBudget: AuxiliaryBudget;
  readonly #limits: ServiceLimits;
  readonly #outbound: Outbound;
  readonly #context: Context;
  readonly #cancel: (reason?: unknown) => void;
  readonly #closing = new AbortController();
  readonly #members = new Map<string, MemberState>();
  readonly #runtimes = new Map<string, SpaceRuntime>();
  readonly #receipts = new Map<string, ControlReceipt>();
  readonly #spaces: SpaceHarnesses;
  readonly #background = new Set<Promise<unknown>>();
  readonly #requests = new Map<string, { key: string; retired: boolean }>();
  readonly #memberRequests = new Map<string, number>();
  readonly #running = new Set<string>();
  readonly #capacityWaiters = new Set<() => void>();
  readonly #reclaiming = new Map<string, ReclamationGate>();
  readonly #memberCursors = new Map<string, number>();
  readonly #seen = new Set<string>();
  readonly #results: ResultMaintenance;
  readonly #downloads?: AttachmentDownloads;
  /** When a request stops waiting for the downloads it bound (this process). */
  readonly #attachmentWaits = new Map<string, number>();
  /** The next look at a delivery with a failed part (a retry) or its window's end, by member and request. */
  readonly #deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #attention = new Attention();
  #lastArrival = 0;
  #maintenanceCursor = 0;
  #fatalError?: DurableStorageFailure;
  #statsLedger?: Database;

  constructor(options: DurableServiceOptions) {
    this.#options = options;
    this.#auxiliaryBudget = new AuxiliaryBudget(options.auxiliary?.maxConcurrent ?? 2);
    this.#limits = { activeRequests: MAX_ACTIVE_REQUESTS, queue: 8, tickMs: 1000, heartbeatMs: 60_000, resultRetentionMs: 7 * 24 * 3600_000,
      memberIdleMs: MEMBER_IDLE_MS, deliveryRetryMs: DELIVERY_RETRY_DELAYS_MS, deliveryWindowMs: DELIVERY_WINDOW_MS, ...options.limits };
    if (!Number.isSafeInteger(this.#limits.activeRequests) || this.#limits.activeRequests < 1) throw new Error("普通请求总容量必须是正整数");
    this.#outbound = options.outbound;
    if (options.closeout) validateCloseout(options.closeout, this.#limits.runTimeoutMs);
    const cancellable = withCancel(options.context ?? BACKGROUND_CONTEXT);
    this.#context = cancellable.context;
    this.#cancel = cancellable.cancel;
    this.#results = new ResultMaintenance({ context: this.#context, signal: this.#closing.signal, warn: line => log.warn(line) });
    this.#spaces = new SpaceHarnesses({
      layout: options.layout,
      harnessOptions: (scope) => this.#harnessOptions(scope),
      prepare: (harness, scope, context) => this.#prepare(harness, scope, context),
      pendingWork: (harness, _scope, context) => this.#pendingWork(harness, context),
      ...(options.maxIdleSpaces === undefined ? {} : { maxIdle: options.maxIdleSpaces }),
      context: this.#context,
      onReport: (error) => this.#report(error),
      onFatal: (error) => this.#fatal(error),
      onClosed: (scope, harness) => this.#closedSpace(scope, harness),
    });
    if (options.attachments) {
      this.#downloads = new AttachmentDownloads(options.attachments.source, {
        read: async (space, phone) => {
          const handle = await this.#spaces.acquire(space);
          try { return await memberRecords(handle.harness, phone, this.#context); } finally { handle.release(); }
        },
        update: async (space, phone, change) => {
          const handle = await this.#spaces.acquire(space);
          try { return await handle.harness.commit(async tx => change(await recordsOf(tx, phone)), this.#context); } finally { handle.release(); }
        },
        tempDir: (space, phone) => userTmp(options.layout, space, phone),
        notify: (reply, text) => this.#track(this.#notify(reply, text)),
        report: error => this.#report(error),
      }, this.#closing.signal, { ...ATTACHMENT_LIMITS, ...options.attachments.limits });
    }
  }

  /** Startup: open every space with work (controls run again, workers start, untried deliveries go out). */
  start(): Promise<Scope[]> {
    return this.#spaces.discover();
  }

  /** What needs an operator's look since this process started (`/health`). */
  attention(): AttentionStatus {
    return this.#attention.status();
  }

  // ---- admission ------------------------------------------------------------------------------------------------------

  hasUserRequestCapacity(): boolean {
    return !this.#closing.signal.aborted && this.#requests.size < this.#limits.activeRequests;
  }

  /** A message whose receipt this process has already committed (a redelivery); the router drops it. */
  seen(msgUid: string): boolean {
    return this.#seen.has(msgUid);
  }

  /** A read-only view of a member's request records (diagnostics). */
  async records(scope: Scope, phone: string): Promise<Readonly<MemberRecords>> {
    const handle = await this.#spaces.acquire(scope);
    try { return structuredClone(await memberRecords(handle.harness, phone, this.#context)); }
    finally { handle.release(); }
  }

  /**
   * Commit a message to the member's inbox with its receipt and run record; resolves once it is durable. Everything up to
   * the admission turn is synchronous: call it in arrival order.
   */
  async admit(message: Inbound): Promise<AdmitResult> {
    this.#assertRunning();
    const { scope, phone, content, reply } = message;
    if (this.#seen.has(reply.msgUid)) return { status: "duplicate" };
    const requestId = `msg:${randomUUID()}`;
    const key = memberKey(scope, phone);
    // Reserve synchronously, before identity/open/commit awaits.
    if (!this.hasUserRequestCapacity()) return { status: "full", reason: "capacity", message: CAPACITY_FULL };
    this.#addRequest(requestId, key);
    const receivedAt = this.#arrival();
    const member = this.#member(scope, phone);
    member.uses++;
    member.lastUsed = Date.now();
    const turn = member.admission.acquire(this.#closing.signal);
    let release: (() => void) | undefined;
    let retained = false;
    try {
      release = await turn;
      await this.#yieldToReclamation(scope);
      this.#assertRunning();
      await ensureStorageIdentity(this.#options.layout, scope, phone, this.#options.stateDb);
      const handle = await this.#spaces.acquire(scope);
      let added: "added" | "duplicate" | "queue-full" | "capacity-full";
      let voided: Attachment[] = [];
      let createdAt = 0;
      try {
        const conversation = await this.#conversation(handle.harness, member);
        added = await handle.harness.commit(async (tx) => {
          const receipts = await tx.doc(ReceiptsDoc);
          if (receipts.items[reply.msgUid]) return "duplicate" as const;
          // Opening a previously unknown space may have recovered older work after the reservation.
          if (this.#requests.size > this.#limits.activeRequests) return "capacity-full" as const;
          const inbox = await tx.doc(InboxDoc, conversation.id);
          if (inbox.items.filter((item) => item.cancelled !== true).length > this.#limits.queue) return "queue-full" as const;
          const now = Date.now(), epoch = this.#runtimes.get(scopeKey(scope))!.epoch;
          const cancelled = receivedAt <= (member.cancelBefore ?? -Infinity);
          inbox.items.push({ requestId, content, receivedAt, epoch, ...(cancelled ? { cancelled: true } : {}) });
          const records = await recordsOf(tx, phone);
          records.requests[requestId] = { requestId, reply: structuredClone(reply), createdAt: now, notes: [], deliverables: [], files: [], events: {} };
          createdAt = now;
          receipts.items[reply.msgUid] = { at: now, phone, request: requestId };
          // The request takes the member's earlier attachments in its admission commit (a cancelled one voids them).
          voided = bindAttachments(records, requestId, { epoch, receivedAt }, cancelled, now);
          return "added" as const;
        }, this.#context);
        retained = added === "added";
      } finally { handle.release(); }
      if (added === "duplicate") { this.#remember(reply.msgUid); return { status: "duplicate" }; }
      if (added === "queue-full") return { status: "full", message: QUEUE_FULL };
      if (added === "capacity-full") return { status: "full", reason: "capacity", message: CAPACITY_FULL };
      this.#remember(reply.msgUid);
      this.#countAsk(scope, phone, requestId, createdAt);
      this.#discard(scope, phone, voided);
      this.#kick(member);
      return { status: "accepted" };
    } finally {
      if (!retained) this.#dropRequest(requestId);
      member.uses--;
      release?.();
      this.#wakeCapacity();
      this.#pruneMember(member);
    }
  }

  /**
   * Register a direct-chat attachment with its receipt in arrival order, acknowledge it and start its download; the
   * member's next admitted request binds it. Everything up to the admission turn is synchronous, as for admit().
   */
  async attach(message: InboundAttachment): Promise<AdmitResult> {
    this.#assertRunning();
    const { scope: space, phone, reply, attachment: event } = message;
    if (this.#seen.has(reply.msgUid)) return { status: "duplicate" };
    const downloads = this.#downloads, limits = downloads?.limits ?? ATTACHMENT_LIMITS;
    const receivedAt = this.#arrival();
    const member = this.#member(space, phone);
    member.uses++;
    member.lastUsed = Date.now();
    const turn = member.admission.acquire(this.#closing.signal);
    let release: (() => void) | undefined;
    try {
      release = await turn;
      await this.#yieldToReclamation(space);
      this.#assertRunning();
      await ensureStorageIdentity(this.#options.layout, space, phone, this.#options.stateDb);
      const handle = await this.#spaces.acquire(space);
      let outcome: { status: "duplicate" } | { status: "full" } | { status: "added"; attachment: Attachment };
      try {
        await this.#conversation(handle.harness, member);
        outcome = await handle.harness.commit(async (tx) => {
          const receipts = await tx.doc(ReceiptsDoc);
          if (receipts.items[reply.msgUid]) return { status: "duplicate" as const };
          const now = Date.now();
          receipts.items[reply.msgUid] = { at: now, phone };
          const records = await recordsOf(tx, phone);
          if (unconsumed(records).length >= limits.memberCount) return { status: "full" as const };
          const attachment: Attachment = {
            id: newAttachmentId(), msgUid: reply.msgUid, receivedAt, epoch: this.#runtimes.get(scopeKey(space))!.epoch, fileId: event.fileId, kind: event.kind,
            name: event.name, ...(event.size === undefined ? {} : { size: event.size }), ...(event.mimeType ? { mimeType: event.mimeType } : {}),
            reply: structuredClone(reply), state: "pending", at: now,
          };
          // Like an inbox item, an attachment behind an admitted /stop or /clear boundary is cancelled by it.
          if (receivedAt <= (member.cancelBefore ?? -Infinity)) attachment.state = "void";
          else if (downloads === undefined) Object.assign(attachment, { state: "rejected", error: "当前服务未开启附件接收" });
          records.attachments[attachment.id] = attachment;
          return { status: "added" as const, attachment: { ...attachment, reply: { ...attachment.reply } } };
        }, this.#context);
      } finally { handle.release(); }
      this.#remember(reply.msgUid);
      if (outcome.status === "duplicate") return { status: "duplicate" };
      if (outcome.status === "full") {
        return { status: "full", message: `未接收${attachmentLabel(event)}：你还有 ${limits.memberCount} 个附件尚未处理，请先发消息说明要怎么处理。` };
      }
      const { attachment } = outcome;
      if (attachment.state === "pending") {
        downloads!.schedule(space, phone, attachment.id);
        this.#track(this.#notify(reply, `已收到${attachmentLabel(attachment)}，请说明要怎么处理。`));
      } else if (attachment.state === "rejected") this.#track(this.#notify(reply, `未接收${attachmentLabel(attachment)}：${attachment.error}。`));
      return { status: "accepted" };
    } finally {
      member.uses--;
      release?.();
      this.#pruneMember(member);
    }
  }

  /** Voided attachments: stop their downloads and remove their files (best effort; the tmp archive takes what is left). */
  #discard(space: Scope, phone: string, voided: readonly Attachment[]): void {
    if (!voided.length) return;
    const ids = voided.map(attachment => attachment.id);
    this.#downloads?.cancel(ids);
    this.#track(removeAttachmentFiles(userTmp(this.#options.layout, space, phone), ids).catch(error => this.#report(error)));
  }

  // ---- controls -------------------------------------------------------------------------------------------------------

  /**
   * A slash command; its receipt is sent to the command's reply context (best effort) once it has run. Resolves to the
   * receipt text, "" when nothing was sent (a redelivered command). The member's
   * command order is taken synchronously: call it in arrival order.
   */
  async control(message: Inbound, onAdmitted?: () => void): Promise<string> {
    this.#assertRunning();
    const member = this.#member(message.scope, message.phone);
    member.uses++;
    try { return await this.#controlMessage(member, message, onAdmitted); }
    finally { member.uses--; this.#pruneMember(member); }
  }

  async #controlMessage(member: MemberState, message: Inbound, onAdmitted?: () => void): Promise<string> {
    const { phone, scope, content, reply: context } = message;
    const command = canonicalCommand(content);
    const receivedAt = this.#arrival();
    member.lastUsed = Date.now();
    if (this.#seen.has(context.msgUid) && ["/stop", "/clear", "/compact"].includes(command)) return "";
    let reply: string;
    if (command === "/stop" || command === "/clear") {
      // A duplicate is known only after the receipt check. Until then the hold only keeps new work from starting; a run
      // that settles meanwhile waits for the decision (#settle), so a redelivered command cannot cancel its reply.
      const release = this.#hold(member);
      const decision = Promise.withResolvers<void>();
      member.deciding.add(decision.promise);
      const decided = () => { member.deciding.delete(decision.promise); decision.resolve(); };
      const receipt: ControlReceipt = { scope, phone, requestId: `ctl:${randomUUID()}` };
      this.#receipts.set(receipt.requestId, receipt);
      receipt.ticket = this.#runtimes.get(scopeKey(scope))?.door.controlReceived(phone, receipt.requestId);
      // Reserve this member's order before any await; slower identity/open steps cannot reorder controls.
      const run = member.controls.then(async () => {
        await this.#yieldToReclamation(scope);
        await ensureStorageIdentity(this.#options.layout, scope, phone, this.#options.stateDb);
        return this.#control(member, command, receivedAt, receipt, context, decided, onAdmitted);
      });
      member.controls = run.catch(() => {});
      let admitted: boolean;
      try {
        admitted = await run;
      } finally {
        decided();
        this.#receipts.delete(receipt.requestId);
        if (receipt.ticket) this.#runtimes.get(scopeKey(scope))?.door.controlDropped(receipt.ticket);
        release();
      }
      if (!admitted) return "";
      reply = await this.#controlReceipt(member, command);
    } else if (command === "/compact") {
      // Reserve command order before any await. Only admission is serialized; waiting for a summary must not block stop.
      const admission = member.controls.then(async () => {
        await this.#yieldToReclamation(scope);
        await ensureStorageIdentity(this.#options.layout, scope, phone, this.#options.stateDb);
        const handle = await this.#spaces.acquire(scope);
        try {
          await member.replaying;
          const conversation = await this.#conversation(handle.harness, member);
          const queued = await handle.harness.commit(async tx => {
            const receipts = await tx.doc(ReceiptsDoc);
            if (receipts.items[context.msgUid]) return undefined;
            receipts.items[context.msgUid] = { at: Date.now(), phone };
            return queueManualCompaction(tx, conversation.id);
          }, this.#context);
          this.#remember(context.msgUid);
          return { handle, queued };
        } catch (error) { handle.release(); throw error; }
      });
      member.controls = admission.then(() => {}, () => {});
      const { handle, queued } = await admission;
      try {
        if (queued === undefined) return "";
        onAdmitted?.();
        const outcome = queued.submissionId !== undefined
          ? { status: "completed" as const, result: { submissionId: queued.submissionId, entryId: undefined } }
          : (await handle.harness.waitForTask(queued.taskId, this.#context)).state.outcome;
        const library = scope.kind === "direct" ? "单聊库" : "群库";
        if (outcome.status !== "completed") {
          reply = "⚠️ 本次会话压缩未完成，原会话仍保留；可用 /status 查看状态。";
        } else if (outcome.result.entryId !== undefined) {
          // A compaction owned by a generation places its entry in the task's terminal commit.
          reply = `📦 会话压缩已完成，摘要已写入会话，聊天记录仍保留在${library}里。`;
        } else if (outcome.result.submissionId === undefined) {
          reply = "📦 本次无需压缩，当前会话没有可压缩的历史。";
        } else {
          // Task completion only generated a summary. Placement is a separate durable submission.
          const summary = await handle.harness.submission(outcome.result.submissionId, this.#context);
          if (!summary) throw new Error("压缩摘要提交不存在，无法确认已写入会话");
          const placed = await summary.wait(this.#context);
          reply = placed.status === "done"
            ? `📦 会话压缩已完成，摘要已写入会话，聊天记录仍保留在${library}里。`
            : "⚠️ 压缩摘要未写入会话（已过期或取消），原会话仍保留；可用 /status 查看状态。";
        }
        await this.#syncStats(handle.harness, member);
      } finally { handle.release(); }
    } else if (command === "/status") {
      onAdmitted?.();
      reply = await this.#status(member);
    } else {
      onAdmitted?.();
      reply = command === "/help" ? HELP_TEXT : unknownCommandText(content);
    }
    await this.#notify(context, reply);
    return reply;
  }

  /**
   * Commit the control (with its receipt) to the stream, execute it, commit its removal; the door holds the member's
   * requests meanwhile. False for a redelivered command: nothing was done. `decided` is called once the receipt check
   * is known: after the cancellation boundary is set, or for a redelivery.
   */
  async #control(member: MemberState, command: ControlCommand, receivedAt: number, receipt: ControlReceipt, reply: ReplyContext,
    decided: () => void, onAdmitted?: () => void): Promise<boolean> {
    const handle = await this.#spaces.acquire(member.scope);
    try {
      await member.replaying;
      this.#assertRunning();
      const { harness } = handle;
      const door = this.#runtimes.get(scopeKey(member.scope))!.door;
      const { requestId } = receipt;
      const ticket = receipt.ticket!;
      try {
        const admitted = await harness.commit(async (tx) => {
          const receipts = await tx.doc(ReceiptsDoc);
          if (receipts.items[reply.msgUid]) return undefined;
          receipts.items[reply.msgUid] = { at: Date.now(), phone: member.phone };
          const controls = await tx.doc(ControlsDoc);
          controls.seq++;
          controls.pending.push({ phone: member.phone, requestId, seq: controls.seq, command, receivedAt, epoch: controls.epoch ?? 0, reply: structuredClone(reply) });
          // A stop or clear ends the sending of earlier replies too; what is left of them is dropped.
          const now = Date.now(), withdrawn: string[] = [];
          for (const record of Object.values((await recordsOf(tx, member.phone)).requests)) {
            if (record.delivery && undelivered(record)) { record.delivery.abandoned = { at: now, reason: "withdrawn" }; withdrawn.push(record.requestId); }
          }
          return { seq: controls.seq, withdrawn };
        }, this.#context);
        this.#remember(reply.msgUid);
        if (admitted === undefined) { decided(); return false; }
        const { seq, withdrawn } = admitted;
        member.withdrawals++;
        door.controlAdmitted(ticket, seq);
        member.cancelBefore = Math.max(member.cancelBefore ?? -Infinity, receivedAt);
        decided();
        // Each withdrawn delivery is looked at once more under the delivery lock (after a send in flight): that frees its snapshots.
        for (const id of withdrawn) this.#track(this.#autoDeliver(member, id));
      } catch (error) {
        await door.controlUncertain(ticket, async () =>
          (await pendingControls(harness, this.#context)).find((control) => control.requestId === requestId)?.seq);
        throw error;
      }
      onAdmitted?.();
      await this.#execute(harness, member, command, requestId, reply);
      return true;
    } finally { handle.release(); }
  }

  /**
   * Run a control that is in the stream, then remove it (idempotent: startup runs waiting ones again). It cancels the
   * messages received before it; later ones (admitted while it waited or ran) stay.
   */
  async #execute(harness: Harness, member: MemberState, command: ControlCommand, requestId: string, reply: ReplyContext | undefined): Promise<void> {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.#executeOnce(harness, member, command, requestId);
          member.controlRetry = undefined;
          return;
        } catch (error) {
          if (this.#closing.signal.aborted) throw error;
          const delay = retryDelay(attempt);
          member.controlRetry = { attempt: attempt + 1, nextAt: Date.now() + delay, message: String(error) };
          this.#report(error);
          if (attempt === 0 && reply) await this.#notify(reply, "控制操作暂未完成，将自动重试；完成前暂停本会话的新任务。可用 /status 查看。");
          await retryWait(delay, this.#closing.signal);
        }
      }
    } finally { this.#kick(member); }
  }

  async #executeOnce(harness: Harness, member: MemberState, command: ControlCommand, requestId: string): Promise<void> {
    const door = this.#runtimes.get(scopeKey(member.scope))!.door;
    // The caller holds the worker (#hold). A start that passed the gate before is finished first: its item arrived
    // before this control, so the cancel below covers it and the abort reaches its run.
    await waitFor(member.starting ?? Promise.resolve(), this.#closing.signal);
    const pending = (await pendingControls(harness, this.#context)).find((control) => control.requestId === requestId);
    if (pending === undefined) { door.controlExecuted(requestId); return; }
    // The in-memory state of an idle member may have been dropped; the persisted conversation is still the member's.
    member.conversationId ??= (await harness.snapshot(MemberDirectory, member.phone, this.#context))?.conversationId;
    const conversation = member.conversationId === undefined ? undefined
      : await harness.conversation(member.conversationId as ConversationId, this.#context);
    if (conversation !== undefined) {
      const voided = await harness.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const cancelled = new Set<string>();
        for (const item of inbox.items) if (receivedBefore(item, pending)) { item.cancelled = true; cancelled.add(item.requestId); }
        // Attachments go with the requests that bound them; a /clear also voids the unbound ones received before it.
        return voidWhere(await recordsOf(tx, member.phone), attachment => attachment.boundTo !== undefined ? cancelled.has(attachment.boundTo)
          : command === "/clear" && arrivedBefore(attachment, pending), Date.now());
      }, this.#context);
      // Resolves once the conversation is idle: the run, its tools and codemode sub-calls have ended.
      await conversation.abort(this.#context, { background: true });
      this.#discard(member.scope, member.phone, voided);
      // abort() withdraws queued inputs, but passive summary writes survive it. Cancel those through the public
      // submission lifecycle as part of the replayable control, so waiting compact commands can settle truthfully.
      const queued = (await harness.snapshot(PiInboxDoc, conversation.id, this.#context))?.items ?? [];
      for (const item of queued) if (item.mode === "write" && item.entry.kind === CompactionEntry.kind) {
        const summary = await harness.submission(item.id, this.#context);
        await summary?.abort(this.#context);
      }
      if (command === "/clear") {
        if (pending.resetDone !== true) {
          await conversation.reset(undefined, this.#context);
          await conversation.waitForIdle(this.#context);
          await harness.commit(async (tx) => {
            const stored = (await tx.doc(ControlsDoc)).pending.find((control) => control.requestId === requestId);
            if (stored) stored.resetDone = true;
          }, this.#context);
        }
        // A clear can overlap another member's run. Record expiry here; an idle group sweep checks
        // every member/fork and the run records before touching bytes.
        await harness.commit(tx => requestMemberExpiry(tx, member.phone), this.#context);
        await this.#syncStats(harness, member);
      }
    }
    await harness.commit(async (tx) => {
      const controls = await tx.doc(ControlsDoc);
      controls.pending = controls.pending.filter((control) => control.requestId !== requestId);
    }, this.#context);
    door.controlExecuted(requestId);
  }

  /** Hold the member's worker until the returned release is called (several holds stack). */
  #hold(member: MemberState, resumeWork = true): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    const previous = member.gate;
    const gate = previous === undefined ? promise : Promise.all([previous, promise]).then(() => {});
    member.gate = gate;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolve();
      void gate.then(() => {
        if (member.gate === gate) member.gate = undefined;
        if (resumeWork) this.#kick(member);
        this.#pruneMember(member);
      });
    };
  }
  #yieldToReclamation(scope: Scope): Promise<void> {
    return (async () => {
      for (let gate; (gate = this.#reclaiming.get(scopeKey(scope)));) { gate.yield = true; await waitFor(gate.promise, this.#closing.signal); }
    })();
  }

  #remember(msgUid: string): void {
    if (this.#seen.size >= SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value!);
    this.#seen.add(msgUid);
  }

  // ---- workers --------------------------------------------------------------------------------------------------------

  #kick(member: MemberState): void {
    if (this.#closing.signal.aborted || member.conversationId === undefined) return;
    if (this.#reclaiming.has(scopeKey(member.scope))) return;
    if (member.worker !== undefined) { member.again = true; return; }
    member.again = false;
    const worker = this.#work(member).catch((error) => { if (!this.#closing.signal.aborted) this.#report(error); })
      .finally(() => {
        member.worker = undefined;
        if (member.again) this.#kick(member);
        this.#pruneMember(member);
      });
    member.worker = worker;
    this.#track(worker);
  }

  async #work(member: MemberState): Promise<void> {
    let failures = 0;
    for (;;) {
      const progress = member.workProgress;
      try {
        await this.#drain(member);
        member.workerRetry = undefined;
        return;
      } catch (error) {
        if (this.#closing.signal.aborted) return;
        if (member.workProgress !== progress) failures = 0;
        const delay = retryDelay(failures++);
        member.workerRetry = { attempt: failures, nextAt: Date.now() + delay, message: String(error) };
        this.#report(error);
        try { await retryWait(delay, this.#closing.signal); } catch { return; }
      }
    }
  }

  async #drain(member: MemberState): Promise<void> {
    for (;;) {
      if (this.#closing.signal.aborted) return;
      const handle = await this.#spaces.acquire(member.scope);
      try {
        const { harness } = handle;
        const conversation = await harness.conversation(member.conversationId as ConversationId, this.#context);
        if (conversation === undefined) return;
        let head = (await inboxItems(harness, conversation.id, this.#context))[0];
        if (head === undefined) return;
        if (head.startedAt !== undefined && head.cancelled !== true && member.current?.requestId !== head.requestId) {
          member.current = { requestId: head.requestId, startedAt: head.startedAt };
        }
        if (head.cancelled !== true && member.gate !== undefined) {
          await waitFor(member.gate, this.#closing.signal);
          continue;
        }
        if (head.cancelled !== true && head.startedAt === undefined && await this.#awaitAttachments(harness, member, head.requestId)) continue;
        // A restored inbox may exceed a newly lowered limit. Preserve it, but run only the allowed number of heads.
        await this.#enterRun(member);
        try {
          // A control may have cancelled the head while it waited for a slot; never submit the stale snapshot.
          const current = (await inboxItems(harness, conversation.id, this.#context))[0];
          if (current?.requestId !== head.requestId) continue;
          head = current;
          if (head.cancelled !== true && member.gate !== undefined) continue;
          // No await between the gate check and this mark: a control arriving from here on waits for the submission.
          const { promise: started, resolve: startedDone } = Promise.withResolvers<void>();
          member.starting = started;
          try {
            await this.#process(harness, conversation, member, head, () => { if (member.starting === started) member.starting = undefined; startedDone(); });
            member.workProgress++;
            member.workerRetry = undefined;
          } finally {
            if (member.current?.requestId === head.requestId) member.current = undefined;
            this.#attachmentWaits.delete(head.requestId);
            clearRunning(member.scope, member.phone, taskNumber(head.requestId));
            if (member.starting === started) member.starting = undefined;
            startedDone();
            member.lastUsed = Date.now();
            if (this.#requests.get(head.requestId)?.retired) this.#dropRequest(head.requestId);
          }
        } finally { this.#leaveRun(member); }
      } finally { handle.release(); }
    }
  }

  /**
   * Before a request starts, wait for the downloads it bound, up to the limit counted from its first wait in this
   * process. True when it waited (the caller reads its inbox again); a control arriving meanwhile ends the wait.
   */
  async #awaitAttachments(harness: Harness, member: MemberState, requestId: string): Promise<boolean> {
    for (let waited = false; ; waited = true) {
      const records = await memberRecords(harness, member.phone, this.#context);
      if (!Object.values(records.attachments).some(attachment => attachment.boundTo === requestId && attachment.state === "pending")) return waited;
      const now = Date.now();
      let deadline = this.#attachmentWaits.get(requestId);
      if (deadline === undefined) this.#attachmentWaits.set(requestId, deadline = now + (this.#downloads?.limits ?? ATTACHMENT_LIMITS).waitMs);
      if (now >= deadline || member.gate !== undefined || this.#closing.signal.aborted) return waited;
      await Bun.sleep(Math.min(200, deadline - now));
    }
  }

  /** The member's text and what the request bound; a ready file that is gone is reported as such. */
  async #requestContent(records: Readonly<MemberRecords>, item: InboxItem): Promise<string> {
    const bound = Object.values(records.attachments).filter(attachment => attachment.boundTo === item.requestId && attachment.state !== "void")
      .sort((a, b) => a.epoch - b.epoch || a.receivedAt - b.receivedAt);
    const shown = await Promise.all(bound.map(async attachment => {
      if (attachment.state !== "ready") return attachment;
      try { await access(attachment.path!); return attachment; }
      catch { return { ...attachment, state: "failed" as const, error: "文件已被清理" }; }
    }));
    return item.content + attachmentPrompt(shown);
  }

  /** Run one inbox item; `submitted` is called once its submission exists (or nothing will be submitted). */
  async #process(harness: Harness, conversation: Conversation, member: MemberState, item: InboxItem, submitted: () => void): Promise<void> {
    const records = await memberRecords(harness, member.phone, this.#context);
    const record = records.requests[item.requestId];
    if (record === undefined) {
      // Admission commits the item with its record; without one there is nowhere to answer.
      submitted();
      await this.#close(harness, member, conversation.id, item.requestId, { cancelled: true });
      this.#report(new Error(`任务记录缺失，已移除 - ${taskText(member, item.requestId)}`));
      return;
    }
    const reply = record.reply;
    const previous = item.startedAt !== undefined || item.cancelled === true
      ? await harness.commit((tx) => tx.submissionByRequest(conversation.id, item.requestId), this.#context) : undefined;
    if (previous?.status === "done" || previous?.status === "unanswered") {
      // A result settled before recovery still belongs to that submission; offline time does not invalidate it.
      // A recovered invocation refused by the door may already have settled while the worker read its inbox.
      if (member.current?.deadlineError) this.#markAborted(member, previous.id.toString(), member.current.deadlineError, member.current.startedAt);
      submitted();
      await this.#settle(harness, conversation, member, item, previous);
      return;
    }
    const expired = item.cancelled === true ? undefined : this.#totalTimeout(item.requestId, item.startedAt);
    if ((item.cancelled === true || expired !== undefined) && previous === undefined) {
      // The first-start timestamp can be committed just before a crash that left no Durable submission.
      submitted();
      const delivery = expired === undefined ? undefined : failureDelivery(reply, describeRequestFailure(expired.error), [], Date.now());
      const stopped = await this.#close(harness, member, conversation.id, item.requestId, { cancelled: item.cancelled === true, ...(delivery ? { delivery } : {}) });
      if (delivery && !stopped) await this.#autoDeliver(member, item.requestId);
      return;
    }
    if (expired && previous) {
      // The door already has the persisted deadline, so recovered model/tools cannot leave while this abort commits.
      this.#markAborted(member, previous.id.toString(), expired, item.startedAt!);
      await conversation.abort(this.#context);
    }
    const startedAt = item.startedAt ?? Date.now();
    if (item.startedAt === undefined) {
      await harness.commit(async (tx) => {
        const stored = (await tx.doc(InboxDoc, conversation.id)).items.find((each) => each.requestId === item.requestId);
        if (stored !== undefined) stored.startedAt = startedAt;
      }, this.#context);
      // No "working on it" notice; only a message redelivered after an outage says why its answer comes late.
      const late = lateMinutes(reply);
      if (late !== undefined) this.#track(sendNotice(this.#outbound, reply, lateNotice(late), { signal: this.#closing.signal }).catch(() => false));
    }
    if (member.current?.requestId !== item.requestId) member.current = { requestId: item.requestId, startedAt };
    markRunning(member.scope, member.phone, taskNumber(item.requestId));
    this.#log(`任务开始 - ${taskText(member, item.requestId)}, 总时限: ${this.#limits.runTimeoutMs / 1000}秒, ` +
      `模型无进展时限: ${this.#limits.modelIdleMs / 1000}秒, 单次模型响应时限: ${this.#limits.modelResponseMs / 1000}秒`);
    let settled: SettledSubmissionRecord;
    try {
      // Durable admits a known requestId once: after a crash this finds the same submission.
      const content = await this.#requestContent(records, item);
      const submission = await conversation.submit({ type: "input", content, requestId: item.requestId }, this.#context);
      submitted();
      settled = await this.#watch(harness, conversation, member, submission, item.cancelled === true ? undefined : startedAt);
      await this.#settle(harness, conversation, member, item, settled);
    } finally { member.current = undefined; clearRunning(member.scope, member.phone, taskNumber(item.requestId)); }
  }

  /** Wait for the submission to settle, aborting the run when a limit is reached. */
  async #watch(harness: Harness, conversation: Conversation, member: MemberState, submission: Submission,
    startedAt: number | undefined): Promise<SettledSubmissionRecord> {
    const waiting = submission.wait(this.#context);
    let attempt: { key: string; since: number; progress: string; changed: number } | undefined;
    let beat = Date.now();
    const task = taskNumber(member.current?.requestId ?? "");
    for (;;) {
      const expired = this.#totalTimeout(member.current?.requestId ?? "", startedAt);
      if (expired && !member.aborted.has(submission.id.toString())) {
        this.#markAborted(member, submission.id.toString(), expired, startedAt!);
        await conversation.abort(this.#context);
      }
      const tick = Bun.sleep(this.#limits.tickMs).then(() => undefined);
      const settled = await Promise.race([waiting, tick]);
      if (settled !== undefined) {
        // A fast terminal response can win the race after the deadline, before the next watchdog tick.
        const expired = this.#totalTimeout(member.current?.requestId ?? "", startedAt);
        if (expired) this.#markAborted(member, submission.id.toString(), expired, startedAt!);
        return settled;
      }
      if (startedAt === undefined || member.aborted.has(submission.id.toString())) continue;
      const now = Date.now();
      let reason: AbortReason | undefined;
      if (now - startedAt >= this.#limits.runTimeoutMs) {
        reason = this.#totalTimeout(member.current?.requestId ?? "", startedAt, now);
      } else {
        const live = await harness.snapshot(LiveDoc, conversation.id, this.#context);
        const model = modelActivity(live);
        if (now - beat >= this.#limits.heartbeatMs) {
          beat = now;
          this.#log(`任务仍在运行 - ${taskText(member, member.current?.requestId ?? "")}, 已用: ${Math.floor((now - startedAt) / 1000)}秒, 阶段: ${livePhase(live)}`);
        }
        if (model === undefined) attempt = undefined;
        else {
          if (attempt?.key !== model.key) attempt = { key: model.key, since: now, progress: model.progress, changed: now };
          else if (attempt.progress !== model.progress) { attempt.progress = model.progress; attempt.changed = now; }
          if (now - attempt.since > this.#limits.modelResponseMs) {
            reason = { kind: "model_response_timeout", error: new Error(`单次模型响应时限 ${this.#limits.modelResponseMs / 1000} 秒已到（任务：${task}）`) };
          } else if (now - attempt.changed > this.#limits.modelIdleMs) {
            reason = { kind: "model_idle", error: new Error(`模型连续 ${this.#limits.modelIdleMs / 1000} 秒无有效进展（任务：${task}）`) };
          }
        }
      }
      if (reason !== undefined) {
        this.#markAborted(member, submission.id.toString(), reason, startedAt);
        await conversation.abort(this.#context);
      }
    }
  }

  #totalTimeout(requestId: string, startedAt: number | undefined, now = Date.now()): AbortReason | undefined {
    if (startedAt === undefined || now - startedAt < this.#limits.runTimeoutMs) return;
    return { kind: "task_timeout", error: new Error(`任务总时限 ${this.#limits.runTimeoutMs / 1000} 秒已到（任务：${taskNumber(requestId)}）`) };
  }

  #markAborted(member: MemberState, id: string, reason: AbortReason, startedAt: number): void {
    if (member.aborted.has(id)) return;
    member.aborted.set(id, reason);
    this.#log(`${ABORT_LABELS[reason.kind]} - ${taskText(member, member.current?.requestId ?? "")}, 已用: ${Math.floor((Date.now() - startedAt) / 1000)}秒, 取消原因: ${reason.kind}`);
  }

  /**
   * The run is over: in one commit the inbox item goes and the record gets its delivery plan (reply, failure, or the
   * closeout fallback); then the plan is sent. No crash window loses the result or sends it twice.
   */
  async #settle(harness: Harness, conversation: Conversation, member: MemberState, item: InboxItem, settled: SettledSubmissionRecord): Promise<void> {
    // The worker's item predates controls. Re-read cancellation after the invocation has settled, once every /stop or
    // /clear received so far is known to be new (it sets cancelBefore) or a redelivery (it changes nothing).
    await this.#controlsDecided(member, item);
    const current = (await inboxItems(harness, conversation.id, this.#context)).find(x => x.requestId === item.requestId);
    const cancelled = current?.cancelled === true || (member.cancelBefore ?? -Infinity) >= item.receivedAt;
    const aborted = member.aborted.get(settled.id.toString());
    member.aborted.delete(settled.id.toString());
    const record = (await memberRecords(harness, member.phone, this.#context)).requests[item.requestId];
    if (record === undefined) throw new Error(`任务记录缺失 - ${taskText(member, item.requestId)}`);
    const now = Date.now();
    let failure: string | undefined;
    let delivery: Delivery | undefined;
    if (cancelled) {
      // Explicit cancellation wins over a watchdog firing at the same time.
    } else if (aborted !== undefined) {
      failure = describeRequestFailure(aborted.error);
    } else if (settled.status === "done" && item.cancelled !== true) {
      const answer = settled.type === "input" && settled.answer !== undefined
        ? await harness.commit(async (tx) => (await tx.entry(AssistantEntry, settled.answer!))?.model?.[0] as AssistantMessage | undefined, this.#context)
        : undefined;
      const text = textOf(answer);
      if (!text && !record.notes.length) failure = describeRequestFailure(new Error("Pi 未返回回复"));
      else delivery = replyDelivery(record.reply, text || "文件链接已生成。", record.notes, now);
    } else if (settled.status === "unanswered" && settled.reason !== "aborted" && item.cancelled !== true) {
      failure = describeRequestFailure(await this.#failure(harness, conversation, settled));
    }
    if (failure !== undefined) {
      if (this.#options.closeout && !this.#closing.signal.aborted) {
        await this.#controlsDecided(member, item);
        const latest = (await inboxItems(harness, conversation.id, this.#context)).find(x => x.requestId === item.requestId);
        // A control that arrived while the candidates were checked cancels the fallback too.
        if (!latest?.cancelled && (member.cancelBefore ?? -Infinity) < item.receivedAt) {
          delivery = await this.#fallback(record, failure, this.#options.closeout.fallbackMs, now);
        }
      } else delivery = failureDelivery(record.reply, failure, record.notes, now);
    }
    // A control that arrived while the plan was prepared decides first; one committed meanwhile is found by #close.
    await this.#controlsDecided(member, item);
    const stopped = await this.#close(harness, member, conversation.id, item.requestId,
      { cancelled: cancelled || (member.cancelBefore ?? -Infinity) >= item.receivedAt, ...(delivery ? { delivery } : {}) });
    await this.#syncStats(harness, member);
    this.#log(`任务结束 - ${taskText(member, item.requestId)}, 结果: ${settled.status}${"reason" in settled && settled.reason ? `/${settled.reason}` : ""}`);
    if (delivery && !stopped) await this.#autoDeliver(member, item.requestId);
  }

  /**
   * Wait until no /stop or /clear of the member is before its receipt check, unless one already admitted covers the item.
   * The checks never wait for the worker, so a settling run cannot deadlock with them.
   */
  async #controlsDecided(member: MemberState, item: InboxItem): Promise<void> {
    while (member.deciding.size && (member.cancelBefore ?? -Infinity) < item.receivedAt) {
      await waitFor(Promise.race(member.deciding), this.#closing.signal);
    }
  }

  /** The closeout fallback: the failure, what the run registered, and the files themselves. */
  async #fallback(record: Readonly<RequestRecord>, failure: string, fallbackMs: number, now: number): Promise<Delivery> {
    const candidates = await this.#validCandidates(record);
    const descriptions = candidates.map(x => {
      const file = record.files.find(f => f.sha256 === x.sha256);
      const status = file?.state === "sent" ? "；该版本已在任务中发出" : file?.state === "uncertain" || file?.state === "sending" ? "；该版本可能已发出" : "";
      return `· 《${x.name}》— ${x.status === "checked" ? "已检查版本" : "草稿"}；文件结构完整；检查记录（模型登记）：${x.checked.join("、") || "未登记"}；未检查：${x.unchecked.join("、") || "未登记"}；已知问题：${x.issues.join("、") || "无登记"}${status}。`;
    });
    const rejected = record.deliverables.some(x => x.status === "rejected" || !x.complete);
    const text = [failure, candidates.length ? "系统将交付本任务已登记的可用版本：" : "本任务没有可交付的已登记版本。",
      ...descriptions, rejected ? "存在已知错误或不完整的版本，未作为交付候选。" : "",
      candidates.some(x => x.status === "draft") ? "这是未完成全部检查的草稿，请核对后使用。" : ""].filter(Boolean).join("\n");
    const delivery = failureDelivery(record.reply, text, record.notes, now);
    candidates.forEach((x, index) => {
      const sent = record.files.find(f => f.sha256 === x.sha256)?.state;
      delivery.parts.push({ id: `f${index}`, kind: "file", file: { name: x.name, path: x.path, size: x.size, sha256: x.sha256 },
        state: sent === "sent" ? "sent" : sent === "uncertain" || sent === "sending" ? "uncertain" : "pending", attempts: 0 });
    });
    return { ...delivery, kind: "fallback", deadline: now + fallbackMs };
  }

  /** Per slot the best complete, not rejected version whose snapshot still matches: checked before draft, newest first. */
  async #validCandidates(record: Readonly<RequestRecord>): Promise<RequestRecord["deliverables"]> {
    const all = record.deliverables, rejected = new Set(all.filter(x => x.status === "rejected").map(x => x.sha256));
    const selected: RequestRecord["deliverables"] = [];
    for (const slot of new Set(all.map(x => x.slot))) {
      const versions = all.filter(x => x.slot === slot && x.complete && !rejected.has(x.sha256)).sort((a, b) =>
        Number(b.status === "checked") - Number(a.status === "checked") || b.seq - a.seq);
      for (const version of versions) {
        try { if (await fileDigest(version.path, this.#closing.signal) === version.sha256) { selected.push(version); break; } }
        catch { this.#closing.signal.throwIfAborted(); }
      }
    }
    return selected;
  }

  /** The model error of an unanswered input, for a member reply. */
  async #failure(harness: Harness, conversation: Conversation, settled: SettledSubmissionRecord): Promise<Error> {
    const reason = "reason" in settled ? settled.reason : "unknown";
    // A blocking compaction that did not complete ends the run before any model request: Durable settles the input
    // `model_error` with "Compaction failed: …" (or "… was aborted") as its detail, and keeps the newest failure, with its
    // task and kind, in the live document. Checked first: the newest assistant entry then belongs to an earlier turn.
    const detail = "detail" in settled && typeof settled.detail === "string" ? settled.detail : undefined;
    if (reason === "model_error" && detail?.startsWith("Compaction ")) {
      const compaction = (await harness.snapshot(LiveDoc, conversation.id, this.#context))?.compactionFailure;
      const which = compaction === undefined ? "" : `任务 ${compaction.taskId}，${compactionReasonText(compaction.reason)}；`;
      return new Error(`模型未能回答：会话历史压缩未完成（${which}${detail}）`);
    }
    const page = await conversation.entries({}, 20, undefined, this.#context);
    const last = page.items.find((entry) => AssistantEntry.is(entry))?.model?.[0] as AssistantMessage | undefined;
    if (last?.errorMessage) return modelRequestError(last.errorMessage, [last], this.#options.selection.model.contextWindow);
    return new Error(`模型未能回答（${reason}）`);
  }

  /**
   * Remove the inbox item and close its record (with the delivery plan, when there is one) in one commit. A /stop or
   * /clear committed before this commit cancels the item even if it has not run yet: the plan is dropped. A later one
   * withdraws the plan itself. True when the item closed as cancelled.
   */
  async #close(harness: Harness, member: MemberState, conversationId: number, requestId: string,
    outcome: { cancelled?: boolean; delivery?: Delivery }): Promise<boolean> {
    let cancelled = outcome.cancelled === true;
    await harness.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversationId as ConversationId);
      const stored = inbox.items.find((item) => item.requestId === requestId);
      const controls = (await tx.doc(ControlsDoc)).pending;
      cancelled = outcome.cancelled === true || stored?.cancelled === true
        || (stored !== undefined && controls.some((control) => control.phone === member.phone && receivedBefore(stored, control)));
      inbox.items = inbox.items.filter((item) => item.requestId !== requestId);
      const records = await recordsOf(tx, member.phone);
      const now = Date.now();
      const record = records.requests[requestId];
      if (record !== undefined && record.closedAt === undefined) {
        record.closedAt = now;
        if (cancelled) record.cancelled = true;
        else if (outcome.delivery) record.delivery = structuredClone(outcome.delivery);
      }
      pruneRecords(records, now, this.#settled);
    }, this.#context);
    const request = this.#requests.get(requestId);
    if (request) request.retired = true;
    await this.#releaseSnapshots(harness, member, requestId);
    return cancelled;
  }

  async #releaseSnapshots(harness: Harness, member: MemberState, requestId: string): Promise<void> {
    try {
      const record = (await memberRecords(harness, member.phone, this.#context)).requests[requestId];
      if (record?.closedAt === undefined) return;
      await deleteSnapshots(releasableSnapshots(record), userTmp(this.#options.layout, member.scope, member.phone));
    } catch (error) { if (!this.#closing.signal.aborted) this.#report(error); }
  }

  // ---- delivery -------------------------------------------------------------------------------------------------------

  /**
   * Send what is due of a request's delivery under the member's delivery lock, then plan the next look: a failed part
   * is tried again when its wait is over, and the delivery is given up when its window ends.
   */
  async #autoDeliver(member: MemberState, requestId: string): Promise<void> {
    const key = `${member.key}\u0000${requestId}`;
    clearTimeout(this.#deliveryTimers.get(key));
    this.#deliveryTimers.delete(key);
    member.uses++;
    try {
      const release = await member.delivery.acquire(this.#closing.signal);
      try {
        const handle = await this.#spaces.acquire(member.scope);
        try {
          const next = await this.#sendDelivery(handle.harness, member, requestId);
          if (next !== undefined) this.#deliverAt(member, requestId, next);
        } finally { handle.release(); }
      } finally { release(); }
    } catch (error) {
      if (this.#closing.signal.aborted) return;
      this.#report(error);
      this.#deliverAt(member, requestId, Date.now() + deliveryRetryDelay(1, this.#limits.deliveryRetryMs));
    } finally { member.uses--; this.#pruneMember(member); }
  }

  /** One timer per delivery. It takes the member again when it fires: the in-memory state may be pruned meanwhile. */
  #deliverAt(member: MemberState, requestId: string, at: number): void {
    if (this.#closing.signal.aborted) return;
    const key = `${member.key}\u0000${requestId}`;
    clearTimeout(this.#deliveryTimers.get(key));
    const { scope, phone } = member;
    const timer = setTimeout(() => {
      this.#deliveryTimers.delete(key);
      if (!this.#closing.signal.aborted) this.#track(this.#autoDeliver(this.#member(scope, phone), requestId));
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.#deliveryTimers.set(key, timer);
  }

  /**
   * Send the due parts of one delivery, part by part. Resolves to when it needs another look (a retry, or the end of its
   * window), or undefined when nothing is left to do. A text part that is not sent holds the later ones: segments never
   * arrive out of order. Each attempt commits `sending` before the platform call.
   */
  async #sendDelivery(harness: Harness, member: MemberState, requestId: string): Promise<number | undefined> {
    const epoch = member.withdrawals;
    const read = async () => (await memberRecords(harness, member.phone, this.#context)).requests[requestId];
    const record = await read();
    if (record === undefined) return undefined;
    if (!undelivered(record)) { await this.#releaseSnapshots(harness, member, requestId); return undefined; }
    const end = deliveryEnd(record.delivery!, this.#limits.deliveryWindowMs);
    if (end <= Date.now()) { await this.#expire(harness, member, requestId); return undefined; }
    const signal = AbortSignal.any([this.#closing.signal, AbortSignal.timeout(end - Date.now())]);
    const due = (part: Readonly<DeliveryPart>) =>
      part.state === "pending" || (part.state === "failed" && part.retryAt !== undefined && part.retryAt <= Date.now());
    /** One part. "stop": later parts wait (a text segment never overtakes an earlier one); "abort": give up for now. */
    const step = async (planned: Readonly<DeliveryPart>, send?: Send): Promise<"next" | "stop" | "abort"> => {
      if (!openPart(planned)) return "next";
      if (!due(planned)) return planned.kind === "file" ? "next" : "stop";
      if (member.withdrawals !== epoch || signal.aborted) return "abort";
      const started = await harness.commit(async tx => {
        const stored = (await recordsOf(tx, member.phone)).requests[requestId]?.delivery;
        const part = stored?.parts.find(x => x.id === planned.id);
        if (stored?.abandoned !== undefined || part === undefined || !due(part)) return false;
        part.state = "sending"; part.attempts++; part.at = Date.now(); delete part.error; delete part.retryAt;
        return true;
      }, this.#context);
      if (!started) return "abort";
      const outcome = await this.#sendPart(member, record, planned, signal, send);
      const retryAt = await harness.commit(async tx => {
        const part = (await recordsOf(tx, member.phone)).requests[requestId]?.delivery?.parts.find(x => x.id === planned.id);
        if (part === undefined) return undefined;
        const now = Date.now();
        part.state = outcome.state; part.at = now;
        if (outcome.error === undefined) delete part.error; else part.error = outcome.error;
        if (outcome.state === "failed" && outcome.final !== true) part.retryAt = now + deliveryRetryDelay(part.attempts, this.#limits.deliveryRetryMs);
        return part.retryAt;
      }, this.#context);
      if (outcome.state === "sent") return "next";
      const result = outcome.state === "uncertain" ? "结果不确定，按已发出处理" : retryAt === undefined ? "失败，不再重试" : `失败，${Math.ceil((retryAt - Date.now()) / 1000)} 秒后重试`;
      this.#report(new Error(`交付${result} - ${taskText(member, requestId)}, 分段: ${planned.id}, ${outcome.error ?? ""}`));
      return retryAt !== undefined && planned.kind !== "file" ? "stop" : "next";
    };
    const parts = record.delivery!.parts;
    for (let index = 0; index < parts.length;) {
      let verdict: "next" | "stop" | "abort";
      if (parts[index]!.kind === "markdown") {
        // Consecutive text segments hold the conversation's send order: only the first carries the summary and @, so
        // another reply in the same group must not land between them. Files and link notes do not hold it (uploads).
        let last = index;
        while (last < parts.length && parts[last]!.kind === "markdown") last++;
        const run = parts.slice(index, last);
        index = last;
        verdict = await this.#outbound.sequence(targetOf(record.reply), async send => {
          for (const planned of run) {
            const each = await step(planned, send);
            if (each !== "next") return each;
          }
          return "next" as const;
        }, signal).catch(error => { if (signal.aborted) return "abort" as const; throw error; });
      } else verdict = await step(parts[index++]!);
      if (verdict !== "next") break;
    }
    if (this.#closing.signal.aborted) return undefined;
    const after = await read();
    if (after === undefined || !undelivered(after)) { await this.#releaseSnapshots(harness, member, requestId); return undefined; }
    const retries = after.delivery!.parts.flatMap(part => part.state === "failed" && part.retryAt !== undefined ? [part.retryAt] : []);
    // Without a retry due, what is left was cut off (the window's end, a concurrent change): look again shortly.
    return Math.min(retries.length ? Math.min(...retries) : Date.now() + 1000, end);
  }

  /** The window of a delivery passed with parts unsent: give it up and free the snapshots it kept. */
  async #expire(harness: Harness, member: MemberState, requestId: string): Promise<void> {
    const left = await harness.commit(async tx => {
      const record = (await recordsOf(tx, member.phone)).requests[requestId];
      if (record?.delivery === undefined || !undelivered(record)) return undefined;
      record.delivery.abandoned = { at: Date.now(), reason: "expired" };
      return record.delivery.parts.filter(openPart).length;
    }, this.#context);
    if (left === undefined) return;
    this.#attention.note("deliveryAbandoned", member.scope);
    this.#report(new Error(`交付超时放弃 - ${taskText(member, requestId)}, 未发出的分段: ${left}`));
    await this.#releaseSnapshots(harness, member, requestId);
  }

  /**
   * One platform send of a part. Never throws: a send that may have reached the platform is uncertain. A final failure
   * is one that sending again cannot fix (a missing note, an expired link, a changed or missing snapshot).
   */
  async #sendPart(member: MemberState, record: Readonly<RequestRecord>, part: Readonly<DeliveryPart>, signal: AbortSignal, held?: Send):
    Promise<{ state: "sent" | "failed" | "uncertain"; error?: string; final?: true }> {
    const reply = record.reply, target = targetOf(reply), options = { replyMsgId: reply.msgUid, signal };
    let dispatched = false;
    const settle = (outcome: SendOutcome) => outcome.status === "sent" ? { state: "sent" as const } : { state: outcome.status, error: outcome.reason };
    try {
      if (part.kind === "markdown") {
        dispatched = true;
        const message = replyMessage(reply, part.body ?? "", part.lead === true);
        return settle(await (held ? held(message, options) : this.#outbound.send(target, message, options)));
      }
      if (part.kind === "links") {
        // Each note is its own part and one platform message, so a confirmed note is never resent with a later one.
        const note = part.note === undefined ? undefined : record.notes[part.note];
        if (!note) return { state: "failed", error: "外链说明缺失", final: true };
        const segments = splitText(await this.#outbound.links([note], signal));
        if (segments.length !== 1) return { state: "failed", error: "外链说明超过单条消息上限", final: true };
        dispatched = true;
        return settle(await this.#outbound.send(target, textMessage(segments[0]!), options));
      }
      const file = part.file!;
      let digest: string;
      try { digest = await fileDigest(file.path, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "failed", error: "快照文件已不存在", final: true }; throw error; }
      if (digest !== file.sha256) return { state: "failed", error: "快照摘要不一致，拒绝发送", final: true };
      const transfer = await transferFile({ kind: "local", path: file.path, size: file.size }, file.name, {
        channel: sendChannel(this.#outbound, reply), relay: this.#options.relay, tempDir: userTmp(this.#options.layout, member.scope, member.phone),
      }, signal, () => { dispatched = true; });
      if (transfer.mode === "direct") return { state: "sent" };
      dispatched = true;
      return settle(await this.#outbound.send(target, textMessage(transfer.note), options));
    } catch (error) {
      if (error instanceof LinkUnavailable) return { state: "failed", error: error.message, final: true };
      const uncertain = error instanceof SendNotConfirmed ? error.uncertain : dispatched;
      return { state: uncertain ? "uncertain" : "failed", error: String(error) };
    }
  }

  /** The receipt of an executed /stop or /clear (also after a restart replayed it). */
  async #controlReceipt(member: MemberState, command: ControlCommand): Promise<string> {
    const here = member.scope.kind === "direct" ? "单聊" : "本群";
    return command === "/stop"
      ? `⏹ 已停止你在${here}的当前任务，并取消排队中的消息。已发出的内容不会撤回。`
      : `🧹 已为你在${here}开启新会话，下条消息从新会话开始，之前的聊天记录留在${member.scope.kind === "direct" ? "单聊库" : "群库"}里。其他人的聊天记录不受影响。`;
  }

  async #notify(reply: ReplyContext, text: string, mention = false): Promise<void> {
    const sent = await sendNotice(this.#outbound, reply, text, { mention, signal: this.#closing.signal })
      .catch((error) => { this.#report(error); return false; });
    if (!sent && !this.#closing.signal.aborted) this.#report(new Error(`回执未送达 - 会话: ${reply.receiveId}, 消息: ${reply.msgUid}`));
  }

  async #status(member: MemberState): Promise<string> {
    // Idle spaces are not discovered at startup. A status query must still see their durable member/expiry records.
    if (member.conversationId === undefined) {
      let exists = false;
      try {
        const info = await lstat(spaceDatabase(this.#options.layout, member.scope));
        if (!info.isFile()) throw new Error("会话库不是普通文件");
        exists = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (exists) {
        const handle = await this.#spaces.acquire(member.scope);
        try { member.conversationId = (await handle.harness.snapshot(MemberDirectory, member.phone, this.#context))?.conversationId; }
        finally { handle.release(); }
      }
    }
    let phase = "空闲";
    let waiting = 0;
    let tools = "暂无";
    let attachments = "";
    let compaction: string | undefined;
    let parked: string | undefined;
    if (member.conversationId !== undefined) {
      const handle = await this.#spaces.acquire(member.scope);
      try {
        const items = (await inboxItems(handle.harness, member.conversationId, this.#context)).filter((item) => item.cancelled !== true);
        const live = await handle.harness.snapshot(LiveDoc, member.conversationId as ConversationId, this.#context);
        if (member.gate !== undefined) phase = "正在执行 /stop 或 /clear";
        else if (member.workerRetry !== undefined) phase = "等待自动重试";
        else if (live?.run !== undefined) phase = live.tools?.some((slot) => slot.status === "running") ? "执行工具中" : "执行中";
        else if (items.length) phase = "准备中";
        waiting = Math.max(0, items.length - (member.current === undefined ? 0 : 1));
        const running = runningTools(live);
        if (running.length) tools = running.join("、");
        if (live?.compactions?.length) phase = "压缩会话历史";
        // Durable's crash-loop guard: a task cut off restartLimit times in a row without progress is not run again.
        const blocked = (await handle.harness.inspect(this.#context)).tasks.filter((task) => task.record.conversationId === member.conversationId
          && task.state.kind === "blocked" && task.state.reason === "restart_limit");
        if (blocked.length) {
          phase = "已停放";
          parked = `${blocked.map((task) => `${task.record.kind}#${task.record.id}`).join("、")}，运行中连续 ${Math.max(...blocked.map((task) => task.record.restarts ?? 0))} 次` +
            "被异常中断且没有进展，已停止自动重跑；发送 /stop 结束本次任务（或 /clear 重新开始）后可继续对话";
        }
        const failed = live?.compactionFailure;
        if (failed !== undefined) compaction = `任务 ${failed.taskId}，${compactionReasonText(failed.reason)}：${failed.error.slice(0, 300)}`;
        const waitingFiles = unconsumed(await memberRecords(handle.harness, member.phone, this.#context));
        if (waitingFiles.length) attachments = `\n待处理附件：${waitingFiles.length} 个（下一条消息会一并处理）`;
      } finally { handle.release(); }
    }
    let text = "状态：" + phase + "\n等待处理的消息：" + waiting + "\n正在运行的工具：" + tools + attachments;
    if (parked !== undefined) text += "\n停放的任务：" + parked;
    if (compaction !== undefined) text += "\n最近一次会话历史压缩失败：" + compaction;
    const retry = member.controlRetry ?? member.workerRetry;
    if (retry) text += `\n自动重试：第 ${retry.attempt} 次，约 ${Math.max(0, Math.ceil((retry.nextAt - Date.now()) / 1000))} 秒后\n最近错误：${retry.message}`;
    if (member.current !== undefined) {
      text += `\n任务编号：${taskNumber(member.current.requestId)}\n已用时间：${Math.floor((Date.now() - member.current.startedAt) / 1000)} 秒\n最长处理时间：${this.#limits.runTimeoutMs / 1000} 秒` +
        `\n模型无进展时限：${this.#limits.modelIdleMs / 1000} 秒\n单次模型响应时限：${this.#limits.modelResponseMs / 1000} 秒`;
    }
    return text;
  }

  // ---- maintenance ----------------------------------------------------------------------------------------------------

  /** Visit a bounded rotation of known spaces, including idle spaces evicted from the connection cache. */
  async maintain(now = Date.now()): Promise<void> {
    await this.#spaces.sweep();
    try { pruneAskIds(this.#ledger(), now); } catch (error) { this.#report(error); }
    const spaces = this.#spaces.knownSpaces;
    const selected = Array.from({ length: Math.min(8, spaces.length) }, (_, i) => spaces[(this.#maintenanceCursor + i) % spaces.length]!);
    this.#maintenanceCursor = spaces.length ? (this.#maintenanceCursor + selected.length) % spaces.length : 0;
    for (const scope of selected) {
      if (this.#closing.signal.aborted) return;
      const handle = await this.#spaces.acquire(scope);
      try {
        await this.#pruneSpace(scope, handle.harness, now).catch(error => this.#report(error));
        // No await between the idle check and publishing the gate. Admissions reserve member.uses
        // synchronously, and worker/control replay state covers work already admitted.
        if (this.#reclaiming.has(scopeKey(scope)) || [...this.#members.values()].some(state => scopeKey(state.scope) === scopeKey(scope)
          && (state.uses || state.worker || state.gate || state.starting || state.replaying || state.current))) continue;
        const gate: ReclamationGate = { ...Promise.withResolvers<void>(), yield: false };
        this.#reclaiming.set(scopeKey(scope), gate);
        try {
          const values = await idleSpaceReferences(handle.harness, this.#context);
          if (!values) continue;
          const members = await this.#memberList(handle.harness);
          // Run records (reply texts, link notes, file paths) may name result files.
          for (const member of members) values.push(await memberRecords(handle.harness, member.phone, this.#context));
          // The gate keeps this snapshot of the whole space's references valid; it is searched, never rescanned per member.
          const references = resultReferences(values);
          const start = (this.#memberCursors.get(scopeKey(scope)) ?? 0) % Math.max(1, members.length);
          let visited = 0;
          for (const member of [...members.slice(start), ...members.slice(0, start)]) {
            // A waiting admission ends the pass between members; the next pass resumes with the next member.
            if (gate.yield || this.#closing.signal.aborted) break;
            visited++;
            // A persisted member visited only for maintenance has no new user activity.
            const state = this.#member(scope, member.phone, 0);
            state.uses++;
            try {
              state.conversationId = member.conversationId;
              await this.#syncStats(handle.harness, state);
              const live = await handle.harness.snapshot(LiveDoc, member.conversationId as ConversationId, this.#context);
              const busy = state.worker !== undefined || state.gate !== undefined || state.current !== undefined
                || (await inboxItems(handle.harness, member.conversationId, this.#context)).length > 0
                || live?.run !== undefined || !!live?.compactions?.length;
              if (busy) continue;
              const release = this.#hold(state, false);
              try {
                // The hold precedes the context read: a newly admitted message cannot start a call during deletion.
                if (state.starting || state.current || state.worker) continue;
                const places = memberPlaces(this.#placesOptions(), scope, member.phone);
                await recoverOfficeProfiles(places.tempDir, deferred => log.warn(`Office 待物理回收：${deferred}`)).catch(error => this.#report(error));
                await this.#results.member(handle.harness, state.phone, places.tempDir, now - this.#limits.resultRetentionMs, references).catch((error) => this.#report(error));
              } finally { release(); }
            } finally { state.uses--; this.#pruneMember(state, now); }
          }
          if (members.length) this.#memberCursors.set(scopeKey(scope), (start + visited) % members.length);
          else this.#memberCursors.delete(scopeKey(scope));
        } finally {
          this.#reclaiming.delete(scopeKey(scope)); gate.resolve();
        }
      } finally { handle.release(); }
    }
    for (const member of this.#members.values()) this.#pruneMember(member, now);
  }

  /** Drop finished run records and old receipts. A receipt stays while its request is open or undelivered. */
  async #pruneSpace(space: Scope, harness: Harness, now: number): Promise<void> {
    const phones = (await this.#memberList(harness)).map(member => member.phone);
    const voided = await harness.commit(async tx => {
      const receipts = await tx.doc(ReceiptsDoc);
      const records = new Map<string, Awaited<ReturnType<typeof recordsOf>>>();
      const expired: [string, Attachment[]][] = [];
      for (const phone of new Set([...phones, ...Object.values(receipts.items).map(receipt => receipt.phone)])) {
        const own = await recordsOf(tx, phone);
        pruneRecords(own, now, this.#settled);
        expired.push([phone, expireAttachments(own, now, this.#downloads?.limits.retentionMs)]);
        records.set(phone, own);
      }
      pruneReceipts(receipts, receipt => receipt.request !== undefined && records.get(receipt.phone)?.requests[receipt.request] !== undefined, now);
      return expired;
    }, this.#context);
    for (const [phone, attachments] of voided) this.#discard(space, phone, attachments);
  }

  /** Stop: cancel waits, close every space (runs stay live in storage and resume on the next start). */
  async close(): Promise<void> {
    this.#closing.abort(new Error("服务正在关闭"));
    for (const timer of this.#deliveryTimers.values()) clearTimeout(timer);
    this.#deliveryTimers.clear();
    this.#cancel(new Error("服务正在关闭"));
    await Promise.allSettled([...this.#runtimes.values()].map((runtime) => runtime.door.close()));
    // Downloads stop at the closing signal; an unfinished one stays pending and starts again at the next open.
    await this.#downloads?.idle();
    try {
      await this.#spaces.closeAll();
    } finally {
      await Promise.allSettled([...this.#background]);
      this.#statsLedger?.close();
      this.#statsLedger = undefined;
      this.#members.clear();
      this.#requests.clear();
      this.#memberRequests.clear();
      this.#running.clear();
      this.#wakeCapacity();
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------------

  #harnessOptions(scope: Scope): HarnessOptions {
    const { selection } = this.#options;
    const holder: { harness?: Harness } = {};
    const door = spaceDoor(holder, { onReport: (error) => this.#report(error), onNotSent: () => this.#attention.note("notSent", scope),
      ...(this.#options.closeout ? { prepareTool: (name, args, api, context) => closeoutTool(name, args, api, context, this.#options.closeout!, this.#limits.runTimeoutMs) } satisfies Partial<import("./door.ts").DoorOptions> : {}),
      beforeDispatch: (phone, signal) => this.#waitForRun(memberKey(scope, phone), signal),
      dispatchError: (phone) => {
        const current = this.#members.get(memberKey(scope, phone))?.current;
        if (!current) return;
        current.deadlineError ??= this.#totalTimeout(current.requestId, current.startedAt);
        return current.deadlineError?.error;
      } });
    for (const receipt of this.#receipts.values()) {
      if (scopeKey(receipt.scope) === scopeKey(scope)) receipt.ticket = door.controlReceived(receipt.phone, receipt.requestId);
    }
    const runtime: SpaceRuntime = { door, holder, refreshed: new Map(), epoch: 0 };
    this.#runtimes.set(scopeKey(scope), runtime);
    // Hooks observe through snapshots; their writes to the run record are commits of their own.
    const write: RecordWriter = async (phone, requestId, change) => {
      const harness = holder.harness;
      if (harness === undefined) throw new Error("会话库未打开，不能写任务记录");
      await harness.commit(async tx => {
        const record = (await recordsOf(tx, phone)).requests[requestId];
        if (record !== undefined && record.closedAt === undefined) change(record);
      }, this.#context);
    };
    const registry = createRegistry();
    const install = (extension: Extension) => registry.install(door.wrapTools(extension));
    if (this.#options.closeout) install(closeoutExtension(write, this.#options.closeout, this.#limits.runTimeoutMs));
    if (this.#options.materials !== false) install(this.#materials(runtime));
    for (const extension of spaceExtensions({
      ...this.#placesOptions(), scope,
      modules: this.#options.modules, relay: this.#options.relay, outbound: this.#outbound,
      closeout: this.#options.closeout !== undefined,
      ...(this.#options.auxiliary ? { auxiliary: { config: this.#options.auxiliary, budget: this.#auxiliaryBudget, door } } : {}),
      ...(this.#options.mcp ? { mcp: { manager: this.#options.mcp, door } } : {}),
    })) install(extension);
    for (const extension of this.#options.extensions?.(scope) ?? []) install(extension);
    return { models: door.wrap(selection.runtime as unknown as Models), registry, settings: selection.harnessSettings,
      onReport: (error, info) => this.#durableReport(scope, error, info) };
  }

  /** Durable's own reports (faulted or parked tasks, failing hooks and listeners, a failed Session), with what they are about. */
  #durableReport(scope: Scope, error: unknown, info: ReportInfo): void {
    const task = "task" in info && info.task !== undefined ? `，任务 ${info.task.kind}#${info.task.id}，会话 ${info.task.conversationId}` : "";
    const extension = "extension" in info && info.extension !== undefined ? `，扩展 ${info.extension}` : "";
    const parked = info.type === "task_parked" ? "；已停止自动重跑，成员可用 /status 查看，/stop 或 /clear 结束" : "";
    if (info.type === "task_parked") this.#attention.note("parked", scope);
    else if (info.type === "task_faulted" || info.type === "session_failed" || info.type === "migration_failed") this.#attention.note("faulted", scope);
    this.#report(new Error(`Durable 报告 ${info.type}（${scopeLabel(scope)}${task}${extension}）：${error instanceof Error ? error.message : String(error)}${parked}`, { cause: error }));
  }

  /** Startup gate of a space: before scheduling resumes. */
  async #prepare(harness: Harness, scope: Scope, context: Context): Promise<void> {
    const runtime = this.#runtimes.get(scopeKey(scope))!;
    runtime.holder.harness = harness;
    runtime.epoch = await harness.commit(async (tx) => {
      const controls = await tx.doc(ControlsDoc), epoch = controls.epoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("会话库的控制世代无效");
      return controls.epoch = epoch + 1;
    }, context);
    const controls = await pendingControls(harness, context);
    runtime.door.loadControls(controls.map(({ phone, requestId, seq }) => ({ phone, requestId, seq })));
    // A recovered generation or summarize request names its conversation only by its provider session.
    await runtime.door.loadSessions(context);
    const kicks: MemberState[] = [];
    const deliveries: { member: MemberState; requestId: string }[] = [];
    const downloads: { phone: string; id: string }[] = [];
    for (const { phone, conversationId } of await this.#memberList(harness)) {
      await ensureStorageIdentity(this.#options.layout, scope, phone, this.#options.stateDb);
      await recoverOfficeProfiles(userTmp(this.#options.layout, scope, phone), deferred => log.warn(`Office 待物理回收：${deferred}`)).catch(error => this.#report(error));
      const member = this.#member(scope, phone);
      member.conversationId = conversationId;
      // Usage committed since the last sync (a background compaction, a run before a crash) counts from here.
      await this.#syncStats(harness, member);
      const items = await inboxItems(harness, conversationId, context);
      for (const item of items) this.#addRequest(item.requestId, member.key);
      const head = items[0];
      if (head?.startedAt !== undefined && head.cancelled !== true) {
        member.current = { requestId: head.requestId, startedAt: head.startedAt };
        markRunning(member.scope, member.phone, taskNumber(head.requestId));
      }
      if (head !== undefined) kicks.push(member);
      // Parts an ended process left `sending` may have reached the platform: uncertain, counted as sent.
      const records = await memberRecords(harness, phone, context);
      if (Object.values(records.requests).some(record => record.delivery?.parts.some(part => part.state === "sending") || record.files.some(file => file.state === "sending"))) {
        await harness.commit(async tx => { settleInterrupted(await recordsOf(tx, phone)); }, context);
      }
      for (const record of pendingDeliveries(await memberRecords(harness, phone, context))) deliveries.push({ member, requestId: record.requestId });
      for (const attachment of Object.values(records.attachments)) if (attachment.state === "pending") downloads.push({ phone, id: attachment.id });
    }
    // Every restored head's original deadline is visible to the door before any task is scheduled.
    harness.resume();
    this.#track((async () => {
      for (const control of controls) {
        const member = this.#member(scope, control.phone);
        const release = this.#hold(member);
        const run: Promise<void> = (member.replaying ?? Promise.resolve()).then(async () => {
          const handle = await this.#spaces.acquire(scope);
          try { await this.#execute(handle.harness, member, control.command, control.requestId, control.reply); } finally { handle.release(); }
          // The receipt goes out only after execution, which also removes the control: one still waiting was never answered.
          if (control.reply) await this.#notify(control.reply, await this.#controlReceipt(member, control.command));
        }).finally(release);
        const replaying = run.catch((error) => this.#report(error));
        member.replaying = replaying;
        void replaying.finally(() => { if (member.replaying === replaying) member.replaying = undefined; this.#pruneMember(member); });
      }
      for (const { phone, id } of downloads) this.#downloads?.schedule(scope, phone, id);
      for (const member of kicks) this.#kick(member);
      for (const { member, requestId } of deliveries) this.#track(this.#autoDeliver(member, requestId));
    })());
  }

  async #pendingWork(harness: Harness, context: Context): Promise<boolean> {
    if ((await pendingControls(harness, context)).length) return true;
    for (const { phone, conversationId } of await this.#memberList(harness)) {
      if ((await inboxItems(harness, conversationId, context)).length) return true;
      const records = await memberRecords(harness, phone, context);
      if (Object.values(records.attachments).some(attachment => attachment.state === "pending")) return true;
      // Open parts are sent at startup (failed ones when their retry is due), or the delivery is given up when its window passed.
      if (pendingDeliveries(records).length) return true;
    }
    return false;
  }

  /** Member conversations of a space: ownerless conversations with an identity. */
  async #memberList(harness: Harness): Promise<{ phone: string; conversationId: number }[]> {
    const ids = await conversationIds(harness, this.#context, true);
    const members: { phone: string; conversationId: number }[] = [];
    for (const id of ids) {
      const identity = await harness.snapshot(IdentityDoc, id as ConversationId, this.#context);
      if (identity?.phone) members.push({ phone: identity.phone, conversationId: id });
    }
    return members;
  }

  /** Refresh the application's materials index once per run, before its first request; every space shares it. */
  #materials(runtime: SpaceRuntime): Extension {
    const { layout } = this.#options;
    return defineExtension({
      name: "mixin.materials",
      hooks: [hook(GenerationTask, {
        async beforeRequest(_request, api, context: Context) {
          const taskId = api.taskId as number;
          let refresh = runtime.refreshed.get(taskId);
          if (refresh === undefined) {
            // The default workspace is created on demand; an external one must exist (the index reports its own errors).
            const workspaceDir = resolve(layout.workspace);
            refresh = Promise.all([...layout.externalWorkspace ? [] : [workspaceDir], layout.index].map((dir) => mkdir(dir, { recursive: true })))
              .catch(() => {})
              .then(() => ensureMaterialsIndex({
                workspaceDir, indexPath: resolve(layout.materialsIndex), ignorePath: resolve(layout.materialsIgnore),
              }))
              .then(() => {});
            runtime.refreshed.set(taskId, refresh);
            if (runtime.refreshed.size > 256) runtime.refreshed.delete(runtime.refreshed.keys().next().value!);
          }
          await waitFor(refresh, context.abortSignal);
          return undefined;
        },
      })],
    });
  }

  /** Paths the tools of every space use: the shared layout and document environment. */
  #placesOptions(): { layout: Layout; venvDir: string } {
    return { layout: this.#options.layout, venvDir: this.#options.venvDir ?? resolve(this.#options.layout.documentEnv) };
  }

  #ledger(): Database {
    return this.#statsLedger ??= openStatsLedger(this.#options.layout.stats);
  }

  /** Which pruning candidates are settled in the ledger; none while it cannot be read (the records wait for a sync). */
  readonly #settled = (candidates: readonly RequestRecord[]): ReadonlySet<string> => {
    try { return settledAsks(this.#ledger(), candidates.map(record => ({ requestId: record.requestId, at: record.createdAt }))); }
    catch { return new Set(); }
  };

  /** Count an admitted message. Best effort: the next sync counts it from the run record. */
  #countAsk(scope: Scope, phone: string, requestId: string, at: number): void {
    try { countAsk(this.#ledger(), scope, phone, requestId, at); } catch (error) { this.#report(error); }
  }

  /** The member's conversation, created if needed; once committed, its provider session may reach the provider. */
  async #conversation(harness: Harness, member: MemberState): Promise<Conversation> {
    const { conversation } = await memberConversation(harness, member.scope, member.phone,
      { model: this.#options.selection.ref, thinkingLevel: this.#options.selection.thinkingLevel }, this.#context);
    member.conversationId = conversation.id;
    await this.#runtimes.get(scopeKey(member.scope))?.door.bind(conversation.id, this.#context);
    return conversation;
  }

  /**
   * Count the member's asks and usage growth into the ledger. Best effort: a failed sync changes nothing and the next one
   * catches up; a failure because the service is closing is not reported.
   */
  async #syncStats(harness: Harness, member: MemberState): Promise<void> {
    if (this.#closing.signal.aborted) return;
    try {
      const regressed = await syncMemberStats(this.#ledger(), harness,
        { scope: member.scope, phone: member.phone, conversationId: member.conversationId }, this.#context);
      if (regressed.length) {
        this.#attention.note("statsRegressed", member.scope);
        log.warn(`统计累计值回退（会话库被替换为较早的副本），已按当前值重设基准，本次不入账 - ${scopeLabel(member.scope)}, 用户: ${member.phone}, 项目: ${regressed.join("、")}`);
      }
    } catch (error) {
      if (!this.#closing.signal.aborted) this.#report(error);
    }
  }

  #member(scope: Scope, phone: string, lastUsed = Date.now()): MemberState {
    const key = memberKey(scope, phone);
    let member = this.#members.get(key);
    if (member === undefined) {
      member = { key, scope, phone, again: false, deciding: new Set(), controls: Promise.resolve(), workProgress: 0, aborted: new Map(), withdrawals: 0,
        admission: new AsyncSemaphore(1), delivery: new AsyncSemaphore(1), uses: 0, lastUsed };
      this.#members.set(key, member);
    }
    return member;
  }

  async #closedSpace(scope: Scope, harness?: Harness): Promise<void> {
    const runtime = this.#runtimes.get(scopeKey(scope));
    if (!runtime || (runtime.holder.harness !== undefined && runtime.holder.harness !== harness)) return;
    // Remove the same instance before awaiting its door: a late close must not discard a newly opened runtime.
    this.#runtimes.delete(scopeKey(scope));
    runtime.holder.harness = undefined;
    runtime.refreshed.clear();
    await runtime.door.close();
    for (const member of this.#members.values()) if (scopeKey(member.scope) === scopeKey(scope)) this.#pruneMember(member);
  }

  #pruneMember(member: MemberState, now = Date.now()): void {
    // A control receipt always holds this member's gate and uses count until its ticket is released.
    if (member.uses || member.worker || member.gate || member.starting || member.replaying || member.current
      || member.workerRetry || member.controlRetry || this.#memberRequests.has(member.key)) return;
    if (this.#runtimes.has(scopeKey(member.scope)) && now - member.lastUsed < this.#limits.memberIdleMs) return;
    if (this.#members.get(member.key) === member) this.#members.delete(member.key);
  }

  async #enterRun(member: MemberState): Promise<void> {
    while (this.#running.size >= this.#limits.activeRequests) await this.#capacityChanged(this.#closing.signal);
    this.#closing.signal.throwIfAborted();
    this.#running.add(member.key);
    this.#wakeCapacity();
  }

  #leaveRun(member: MemberState): void { this.#running.delete(member.key); this.#wakeCapacity(); }

  async #waitForRun(key: string, signal: AbortSignal): Promise<void> {
    while (!this.#running.has(key) && this.#memberRequests.has(key)) await this.#capacityChanged(signal);
    signal.throwIfAborted();
  }

  #addRequest(id: string, key: string): void {
    if (this.#requests.has(id)) return;
    this.#requests.set(id, { key, retired: false });
    this.#memberRequests.set(key, (this.#memberRequests.get(key) ?? 0) + 1);
  }

  #dropRequest(id: string): void {
    const request = this.#requests.get(id);
    if (!request) return;
    this.#requests.delete(id);
    const remaining = this.#memberRequests.get(request.key)! - 1;
    if (remaining) this.#memberRequests.set(request.key, remaining);
    else this.#memberRequests.delete(request.key);
  }

  #capacityChanged(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.#capacityWaiters.delete(wake); signal.removeEventListener("abort", abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.#capacityWaiters.add(wake); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  #wakeCapacity(): void { for (const wake of [...this.#capacityWaiters]) wake(); }

  /**
   * Arrival time of a message or control: strictly increasing within the process, so a control cancels exactly the
   * messages that arrived before it, also within one millisecond (a /clear and the message right after it).
   */
  #arrival(): number {
    this.#lastArrival = Math.max(Date.now(), this.#lastArrival + 1);
    return this.#lastArrival;
  }

  #track(work: Promise<unknown>): void {
    this.#background.add(work);
    void work.finally(() => this.#background.delete(work)).catch(() => {});
  }

  #assertRunning(): void {
    if (this.#fatalError) throw this.#fatalError;
    if (this.#closing.signal.aborted) throw new Error("服务正在关闭");
  }

  #fatal(error: DurableStorageFailure): void {
    if (this.#closing.signal.aborted) return;
    this.#fatalError = error;
    this.#closing.abort(error);
    this.#cancel(error);
    for (const runtime of this.#runtimes.values()) void runtime.door.close();
    this.#report(error);
    try { this.#options.onFatal?.(error); } catch {}
  }

  #report(error: unknown): void {
    try { this.#options.onReport?.(error); } catch {}
  }

  #log(line: string): void {
    try { this.#options.onLog?.(line); } catch {}
  }
}

/** The in-memory key of a member (space, phone). */
export function memberKey(scope: Scope, phone: string): string {
  return JSON.stringify([scopeKey(scope), phone]);
}

/** A final reply: its segments (the first one leads), then one text part per link note. */
function replyDelivery(reply: ReplyContext, body: string, notes: readonly unknown[], now: number): Delivery {
  const parts: DeliveryPart[] = replySegments(reply, body).map((segment, index) => ({
    id: `m${index}`, kind: "markdown", body: segment, ...(index === 0 ? { lead: true as const } : {}), state: "pending", attempts: 0,
  }));
  notes.forEach((_, note) => parts.push({ id: `l${note}`, kind: "links", note, state: "pending", attempts: 0 }));
  return { kind: "reply", createdAt: now, parts };
}

/** A terminal error is delivered like a reply: it leads (with the @ in a group) and keeps the run's link notes. */
const failureDelivery = replyDelivery;

const retryDelay = (attempt: number) => Math.min(100 * 2 ** Math.min(attempt, 9), 30_000);
function retryWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * The task number of a message: the first 8 hex digits of its request id. Logs write it as `任务: <number>`, the form
 * the log extraction scripts (scripts/ops/task-logs.*) and the TUI search for; /status and failure details show it.
 */
function taskNumber(requestId: string): string {
  return requestId.replace(/^(?:msg|ctl):/, "").slice(0, 8);
}

function taskText(member: Pick<MemberState, "scope" | "phone">, requestId: string): string {
  return `${scopeLabel(member.scope)}, 用户: ${member.phone}, 任务: ${taskNumber(requestId)}`;
}

function compactionReasonText(reason: string): string {
  return reason === "overflow" ? "上下文溢出时压缩" : reason === "threshold" ? "达到阈值时压缩" : reason === "manual" ? "手动压缩" : reason;
}

/** The running tool calls, each with the nested calls it runs (a script's tool calls): `codemode（read、bash）`. */
function runningTools(live: Readonly<LiveState> | undefined): string[] {
  const nested = live?.nestedTools?.filter((slot) => slot.status === "running") ?? [];
  return (live?.tools?.filter((slot) => slot.status === "running") ?? []).map((slot) => {
    const children = nested.filter((child) => child.parentTaskId === slot.taskId).map((child) => child.name);
    return children.length ? `${slot.name}（${children.join("、")}）` : slot.name;
  });
}

/** What a running task is doing, for the heartbeat log. */
function livePhase(live: Readonly<LiveState> | undefined): string {
  const running = runningTools(live);
  if (running.length) return "执行工具 " + running.join("、");
  if (live?.compactions?.some((compaction) => compaction.blocking)) return "压缩会话历史";
  const generation = live?.generation;
  if (generation?.retry !== undefined) return "等待重试";
  if (generation !== undefined) return "等待或接收模型输出";
  return "准备中";
}

/** The model's current attempt when the model is what the run waits for, with its committed progress. */
function modelActivity(live: Readonly<LiveState> | undefined): { key: string; progress: string } | undefined {
  const generation = live?.generation;
  if (live?.run === undefined || generation === undefined) return undefined;
  if (generation.retry !== undefined || generation.deferred !== undefined) return undefined;
  if (live.tools !== undefined && live.tools.length > 0) return undefined;
  if (live.compactions?.some((compaction) => compaction.blocking)) return undefined;
  return { key: `${live.run.taskId}:${generation.attempt}`, progress: JSON.stringify(generation.message ?? null) };
}
