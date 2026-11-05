import { join } from "node:path";
import { lstatSync } from "node:fs";
import { publishJson } from "../../lib/atomic-file.ts";
import { OPS_MAINTENANCE_FILE, readOpsMaintenanceRecord, validateOpsMaintenanceRecord, type OpsMaintenanceRecord } from "../../../src/core/ops-maintenance-state.ts";
import { MaintenanceRefused, type MaintenanceCheckpoint } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";

/** Every mutation runs under the caller's native deployment lock; assertions also catch accidental use after release. */
export class MaintenanceRecord {
  constructor(readonly project: string, readonly id: string, private readonly assertHeld: () => void) {}
  read(): OpsMaintenanceRecord | null { this.assertHeld(); return readOpsMaintenanceRecord(this.project); }
  assertAvailable(): void {
    const current = this.read();
    if (current && !current.result) throw new MaintenanceRefused("上次运维尚未收尾，请先运行 ops maintenance-recover；未执行新操作");
  }
  private owned(): OpsMaintenanceRecord {
    const current = this.read();
    if (!current || current.checkpoint.request.id !== this.id || current.result) throw new Error("运维恢复记录已变化，未继续写入");
    return current;
  }
  private async write(value: OpsMaintenanceRecord): Promise<void> {
    this.assertHeld(); validateOpsMaintenanceRecord(value);
    // rootful hosts write as root, while the bot reads as its numeric deployment user. Assign the existing state
    // directory's owner before publication, never expose the new inode before its ownership is correct.
    const state = lstatSync(join(this.project, "data/state"));
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("状态目录已变化");
    await publishJson(join(this.project, OPS_MAINTENANCE_FILE), value, { owner: { uid: state.uid, gid: state.gid } });
    this.assertHeld();
  }
  async checkpoint(checkpoint: MaintenanceCheckpoint): Promise<void> {
    if (checkpoint.request.id !== this.id) throw new Error("维护阶段所属操作不符");
    const previous = this.read();
    if (previous && !previous.result && previous.checkpoint.request.id !== this.id) throw new Error("有另一份未完成运维记录");
    if ((!previous || previous.result) && checkpoint.phase !== "prepared") throw new Error("维护必须先持久记录原状态");
    const continuing = previous && !previous.result ? previous : null;
    if (continuing && JSON.stringify([continuing.checkpoint.request, continuing.checkpoint.original]) !== JSON.stringify([checkpoint.request, checkpoint.original]))
      throw new Error("维护请求或原运行状态发生变化");
    if (continuing?.writer && continuing.writer.phase !== "reaped" && checkpoint.phase !== "acting") throw new Error("写入者尚未回收，不能推进维护阶段");
    await this.write({ version: 1, checkpoint, ...(continuing?.writer ? { writer: continuing.writer } : {}), ...(continuing?.staging ? { staging: continuing.staging } : {}),
      ...(continuing?.runtimeDraft ? { runtimeDraft: continuing.runtimeDraft } : {}) });
  }
  async writer(writer: NonNullable<OpsMaintenanceRecord["writer"]>): Promise<void> {
    const current = this.owned();
    if (current.writer && current.writer.phase !== "reaped" && current.writer.id !== writer.id) throw new Error("不能覆盖未回收的写入者");
    if (current.checkpoint.phase !== "prepared" && current.checkpoint.phase !== "acting" && current.checkpoint.phase !== "recovering" && current.checkpoint.phase !== "completing"
      && !(current.writer?.id === writer.id && current.writer.phase === "reaped" && writer.phase === "reaped")) throw new Error("当前阶段不能记录数据写入者");
    await this.write({ ...current, writer });
  }
  async staging(staging: NonNullable<OpsMaintenanceRecord["staging"]>): Promise<void> {
    const current = this.owned();
    if (current.writer && current.writer.phase !== "reaped") throw new Error("写入者尚未回收，不能修改统计副本");
    if (current.staging && (current.staging.id !== staging.id || JSON.stringify(current.staging.owner) !== JSON.stringify(staging.owner)
      || current.staging.directory && JSON.stringify(current.staging.directory) !== JSON.stringify(staging.directory)
      || current.staging.phase === "removed" && staging.phase !== "removed")) throw new Error("统计副本恢复身份已变化");
    await this.write({ ...current, staging });
  }
  async finish(result: OpsResult): Promise<void> {
    const current = this.read();
    // A refusal before the first checkpoint must never overwrite an interrupted task's record.
    if (!current || current.checkpoint.request.id !== this.id) return;
    if (current.result) throw new Error("维护结果已经发布，不能覆盖");
    await this.write({ ...current, result });
  }
  async runtimeDraft(value: NonNullable<OpsMaintenanceRecord["runtimeDraft"]>): Promise<void> {
    const current = this.owned();
    if (current.writer && current.writer.phase !== "reaped") throw new Error("写入者尚未回收，不能处理运行参数草稿");
    if (current.runtimeDraft && (JSON.stringify({ ...current.runtimeDraft, phase: value.phase }) !== JSON.stringify(value)
      || current.runtimeDraft.phase === "removed" && value.phase !== "removed")) throw new Error("运行参数草稿归属变化");
    await this.write({ ...current, runtimeDraft: value });
  }
}
