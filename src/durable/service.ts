// The message lifecycle on the Durable engine (D3): admission, the member workers, controls, replies, the watchdog,
// usage projection and maintenance. The webhook (src/server/webhook.ts) hands every message and command to it; it replaced
// the AgentSession engine at data version 3.
//
// Admission. A webhook message is committed to the member's inbox (src/durable/inbox.ts) before `admit` returns, so the
// webhook is acknowledged only after it is durable. The storage identity of the member's directories is checked first
// (src/agent/storage-identity.ts), for a new member as for a known one.
//
// Workers. One per member, in memory: submit the inbox head to Durable (idempotent by its requestId), wait for it to
// settle, store the reply in the outbox (DeliveryStore, deterministic row ids), remove the item, project usage, send.
// The member's IM callback URL is kept in memory only (it carries the bot key): after a restart, a recovered answer
// waits in the outbox for the member's next message or /deliver. Link notes of send_file are written to the run's
// outbox row as they are made, so they survive a crash and join the final reply.
//
// Controls. /stop and /clear are committed to the control stream before they run; the request door holds the member's
// model requests from receipt until the removal is committed. /stop cancels the inbox and aborts the run. /clear also
// holds the worker (new messages are admitted but not submitted), waits until the conversation is idle (Durable's abort
// returns only then: no tool, codemode sub-call or store commit of the member is left), starts a new context, removes
// the member's codemode result directories, then releases the worker. A restart executes waiting controls again.
//
// Watchdog. The total deadline counts from the item's first submission (stored, so it survives restarts); model
// progress is the committed partial of the current attempt (`pi.live`): no change for the idle limit, or one attempt
// running longer than the response limit, aborts the run like the AgentSession engine's limits. Tool rounds, retry
// backoff, deferred polls and compactions are not model idleness.
//
// Startup. Groups with work are opened by discovery; before scheduling resumes, the door gets the waiting controls and
// every member's storage identity is checked; then the controls run again and the workers start.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry, CompactionEntry, InboxDoc as PiInboxDoc, type Conversation, type ConversationId, createRegistry, defineExtension, type Extension, GenerationTask, type Harness,
  type HarnessOptions, hook, LiveDoc, type LiveState, type SettledSubmissionRecord, type Submission,
} from "@earendil-works/pi-durable";
import { canonicalCommand, HELP_TEXT, unknownCommandText } from "../agent/commands.ts";
import { refreshDeliveryText } from "../agent/delivery-links.ts";
import { type DeliveryAttachment, DeliveryStore } from "../agent/delivery-store.ts";
import { describeRequestFailure, modelRequestError } from "../agent/failure.ts";
import { ensureMaterialsIndex } from "../agent/materials-index.ts";
import type { AgentModuleDefinition } from "../agent/modules.ts";
import { groupIndexDir, groupWorkspaceDir, materialsIgnorePath, materialsIndexPath, userTempDir } from "../agent/paths.ts";
import type { OutboundNotes } from "../agent/send-tools.ts";
import { ensureStorageIdentity } from "../agent/storage-identity.ts";
import { openStatsLedger } from "../agent/stats-ledger.ts";
import { DEDUP_TTL, MAX_ACTIVE_REQUESTS, MAX_DEDUP_SIZE } from "../core/config.ts";
import { waitFor } from "../core/lifecycle.ts";
import { AsyncSemaphore } from "../core/async-semaphore.ts";
import { getOutboundRateStatus, sendReplyWithMention, sendText } from "../integrations/im.ts";
import type { RelayConfig } from "../integrations/relay.ts";
import { removeCodemodeResults } from "./codemode/results.ts";
import { RequestDoor, type ControlTicket } from "./door.ts";
import { groupDatabasePath, GroupHarnesses } from "./groups.ts";
import { IdentityDoc, memberConversation, MemberDirectory } from "./identity.ts";
import { type ControlCommand, ControlsDoc, InboxDoc, type InboxItem, inboxItems, pendingControls, receivedBefore, WebhookReceiptsDoc } from "./inbox.ts";
import { groupDoor, type ModelSelection } from "./models.ts";
import type { AuxiliaryConfig } from "../core/auxiliary-config.ts";
import { AuxiliaryBudget } from "./auxiliary.ts";
import type { McpTools } from "../integrations/mcp.ts";
import { queueManualCompaction } from "./manual-compaction.ts";
import { recoverOfficeProfiles } from "../agent/office-profiles.ts";
import { configuredRootlessTasks } from "../core/rootless-tasks.ts";
import { log } from "../core/log.ts";
import { referencedResults, ResultsDoc } from "./result-lifecycle.ts";
import { projectConversation } from "./projection.ts";
import { groupExtensions } from "./registry.ts";
import type { SendDelivery } from "./send.ts";
import type { DurableStorageFailure } from "./storage-failure.ts";
import { memberPlaces } from "./tools.ts";

export const STATUS_TEXT = "收到，正在处理🤔💭";
const QUEUE_FULL = "本会话已有 8 条消息排队，请稍后重发";
const CAPACITY_FULL = "⚠️ 机器人现在比较忙，这条消息未加入队列，不会自动处理，请稍后重新发送。";

/** Where replies and receipts go; the IM functions by default, fakes in tests. */
export interface Outbound {
  sendText(text: string, groupId: string, phone: string, callbackUrl: string,
    options?: { traffic?: "status" | "required"; signal?: AbortSignal }): Promise<boolean>;
  sendReply(body: string, groupId: string, phone: string, callbackUrl: string, signal?: AbortSignal, appendix?: string): Promise<boolean>;
  rate(callbackUrl: string): { used: number; limit: number };
  refresh(item: { text: string; attachments: DeliveryAttachment[]; blockedReason?: string }, signal?: AbortSignal): Promise<string>;
}

const IM: Outbound = {
  sendText: (text, groupId, phone, callbackUrl, options) => sendText(text, groupId, phone, callbackUrl, options),
  sendReply: (body, groupId, phone, callbackUrl, signal, appendix) => sendReplyWithMention(body, groupId, phone, callbackUrl, signal, appendix),
  rate: (callbackUrl) => getOutboundRateStatus(callbackUrl),
  refresh: (item, signal) => refreshDeliveryText(item, signal),
};

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
}

export interface DurableServiceOptions {
  root: string;
  selection: ModelSelection;
  modules: readonly AgentModuleDefinition[];
  relay: RelayConfig | null;
  auxiliary?: AuxiliaryConfig;
  mcp?: McpTools;
  venvDir?: string;
  limits: Omit<ServiceLimits, "activeRequests" | "queue" | "tickMs" | "heartbeatMs" | "resultRetentionMs"> & Partial<ServiceLimits>;
  outbound?: Outbound;
  deliveries?: DeliveryStore;
  /** The storage identity table (src/core/state.ts by default). */
  stateDb?: Database;
  /** Extensions installed after the project's (tests). */
  extensions?: (groupId: string) => readonly Extension[];
  /** Refresh the group's materials index before each run (default true). */
  materials?: boolean;
  maxIdleGroups?: number;
  context?: Context;
  /** Failures that do not fail the calling operation. Must not throw. */
  onReport?: (error: unknown) => void;
  /** Uncertain group commit/SQL thread loss: the application must exit immediately, without ordinary shutdown writes. */
  onFatal?: (error: DurableStorageFailure) => void;
  /** Progress lines for the service log. Must not throw. */
  onLog?: (line: string) => void;
}

