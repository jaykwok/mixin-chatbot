import { expect, test } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeploymentRecord } from "../../scripts/ops/core/deployment-record.ts";
import { OPS_DEPLOYMENT_FILE } from "../../src/core/ops-deployment-state.ts";
import { parseDeploymentExecution, type DeploymentCheckpoint } from "../../scripts/ops/core/deployment-contract.ts";
import { serializeTransactionRecord, type TransactionRecord } from "../../scripts/ops/core/transaction-record.ts";
import { newDockerTask } from "../../scripts/ops/core/docker-task.ts";
import type { DockerTaskRecord } from "../../src/contracts/ops-writer.ts";
import { recoveryPlan, recoveryView } from "../../scripts/ops/console/lifecycle.ts";
import type { OpsResult } from "../../scripts/ops/core/result.ts";
import { tempFixture } from "../helpers/temp.ts";

async function fixture() {
  const f = await tempFixture("deployment-journal-"), state = join(f.root, "data/state"), snapshot = join(f.root, "backup/snapshots/deploy-journal");
  await mkdir(state, { recursive: true }); await mkdir(snapshot, { recursive: true });
  const record: TransactionRecord = { format: "2", operation: "upgrade", snapshot: "deploy-journal", target_sha: "a".repeat(40), original_sha: "b".repeat(40),
    original_branch: "main", original_workspace_root: "", target_workspace_root: "", was_running: "1", bot_port: "2022", reconfigure_ai: "0" };
  const checkpoint: DeploymentCheckpoint = { version: 1, snapshot: record.snapshot, runtime: "d".repeat(64), direction: "forward", step: "prepare-data" };
  await writeFile(join(state, "deploy-transaction"), record.snapshot);
  await writeFile(join(snapshot, "transaction"), serializeTransactionRecord(record));
  let held = true;
  const store = new DeploymentRecord(f.root, record, checkpoint.runtime, () => { if (!held) throw new Error("not locked"); });
  const result: OpsResult = { protocol: "mixin-ops", version: 1, command: "update", wasRunning: true, outcome: "success", exitCode: 0, finalState: "running", message: "已完成" };
  const writer = newDockerTask({ daemon: "fixture-daemon", endpoint: "unix:///fixture/docker.sock", image: "sha256:" + "a".repeat(64), user: "1001:1001",
    data: "/fixture/data", backup: "/fixture/backup", network: "none", runtime: checkpoint.runtime }, ["script", "synthetic-private-value"]);
  return { ...f, state, snapshot, checkpoint, result, store, writer, path: join(f.root, OPS_DEPLOYMENT_FILE), release: join(state, "release-data.json"),
    unlock() { held = false; } };
}

test("部署执行日志先保存阶段，再记不可变写入者；未回收不能换阶段或覆盖进程", async () => {
  const f = await fixture();
  try {
    await expect(f.store.writer(f.writer)).rejects.toThrow("执行意图");
    await f.store.checkpoint(f.checkpoint); await f.store.writer(f.writer);
    const before = await readFile(f.path, "utf8");
    expect(before).not.toContain("synthetic-private-value"); expect(before).not.toContain('"args"');
    await expect(f.store.checkpoint({ ...f.checkpoint, step: "cleanup-revisions" })).rejects.toThrow("尚未回收");
    await expect(f.store.writer({ ...f.writer, id: "e".repeat(32) })).rejects.toThrow("覆盖");
    await expect(f.store.writer({ ...f.writer, image: "sha256:" + "b".repeat(64) })).rejects.toThrow("固定身份");
    expect(await readFile(f.path, "utf8")).toBe(before);
    const created: DockerTaskRecord = { ...f.writer, phase: "created", container: "c".repeat(64) };
    await f.store.writer(created); await f.store.writer({ ...created, phase: "starting" });
    await expect(f.store.writer(created)).rejects.toThrow("退回");
    await expect(f.store.writer({ ...created, phase: "reaped", container: "b".repeat(64) })).rejects.toThrow("固定身份");
    await f.store.writer({ ...created, phase: "reaped" });
    await f.store.checkpoint({ ...f.checkpoint, step: "cleanup-revisions" });
    expect(f.store.read()?.writer?.phase).toBe("reaped");
    f.unlock(); expect(() => f.store.read()).toThrow("not locked");
  } finally { await f.cleanup(); }
});

