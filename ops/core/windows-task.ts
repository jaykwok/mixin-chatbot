import { randomUUID } from "node:crypto";
import { monitorJob } from "../../src/lib/process-job.ts";
import { runNative, type NativeCommand, type NativeResult, type NativeRunner } from "./native-process.ts";
import { taskCommandDigest, taskInput } from "./docker-task.ts";
import type { WindowsTaskRecord } from "../../src/contracts/ops-writer.ts";

export type WindowsTaskSave = (record: WindowsTaskRecord) => Promise<void>;
const digest = (command: NativeCommand) => taskCommandDigest([command.command, command.cwd, ...command.args,
  ...(command.input !== undefined ? [JSON.stringify(taskInput(command.input))] : [])]);
export function newWindowsTask(command: NativeCommand): WindowsTaskRecord {
  const uuid = randomUUID();
  return { kind: "windows-job", version: 1, id: uuid.replaceAll("-", ""), job: `Global\\mixin-process-${uuid}`, commandDigest: digest(command), phase: "prepared" };
}
function validate(record: WindowsTaskRecord): void {
  if (record.kind !== "windows-job" || record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.id)
    || !/^Global\\mixin-process-[a-f0-9-]{36}$/.test(record.job) || record.job.slice("Global\\mixin-process-".length).replaceAll("-", "") !== record.id
    || !/^[a-f0-9]{64}$/.test(record.commandDigest) || !["prepared", "reaped"].includes(record.phase)) throw new Error("Windows 写入者记录无效");
}

/** Global job namespace is intentional: a scheduled executor and a later interactive recovery can be in different sessions. */
export async function recoverWindowsTask(record: WindowsTaskRecord, save: WindowsTaskSave): Promise<void> {
  validate(record);
  if (process.platform !== "win32") throw new Error("Windows 任务只能由原 Windows 宿主恢复");
  const job = monitorJob(record.job, true);
  if (job) {
    try {
      if (job.active()) job.terminate();
      const until = performance.now() + 5000;
      while (job.active() && performance.now() < until) await Bun.sleep(20);
      if (job.active()) throw new Error("Windows 维护作业仍有活动进程；保持启动阻止");
    } finally { job.close(); }
  }
  await save({ ...record, phase: "reaped" });
}

export async function runWindowsTask(command: NativeCommand, record: WindowsTaskRecord, save: WindowsTaskSave,
  run: NativeRunner = runNative): Promise<NativeResult> {
  validate(record);
  if (process.platform !== "win32" || record.phase !== "prepared" || record.commandDigest !== digest(command)) throw new Error("Windows 任务请求与恢复记录不符");
  command.signal?.throwIfAborted(); await save(record);
  const prior = monitorJob(record.job, true);
  if (prior) { prior.close(); throw new Error("同名 Windows 维护作业已存在，未执行新命令"); }
  let result: NativeResult | undefined, failure: unknown;
  try { result = await run({ ...command, jobName: record.job }); } catch (error) { failure = error; }
  // Even a supervisor failure must not bypass disk evidence or the native job query.
  try { await recoverWindowsTask(record, save); }
  catch (error) { throw new Error("Windows 写入者无法确认已回收；保留恢复记录，机器人不能启动", { cause: failure ? new AggregateError([failure, error]) : error }); }
  if (failure) throw failure;
  if (!result) throw new Error("Windows 维护没有完整结果");
  return result;
}
