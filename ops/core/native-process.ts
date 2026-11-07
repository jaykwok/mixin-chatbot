import { executeProcess } from "../../src/lib/process.ts";
import type { ProcessOptions } from "../../src/lib/process.ts";

export interface NativeCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Protocol stdout is bounded independently from human-readable stderr. */
  protocol?: boolean;
  jobName?: string;
  input?: Uint8Array;
  beforeCommand?: ProcessOptions["beforeCommand"];
  reapReceipt?: ProcessOptions["reapReceipt"];
  identity?: ProcessOptions["identity"];
}
export type NativeOutput = (text: string, stream: "stdout" | "stderr") => void;
export interface NativeResult { code: number; stdout: string }
export type NativeRunner = (command: NativeCommand, output?: NativeOutput) => Promise<NativeResult>;

/** Uses the existing Job Object/subreaper; resolving means the entire owned process tree has been reaped. */
export const runNative: NativeRunner = async (command, output = (text, stream) => { process[stream].write(text); }) => {
  const decoders = { stdout: new TextDecoder("utf-8", { fatal: true }), stderr: new TextDecoder("utf-8", { fatal: true }) };
  let stdout = "", bytes = 0;
  const onOutput: NonNullable<ProcessOptions["onOutput"]> = (chunk, stream) => {
    const text = decoders[stream].decode(chunk, { stream: true });
    if (stream === "stdout" && command.protocol) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("平台协议超过 1 MiB，拒绝不完整结果");
      stdout += text;
    } else if (text) output(text, stream);
  };
  const result = await executeProcess({ ...command, timeoutMs: command.timeoutMs ?? 60_000,
    // A data action can emit substantial progress, but pathological output remains bounded by the supervisor.
    maxOutputBytes: 128 * 1024 * 1024, onOutput });
  for (const stream of ["stdout", "stderr"] as const) {
    const tail = decoders[stream].decode();
    if (stream === "stdout" && command.protocol) stdout += tail;
    else if (tail) output(tail, stream);
  }
  return { code: result.exitCode, stdout };
};

/** Only complete, matching protocol messages count. Stderr is never reparsed as JSON. */
export function nativePayload(result: NativeResult, action: string): unknown {
  if (result.code !== 0) throw new Error(`平台动作 ${action} 失败（退出码 ${result.code}）`);
  let value: any;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`平台动作 ${action} 没有完整 JSON 结果`); }
  if (!value || Array.isArray(value) || value.protocol !== "mixin-platform" || value.version !== 1
    || value.action !== action || value.ok !== true || !Object.hasOwn(value, "value")) throw new Error("平台结果格式或动作不符");
  return value.value;
}
