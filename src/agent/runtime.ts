// Pi local SDK integration. One SessionQueue owns each user's entire task lifecycle.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { GROUP_DATA_ROOT, SESSION_IDLE_TTL, RUN_TIMEOUT_MS, MODEL_IDLE_TIMEOUT_MS, MODEL_RESPONSE_TIMEOUT_MS } from "../core/config.ts";
import { log } from "../core/log.ts";
import { application, waitFor } from "../core/lifecycle.ts";
import { archiveFile } from "../core/maintenance.ts";
import { abortOutboundRequests, getOutboundRateStatus, sendReplyWithMention, sendText } from "../integrations/im.ts";
import { groupSegment, groupWorkspaceDir, materialsIgnorePath, materialsIndexPath, sessionFilePath, userSegment } from "./paths.ts";
import { ingestBeforeArchive, ingestUserSession } from "./stats-ledger.ts";
import { ensureMaterialsIndex } from "./materials-index.ts";
import { canonicalCommand, HELP_TEXT, isSlashCommandMessage, stripLeadingMention, unknownCommandText } from "./commands.ts";
import { createOutboundNotes, type OutboundNotes } from "./send-tools.ts";
import { DeliveryStore } from "./delivery-store.ts";
import { refreshDeliveryText } from "./delivery-links.ts";
import { SessionQueue } from "./session-queue.ts";
import { ensureStorageIdentity } from "./storage-identity.ts";
import { redactSecrets } from "../../scripts/lib/redact.ts";
import { ModelProgress } from "./model-progress.ts";
import { createChatSession, getRuntime } from "./session-factory.ts";
import { progressText, setStage, subscribeProgress, type ProgressState } from "./session-events.ts";
import { cancelCacheWarming } from "./session-control.ts";

interface SessionRecord extends ProgressState {
  key: string; phone: string; groupId: string; callbackUrl: string;
  queue: SessionQueue; session?: AgentSession; lastUsed: number;
  notes: OutboundNotes; deliveryId?: string; unsubscribe?: () => void;
}
const records = new Map<string, SessionRecord>();
const controlReceipts = new Map<string, Promise<unknown>>();
let deliveries: DeliveryStore | undefined;
const store = () => deliveries ??= new DeliveryStore();
const sessionKey = (phone: string, groupId: string) => JSON.stringify([groupId, phone]);

export function resolveSessionCallbackUrl(phone: string, groupId: string, fallback: string): string {
  return records.get(sessionKey(phone, groupId))?.callbackUrl ?? fallback;
}

/** Stop remains available even if control receipts are already queued. */
export function stopUserTask(phone: string, groupId: string): void {
  const record = records.get(sessionKey(phone, groupId));
  if (record?.session) cancelCacheWarming(record.session);
  void record?.queue.cancel();
}

function getRecord(phone: string, groupId: string, callbackUrl: string): SessionRecord {
  const key = sessionKey(phone, groupId);
  let record = records.get(key);
  if (!record) {
    if (records.size >= 1000) throw new Error("会话容量已满，请稍后重试");
    record = { key, phone, groupId, callbackUrl, queue: new SessionQueue(), lastUsed: Date.now(),
      notes: createOutboundNotes((note, attachment) => {
        record!.deliveryId = store().save(key, [...record!.notes.peek(), note].join("\n\n"), record!.deliveryId,
          [...record!.notes.references(), ...(attachment ? [attachment] : [])]);
      }) };
    records.set(key, record);
  }
  record.callbackUrl = callbackUrl;
  record.lastUsed = Date.now();
  return record;
}

async function refreshIndex(record: SessionRecord, signal: AbortSignal): Promise<void> {
  const indexPath = resolve(materialsIndexPath(GROUP_DATA_ROOT, record.groupId));
  await mkdir(dirname(indexPath), { recursive: true });
  await waitFor(ensureMaterialsIndex({
    workspaceDir: resolve(groupWorkspaceDir(GROUP_DATA_ROOT, record.groupId)), indexPath,
    ignorePath: resolve(materialsIgnorePath(GROUP_DATA_ROOT, record.groupId)),
  }), signal);
}

