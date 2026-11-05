// A Docker CLI process and its daemon-side writer have different lifetimes. Never release the maintenance window
// merely because the CLI exited. The durable intent is written before create; recovery can find the container by name.
import { createHash, randomUUID } from "node:crypto";
import type { NativeResult } from "./native-process.ts";
import { validateOpsTaskInput, type OpsTaskInput } from "../../../src/contracts/ops-task-input.ts";
import type { DockerTaskRecord } from "../../../src/contracts/ops-writer.ts";

export interface DockerTaskFacts { id: string; state: "created" | "running" | "exited"; exitCode: number }
export interface DockerTaskDriver {
  /** All effects must recheck the pinned daemon and validate ownership, including immutable container ID if saved. */
  inspect(record: DockerTaskRecord): Promise<DockerTaskFacts | null>;
  create(record: DockerTaskRecord, args: string[]): Promise<string>;
  attach(record: DockerTaskRecord, signal?: AbortSignal): Promise<NativeResult>;
  /** Stop, remove and confirm absent. A failed/query-unknown removal is never reported as reaped. */
  reap(record: DockerTaskRecord): Promise<void>;
}
export type DockerTaskSave = (record: DockerTaskRecord) => Promise<void>;
export const taskName = (record: DockerTaskRecord) => `mixin-maint-${record.id}`;
export const taskCommandDigest = (args: readonly string[]) => createHash("sha256").update(JSON.stringify(args)).digest("hex");
export function taskInput(input: Uint8Array): OpsTaskInput {
  const value = { bytes: input.byteLength, digest: createHash("sha256").update(input).digest("hex") };
  validateOpsTaskInput(value); return value;
}

/** No script argv or output is saved: space/member identifiers and credentials must not become recovery metadata. */
export function newDockerTask(facts: Omit<DockerTaskRecord, "kind" | "version" | "id" | "phase" | "commandDigest" | "container">, args: string[]): DockerTaskRecord {
  return { kind: "docker", version: 1, id: randomUUID().replaceAll("-", ""), ...facts, commandDigest: taskCommandDigest(args), phase: "prepared" };
}

export class DockerWriterUnsettled extends Error {
  constructor(cause: unknown) { super("无法确认维护容器已经停止并移除；保留恢复记录，机器人不能启动", { cause }); }
}

/** Ordinary cancellation is shielded during reaping. A hard kill instead leaves the same record for recoverDockerTask. */
export async function runDockerTask(driver: DockerTaskDriver, record: DockerTaskRecord, args: string[], save: DockerTaskSave,
  signal?: AbortSignal): Promise<NativeResult> {
  if (record.phase !== "prepared" || record.container || taskCommandDigest(args) !== record.commandDigest) throw new Error("维护容器请求与记录不符");
  signal?.throwIfAborted();
  await save({ ...record }); // A failed first save must create nothing.
  if (await driver.inspect(record)) throw new Error("维护容器名称已经存在，未启动另一个写入者");
  let result: NativeResult | undefined, failure: unknown;
  try {
    signal?.throwIfAborted();
    const id = await driver.create(record, args);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker 未返回有效的维护容器 ID");
    record = { ...record, container: id, phase: "created" }; await save({ ...record });
    const created = await driver.inspect(record);
    if (!created || created.id !== id || created.state !== "created") throw new Error("维护容器创建后的身份或状态不符");
    signal?.throwIfAborted(); record = { ...record, phase: "starting" }; await save({ ...record });
    result = await driver.attach(record, signal);
    const exited = await driver.inspect(record);
    if (!exited || exited.state !== "exited" || exited.exitCode !== result.code) throw new Error("维护命令退出与容器实际状态不符，不能认定完成");
  } catch (error) { failure = error; }
  // This includes create/attach transport failures: the daemon may have accepted the request before the CLI failed.
  try { await driver.reap(record); await save({ ...record, phase: "reaped" }); }
  catch (error) { throw new DockerWriterUnsettled(failure ? new AggregateError([failure, error]) : error); }
  if (failure) throw failure;
  if (!result) throw new Error("维护命令没有结果");
  signal?.throwIfAborted();
  return result;
}

/** Recovery never reruns the data action, even if inspect reports exit code 0. The caller settles its storage journal. */
export async function recoverDockerTask(driver: DockerTaskDriver, record: DockerTaskRecord, save: DockerTaskSave): Promise<void> {
  try { await driver.reap(record); await save({ ...record, phase: "reaped" }); }
  catch (error) { throw new DockerWriterUnsettled(error); }
}