test("损坏、未知格式、另一个运行包或替换的快照都拒绝覆盖，现场文件不变", async () => {
  for (const mode of ["broken", "future", "runtime", "directory", "choices"]) {
    const f = await fixture();
    try {
      await f.store.checkpoint(f.checkpoint);
      if (mode === "broken") await writeFile(f.path, "private-invalid-json");
      if (mode === "future") await writeFile(f.path, JSON.stringify({ version: 2, checkpoint: f.checkpoint }));
      if (mode === "runtime") await writeFile(f.path, JSON.stringify({ version: 1, checkpoint: { ...f.checkpoint, runtime: "f".repeat(64) } }));
      if (mode === "directory") {
        await rename(f.snapshot, f.snapshot + "-original"); await mkdir(f.snapshot);
        await writeFile(join(f.snapshot, "transaction"), await readFile(join(f.snapshot + "-original", "transaction")));
      }
      if (mode === "choices") {
        const path = join(f.snapshot, "transaction"); await writeFile(path, (await readFile(path, "utf8")).replace("bot_port=2022", "bot_port=2023"));
      }
      const before = await readFile(f.path, "utf8");
      await expect(f.store.checkpoint({ ...f.checkpoint, step: "cleanup-revisions" })).rejects.toThrow();
      expect(await readFile(f.path, "utf8")).toBe(before);
    } finally { await f.cleanup(); }
  }
});

test("成功收尾要求磁盘提交、写入者回收及明确最终运行状态；重试不改写原结果", async () => {
  const f = await fixture();
  try {
    await f.store.checkpoint(f.checkpoint); await f.store.writer(f.writer);
    await expect(f.store.finish(f.result, "forward")).rejects.toThrow("写入者尚未回收");
    await f.store.writer({ ...f.writer, phase: "reaped" });
    await expect(f.store.finish(f.result, "forward")).rejects.toThrow("数据状态");
    await writeFile(f.release, JSON.stringify({ format: 1, deployment: f.checkpoint.snapshot, phase: "committed", previous: null }));
    await expect(f.store.finish({ ...f.result, finalState: "start-requested" }, "forward")).rejects.toThrow("最终运行状态");
    await f.store.checkpoint({ ...f.checkpoint, step: "publish-target" });
    await f.store.finish(f.result, "forward");
    const before = await readFile(f.path, "utf8");
    await f.store.finish({ ...f.result, command: "resume", message: "再次确认" }, "forward");
    expect(await readFile(f.path, "utf8")).toBe(before);
    await expect(f.store.checkpoint({ ...f.checkpoint, direction: "rollback", step: "restore-data" })).rejects.toThrow();
    await expect(f.store.checkpoint({ ...f.checkpoint, step: "prepare-data" })).rejects.toThrow("不能重复");
    expect(await readFile(f.path, "utf8")).toBe(before);
    await f.store.checkpoint({ ...f.checkpoint, step: "start-candidate" });
    expect(f.store.read()?.completion).toBeUndefined();
    expect(f.store.read()?.checkpoint.step).toBe("start-candidate");
  } finally { await f.cleanup(); }
});

test("开始回滚即禁止网页继续发布；原失败任务恢复成功仍保存失败结果，只可重试启动收尾", async () => {
  const f = await fixture();
  try {
    await f.store.checkpoint({ ...f.checkpoint, direction: "rollback", step: "restore-data" });
    expect(recoveryView(f.root)).toMatchObject({ canResume: false, canRollback: true });
    expect(() => recoveryPlan(f.root, "resume")).toThrow("只能完成回滚");
    expect(recoveryPlan(f.root, "rollback").summary.join(" ")).not.toContain("只恢复升级前的代码");
    await expect(f.store.checkpoint(f.checkpoint)).rejects.toThrow("已经开始回滚");
    await f.store.checkpoint({ ...f.checkpoint, direction: "rollback", step: "start-original" });
    await f.store.finish({ ...f.result, outcome: "failed", exitCode: 3, message: "升级失败，原状态已恢复" }, "rollback");
    expect(f.store.read()?.result).toMatchObject({ outcome: "failed", exitCode: 3 });
    await expect(f.store.checkpoint({ ...f.checkpoint, direction: "rollback", step: "restore-data" })).rejects.toThrow("不能重复");
    await f.store.checkpoint({ ...f.checkpoint, direction: "rollback", step: "start-original" });
    expect(f.store.read()?.checkpoint.step).toBe("start-original");
  } finally { await f.cleanup(); }
});

test("执行日志严格拒绝半份结果、未知字段、成功但非零退出和带未收尾写入者的完成标记", async () => {
  const f = await fixture();
  try {
    const base = { version: 1, checkpoint: f.checkpoint };
    for (const value of [{ ...base, unknown: "x" }, { ...base, checkpoint: { ...f.checkpoint, version: 2 } },
      { ...base, result: {} }, { ...base, result: { ...f.result, exitCode: 3 }, completion: "forward" },
      { ...base, result: f.result }, { ...base, result: f.result, completion: "forward", writer: f.writer },
      { ...base, writer: { ...f.writer, runtime: "a".repeat(64) } }]) {
      expect(() => parseDeploymentExecution(JSON.stringify(value), f.checkpoint.snapshot, true)).toThrow("格式不支持");
    }
  } finally { await f.cleanup(); }
});
