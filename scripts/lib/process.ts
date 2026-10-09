import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { monitorJob } from "./process-job.ts";

const supervisor = fileURLToPath(new URL("./process-supervisor.ts", import.meta.url));
export const PROCESS_CLEANUP_MS = 5_000;
export interface ProcessEvent { phase: string; elapsedMs: number; pid?: number; code?: number | null; signal?: string | null; detail?: string }
export interface ProcessOptions {
  command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  timeoutMs: number; deadline?: number; maxOutputBytes?: number;
  onData?: (data: Buffer) => void;
  onOutput?: (data: Buffer, stream: "stdout" | "stderr") => void;
  observe?: (event: ProcessEvent) => void;
}
export interface ProcessResult {
  exitCode: number; commandExitCode: number | null; commandSignal: string | null;
  supervisorExitCode: number | null; supervisorSignal: string | null;
  output: string; stdout: string; stderr: string; lastPhase: string; pid?: number;
}
export class ProcessFailure extends Error {
  constructor(readonly kind: "startup" | "timeout" | "cancelled" | "output-limit" | "supervisor" | "reaping", message: string,
    readonly result: ProcessResult, cause?: unknown) { super(message, { cause }); }
}

/** Owns a helper/job/subreaper through exit, fixed pipe drainage, and confirmed reaping; no application singleton. */
export async function executeProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("命令时限必须大于零");
  options.signal?.throwIfAborted();
  const started = performance.now(), budget = Math.min(options.timeoutMs, options.deadline === undefined ? Infinity : options.deadline - started);
  if (budget <= 0) throw new Error("命令截止时间已到");
  const result: ProcessResult = { exitCode: 1, commandExitCode: null, commandSignal: null, supervisorExitCode: null, supervisorSignal: null,
    stdout: "", stderr: "", output: "", lastPhase: "spawn-request" };
  let observationFailed: ((error: unknown) => void) | undefined;
  const event = (phase: string, data: Omit<ProcessEvent, "phase" | "elapsedMs"> = {}) => {
    result.lastPhase = phase;
    try { options.observe?.({ phase, elapsedMs: performance.now() - started, ...data }); }
    catch (error) { if (observationFailed) observationFailed(error); else throw error; }
  };
  event("spawn-request");
  const jobName = `Local\\mixin-process-${randomUUID()}`;
  const child = spawn(process.execPath, [supervisor], { cwd: options.cwd, env: { ...process.env, MIXIN_PROCESS_EVENTS: "1", MIXIN_PROCESS_JOB: jobName },
    stdio: ["pipe", "pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  result.pid = child.pid;
  let failure: { kind: ProcessFailure["kind"]; message: string; cause?: unknown } | undefined;
  let job: ReturnType<typeof monitorJob> | undefined, bytes = 0, protocol = "", commandExited = false, reaped = false, pipesClosed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined, drain: ReturnType<typeof setTimeout> | undefined;
  const fail = (kind: ProcessFailure["kind"], message: string, cause?: unknown) => {
    failure ??= { kind, message, cause }; child.stdin?.end();
    escalation ??= setTimeout(() => { try { job?.terminate(); } catch (error) { failure = { kind: "reaping", message: String(error), cause: error }; } child.kill("SIGKILL"); }, 2_000);
  };
  const onAbort = () => fail("cancelled", String(options.signal?.reason ?? "Command cancelled"), options.signal?.reason);
  observationFailed = error => fail("supervisor", "进程阶段观察器失败：" + String(error), error);
  const timer = setTimeout(() => fail("timeout", `Command timed out after ${budget / 1000} seconds`), budget);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const receive = (data: Buffer, stream: "stdout" | "stderr") => {
    bytes += data.length;
    result[stream] = (result[stream] + data.toString("utf8")).slice(-64 * 1024);
    result.output = (result.output + data.toString("utf8")).slice(-64 * 1024);
    if (bytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) { fail("output-limit", "命令输出超过上限，已终止进程树"); return; }
    try { options.onOutput?.(data, stream); options.onData?.(data); } catch (error) { fail("supervisor", String(error), error); }
  };
  child.stdout?.on("data", data => receive(data, "stdout")); child.stderr?.on("data", data => receive(data, "stderr"));
  const events = child.stdio[3] as import("node:stream").Readable;
  events.on("data", data => {
    protocol += String(data);
    if (protocol.length > 64 * 1024) return fail("supervisor", "Supervisor event limit exceeded");
    let newline: number;
    while ((newline = protocol.indexOf("\n")) >= 0) {
      const line = protocol.slice(0, newline); protocol = protocol.slice(newline + 1);
      try {
        const message = JSON.parse(line) as ProcessEvent;
        if (message.phase === "supervisor-ready" && process.platform === "win32") job = monitorJob(jobName);
        if (message.phase === "supervisor-ready" && !failure) child.stdin?.write(JSON.stringify({ command: options.command, args: options.args, cwd: options.cwd, env: options.env ?? process.env }) + "\n");
        if (message.phase === "command-exit") { commandExited = true; result.commandExitCode = message.code ?? null; result.commandSignal = message.signal ?? null; }
        if (message.phase === "spawn-error") fail("startup", message.detail ?? "Command spawn failed");
        if (message.phase === "reaped") reaped = true;
        event(message.phase, { pid: message.pid, code: message.code, signal: message.signal, detail: message.detail });
      } catch (error) { fail("supervisor", String(error), error); }
    }
  });
  child.stdin?.on("error", error => { if (!failure && !commandExited) fail("supervisor", String(error), error); });
  try {
    const exited = await new Promise<void>(done => {
      child.once("error", error => { fail("startup", String(error), error); done(); });
      child.once("exit", (code, signal) => { result.supervisorExitCode = code; result.supervisorSignal = signal; event("exit", { code, signal }); done(); });
      child.once("close", () => { pipesClosed = true; event("stdio-close"); done(); });
      if (options.signal?.aborted) onAbort();
    });
    void exited;
    // EOF can be held by grandchildren. The helper reaps them, and drainage has its own fixed limit.
    if (!pipesClosed) await new Promise<void>(done => { drain = setTimeout(done, 150); child.once("close", () => { if (drain) clearTimeout(drain); done(); }); });
    if (job) {
      if (job.active() > 0) job.terminate();
      const until = performance.now() + PROCESS_CLEANUP_MS - 2_000;
      while (job.active() > 0 && performance.now() < until) await Bun.sleep(10);
      if (job.active() !== 0) throw new Error("Windows job still has active writers");
      reaped = true;
    }
    if (!reaped) failure = { kind: "reaping", message: "监督进程未确认全部子孙回收" + (failure ? `；原错误：${failure.message}` : ""), cause: failure?.cause };
    if (!pipesClosed) event("stdio-drain-deadline");
    if (reaped) event("reaped");
    result.exitCode = result.commandExitCode ?? (result.commandSignal === "SIGTERM" ? 143 : result.commandSignal === "SIGINT" ? 130 : result.commandSignal === "SIGKILL" ? 137 : result.supervisorExitCode ?? 1);
  } catch (error) { failure = { kind: "reaping", message: String(error), cause: error }; }
  finally {
    clearTimeout(timer); if (escalation) clearTimeout(escalation); if (drain) clearTimeout(drain); options.signal?.removeEventListener("abort", onAbort);
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); events.destroy();
    try { job?.close(); } catch (error) { failure = { kind: "reaping", message: String(error), cause: error }; }
  }
  if (failure) throw new ProcessFailure(failure.kind, failure.message, result, failure.cause);
  return result;
}