type AbortReason = { kind: "task_timeout" | "model_idle" | "model_response_timeout"; error: Error };

/** Log labels of the watchdog's aborts, as the task log extraction (scripts/ops/task-logs.*) looks for them. */
const ABORT_LABELS: Record<AbortReason["kind"], string> = {
  task_timeout: "任务总时限到达",
  model_idle: "模型无有效进展超时",
  model_response_timeout: "单次模型响应超时",
};

type MemberState = {
  readonly key: string;
  readonly groupId: string;
  readonly phone: string;
  conversationId?: number;
  callbackUrl?: string;
  worker?: Promise<void>;
  again: boolean;
  /** Admitted control boundary for this process, including messages whose admission is still in flight. */
  cancelBefore?: number;
  /**
   * Set from a /stop's or /clear's arrival until it ran: the worker starts nothing, so a message that arrives after the
   * control is never started before it and aborted by it.
   */
  gate?: Promise<void>;
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
  /** The inbox item being run (its outbox row collects link notes). */
  current?: { requestId: string; startedAt: number; deadlineError?: AbortReason };
  aborted: Map<string, AbortReason>;
  /** Outbox rows this process already tried to send (the rest are replies recovered from an earlier process). */
  attempted: Set<string>;
  /** Automatic, recovered and manual delivery share one send/acknowledge boundary. */
  delivery: AsyncSemaphore;
  /** Public operations and automatic reply recovery still using this state. */
  uses: number;
  lastUsed: number;
};

type GroupRuntime = { door: RequestDoor; holder: { harness?: Harness }; refreshed: Map<number, Promise<void>>; epoch: number };
type ControlReceipt = { groupId: string; phone: string; requestId: string; ticket?: ControlTicket };

export type AdmitResult = { status: "accepted" } | { status: "full"; message: string; reason?: "capacity" };

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? []).filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("").trim();

/** The message service of the process (src/server/app.ts creates one). */
export class DurableService {
  readonly #options: DurableServiceOptions;
  readonly #auxiliaryBudget: AuxiliaryBudget;
  readonly #limits: ServiceLimits;
  readonly #outbound: Outbound;
  readonly #deliveries: DeliveryStore;
  readonly #context: Context;
  readonly #cancel: (reason?: unknown) => void;
  readonly #closing = new AbortController();
  readonly #members = new Map<string, MemberState>();
  readonly #runtimes = new Map<string, GroupRuntime>();
  readonly #receipts = new Map<string, ControlReceipt>();
  readonly #groups: GroupHarnesses;
  readonly #background = new Set<Promise<unknown>>();
  readonly #requests = new Map<string, { key: string; retired: boolean }>();
  readonly #running = new Set<string>();
  readonly #capacityWaiters = new Set<() => void>();
  #lastArrival = 0;
  #fatalError?: DurableStorageFailure;

  constructor(options: DurableServiceOptions) {
    this.#options = options;
    this.#auxiliaryBudget = new AuxiliaryBudget(options.auxiliary?.maxConcurrent ?? 2);
    this.#limits = { activeRequests: MAX_ACTIVE_REQUESTS, queue: 8, tickMs: 1000, heartbeatMs: 60_000, resultRetentionMs: 7 * 24 * 3600_000, ...options.limits };
    if (!Number.isSafeInteger(this.#limits.activeRequests) || this.#limits.activeRequests < 1) throw new Error("普通请求总容量必须是正整数");
    this.#outbound = options.outbound ?? IM;
    this.#deliveries = options.deliveries ?? new DeliveryStore(options.stateDb);
    const cancellable = withCancel(options.context ?? BACKGROUND_CONTEXT);
    this.#context = cancellable.context;
    this.#cancel = cancellable.cancel;
    this.#groups = new GroupHarnesses({
      root: options.root,
      harnessOptions: (groupId) => this.#harnessOptions(groupId),
      prepare: (harness, groupId, context) => this.#prepare(harness, groupId, context),
      pendingWork: (harness, _groupId, context) => this.#pendingWork(harness, context),
      ...(options.maxIdleGroups === undefined ? {} : { maxIdle: options.maxIdleGroups }),
      context: this.#context,
      onReport: (error) => this.#report(error),
      onFatal: (error) => this.#fatal(error),
      onClosed: (groupId, harness) => this.#closedGroup(groupId, harness),
    });
  }

  /** Startup: open every group with work (controls run again, workers start). Returns those groups. */
  start(): Promise<string[]> {
    return this.#groups.discover();
  }

  /** The member's last known callback URL, else `fallback`. */
  callbackUrl(phone: string, groupId: string, fallback: string): string {
    return this.#members.get(memberKey(groupId, phone))?.callbackUrl ?? fallback;
  }

  // ---- admission ------------------------------------------------------------------------------------------------------

  hasUserRequestCapacity(): boolean {
    return !this.#closing.signal.aborted && this.#requests.size < this.#limits.activeRequests;
  }

