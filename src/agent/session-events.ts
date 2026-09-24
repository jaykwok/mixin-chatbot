// Translate SDK events into host progress without owning the task or starting another agent loop.
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { log } from "../core/log.ts";
import { redactSecrets } from "./failure.ts";
import type { ModelProgress } from "./model-progress.ts";

export interface ProgressState {
  phone: string;
  groupId: string;
  lastTool?: string;
  progress?: {
    id: string; started: number; updated: number; stage: string;
    model: ModelProgress; signal: AbortSignal; checkModelLimits: () => void;
    abortReason?: "model_idle" | "model_response_timeout" | "task_timeout" | "user_cancel" | "shutdown";
  };
}

export function progressText(record: ProgressState): string {
  const p = record.progress;
  if (!p) return "";
  const stream = p.model.snapshot();
  return `任务: ${p.id}, 群: ${record.groupId}, 用户: ${record.phone}, 阶段: ${p.stage}, ` +
    `耗时: ${Math.floor((Date.now() - p.started) / 1000)}秒, 最近进展距今: ${Math.floor((Date.now() - p.updated) / 1000)}秒` +
    (stream ? ", 模型流: " + JSON.stringify(stream) : "") +
    (p.abortReason ? ", 取消原因: " + p.abortReason : "");
}

export function setStage(record: ProgressState, stage: string, advanced = true): void {
  const p = record.progress;
  if (!p || (p.signal.aborted && stage !== "等待取消清理")) return;
  const changed = p.stage !== stage;
  p.stage = stage;
  if (advanced) p.updated = Date.now();
  if (changed) log.info("任务进展 - " + progressText(record));
}

export function subscribeProgress(session: AgentSession, record: ProgressState): () => void {
  return session.subscribe((event) => {
    // Only record metadata; never log model text, reasoning or tool arguments/results.
    if (event.type === "entry_appended" && event.entry.type === "usage") {
      const entry = event.entry;
      log.info(`Pi 独立用量 - kind=${entry.kind}, provider=${entry.provider}, model=${entry.model}, cost=${entry.usage.cost.total}`);
    }
    const p = record.progress;
    if (!p) return;
    // Cancellation can still yield a terminal assistant message; keep its finish reason.
    if (event.type === "message_end" && event.message.role === "assistant") {
      p.model.finish(event.message);
      log.info("模型流结束 - " + progressText(record));
      setStage(record, "模型响应结束");
      return;
    }
    // Late SDK events must not rearm the watchdog or hide the cancellation cleanup stage.
    if (p.signal.aborted) return;
    if (event.type === "turn_start") {
      p.model.begin();
      setStage(record, "等待模型响应");
    }
    if (event.type === "message_start" && event.message.role === "assistant") p.model.start(event.message);
    if (event.type === "message_update") {
      setStage(record, "接收模型输出", p.model.update(event.assistantMessageEvent));
      // Also check on events so a flood of empty deltas cannot conceal a stalled stream.
      p.checkModelLimits();
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" ||
        event.type === "tool_execution_end" || event.type === "turn_end" ||
        event.type === "compaction_start" || event.type === "auto_retry_start" ||
        event.type === "summarization_retry_scheduled" || event.type === "summarization_retry_attempt_start") p.model.pause();
    if (event.type === "tool_execution_start") {
      record.lastTool = event.toolName;
      setStage(record, "执行工具 " + event.toolName);
    }
    if (event.type === "tool_execution_update") setStage(record, "执行工具 " + event.toolName);
    if (event.type === "tool_execution_end") setStage(record, "工具结束 " + event.toolName);
    if (event.type === "compaction_start") setStage(record, "压缩会话历史");
    if (event.type === "compaction_end") {
      setStage(record, "会话历史压缩结束");
      if (event.errorMessage) log.warn("历史压缩异常 - " + progressText(record) + ", 错误: " + redactSecrets(event.errorMessage));
    }
    if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
      setStage(record, event.type === "auto_retry_start" ? "等待模型重试" : "等待历史压缩重试");
      log.warn(`模型自动重试 - ${progressText(record)}, 次数: ${event.attempt}/${event.maxAttempts}, ` +
        `延迟: ${event.delayMs}ms, 错误: ${redactSecrets(event.errorMessage)}`);
    }
    if (event.type === "auto_retry_end") setStage(record, "模型重试结束");
    if (event.type === "summarization_retry_attempt_start") setStage(record, "重试会话历史压缩");
  });
}
