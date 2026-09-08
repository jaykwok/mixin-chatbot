import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { application, abortError } from "./lifecycle.ts";

const supervisor = fileURLToPath(new URL("./process-supervisor.ts", import.meta.url));
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  onData?: (data: Buffer) => void;
}

/** No shell expansion of argv. Resolve uv.exe/bash.exe before passing this boundary. */
export function runProcess(options: ProcessOptions): Promise<{ exitCode: number; output: string }> {
  const task = execute(options);
  return application.track(task);
}

async function execute(options: ProcessOptions): Promise<{ exitCode: number; output: string }> {
  const signal = AbortSignal.any([application.signal, ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("命令时限必须大于零");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisor], {
      cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true,
    });
    let error: unknown;
    let tail = Buffer.alloc(0);
    let bytes = 0;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: unknown) => {
      error ??= reason;
      child.stdin?.end();
      if (!escalation) escalation = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const onAbort = () => stop(signal.reason ?? abortError());
    const timer = setTimeout(() => stop(new Error(`Command timed out after ${options.timeoutMs / 1000} seconds`)), options.timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (drain) clearTimeout(drain);
      signal.removeEventListener("abort", onAbort);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (error) reject(error);
      else resolve({ exitCode: code ?? 1, output: tail.toString("utf8") });
    };
    const onData = (data: Buffer) => {
      bytes += data.length;
      tail = Buffer.concat([tail, data]).subarray(-64 * 1024);
      if (bytes > MAX_OUTPUT_BYTES) { stop(new Error("命令输出超过 16 MiB，已终止进程树")); return; }
      try { options.onData?.(data); } catch (cause) { stop(cause); }
    };
    child.stdout?.on("data", onData); child.stderr?.on("data", onData);
    child.once("error", (cause) => { error = cause; finish(null); });
    child.once("exit", (code) => {
      // Fixed tail deadline, never reset by output from inherited handles.
      drain = setTimeout(() => finish(code), 150);
    });
    child.once("close", finish);
    child.stdin?.on("error", (cause) => { if (!settled && !error) stop(cause); });
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdin?.write(JSON.stringify({ command: options.command, args: options.args, cwd: options.cwd, env: options.env ?? process.env }) + "\n");
    if (signal.aborted) onAbort();
  });
}
