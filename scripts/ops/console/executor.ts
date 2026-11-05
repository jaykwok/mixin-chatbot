import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliArgs } from "../../lib/cli.ts";
import { operationCommand, operationObserver } from "./operations.ts";
import { PlanStore } from "./plans.ts";
import { consoleDir } from "./state.ts";
import { TaskStore } from "./tasks.ts";
import type { ExecutorIdentity, TaskRequest, TaskResult } from "./tasks.ts";
import { executorIdentity, taskObservers, unregisterTask } from "./task-host.ts";
import { UploadStore } from "./uploads.ts";
import { ConfigurationDrafts } from "./configuration-drafts.ts";
import { readOpsResult } from "../core/result.ts";

interface ExecutorDependencies {
  identity: ExecutorIdentity;
  verify(request: TaskRequest): Promise<unknown>;
  command(request: TaskRequest): { command: string; args: string[]; env?: Record<string, string> };
  cleanup?(request: TaskRequest): Promise<void>;
  /** Asked once a task has failed: whether maintenance state is still unfinished (recorded with the result). */
  needsRecovery?(request: TaskRequest): Promise<boolean>;
}

function outcome(id: string, request: TaskRequest, exitCode: number, source: unknown): Omit<TaskResult, "version" | "id" | "finishedAt"> {
  const value = readOpsResult(source, request.operation, exitCode);
  if (!value) {
    return { outcome: "failed", exitCode: exitCode || 1, finalState: "unknown", message: `任务 ${id} 没有完整且一致的执行结果，请检查维护状态` };
  }
  return { outcome: value.outcome, exitCode, finalState: value.finalState, message: value.message };
}

/** No HTTP/session dependency: once accepted, closing a browser or the console cannot cancel this process. */
export async function executeTask(store: TaskStore, id: string, dependencies: ExecutorDependencies): Promise<number> {
  const request = store.request(id);
  if (!store.accept(id, dependencies.identity)) return 1;
  let log: ReturnType<TaskStore["eventWriter"]> | undefined, persistenceFailed = false;
  const emit = (kind: "output" | "phase" | "error", message: string) => {
    try { log?.(kind, message); } catch { persistenceFailed = true; }
  };
  const beat = () => { try { store.heartbeat(id, dependencies.identity); } catch { persistenceFailed = true; } };
  let timer: ReturnType<typeof setInterval> | undefined;
  let result: Omit<TaskResult, "version" | "id" | "finishedAt">;
  try {
    log = store.eventWriter(id); beat();
    timer = setInterval(beat, 5000);
    emit("phase", "已接单，正在核对计划");
    await dependencies.verify(request);
    if (persistenceFailed) throw new Error("接单后无法写入任务记录，未执行操作");
    const command = dependencies.command(request);
    const resultPath = join(store.dir(id), "ops-result.json");
    // Child streams are drained concurrently, including after log failure, so maintenance can finish safely.
    const child = Bun.spawn([command.command, ...command.args], { cwd: request.project, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...command.env, MIXIN_OPS_RESULT_FILE: resultPath, MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: id } });
    const drain = async (stream: ReadableStream<Uint8Array>, kind: "output" | "error") => {
      const reader = stream.getReader(), decoder = new TextDecoder(); let buffered = "", discard = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          buffered += decoder.decode(chunk.value, { stream: !chunk.done });
          let end: number;
          while ((end = buffered.indexOf("\n")) !== -1) {
            // The ops core reports its stage progress on stderr, next to its notices; progress is not an error.
            if (!discard) emit(kind === "error" && buffered.startsWith("部署阶段：") ? "output" : kind, buffered.slice(0, end));
            buffered = buffered.slice(end + 1); discard = false;
          }
          // Unbounded lines are discarded as a whole; never split a secret across separately redacted fragments.
          if (buffered.length > 64 * 1024) { buffered = ""; discard = true; emit("error", "一行输出过长，已省略"); }
          if (chunk.done) break;
        }
        if (buffered && !discard) emit(kind, buffered);
      } finally { reader.releaseLock(); }
    };
    emit("phase", "正在执行");
    const [exitCode] = await Promise.all([child.exited, drain(child.stdout, "output"), drain(child.stderr, "error")]);
    let source: unknown;
    try { source = JSON.parse(readFileSync(resultPath, "utf8")); } catch { /* outcome refuses missing/partial JSON */ }
    result = outcome(id, request, exitCode, source);
  } catch (error) {
    result = { outcome: "failed", exitCode: 1, finalState: "unknown", message: error instanceof Error ? error.message : String(error) };
  } finally { if (timer) clearInterval(timer); }
  emit(result.outcome === "success" ? "phase" : "error", result.message);
  if (persistenceFailed) result = { ...result, outcome: "failed", exitCode: result.exitCode || 1, message: "任务日志或心跳写入失败，请核对维护状态和运维日志" };
  if (result.outcome === "failed" && dependencies.needsRecovery) {
    try { result = { ...result, leftRecovery: await dependencies.needsRecovery(request) }; }
    catch { result = { ...result, leftRecovery: true }; }
  }
  let code = 1;
  try { store.finish(id, result); code = result.outcome === "success" && result.exitCode === 0 ? 0 : result.exitCode || 1; }
  catch { /* no result = interrupted after the hosting process ends, never success */ }
  try { await dependencies.cleanup?.(request); } catch { /* retained unit is reconciled on the next console startup */ }
  return code;
}

if (import.meta.main) {
  try {
    const { values, positionals } = cliArgs(process.argv.slice(2), { project: { type: "string" }, task: { type: "string" } });
    if (positionals.length || !values.project || !values.task) throw new Error("执行器需要 --project 和 --task");
    const project = resolve(values.project), store = new TaskStore(consoleDir(project));
    const plans = new PlanStore(consoleDir(project), operationObserver(project));
    process.exitCode = await executeTask(store, values.task, { identity: await executorIdentity(),
      verify: request => plans.verify(request.planId, request), command: request => operationCommand(project, request.operation, request.params, plans.read(request.planId).facts),
      needsRecovery: taskObservers().needsRecovery,
      cleanup: async request => {
        try {
          if (existsSync(join(store.dir(request.id), "result.json"))) {
            if (request.params.upload !== undefined) new UploadStore(consoleDir(project)).finish(request);
            if (request.operation === "configuration-apply") new ConfigurationDrafts(project).finish(String(request.params.draft), request.id);
            if (request.operation === "configuration-restore") {
              const drafts = new ConfigurationDrafts(project), id = String(request.params.draft), owner = drafts.task(id);
              if (owner) drafts.finish(id, owner);
            }
          }
        }
        finally { await unregisterTask(request); }
      } });
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