  /** Commit a message to the member's inbox; resolves once it is durable. */
  async admit(phone: string, groupId: string, content: string, callbackUrl: string, deduplicate = false): Promise<AdmitResult> {
    this.#assertRunning();
    const requestId = `msg:${randomUUID()}`;
    const key = memberKey(groupId, phone);
    // Reserve synchronously, before identity/open/commit awaits. A duplicate may still be acknowledged when full.
    if (this.hasUserRequestCapacity()) this.#requests.set(requestId, { key, retired: false });
    else if (!deduplicate) return { status: "full", reason: "capacity", message: CAPACITY_FULL };
    const receivedAt = this.#arrival();
    const member = this.#member(groupId, phone);
    member.uses++;
    member.callbackUrl = callbackUrl;
    member.lastUsed = Date.now();
    const turn = member.admission.acquire(this.#closing.signal);
    let release: (() => void) | undefined;
    let retained = false;
    try {
      release = await turn;
      this.#assertRunning();
      await ensureStorageIdentity(this.#options.root, groupId, phone, this.#options.stateDb);
      const handle = await this.#groups.acquire(groupId);
      let added: "added" | "duplicate" | "queue-full" | "capacity-full";
      try {
        const { conversation } = await memberConversation(handle.harness, groupId, phone,
          { model: this.#options.selection.ref, thinkingLevel: this.#options.selection.thinkingLevel }, this.#context);
        member.conversationId = conversation.id;
        added = await handle.harness.commit(async (tx) => {
          const now = Date.now();
          const digest = deduplicate ? createHash("sha256").update(content, "utf8").digest("hex") : undefined;
          const receipts = digest === undefined ? undefined : await tx.doc(WebhookReceiptsDoc);
          if (receipts) {
            receipts.items = receipts.items.filter(item => now - item.at <= DEDUP_TTL);
            if (receipts.items.some(item => item.phone === phone && item.digest === digest)) return "duplicate" as const;
          }
          // Opening a previously unknown group may have recovered older work after the reservation.
          if (!this.#requests.has(requestId)) {
            if (!this.hasUserRequestCapacity()) return "capacity-full" as const;
            this.#requests.set(requestId, { key, retired: false });
          } else if (this.#requests.size > this.#limits.activeRequests) return "capacity-full" as const;
          const inbox = await tx.doc(InboxDoc, conversation.id);
          if (inbox.items.filter((item) => item.cancelled !== true).length > this.#limits.queue) return "queue-full" as const;
          inbox.items.push({ requestId, content, receivedAt, epoch: this.#runtimes.get(groupId)!.epoch,
            ...(receivedAt <= (member.cancelBefore ?? -Infinity) ? { cancelled: true } : {}) });
          if (receipts && digest) {
            receipts.items.push({ phone, digest, at: now });
            if (receipts.items.length > MAX_DEDUP_SIZE) receipts.items.splice(0, receipts.items.length - MAX_DEDUP_SIZE);
          }
          return "added" as const;
        }, this.#context);
        retained = added === "added";
      } finally { handle.release(); }
      if (added === "queue-full") return { status: "full", message: QUEUE_FULL };
      if (added === "capacity-full") return { status: "full", reason: "capacity", message: CAPACITY_FULL };
      this.#kick(member);
      this.#track(this.#recovered(member).catch((error) => this.#report(error)));
      return { status: "accepted" };
    } finally {
      if (!retained) this.#requests.delete(requestId);
      member.uses--;
      release?.();
      this.#wakeCapacity();
      this.#pruneMember(member);
    }
  }

  // ---- controls -------------------------------------------------------------------------------------------------------

  /** A slash command; its receipt is sent to the member (best effort) once it has run. */
  async control(phone: string, groupId: string, content: string, callbackUrl: string, onAdmitted?: () => void): Promise<string> {
    const member = this.#member(groupId, phone);
    member.uses++;
    try { return await this.#controlMessage(phone, groupId, content, callbackUrl, onAdmitted); }
    finally { member.uses--; this.#pruneMember(member); }
  }

  async #controlMessage(phone: string, groupId: string, content: string, callbackUrl: string, onAdmitted?: () => void): Promise<string> {
    this.#assertRunning();
    const command = canonicalCommand(content);
    const receivedAt = this.#arrival();
    const member = this.#member(groupId, phone);
    member.callbackUrl = callbackUrl;
    member.lastUsed = Date.now();
    let reply: string;
    if (command === "/stop" || command === "/clear") {
      const release = this.#hold(member);
      const receipt: ControlReceipt = { groupId, phone, requestId: `ctl:${randomUUID()}` };
      this.#receipts.set(receipt.requestId, receipt);
      receipt.ticket = this.#runtimes.get(groupId)?.door.controlReceived(phone, receipt.requestId);
      // Reserve this member's order before any await; slower identity/open steps cannot reorder controls.
      const run = member.controls.then(async () => {
        await ensureStorageIdentity(this.#options.root, groupId, phone, this.#options.stateDb);
        await this.#control(member, command, receivedAt, receipt, onAdmitted);
      });
      member.controls = run.catch(() => {});
      try {
        await run;
      } finally {
        this.#receipts.delete(receipt.requestId);
        if (receipt.ticket) this.#runtimes.get(groupId)?.door.controlDropped(receipt.ticket);
        release();
      }
      reply = command === "/stop"
        ? "⏹ 已停止你在本群的当前任务，并取消排队中的消息。已发出的内容不会撤回。"
        : "🧹 已为你在本群开启新会话，下条消息从新会话开始，之前的聊天记录留在群库里。其他人的聊天记录不受影响。";
      if (this.#deliveries.pending(member.key).length) {
        reply += command === "/stop" ? "\n已生成但尚未发完的回复已保留，发送 /deliver 可补发。" : "\n之前已生成但尚未发完的回复仍保留，发送 /deliver 可补发。";
      }
    } else if (command === "/compact") {
      // Reserve command order before any await. Only admission is serialized; waiting for a summary must not block stop.
      const admission = member.controls.then(async () => {
        await ensureStorageIdentity(this.#options.root, groupId, phone, this.#options.stateDb);
        const handle = await this.#groups.acquire(groupId);
        try {
          await member.replaying;
          const { conversation } = await memberConversation(handle.harness, groupId, phone,
            { model: this.#options.selection.ref, thinkingLevel: this.#options.selection.thinkingLevel }, this.#context);
          member.conversationId = conversation.id;
          const queued = await handle.harness.commit(tx => queueManualCompaction(tx, conversation.id), this.#context);
          return { handle, queued };
        } catch (error) { handle.release(); throw error; }
      });
      member.controls = admission.then(() => {}, () => {});
      const { handle, queued } = await admission;
      try {
        onAdmitted?.();
        const outcome = queued.submissionId !== undefined
          ? { status: "completed" as const, result: { submissionId: queued.submissionId, entryId: undefined } }
          : (await handle.harness.waitForTask(queued.taskId, this.#context)).state.outcome;
        if (outcome.status !== "completed") {
          reply = "⚠️ 本次会话压缩未完成，原会话仍保留；可用 /status 查看状态。";
        } else if (outcome.result.entryId !== undefined) {
          // A compaction owned by a generation places its entry in the task's terminal commit.
          reply = "📦 会话压缩已完成，摘要已写入会话，聊天记录仍保留在群库里。";
        } else if (outcome.result.submissionId === undefined) {
          reply = "📦 本次无需压缩，当前会话没有可压缩的历史。";
        } else {
          // Task completion only generated a summary. Placement is a separate durable submission.
          const summary = await handle.harness.submission(outcome.result.submissionId, this.#context);
          if (!summary) throw new Error("压缩摘要提交不存在，无法确认已写入会话");
          const placed = await summary.wait(this.#context);
          reply = placed.status === "done"
            ? "📦 会话压缩已完成，摘要已写入会话，聊天记录仍保留在群库里。"
            : "⚠️ 压缩摘要未写入会话（已过期或取消），原会话仍保留；可用 /status 查看状态。";
        }
        await this.#project(handle.harness, member);
      } finally { handle.release(); }
    } else if (command === "/deliver") {
      onAdmitted?.();
      try {
        await this.#deliver(member, callbackUrl);
        return "";
      } catch (error) {
        reply = describeRequestFailure(error);
      }
    } else if (command === "/status") {
      onAdmitted?.();
      reply = await this.#status(member, callbackUrl);
    } else {
      onAdmitted?.();
      reply = command === "/help" ? HELP_TEXT : unknownCommandText(content);
    }
    await this.#outbound.sendText(reply, groupId, phone, callbackUrl, { signal: this.#closing.signal })
      .catch((error) => this.#report(error));
    return reply;
  }

  /** Commit the control to the stream, execute it, commit its removal; the door holds the member's requests meanwhile. */
  async #control(member: MemberState, command: ControlCommand, receivedAt: number, receipt: ControlReceipt, onAdmitted?: () => void): Promise<void> {
    const handle = await this.#groups.acquire(member.groupId);
    try {
      await member.replaying;
      this.#assertRunning();
      const { harness } = handle;
      const door = this.#runtimes.get(member.groupId)!.door;
      const { requestId } = receipt;
      const ticket = receipt.ticket!;
      try {
        const seq = await harness.commit(async (tx) => {
          const controls = await tx.doc(ControlsDoc);
          controls.seq++;
          controls.pending.push({ phone: member.phone, requestId, seq: controls.seq, command, receivedAt, epoch: controls.epoch ?? 0 });
          return controls.seq;
        }, this.#context);
        door.controlAdmitted(ticket, seq);
        member.cancelBefore = Math.max(member.cancelBefore ?? -Infinity, receivedAt);
      } catch (error) {
        await door.controlUncertain(ticket, async () =>
          (await pendingControls(harness, this.#context)).find((control) => control.requestId === requestId)?.seq);
        throw error;
      }
      onAdmitted?.();
      await this.#execute(harness, member, command, requestId);
    } finally { handle.release(); }
  }

  /**
   * Run a control that is in the stream, then remove it (idempotent: startup runs waiting ones again). It cancels the
   * messages received before it; later ones (admitted while it waited or ran) stay.
   */
  async #execute(harness: Harness, member: MemberState, command: ControlCommand, requestId: string): Promise<void> {
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
          if (attempt === 0) await this.#notify(member, "控制操作暂未完成，将自动重试；完成前暂停本会话的新任务。可用 /status 查看。");
          await retryWait(delay, this.#closing.signal);
        }
      }
    } finally { this.#kick(member); }
  }

  async #executeOnce(harness: Harness, member: MemberState, command: ControlCommand, requestId: string): Promise<void> {
    const door = this.#runtimes.get(member.groupId)!.door;
    // The caller holds the worker (#hold). A start that passed the gate before is finished first: its item arrived
    // before this control, so the cancel below covers it and the abort reaches its run.
    await waitFor(member.starting ?? Promise.resolve(), this.#closing.signal);
    const pending = (await pendingControls(harness, this.#context)).find((control) => control.requestId === requestId);
    if (pending === undefined) { door.controlExecuted(requestId); return; }
      const conversation = member.conversationId === undefined ? undefined
        : await harness.conversation(member.conversationId as ConversationId, this.#context);
      if (conversation !== undefined) {
        await harness.commit(async (tx) => {
          const inbox = await tx.doc(InboxDoc, conversation.id);
          for (const item of inbox.items) if (receivedBefore(item, pending)) item.cancelled = true;
        }, this.#context);
        // Resolves once the conversation is idle: the run, its tools and codemode sub-calls have ended.
        await conversation.abort(this.#context, { background: true });
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
          const places = memberPlaces({ root: this.#options.root, ...(this.#options.venvDir === undefined ? {} : { venvDir: this.#options.venvDir }) },
            member.groupId, member.phone);
          await this.#removeResults(harness, member, places.tempDir, Number.POSITIVE_INFINITY, false);
          await this.#project(harness, member);
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

  // ---- workers --------------------------------------------------------------------------------------------------------

  #kick(member: MemberState): void {
    if (this.#closing.signal.aborted || member.conversationId === undefined) return;
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
      const handle = await this.#groups.acquire(member.groupId);
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
            if (member.starting === started) member.starting = undefined;
            startedDone();
            member.lastUsed = Date.now();
            if (this.#requests.get(head.requestId)?.retired) this.#requests.delete(head.requestId);
          }
        } finally { this.#leaveRun(member); }
      } finally { handle.release(); }
    }
  }

  /** Run one inbox item; `submitted` is called once its submission exists (or nothing will be submitted). */
  async #process(harness: Harness, conversation: Conversation, member: MemberState, item: InboxItem, submitted: () => void): Promise<void> {
    const reply = this.#deliveries.find(member.key, replyRow(item.requestId));
    if (reply !== undefined) {
      // Settled and stored before a crash: finish the removal; the reply waits in the outbox.
      await this.#remove(harness, conversation.id, item.requestId);
      await this.#project(harness, member);
      await this.#recovered(member);
      return;
    }
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
      await this.#remove(harness, conversation.id, item.requestId);
      if (expired) await this.#notify(member, describeRequestFailure(expired.error));
      return;
    }
    if (expired && previous) {
      // The door already has the persisted deadline, so recovered model/tools cannot leave while this abort commits.
      this.#markAborted(member, previous.id.toString(), expired, item.startedAt!);
      await conversation.abort(this.#context);
    }
    if (item.startedAt === undefined && item.cancelled !== true) {
      try {
        this.#deliveries.assertCapacity(member.key);
      } catch (error) {
        await this.#remove(harness, conversation.id, item.requestId);
        await this.#notify(member, describeRequestFailure(error));
        return;
      }
    }
    const startedAt = item.startedAt ?? Date.now();
    if (item.startedAt === undefined) {
      await harness.commit(async (tx) => {
        const stored = (await tx.doc(InboxDoc, conversation.id)).items.find((each) => each.requestId === item.requestId);
        if (stored !== undefined) stored.startedAt = startedAt;
      }, this.#context);
      if (member.callbackUrl !== undefined) {
        this.#track(this.#outbound.sendText(STATUS_TEXT, member.groupId, member.phone, member.callbackUrl,
          { traffic: "status", signal: this.#closing.signal }).catch(() => false));
      }
    }
    if (member.current?.requestId !== item.requestId) member.current = { requestId: item.requestId, startedAt };
    this.#log(`任务开始 - ${taskText(member, item.requestId)}, 总时限: ${this.#limits.runTimeoutMs / 1000}秒, ` +
      `模型无进展时限: ${this.#limits.modelIdleMs / 1000}秒, 单次模型响应时限: ${this.#limits.modelResponseMs / 1000}秒`);
    let settled: SettledSubmissionRecord;
    try {
      // Durable admits a known requestId once: after a crash this finds the same submission.
      const submission = await conversation.submit({ type: "input", content: item.content, requestId: item.requestId }, this.#context);
      submitted();
      settled = await this.#watch(harness, conversation, member, submission, item.cancelled === true ? undefined : startedAt);
      await this.#settle(harness, conversation, member, item, settled);
    } finally { member.current = undefined; }
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

  async #settle(harness: Harness, conversation: Conversation, member: MemberState, item: InboxItem, settled: SettledSubmissionRecord): Promise<void> {
    const aborted = member.aborted.get(settled.id.toString());
    member.aborted.delete(settled.id.toString());
    const notes = this.#deliveries.find(member.key, notesRow(item.requestId));
    let failure: string | undefined;
    let reply: { body: string; notes?: { text: string; attachments: DeliveryAttachment[] } } | undefined;
    if (aborted !== undefined) {
      failure = describeRequestFailure(aborted.error);
    } else if (settled.status === "done" && item.cancelled !== true) {
      const answer = settled.type === "input" && settled.answer !== undefined
        ? await harness.commit(async (tx) => (await tx.entry(AssistantEntry, settled.answer!))?.model?.[0] as AssistantMessage | undefined, this.#context)
        : undefined;
      const text = textOf(answer);
      if (!text && !notes) failure = describeRequestFailure(new Error("Pi 未返回回复"));
      else {
        reply = { body: text || "文件链接已生成。", ...(notes === undefined ? {} : { notes }) };
        // Stored before anything is sent: a failed or interrupted send leaves it for /deliver.
        this.#deliveries.finalize(member.key, notesRow(item.requestId), replyRow(item.requestId),
          [reply.body, notes?.text].filter(Boolean).join("\n\n"), notes?.attachments ?? []);
      }
    } else if (settled.status === "unanswered" && settled.reason !== "aborted" && item.cancelled !== true) {
      failure = describeRequestFailure(await this.#failure(conversation, settled));
    }
    await this.#remove(harness, conversation.id, item.requestId);
    await this.#project(harness, member);
    this.#log(`任务结束 - ${taskText(member, item.requestId)}, 结果: ${settled.status}${"reason" in settled && settled.reason ? `/${settled.reason}` : ""}`);
    if (failure !== undefined) await this.#notify(member, failure);
    if (reply !== undefined && member.callbackUrl !== undefined) {
      const release = await member.delivery.acquire(this.#closing.signal);
      try {
        const id = replyRow(item.requestId);
        // Another path may have delivered it while this worker was projecting usage or waiting for the lock.
        if (member.attempted.has(id) || this.#deliveries.find(member.key, id) === undefined) return;
        member.attempted.add(id);
        let sent = false;
        try {
          const appendix = reply.notes === undefined ? "" : await this.#outbound.refresh(reply.notes, this.#closing.signal);
          sent = await this.#outbound.sendReply(reply.body, member.groupId, member.phone, member.callbackUrl, this.#closing.signal, appendix || undefined);
        } catch (error) { this.#report(error); }
        if (sent) { this.#deliveries.acknowledge([id]); member.attempted.delete(id); }
        else await this.#notify(member, "回复未能完整发到群里，已保存的内容可用 /deliver 补发");
      } finally { release(); }
    }
  }

  /** The model error of an unanswered input, as the AgentSession engine reports it. */
  async #failure(conversation: Conversation, settled: SettledSubmissionRecord): Promise<Error> {
    const page = await conversation.entries({}, 20, undefined, this.#context);
    const last = page.items.find((entry) => AssistantEntry.is(entry))?.model?.[0] as AssistantMessage | undefined;
    if (last?.errorMessage) return modelRequestError(last.errorMessage, [last], this.#options.selection.model.contextWindow);
    return new Error(`模型未能回答（${"reason" in settled ? settled.reason : "unknown"}）`);
  }

  /** Replies stored by an earlier process and never tried: sent once a callback URL is known; a failure leaves them for /deliver. */
  async #recovered(member: MemberState): Promise<void> {
    member.uses++;
    try { await this.#recoverReplies(member); }
    finally { member.uses--; this.#pruneMember(member); }
  }

  async #recoverReplies(member: MemberState): Promise<void> {
    const callbackUrl = member.callbackUrl;
    if (callbackUrl === undefined) return;
    const release = await member.delivery.acquire(this.#closing.signal);
    try {
      const pending = this.#deliveries.pending(member.key);
      if (pending.some(item => item.id.startsWith("reply:")) && member.conversationId !== undefined) {
        const handle = await this.#groups.acquire(member.groupId);
        try { await this.#project(handle.harness, member); } finally { handle.release(); }
      }
      for (const item of pending) {
        if (!item.id.startsWith("reply:") || member.attempted.has(item.id) || this.#deliveries.find(member.key, item.id) === undefined) continue;
        member.attempted.add(item.id);
        let sent = false;
        try {
          const text = await this.#outbound.refresh(item, this.#closing.signal);
          sent = await this.#outbound.sendText(text, member.groupId, member.phone, callbackUrl, { signal: this.#closing.signal });
        } catch (error) { this.#report(error); }
        if (!sent) {
          await this.#notify(member, "回复未能完整发到群里，已保存的内容可用 /deliver 补发");
          return;
        }
        this.#deliveries.acknowledge([item.id]);
        member.attempted.delete(item.id);
      }
    } finally { release(); }
  }

  async #remove(harness: Harness, conversationId: number, requestId: string): Promise<void> {
    await harness.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversationId as ConversationId);
      inbox.items = inbox.items.filter((item) => item.requestId !== requestId);
    }, this.#context);
    const request = this.#requests.get(requestId);
    if (request) request.retired = true;
  }

  /** /deliver: send the member's stored replies, oldest first (not the link notes of a run still going). */
  async #deliver(member: MemberState, callbackUrl: string): Promise<void> {
    const release = await member.delivery.acquire(this.#closing.signal);
    try {
      const running = member.current === undefined ? undefined : notesRow(member.current.requestId);
      const pending = this.#deliveries.pending(member.key).filter((item) => item.id !== running);
      if (!pending.length) {
        await this.#outbound.sendText("你在本群没有待补发的回复。", member.groupId, member.phone, callbackUrl, { signal: this.#closing.signal });
        return;
      }
      for (const item of pending) {
        member.attempted.add(item.id);
        const text = await this.#outbound.refresh(item, this.#closing.signal);
        if (!await this.#outbound.sendText(text, member.groupId, member.phone, callbackUrl, { signal: this.#closing.signal })) {
          throw new Error("补发失败，尚未发完的回复仍已保存，可稍后再发送 /deliver");
        }
        this.#deliveries.acknowledge([item.id]);
        member.attempted.delete(item.id);
      }
    } finally { release(); }
  }

  async #notify(member: MemberState, text: string): Promise<void> {
    if (member.callbackUrl === undefined) return;
    const sent = await this.#outbound.sendText(text, member.groupId, member.phone, member.callbackUrl, { signal: this.#closing.signal })
      .catch((error) => { this.#report(error); return false; });
    if (!sent) this.#report(new Error(`回执未送达 - 群: ${member.groupId}, 用户: ${member.phone}`));
  }

  async #status(member: MemberState, callbackUrl: string): Promise<string> {
    // Idle groups are not discovered at startup. A status query must still see their durable member/expiry records.
    if (member.conversationId === undefined) {
      let exists = false;
      try {
        const info = await lstat(groupDatabasePath(this.#options.root, member.groupId));
        if (!info.isFile()) throw new Error("群库不是普通文件");
        exists = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (exists) {
        const handle = await this.#groups.acquire(member.groupId);
        try { member.conversationId = (await handle.harness.snapshot(MemberDirectory, member.phone, this.#context))?.conversationId; }
        finally { handle.release(); }
      }
    }
    const rate = this.#outbound.rate(callbackUrl);
    let phase = "空闲";
    let waiting = 0;
    let tools = "暂无";
    let taskSpan: string | undefined;
    if (member.conversationId !== undefined) {
      const handle = await this.#groups.acquire(member.groupId);
      try {
        const items = (await inboxItems(handle.harness, member.conversationId, this.#context)).filter((item) => item.cancelled !== true);
        const live = await handle.harness.snapshot(LiveDoc, member.conversationId as ConversationId, this.#context);
        if (member.gate !== undefined) phase = "正在执行 /stop 或 /clear";
        else if (member.workerRetry !== undefined) phase = "等待自动重试";
        else if (live?.run !== undefined) phase = live.tools?.some((slot) => slot.status === "running") ? "执行工具中" : "执行中";
        else if (items.length) phase = "准备中";
        waiting = Math.max(0, items.length - (member.current === undefined ? 0 : 1));
        const running = live?.tools?.filter((slot) => slot.status === "running").map((slot) => slot.name) ?? [];
        if (running.length) tools = running.join("、");
        if (live?.compactions?.length) phase = "压缩会话历史";
        if (live?.run) {
          const task = await handle.harness.getTask(live.run.taskId, this.#context);
          taskSpan = task?.startedAt === undefined ? "未知" : `${Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))} 秒（含等待/重试）`;
        }
      } finally { handle.release(); }
    }
    let text = "状态：" + phase + "\n等待处理的消息：" + waiting + "\n正在运行的工具：" + tools +
      "\n待补发回复：" + this.#deliveries.pending(member.key).length + "\n机器人近1分钟发送额度用量：" + rate.used + "/" + rate.limit;
    if (taskSpan !== undefined) text += "\nDurable 任务跨度：" + taskSpan;
    if (member.conversationId !== undefined) {
      const handle = await this.#groups.acquire(member.groupId);
      try {
        const expired = Object.entries((await handle.harness.snapshot(ResultsDoc, this.#context))?.calls ?? {})
          .filter(([, call]) => call.phone === member.phone && call.expiryRequestedAt !== undefined).map(([name]) => name);
        if (expired.length) text += `\n已过期结果：${expired.length} 个（最近记录最多 256 个）：${expired.slice(-8).join("、")}`;
        const pending = Object.values((await handle.harness.snapshot(ResultsDoc, this.#context))?.calls ?? {}).filter(call => call.phone === member.phone && call.reclamation !== undefined).length;
        if (pending) text += `\n待物理回收：${pending} 个`;
      } finally { handle.release(); }
    }
    const retry = member.controlRetry ?? member.workerRetry;
    if (retry) text += `\n自动重试：第 ${retry.attempt} 次，约 ${Math.max(0, Math.ceil((retry.nextAt - Date.now()) / 1000))} 秒后\n最近错误：${retry.message}`;
    if (member.current !== undefined) {
      text += `\n任务编号：${taskNumber(member.current.requestId)}\n已用时间：${Math.floor((Date.now() - member.current.startedAt) / 1000)} 秒\n最长处理时间：${this.#limits.runTimeoutMs / 1000} 秒` +
        `\n模型无进展时限：${this.#limits.modelIdleMs / 1000} 秒\n单次模型响应时限：${this.#limits.modelResponseMs / 1000} 秒`;
    }
    return text;
  }

  // ---- maintenance ----------------------------------------------------------------------------------------------------

  async #removeResults(harness: Harness, member: MemberState, tempDir: string, before: number, history = true): Promise<void> {
    const doc = await harness.snapshot(ResultsDoc, this.#context);
    const names = Object.entries(doc?.calls ?? {}).filter(([, call]) => call.phone === member.phone).map(([name]) => name);
    const conversation = member.conversationId === undefined ? undefined : await harness.conversation(member.conversationId as ConversationId, this.#context);
    const references: unknown[] = this.#deliveries.pending(member.key);
    if (history && conversation) references.push((await conversation.context(this.#context)).messages);
    const eligible = names.filter(name => doc!.calls[name]!.createdAt < before && (doc!.calls[name]!.reclamation?.nextAttemptAt ?? 0) <= Date.now());
    const isolated = new Map(names.flatMap(name => doc!.calls[name]!.isolatedTask ? [[name, doc!.calls[name]!.isolatedTask!] as const] : []));
    const removed = await removeCodemodeResults(tempDir, before, { isolated, registered: new Set(eligible), protected: referencedResults(tempDir, names, references, isolated),
      expire: async expired => { await harness.commit(async tx => {
        const records = (await tx.doc(ResultsDoc)).calls;
        for (const name of expired) if (records[name]) records[name].expiryRequestedAt ??= Date.now();
      }, this.#context); },
      record: async results => { if (results.some(item => item.status !== "removed")) await harness.commit(async tx => {
        const records = (await tx.doc(ResultsDoc)).calls, attemptedAt = Date.now();
        for (const item of results) if (item.status !== "removed" && records[item.name]) records[item.name]!.reclamation = {
          status: item.status, ...(item.reason ? { reason: item.reason } : {}), ...(item.identity ? { identity: item.identity } : {}), attemptedAt, nextAttemptAt: attemptedAt + 60_000,
        };
      }, this.#context); },
    });
    // Reconcile a crash after deletion but before its completion receipt was committed.
    for (const name of names) {
      if (process.platform === "linux") continue; // An absent shared name does not prove physical deletion.
      if (!/^\d+-[A-Za-z0-9_.-]+$/.test(name) || doc!.calls[name]!.expiryRequestedAt === undefined || doc!.calls[name]!.expiredAt !== undefined || removed.includes(name)) continue;
      try { await lstat(join(tempDir, "codemode", name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.push(name); else throw error; }
    }
    // Only successful removals may be pruned. A failed deletion remains registered for the next sweep/clear retry.
    if (removed.length) await harness.commit(async tx => {
        const records = (await tx.doc(ResultsDoc)).calls;
        for (const name of removed) if (records[name]) { records[name].expiredAt = Date.now(); delete records[name].reclamation; }
        // Expired receipts remain visible (latest 256); live ownership is never pruned by time alone.
        const old = Object.entries(records).filter(([, call]) => call.expiredAt !== undefined)
          .sort((a, b) => a[1].expiredAt! - b[1].expiredAt!);
        for (const [name] of old.slice(0, Math.max(0, old.length - 256))) delete records[name];
      }, this.#context);
    const pending = (await configuredRootlessTasks()?.sweep(tempDir, before, references, new Set(isolated.values())))?.filter(item => item.status !== "removed") ?? [];
    if (pending.length) log.warn(`隔离任务物理回收待办：${pending.length} 个；` + pending.map(item => `${item.name}: ${item.reason}`).join("；"));
  }

  /** Close idle groups, project usage of open groups' members, remove old codemode results of idle members. */
  async maintain(now = Date.now()): Promise<void> {
    await this.#groups.sweep();
    for (const groupId of this.#groups.openGroups) {
      if (this.#closing.signal.aborted) return;
      const handle = await this.#groups.acquire(groupId);
      try {
        for (const member of await this.#memberList(handle.harness)) {
          // A persisted member visited only for maintenance has no new user activity.
          const state = this.#member(groupId, member.phone, 0);
          state.uses++;
          try {
            state.conversationId = member.conversationId;
            await this.#project(handle.harness, state);
            const live = await handle.harness.snapshot(LiveDoc, member.conversationId as ConversationId, this.#context);
            const busy = state.worker !== undefined || state.gate !== undefined || state.current !== undefined
              || (await inboxItems(handle.harness, member.conversationId, this.#context)).length > 0
              || live?.run !== undefined || !!live?.compactions?.length;
            if (busy) continue;
            const release = this.#hold(state, false);
            try {
              // The hold precedes the context read: a newly admitted message cannot start a call during deletion.
              if (state.starting || state.current || state.worker) continue;
              const places = memberPlaces({ root: this.#options.root, ...(this.#options.venvDir === undefined ? {} : { venvDir: this.#options.venvDir }) },
                groupId, member.phone);
              await recoverOfficeProfiles(places.tempDir, deferred => log.warn(`Office 待物理回收：${deferred}`)).catch(error => this.#report(error));
              await this.#removeResults(handle.harness, state, places.tempDir, now - this.#limits.resultRetentionMs).catch((error) => this.#report(error));
            } finally { release(); }
          } finally { state.uses--; this.#pruneMember(state, now); }
        }
      } finally { handle.release(); }
    }
    for (const member of this.#members.values()) this.#pruneMember(member, now);
  }

  /** Stop: cancel waits, close every group (runs stay live in storage and resume on the next start). */
  async close(): Promise<void> {
    this.#closing.abort(new Error("服务正在关闭"));
    this.#cancel(new Error("服务正在关闭"));
    await Promise.allSettled([...this.#runtimes.values()].map((runtime) => runtime.door.close()));
    try {
      await this.#groups.closeAll();
    } finally {
      await Promise.allSettled([...this.#background]);
      this.#members.clear();
      this.#requests.clear();
      this.#running.clear();
      this.#wakeCapacity();
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------------

  #harnessOptions(groupId: string): HarnessOptions {
    const { selection } = this.#options;
    const holder: { harness?: Harness } = {};
    const door = groupDoor(holder, { onReport: (error) => this.#report(error),
      beforeDispatch: (phone, signal) => this.#waitForRun(memberKey(groupId, phone), signal),
      dispatchError: (phone) => {
        const current = this.#members.get(memberKey(groupId, phone))?.current;
        if (!current) return;
        current.deadlineError ??= this.#totalTimeout(current.requestId, current.startedAt);
        return current.deadlineError?.error;
      } });
    for (const receipt of this.#receipts.values()) {
      if (receipt.groupId === groupId) receipt.ticket = door.controlReceived(receipt.phone, receipt.requestId);
    }
    const runtime: GroupRuntime = { door, holder, refreshed: new Map(), epoch: 0 };
    this.#runtimes.set(groupId, runtime);
    const registry = createRegistry();
    const install = (extension: Extension) => registry.install(door.wrapTools(extension));
    install(door.extension());
    if (this.#options.materials !== false) install(this.#materials(groupId, runtime));
    for (const extension of groupExtensions({
      root: this.#options.root, groupId,
      ...(this.#options.venvDir === undefined ? {} : { venvDir: this.#options.venvDir }),
      modules: this.#options.modules, relay: this.#options.relay, delivery: this.#delivery(groupId),
      ...(this.#options.auxiliary ? { auxiliary: { config: this.#options.auxiliary, budget: this.#auxiliaryBudget, door } } : {}),
      ...(this.#options.mcp ? { mcp: { manager: this.#options.mcp, door } } : {}),
    })) install(extension);
    for (const extension of this.#options.extensions?.(groupId) ?? []) install(extension);
    return { models: door.wrap(selection.runtime as unknown as Models), registry, settings: selection.harnessSettings };
  }

  /** Startup gate of a group: before scheduling resumes. */
  async #prepare(harness: Harness, groupId: string, context: Context): Promise<void> {
    const runtime = this.#runtimes.get(groupId)!;
    runtime.holder.harness = harness;
    runtime.epoch = await harness.commit(async (tx) => {
      const controls = await tx.doc(ControlsDoc), epoch = controls.epoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("群库的控制世代无效");
      return controls.epoch = epoch + 1;
    }, context);
    const controls = await pendingControls(harness, context);
    runtime.door.loadControls(controls.map(({ phone, requestId, seq }) => ({ phone, requestId, seq })));
    const kicks: MemberState[] = [];
    for (const { phone, conversationId } of await this.#memberList(harness)) {
      await ensureStorageIdentity(this.#options.root, groupId, phone, this.#options.stateDb);
      await recoverOfficeProfiles(userTempDir(this.#options.root, groupId, phone), deferred => log.warn(`Office 待物理回收：${deferred}`)).catch(error => this.#report(error));
      const member = this.#member(groupId, phone);
      member.conversationId = conversationId;
      const items = await inboxItems(harness, conversationId, context);
      for (const item of items) if (!this.#requests.has(item.requestId)) this.#requests.set(item.requestId, { key: member.key, retired: false });
      const head = items[0];
      if (head?.startedAt !== undefined && head.cancelled !== true) member.current = { requestId: head.requestId, startedAt: head.startedAt };
      if (head !== undefined) kicks.push(member);
    }
    // Every restored head's original deadline is visible to the door before any task is scheduled.
    harness.resume();
    this.#track((async () => {
      for (const control of controls) {
        const member = this.#member(groupId, control.phone);
        const release = this.#hold(member);
        const run: Promise<void> = (member.replaying ?? Promise.resolve()).then(async () => {
          const handle = await this.#groups.acquire(groupId);
          try { await this.#execute(handle.harness, member, control.command, control.requestId); } finally { handle.release(); }
        }).finally(release);
        const replaying = run.catch((error) => this.#report(error));
        member.replaying = replaying;
        void replaying.finally(() => { if (member.replaying === replaying) member.replaying = undefined; this.#pruneMember(member); });
      }
      for (const member of kicks) this.#kick(member);
    })());
  }

  async #pendingWork(harness: Harness, context: Context): Promise<boolean> {
    if ((await pendingControls(harness, context)).length) return true;
    for (const { conversationId } of await this.#memberList(harness)) {
      if ((await inboxItems(harness, conversationId, context)).length) return true;
    }
    return false;
  }

  /** Member conversations of a group: ownerless conversations with an identity. */
  async #memberList(harness: Harness): Promise<{ phone: string; conversationId: number }[]> {
    const ids = await harness.commit(async (tx) => {
      const found: number[] = [];
      let cursor: Parameters<typeof tx.scanConversations>[2];
      for (;;) {
        const page = await tx.scanConversations({}, 200, cursor);
        for (const record of page.items) if (record.owner === undefined) found.push(record.id as number);
        if (page.next === undefined) return found;
        cursor = page.next;
      }
    }, this.#context);
    const members: { phone: string; conversationId: number }[] = [];
    for (const id of ids) {
      const identity = await harness.snapshot(IdentityDoc, id as ConversationId, this.#context);
      if (identity?.phone) members.push({ phone: identity.phone, conversationId: id });
    }
    return members;
  }

  #delivery(groupId: string): SendDelivery {
    return {
      callbackUrl: (member) => {
        const url = this.#members.get(memberKey(groupId, member.phone))?.callbackUrl;
        if (url === undefined) throw new Error("服务重启后还没有收到你的新消息，暂时无法向群里发送文件；请再发一条消息后重试");
        return url;
      },
      notes: (member) => this.#notes(this.#member(groupId, member.phone)),
    };
  }

  /** Link notes go to the running item's outbox row at once (a crash keeps them; the final reply takes them over). */
  #notes(member: MemberState): OutboundNotes {
    const row = () => notesRow(member.current?.requestId ?? `unattached:${randomUUID()}`);
    return {
      add: (note, attachment) => {
        const id = row();
        const existing = this.#deliveries.find(member.key, id);
        this.#deliveries.put(member.key, id, [existing?.text, note].filter(Boolean).join("\n\n"),
          [...(existing?.attachments ?? []), ...(attachment ? [attachment] : [])]);
      },
      peek: () => [],
      references: () => [],
      clear: () => {},
    };
  }

  /** Refresh the group's materials index once per run, before its first request (as the AgentSession engine did). */
  #materials(groupId: string, runtime: GroupRuntime): Extension {
    const root = this.#options.root;
    return defineExtension({
      name: "mixin.materials",
      hooks: [hook(GenerationTask, {
        async beforeRequest(_request, api, context: Context) {
          const taskId = api.taskId as number;
          let refresh = runtime.refreshed.get(taskId);
          if (refresh === undefined) {
            // A new group has neither directory yet (the tools create them on their first call); the index reports its own errors.
            const workspaceDir = resolve(groupWorkspaceDir(root, groupId));
            refresh = Promise.all([workspaceDir, groupIndexDir(root, groupId)].map((dir) => mkdir(dir, { recursive: true })))
              .catch(() => {})
              .then(() => ensureMaterialsIndex({
                workspaceDir, indexPath: resolve(materialsIndexPath(root, groupId)), ignorePath: resolve(materialsIgnorePath(root, groupId)),
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

/**
   * Count the member's new usage into the ledger. Best effort: the cursor stays where it was on failure and the next
   * projection catches up; a failure because the service is closing is not reported.
   */
  async #project(harness: Harness, member: MemberState): Promise<void> {
    if (member.conversationId === undefined) return;
    let db: ReturnType<typeof openStatsLedger> | undefined;
    try {
      db = openStatsLedger(this.#options.root);
      await projectConversation(db, harness, { groupId: member.groupId, phone: member.phone, conversationId: member.conversationId }, this.#context);
    } catch (error) {
      if (!this.#closing.signal.aborted) this.#report(error);
    } finally { db?.close(); }
  }

  #member(groupId: string, phone: string, lastUsed = Date.now()): MemberState {
    const key = memberKey(groupId, phone);
    let member = this.#members.get(key);
    if (member === undefined) {
      member = { key, groupId, phone, again: false, controls: Promise.resolve(), workProgress: 0, aborted: new Map(), attempted: new Set(),
        admission: new AsyncSemaphore(1), delivery: new AsyncSemaphore(1), uses: 0, lastUsed };
      this.#members.set(key, member);
    }
    return member;
  }

  async #closedGroup(groupId: string, harness?: Harness): Promise<void> {
    const runtime = this.#runtimes.get(groupId);
    if (!runtime || (runtime.holder.harness !== undefined && runtime.holder.harness !== harness)) return;
    // Remove the same instance before awaiting its door: a late close must not discard a newly opened runtime.
    this.#runtimes.delete(groupId);
    runtime.holder.harness = undefined;
    runtime.refreshed.clear();
    await runtime.door.close();
    for (const member of this.#members.values()) if (member.groupId === groupId) this.#pruneMember(member);
  }

  #pruneMember(member: MemberState, now = Date.now()): void {
    if (member.uses || member.worker || member.gate || member.starting || member.replaying || member.current
      || member.workerRetry || member.controlRetry || member.attempted.size || this.#deliveries.pending(member.key).length
      || [...this.#requests.values()].some(request => request.key === member.key)
      || [...this.#receipts.values()].some(receipt => receipt.groupId === member.groupId && receipt.phone === member.phone)) return;
    if (this.#runtimes.has(member.groupId) && now - member.lastUsed < DEDUP_TTL) return;
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
    while (!this.#running.has(key) && [...this.#requests.values()].some(request => request.key === key)) await this.#capacityChanged(signal);
    signal.throwIfAborted();
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

/** The DeliveryStore session of a member, as the AgentSession engine keys it (pending replies carry over). */
export function memberKey(groupId: string, phone: string): string {
  return JSON.stringify([groupId, phone]);
}

const notesRow = (requestId: string) => `notes:${requestId}`;
const replyRow = (requestId: string) => `reply:${requestId}`;

const retryDelay = (attempt: number) => Math.min(100 * 2 ** Math.min(attempt, 9), 30_000);
function retryWait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The model's current attempt when the model is what the run waits for, with its committed progress. */
/**
 * The task number of a message: the first 8 hex digits of its request id. Logs write it as `任务: <number>`, the form
 * the log extraction scripts (scripts/ops/task-logs.*) and the TUI search for; /status and failure details show it.
 */
function taskNumber(requestId: string): string {
  return requestId.replace(/^(?:msg|ctl):/, "").slice(0, 8);
}

function taskText(member: Pick<MemberState, "groupId" | "phone">, requestId: string): string {
  return `群: ${member.groupId}, 用户: ${member.phone}, 任务: ${taskNumber(requestId)}`;
}

/** What a running task is doing, for the heartbeat log. */
function livePhase(live: Readonly<LiveState> | undefined): string {
  const running = live?.tools?.filter((slot) => slot.status === "running").map((slot) => slot.name) ?? [];
  if (running.length) return "执行工具 " + running.join("、");
  if (live?.compactions?.some((compaction) => compaction.blocking)) return "压缩会话历史";
  const generation = live?.generation;
  if (generation?.retry !== undefined) return "等待重试";
  if (generation !== undefined) return "等待或接收模型输出";
  return "准备中";
}

function modelActivity(live: Readonly<LiveState> | undefined): { key: string; progress: string } | undefined {
  const generation = live?.generation;
  if (live?.run === undefined || generation === undefined) return undefined;
  if (generation.retry !== undefined || generation.deferred !== undefined) return undefined;
  if (live.tools !== undefined && live.tools.length > 0) return undefined;
  if (live.compactions?.some((compaction) => compaction.blocking)) return undefined;
  return { key: `${live.run.taskId}:${generation.attempt}`, progress: JSON.stringify(generation.message ?? null) };
}
