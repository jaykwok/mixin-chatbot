import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareConsoleDir } from "./console-state.ts";
import { assertReceiptDirectory, hasProcessReceipt, writeProcessReceipt, type ProcessReceipt } from "../../src/lib/process-receipt.ts";
import { validateHostProcess, type LinuxTaskRecord } from "../../src/contracts/ops-host-process.ts";
import { runNative, type NativeCommand, type NativeResult, type NativeRunner } from "./native-process.ts";
import { taskCommandDigest, taskInput } from "./docker-task.ts";

const digest = (command: NativeCommand) => taskCommandDigest([command.command, command.cwd, ...command.args,
  ...(command.input !== undefined ? [JSON.stringify(taskInput(command.input))] : [])]);
const receiptFor = (project: string, record: LinuxTaskRecord): ProcessReceipt => ({ id: record.id, commandDigest: record.commandDigest,
  directory: record.directory, path: join(resolve(project), ".console/processes", record.id) });
type Save = (record: LinuxTaskRecord) => Promise<void>;

/** Called under the existing deployment lock, before publishing writer intent. No native command has started yet. */
export function newLinuxTask(project: string, command: NativeCommand, assertHeld: () => void): LinuxTaskRecord {
  assertHeld(); if (process.platform !== "linux") throw new Error("Linux 写入者只能由原 Linux 宿主创建");
  const parent = join(resolve(project), ".console"); prepareConsoleDir(parent);
  const processes = join(parent, "processes");
  mkdirSync(processes, { recursive: true, mode: 0o700 });
  const before = lstatSync(processes);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.geteuid!() || (before.mode & 0o077) !== 0) throw new Error("进程收尾目录身份或权限错误");
  const id = randomUUID().replaceAll("-", ""), directory = join(processes, id); mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory, { bigint: true }), fd = openSync(processes, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const record: LinuxTaskRecord = { kind: "linux-supervisor", version: 1, id, commandDigest: digest(command),
    directory: { dev: String(stat.dev), ino: String(stat.ino) }, phase: "prepared" };
  assertReceiptDirectory(receiptFor(project, record)); assertHeld(); return record;
}

/** Holding deploy.lock proves the old authorizing host has exited. It does not prove its child has finished. */
export async function recoverLinuxTask(project: string, record: LinuxTaskRecord, save: Save, assertHeld: () => void, timeoutMs = 5000): Promise<void> {
  validateHostProcess(record); assertHeld();
  if (process.platform !== "linux") throw new Error("Linux 写入者只能由原 Linux 宿主恢复");
  if (record.phase === "reaped") return;
  const receipt = receiptFor(project, record), until = performance.now() + timeoutMs;
  do {
    assertHeld();
    // Authorization is fsynced before the command crosses the pipe. Without it, a delayed supervisor cannot run it.
    if (!hasProcessReceipt(receipt, "authorized") || hasProcessReceipt(receipt, "reaped")) {
      await save({ ...record, phase: "reaped" }); return;
    }
    if (performance.now() >= until) break;
    await Bun.sleep(Math.min(25, until - performance.now()));
  } while (true);
  throw new Error("Linux 写入者没有确认全部子孙回收；保留记录，不能启动或覆盖数据");
}

export async function runLinuxTask(project: string, command: NativeCommand, record: LinuxTaskRecord, save: Save,
  assertHeld: () => void, run: NativeRunner = runNative): Promise<NativeResult> {
  validateHostProcess(record); assertHeld();
  if (process.platform !== "linux" || record.phase !== "prepared" || record.commandDigest !== digest(command) || command.beforeCommand || command.reapReceipt)
    throw new Error("Linux 任务请求与恢复记录不符");
  const receipt = receiptFor(project, record);
  if (hasProcessReceipt(receipt, "authorized") || hasProcessReceipt(receipt, "reaped")) throw new Error("Linux 命令已被使用，不能再次执行");
  command.signal?.throwIfAborted(); await save(record); assertHeld();
  let result: NativeResult | undefined, failure: unknown;
  try {
    result = await run({ ...command, reapReceipt: receipt,
      beforeCommand() { assertHeld(); writeProcessReceipt(receipt, "authorized"); } });
  } catch (error) { failure = error; }
  try { await recoverLinuxTask(project, record, save, assertHeld); }
  catch (error) { throw new Error("Linux 写入者无法确认已回收；保留记录", { cause: failure ? new AggregateError([failure, error]) : error }); }
  if (failure) throw failure;
  if (!result) throw new Error("Linux 维护没有完整结果");
  return result;
}
