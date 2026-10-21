import { AsyncLocalStorage } from "node:async_hooks";
import { application } from "./lifecycle.ts";
import { log } from "./log.ts";
import { executeProcess, ProcessFailure, type ProcessEvent, type ProcessOptions } from "../../scripts/lib/process.ts";

export type { ProcessOptions } from "../../scripts/lib/process.ts";

/** The member tool call commands run for; src/durable/tools.ts sets it around each call. */
export interface CommandScope {
  tool: string;
  toolTask: number | string;
  /** Immutable identity of this tool invocation; never look up the member's next request here. */
  describe: () => Promise<string>;
}
export const commandScope = new AsyncLocalStorage<CommandScope>();

/** Service lifecycle adapter; migrations and tests use the same executor without the application singleton. */
export function runProcess(options: ProcessOptions) {
  const signal = AbortSignal.any([application.signal, ...(options.signal ? [options.signal] : [])]);
  const phases = new Map<string, number>();
  const observe = (event: ProcessEvent) => { if (!phases.has(event.phase)) phases.set(event.phase, event.elapsedMs); options.observe?.(event); };
  const scoped = commandScope.getStore() !== undefined;
  return application.track(timedCommand(() => executeProcess({ ...options, signal, ...(scoped ? { observe } : {}) }), phases));
}

/**
 * Runs `work` and, inside a tool call, logs one `命令耗时` line for it, success or failure. `phases` holds the first
 * time of each supervisor phase (ms from the request); without them only the total is known.
 */
export async function timedCommand<T extends { exitCode: number }>(work: () => Promise<T>,
  phases: ReadonlyMap<string, number> = new Map()): Promise<T> {
  const scope = commandScope.getStore();
  if (!scope) return work();
  const started = performance.now();
  const label = Promise.resolve().then(scope.describe).catch(() => "成员未知");
  const write = async (outcome: string) => {
    const timing = timingText(phases, performance.now() - started);
    try { log.info(`命令耗时 - ${await label}, 工具: ${scope.tool}#${scope.toolTask}, 结果: ${outcome}, ${timing}`); } catch {}
  };
  try {
    const result = await work();
    void write(`退出码 ${result.exitCode}`);
    return result;
  } catch (error) {
    void write(error instanceof ProcessFailure ? FAILURE_LABELS[error.kind] : "失败");
    throw error;
  }
}

const FAILURE_LABELS: Record<ProcessFailure["kind"], string> = {
  startup: "启动失败", timeout: "超时", cancelled: "取消", "output-limit": "输出超限", supervisor: "监督失败", reaping: "回收失败",
};

function timingText(phases: ReadonlyMap<string, number>, total: number): string {
  const seconds = (ms: number | undefined) => ms === undefined || ms < 0 ? "-" : (ms / 1000).toFixed(2) + "秒";
  const at = (phase: string) => phases.get(phase);
  const between = (from: number | undefined, to: number | undefined) => from === undefined || to === undefined ? undefined : to - from;
  const ready = at("supervisor-ready"), spawned = at("spawned"), exited = at("command-exit");
  if (ready === undefined) return `总: ${seconds(total)}`;
  return `总: ${seconds(total)}, 监督进程启动: ${seconds(ready)}, 命令启动: ${seconds(between(ready, spawned))}, ` +
    `执行: ${seconds(between(spawned, exited))}, 回收: ${seconds(between(exited, total))}`;
}
