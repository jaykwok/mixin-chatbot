import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { executeProcess, ProcessFailure, type ProcessOptions } from "../../lib/process.ts";
import type { Context } from "./types.ts";

export const VALIDATION_TIMEOUT_MS = 120_000;
const entry = fileURLToPath(new URL("../validate.ts", import.meta.url));
/** Explicit library dependency for synthetic validators; the CLI provides no bypass switch. */
export interface ValidationExecution { command: string; args: string[]; timeoutMs: number }
export async function validateMigration(context: Context, projection?: string, execution?: ValidationExecution): Promise<void> {
  const id = randomUUID(), started = performance.now(); let last = "spawn-request", pending = "";
  const report = (phase: string, detail = "") => {
    last = phase; context.report?.("validation-" + phase, `id=${id}; elapsedMs=${(performance.now() - started).toFixed(2)}; ${detail}`);
  };
  const options: ProcessOptions = {
    command: execution?.command ?? process.execPath,
    args: execution?.args ?? [entry, ...(projection ? ["--config", projection] : [context.project, context.groups, context.project])],
    cwd: context.project, env: { ...process.env, GROUP_DATA_ROOT: context.groups, MIXIN_VALIDATION_ID: id },
    timeoutMs: execution?.timeoutMs ?? VALIDATION_TIMEOUT_MS, signal: context.signal, maxOutputBytes: 1024 * 1024,
    observe: event => report(event.phase, `pid=${event.pid ?? ""}; code=${event.code ?? ""}; signal=${event.signal ?? ""}`),
    onOutput: (data, stream) => {
      if (stream !== "stderr") return;
      pending = (pending + String(data)).slice(-8192);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.startsWith("migration-validation ")) continue;
        const message = JSON.parse(line.slice("migration-validation ".length));
        if (message.id === id && /^(entry-ready|imports-start|imports-ready|config|stats|delivery|result)$/.test(message.phase)) {
          report(message.phase, `state=${message.state}; code=${message.code ?? ""}; pid=${message.pid}`);
        }
      }
    },
  };
  let result;
  try { result = await executeProcess(options); }
  catch (error) {
    const details = error instanceof ProcessFailure ? `kind=${error.kind}; commandExit=${error.result.commandExitCode}; commandSignal=${error.result.commandSignal}; supervisorExit=${error.result.supervisorExitCode}; stderr=${error.result.stderr.slice(-8192)}` : String(error);
    report("failure", `last=${last}; ${details}`);
    throw new Error(`当前版本${projection ? "配置" : "完整"}校验失败：${details}`, { cause: error });
  }
  if (result.exitCode !== 0) throw new Error(`当前版本${projection ? "配置" : "完整"}校验失败：exit=${result.exitCode}; signal=${result.commandSignal}; ${result.stderr.slice(-8192)}`);
}