async function createSession(record: SessionRecord, signal: AbortSignal): Promise<AgentSession> {
  const session = await createChatSession({ phone: record.phone, groupId: record.groupId,
    notes: record.notes, getCallbackUrl: () => record.callbackUrl }, signal);
  record.session = session;
  record.unsubscribe = subscribeProgress(session, record);
  signal.throwIfAborted();
  return session;
}

export async function initializeAgentRuntime(): Promise<void> { store(); await getRuntime(); }

async function run(record: SessionRecord, content: string, cancellation: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const modelIdle = new AbortController();
  const modelResponse = new AbortController();
  const signal = AbortSignal.any([application.signal, cancellation, deadline, modelIdle.signal, modelResponse.signal]);
  const p: NonNullable<SessionRecord["progress"]> = record.progress = {
    id: randomUUID().slice(0, 8), started: Date.now(), updated: Date.now(), stage: "准备会话",
    model: new ModelProgress(), signal,
    checkModelLimits: () => {
      if (signal.aborted) return;
      // Sample before cancelling so a recent parsed change cannot be missed by throttling.
      if (p.model.sampleToolArguments(p.model.isIdle(MODEL_IDLE_TIMEOUT_MS))) p.updated = Date.now();
      if (p.model.isExpired(MODEL_RESPONSE_TIMEOUT_MS)) {
        modelResponse.abort(new Error(`单次模型响应时限 ${MODEL_RESPONSE_TIMEOUT_MS / 1000} 秒已到（阶段：${p.stage}；任务：${p.id}）`));
      } else if (p.model.isIdle(MODEL_IDLE_TIMEOUT_MS)) {
        modelIdle.abort(new Error(`模型连续 ${MODEL_IDLE_TIMEOUT_MS / 1000} 秒无有效进展（阶段：${p.stage}；任务：${p.id}）`));
      }
    },
  };
  record.lastTool = undefined;
  log.info(`任务开始 - ${progressText(record)}, 总时限: ${RUN_TIMEOUT_MS / 1000}秒, 模型无进展时限: ${MODEL_IDLE_TIMEOUT_MS / 1000}秒, 单次模型响应时限: ${MODEL_RESPONSE_TIMEOUT_MS / 1000}秒`);
  const heartbeat = setInterval(() => log.info("任务仍在运行 - " + progressText(record)), 60_000);
  heartbeat.unref();
  const watchdog = setInterval(p.checkModelLimits, 1000);
  watchdog.unref();
  record.notes.clear();
  record.deliveryId = undefined;
  let session: AgentSession | undefined;
  let abortTask: Promise<void> | undefined;
  let timeoutStage: string | undefined;
  const onAbort = () => {
    if (!p.abortReason) {
      timeoutStage = p.stage;
      p.abortReason = application.signal.aborted ? "shutdown" : cancellation.aborted ? "user_cancel" :
        modelIdle.signal.aborted ? "model_idle" : modelResponse.signal.aborted ? "model_response_timeout" : "task_timeout";
      const reason = p.abortReason === "model_idle" ? "模型无有效进展超时" :
        p.abortReason === "model_response_timeout" ? "单次模型响应超时" :
        p.abortReason === "task_timeout" ? "任务总时限到达" : "任务取消";
      log.warn(reason + " - " + progressText(record));
      p.model.pause();
      setStage(record, "等待取消清理");
    }
    if (session && !abortTask) {
      cancelCacheWarming(session);
      abortTask = session.abort().catch((error) => log.warn("Pi abort: " + String(error)));
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    store().assertCapacity(record.key);
    session = record.session ?? await createSession(record, signal);
    if (signal.aborted) { onAbort(); signal.throwIfAborted(); }
    setStage(record, "刷新资料索引");
    await refreshIndex(record, signal);
    record.queue.phase = "执行中";
    // A status message is disposable and cannot delay model execution.
    const status = sendText("收到, 正在处理... 🤔💭", record.groupId, record.phone, record.callbackUrl,
      { traffic: "status", signal }).catch(() => false);
    application.track(status);
    setStage(record, "模型调用准备（含历史检查）");
    log.info(`模型调用开始 - ${progressText(record)}, 历史消息数: ${session.state.messages.length}`);
    await session.prompt(content);
    signal.throwIfAborted();
    if (session.cacheWarmingStatus) {
      log.info("Pi 缓存保温状态 - " + redactSecrets(JSON.stringify(session.cacheWarmingStatus)));
    }
    p.model.pause();
    setStage(record, "模型调用结束");
    const failure = session.state.errorMessage;
    const text = session.getLastAssistantText();
    const rawAppendix = record.notes.peek().join("\n\n");
    if (failure) throw new Error(failure);
    if (!text && !rawAppendix) throw new Error("Pi 未返回回复");
    const body = text || "文件链接已生成。";
    // Persist the complete answer before any network probe or send can fail.
    record.deliveryId = store().save(record.key, [body, rawAppendix].filter(Boolean).join("\n\n"), record.deliveryId, record.notes.references());
    const appendix = await refreshDeliveryText({ text: rawAppendix, attachments: record.notes.references() }, signal);
    record.queue.phase = "正在发送回复";
    setStage(record, "发送最终回复");
    const sent = await sendReplyWithMention(body, record.groupId, record.phone, record.callbackUrl, signal, appendix || undefined);
    if (!sent) throw new Error("回复未能完整发到群里，已保存的内容可用 /deliver 补发");
    store().acknowledge([record.deliveryId]);
    record.notes.clear();
    log.info("任务完成 - " + progressText(record));
  } catch (error) {
    if (cancellation.aborted || application.signal.aborted) return;
    if (p.abortReason === "model_idle") throw modelIdle.signal.reason;
    if (p.abortReason === "model_response_timeout") throw modelResponse.signal.reason;
    if (p.abortReason === "task_timeout") {
      throw new Error(`任务总时限 ${RUN_TIMEOUT_MS / 1000} 秒已到（阶段：${timeoutStage ?? record.progress?.stage}；任务：${record.progress?.id}）`);
    }
    log.warn("任务失败 - " + progressText(record) + ", 错误: " + redactSecrets(String(error)));
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearInterval(watchdog);
    p.model.pause();
    try { await abortTask; } finally {
      if (signal.aborted) log.info("任务取消清理完成 - " + progressText(record));
      clearInterval(heartbeat);
      record.progress = undefined;
    }
    record.lastUsed = Date.now();
    // 失败和取消的任务也有真实消耗。仍在本成员队列里，与 /clear 的归档入账串行；失败留给每日兜底扫描。
    await ingestUserSession(GROUP_DATA_ROOT, groupSegment(record.groupId), userSegment(record.phone)).catch((error) =>
      log.warn(`统计入账失败，留待每日扫描 - 群: ${record.groupId}, 用户: ${record.phone}, 错误: ${String(error)}`));
  }
}

/** Control action is immediate; its network receipt is separately bounded/coalesced. */
export async function handleUserMessage(phone: string, groupId: string, content: string, callbackUrl: string, invalidate?: () => void): Promise<void> {
  application.signal.throwIfAborted();
  const record = getRecord(phone, groupId, callbackUrl);
  if (!isSlashCommandMessage(content)) return record.queue.enqueue((signal) => run(record, stripLeadingMention(content), signal), invalidate);
  const command = canonicalCommand(content);
  let reply: string;
  if (command === "/stop") {
    if (record.session) cancelCacheWarming(record.session);
    await record.queue.cancel();
    reply = "⏹ 已停止你在本群的当前任务，并取消排队中的消息。已发出的内容不会撤回。";
    if (store().pending(record.key).length) reply += "\n已生成但尚未发完的回复已保留，发送 /deliver 可补发。";
  } else if (command === "/clear") {
    record.queue.cancel();
    await record.queue.enqueue(async () => {
      await ensureStorageIdentity(GROUP_DATA_ROOT, groupId, phone);
      await disposeSession(record);
      // 统计只认账本，而 /clear 是成员随时能发的指令：归档前必须把这段历史落账。
      await ingestBeforeArchive(GROUP_DATA_ROOT, groupSegment(groupId), userSegment(phone));
      await archiveFile(sessionFilePath(GROUP_DATA_ROOT, groupId, phone));
    });
    reply = "🧹 你在本群的聊天记录已归档，下条消息将开启新会话。其他人的聊天记录不受影响。";
    if (store().pending(record.key).length) reply += "\n之前已生成但尚未发完的回复仍保留，发送 /deliver 可补发。";
  } else if (command === "/deliver") {
    return record.queue.enqueue(async (cancel) => {
      const signal = AbortSignal.any([application.signal, cancel]);
      const pending = store().pending(record.key);
      if (!pending.length) { await sendText("你在本群没有待补发的回复。", groupId, phone, callbackUrl, { signal }); return; }
      for (const item of pending) {
        const text = await refreshDeliveryText(item, signal);
        if (!await sendText(text, groupId, phone, record.callbackUrl, { signal })) throw new Error("补发失败，尚未发完的回复仍已保存，可稍后再发送 /deliver");
        store().acknowledge([item.id]);
      }
    });
  } else if (command === "/status") {
    const rate = getOutboundRateStatus(callbackUrl);
    reply = "状态：" + record.queue.phase + "\n等待处理的消息：" + record.queue.waiting +
      "\n最近使用的工具：" + (record.lastTool ?? "暂无") + "\n待补发回复：" + store().pending(record.key).length +
      "\n机器人近1分钟发送额度用量：" + rate.used + "/" + rate.limit;
    if (record.progress) {
      const p = record.progress;
      reply += `\n任务编号：${p.id}\n当前阶段：${p.stage}\n已用时间：${Math.floor((Date.now() - p.started) / 1000)} 秒` +
        `\n距上次进度更新：${Math.floor((Date.now() - p.updated) / 1000)} 秒\n最长处理时间：${RUN_TIMEOUT_MS / 1000} 秒` +
        `\n模型无进展时限：${MODEL_IDLE_TIMEOUT_MS / 1000} 秒` +
        `\n单次模型响应时限：${MODEL_RESPONSE_TIMEOUT_MS / 1000} 秒`;
    }
  } else reply = command === "/help" ? HELP_TEXT : unknownCommandText(content);
  const receiptKey = record.key + command;
  if (controlReceipts.has(receiptKey) || controlReceipts.size >= 128) return;
  const receipt = sendText(reply, groupId, phone, record.callbackUrl, { signal: application.signal })
    .catch((error) => log.warn("控制指令回执失败: " + String(error)))
    .finally(() => controlReceipts.delete(receiptKey));
  controlReceipts.set(receiptKey, application.track(receipt));
}

export async function cleanupIdleSessions(now = Date.now()): Promise<void> {
  for (const [key, record] of records) {
    if (record.queue.busy || now - record.lastUsed < SESSION_IDLE_TTL) continue;
    const lastUsed = record.lastUsed;
    try {
      // Keep the same record until disposal finishes; arriving messages queue behind it.
      await record.queue.enqueue(() => disposeSession(record));
      if (!record.queue.busy && record.lastUsed === lastUsed && records.get(key) === record) records.delete(key);
    } catch (error) {
      if (application.signal.aborted) return;
      // Keep the failed record available for a later retry, but continue disposing other idle sessions.
      log.warn(`空闲会话释放失败，保留待重试 - 群: ${record.groupId}, 用户: ${record.phone}, 错误: ${String(error)}`);
    }
  }
}

async function disposeSession(record: SessionRecord): Promise<void> {
  record.unsubscribe?.();
  record.unsubscribe = undefined;
  await record.session?.dispose();
  record.session = undefined;
}

export async function disposeAllSessions(): Promise<void> {
  application.abort();
  abortOutboundRequests();
  const all = [...records.values()];
  await Promise.allSettled(all.map(async (record) => {
    await record.queue.close();
    await disposeSession(record);
  }));
  records.clear();
}
