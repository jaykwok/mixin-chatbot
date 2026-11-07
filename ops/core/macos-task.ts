// The writer of a macOS maintenance or deployment step: one supervised command, recorded before it starts. See
// MacosTaskRecord (src/contracts/ops-writer.ts) for what its "reaped" says and does not say.
import { randomUUID } from "node:crypto";
import type { MacosTaskRecord } from "../../src/contracts/ops-writer.ts";
import { runNative, type NativeCommand, type NativeResult, type NativeRunner } from "./native-process.ts";
import { taskCommandDigest, taskInput } from "./docker-task.ts";

export type MacosTaskSave = (record: MacosTaskRecord) => Promise<void>;
/** Ends what is left of the service account, unless the service itself is up. Throws when something stays. */
export type MacosSweep = () => Promise<void>;

/** A supervisor whose parent died ends its command within this time: closing its lifeline starts the same cleanup. */
const SUPERVISOR_GRACE_MS = 3000;
const digest = (command: NativeCommand) => taskCommandDigest([command.command, command.cwd, ...command.args,
  ...(command.input !== undefined ? [JSON.stringify(taskInput(command.input))] : [])]);

export function newMacosTask(command: NativeCommand, service: boolean): MacosTaskRecord {
  return { kind: "macos-session", version: 1, id: randomUUID().replaceAll("-", ""), service, commandDigest: digest(command), phase: "prepared" };
}

function validate(record: MacosTaskRecord): void {
  if (record.kind !== "macos-session" || record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.id) || typeof record.service !== "boolean"
    || !/^[a-f0-9]{64}$/.test(record.commandDigest) || !["prepared", "reaped"].includes(record.phase)) throw new Error("macOS 写入者记录无效");
}

/** Holding deploy.lock proves the host that started it has exited, not that its supervisor has finished. */
export async function recoverMacosTask(record: MacosTaskRecord, save: MacosTaskSave, sweep: MacosSweep, graceMs = SUPERVISOR_GRACE_MS): Promise<void> {
  validate(record);
  if (process.platform !== "darwin") throw new Error("macOS 写入者只能由原 macOS 宿主恢复");
  if (record.phase === "reaped") return;
  if (graceMs > 0) await Bun.sleep(graceMs);
  if (record.service) await sweep();
  await save({ ...record, phase: "reaped" });
}

export async function runMacosTask(command: NativeCommand, record: MacosTaskRecord, save: MacosTaskSave, sweep: MacosSweep,
  run: NativeRunner = runNative): Promise<NativeResult> {
  validate(record);
  if (process.platform !== "darwin" || record.phase !== "prepared" || record.commandDigest !== digest(command)) throw new Error("macOS 任务请求与恢复记录不符");
  command.signal?.throwIfAborted(); await save(record);
  let result: NativeResult | undefined, failure: unknown;
  try { result = await run(command); } catch (error) { failure = error; }
  // The supervisor has finished when run returns; even its failure must not bypass the account check.
  try { await recoverMacosTask(record, save, sweep, result ? 0 : SUPERVISOR_GRACE_MS); }
  catch (error) { throw new Error("macOS 写入者无法确认已回收；保留恢复记录，机器人不能启动", { cause: failure ? new AggregateError([failure, error]) : error }); }
  if (failure) throw failure;
  if (!result) throw new Error("macOS 维护没有完整结果");
  return result;
}
