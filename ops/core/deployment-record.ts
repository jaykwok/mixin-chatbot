import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { publishJson } from "../../src/lib/atomic-file.ts";
import { validateOpsWriter } from "../../src/contracts/ops-writer.ts";
import { loadDeploymentState, type DeploymentState } from "./deployment-state.ts";
import { parseDeploymentExecution, validateDeploymentCheckpoint, type DeploymentCheckpoint, type DeploymentDirection,
  type DeploymentExecution } from "./deployment-contract.ts";
import { serializeTransactionRecord, type TransactionRecord } from "./transaction-record.ts";
import type { OpsResult } from "./result.ts";
import { OPS_DEPLOYMENT_FILE } from "../../src/core/ops-deployment-state.ts";
import { validateHostProcess } from "../../src/contracts/ops-host-process.ts";

type Writer = NonNullable<DeploymentExecution["writer"]>;
const writerIdentity = (writer: Writer) => {
  const { phase: _, ...identity } = writer;
  if ("container" in identity) delete identity.container;
  return identity;
};

/** A journal bound to the already published snapshot, readable through the bot's data mount. */
export class DeploymentRecord {
  private directory?: { dev: bigint; ino: bigint };
  private stateDirectory?: { dev: bigint; ino: bigint };
  private readonly choices: string;
  constructor(readonly project: string, readonly selected: TransactionRecord, readonly runtime: string, private readonly assertHeld: () => void) {
    this.choices = serializeTransactionRecord(selected);
  }
  private owned(): DeploymentState {
    this.assertHeld();
    const state = loadDeploymentState(this.project);
    if (!state || state.snapshot !== this.selected.snapshot || serializeTransactionRecord(state.record) !== this.choices)
      throw new Error("部署事务的指针或选择已变化，未改写执行记录");
    const directory = lstatSync(join(this.project, "backup/snapshots", this.selected.snapshot), { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || this.directory && (directory.dev !== this.directory.dev || directory.ino !== this.directory.ino)) throw new Error("部署快照目录被替换，未改写执行记录");
    this.directory ??= { dev: directory.dev, ino: directory.ino };
    const stateDirectory = lstatSync(join(this.project, "data/state"), { bigint: true });
    if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink()
      || this.stateDirectory && (stateDirectory.dev !== this.stateDirectory.dev || stateDirectory.ino !== this.stateDirectory.ino))
      throw new Error("部署状态目录被替换，未改写执行记录");
    this.stateDirectory ??= { dev: stateDirectory.dev, ino: stateDirectory.ino };
    if (state.execution && state.execution.checkpoint.runtime !== this.runtime) throw new Error("此事务需要原来的固定运维运行包");
    return state;
  }
  read(): DeploymentExecution | null { return this.owned().execution ?? null; }
  private async write(record: DeploymentExecution): Promise<void> {
    const state = this.owned();
    if (record.checkpoint.direction === "rollback" && state.committed) throw new Error("数据已经提交，不能记录回滚步骤");
    parseDeploymentExecution(JSON.stringify(record), this.selected.snapshot, this.selected.was_running === "1");
    const owner = lstatSync(join(this.project, "data/state"));
    await publishJson(join(this.project, OPS_DEPLOYMENT_FILE), record, { owner: { uid: owner.uid, gid: owner.gid } });
    this.owned(); this.assertHeld();
  }
  async checkpoint(checkpoint: DeploymentCheckpoint): Promise<void> {
    validateDeploymentCheckpoint(checkpoint);
    if (checkpoint.snapshot !== this.selected.snapshot || checkpoint.runtime !== this.runtime) throw new Error("部署阶段属于另一事务或运行包");
    const previous = this.read();
    if (previous?.writer && previous.writer.phase !== "reaped") throw new Error("部署写入者尚未回收，不能推进阶段");
    if (previous?.checkpoint.direction === "rollback" && checkpoint.direction !== "rollback") throw new Error("已经开始回滚，不能再次继续发布");
    if (previous?.completion && (checkpoint.direction !== previous.completion || (previous.completion === "rollback"
      ? checkpoint.step !== "start-original" : !["retire-previous-writers", "disable-verification", "start-candidate", "publish-target"].includes(checkpoint.step))))
      throw new Error("事务已经完成数据步骤，不能重复准备或恢复数据");
    await this.write({ version: 1, checkpoint, ...(previous?.writer ? { writer: previous.writer } : {}) });
  }
  async writer(writer: Writer): Promise<void> {
    if (writer.kind === "linux-supervisor") validateHostProcess(writer);
    else validateOpsWriter(writer, this.runtime);
    const current = this.read();
    if (!current || current.completion) throw new Error("部署尚未记录执行意图，不能创建写入者");
    const previous = current.writer;
    if (!previous || previous.id !== writer.id) {
      if (writer.phase !== "prepared" || previous && previous.phase !== "reaped") throw new Error("不能覆盖未回收的写入者或补记已启动的写入者");
    } else {
      if (!isDeepStrictEqual(writerIdentity(previous), writerIdentity(writer))
        || previous.kind === "docker" && writer.kind === "docker" && previous.container !== undefined && previous.container !== writer.container)
        throw new Error("部署写入者的固定身份发生变化");
      const stages = ["prepared", "created", "starting", "reaped"];
      if (stages.indexOf(writer.phase) < stages.indexOf(previous.phase)) throw new Error("部署写入者不能退回已完成的阶段");
    }
    await this.write({ ...current, writer });
  }
  async finish(result: OpsResult, completion?: DeploymentDirection): Promise<void> {
    const state = this.owned(), current = state.execution;
    if (!current) {
      if (completion) throw new Error("部署没有执行记录，不能清除事务");
      return;
    }
    if (completion) {
      if (current.writer && current.writer.phase !== "reaped") throw new Error("写入者尚未回收，不能结束部署事务");
      if (completion === "forward" ? !state.committed : state.dataPhase !== "unprepared") throw new Error("数据状态不允许结束部署事务");
      const running = completion === "forward" && state.operation === "deploy" || state.record.was_running === "1";
      if (result.finalState !== (running ? "running" : "stopped")) throw new Error("结果未确认最终运行状态，不能结束事务");
    }
    // An already durable completion is immutable. Retrying pointer removal cannot erase the original attempt's result.
    if (current.completion) {
      if (completion !== current.completion) throw new Error("已经落盘的事务结论不能被覆盖");
      return;
    }
    await this.write({ ...current, result, ...(completion ? { completion } : {}) });
  }
}
