import { expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDeploymentState } from "../../ops/core/deployment-state.ts";
import { parseTransactionRecord, serializeTransactionRecord, type TransactionRecord } from "../../ops/core/transaction-record.ts";
import { assertConfirmedTransaction, confirmTransaction, readTransaction } from "../../ops/lib/confirmed-transaction.ts";
import { recoveryView } from "../../ops/core/recovery-plan.ts";
import { tempFixture } from "../helpers/temp.ts";

const record: TransactionRecord = { format: "2", operation: "upgrade", snapshot: "deploy-synthetic", target_sha: "a".repeat(40),
  original_sha: "b".repeat(40), original_branch: "main", original_workspace_root: "", target_workspace_root: "",
  was_running: "1", bot_port: "2022", reconfigure_ai: "0" };
async function fixture() {
  const f = await tempFixture("core-deployment-state-"), state = join(f.root, "data/state"), snapshot = join(f.root, "backup/snapshots", record.snapshot);
  await mkdir(state, { recursive: true }); await mkdir(snapshot, { recursive: true });
  await writeFile(join(state, "deploy-transaction"), record.snapshot + "\n");
  await writeFile(join(snapshot, "transaction"), serializeTransactionRecord(record));
  return { ...f, state, snapshot, release: join(state, "release-data.json") };
}

test("共享事务记录序列化不丢失空值、中文或等号；未知、缺失和继承字段不能写出", () => {
  const value = { ...record, target_workspace_root: "D:\\共享资料\\a=b" };
  const text = serializeTransactionRecord(value);
  expect(parseTransactionRecord(text)).toEqual(value); expect(text).not.toContain("\r"); expect(text.endsWith("\n")).toBe(true);
  const { bot_port: _, ...missing } = value;
  for (const invalid of [{ ...value, unknown: "1" }, missing, { ...value, was_running: 1 }, Object.create(value),
    { ...value, target_workspace_root: "D:\\共享\nwas_running=0" }]) expect(() => serializeTransactionRecord(invalid as TransactionRecord)).toThrow();
});

test("共享状态与恢复页面只信本事务的完整磁盘提交回执", async () => {
  const f = await fixture();
  const release = { format: 1, deployment: record.snapshot, phase: "prepared", previous: null };
  try {
    expect(loadDeploymentState(f.root)).toMatchObject({ operation: "upgrade", snapshot: record.snapshot, dataPhase: "unprepared", committed: false });
    await writeFile(f.release, JSON.stringify(release));
    expect(loadDeploymentState(f.root)?.dataPhase).toBe("prepared");
    await writeFile(f.release, JSON.stringify({ ...release, phase: "committed" }));
    expect(loadDeploymentState(f.root)?.dataPhase).toBe("committed");
    expect(recoveryView(f.root)).toMatchObject({ canResume: true, canRollback: false });
    await writeFile(f.release, JSON.stringify({ ...release, phase: "committed", deployment: "deploy-previous" }));
    expect(loadDeploymentState(f.root)?.dataPhase).toBe("unprepared");
    expect(recoveryView(f.root)?.canRollback).toBe(true);
    for (const value of ["invalid-private-text", "null", "[]", "{}", JSON.stringify({ ...release, format: 2 }),
      JSON.stringify({ ...release, phase: "unknown" }), JSON.stringify({ ...release, previous: {} })]) {
      await writeFile(f.release, value);
      expect(() => loadDeploymentState(f.root)).toThrow("发布状态格式不匹配");
      expect(() => recoveryView(f.root)).toThrow("发布状态格式不匹配");
    }
    await writeFile(f.release, JSON.stringify({ ...release, deployment: "deploy-foreign" }));
    expect(() => loadDeploymentState(f.root)).toThrow("另一个未完成事务");
    // A rollback cannot coexist with this transaction's commit receipt.
    await writeFile(join(f.state, "ops-deployment.json"), JSON.stringify({ version: 1, checkpoint: { version: 1, snapshot: record.snapshot, runtime: "d".repeat(64), direction: "rollback", step: "restore-data" } }));
    await writeFile(f.release, JSON.stringify(release));
    expect(loadDeploymentState(f.root)).toMatchObject({ rollbackPending: true, committed: false });
    expect(recoveryView(f.root)).toMatchObject({ canResume: false, canRollback: true });
    await writeFile(f.release, JSON.stringify({ ...release, phase: "committed" }));
    expect(() => loadDeploymentState(f.root)).toThrow("部署回滚记录与数据提交回执冲突");
  } finally { await f.cleanup(); }
});

test("冲突的部署指针不择一处理；Windows 升级指针必须指向升级记录", async () => {
  const f = await fixture(), pointer = join(f.state, "upgrade-transaction");
  try {
    await writeFile(pointer, "deploy-foreign");
    expect(() => loadDeploymentState(f.root)).toThrow("指针不一致");
    await writeFile(pointer, record.snapshot);
    expect(loadDeploymentState(f.root)?.operation).toBe("upgrade");
    await writeFile(join(f.snapshot, "transaction"), serializeTransactionRecord({ ...record, operation: "deploy" }));
    expect(() => loadDeploymentState(f.root)).toThrow("操作不一致");
  } finally { await f.cleanup(); }
});

test("确认摘要覆盖候选镜像、服务身份、任务 daemon 与验证标记，已捕获的字节不会随磁盘变动", async () => {
  const f = await fixture();
  try {
    for (const name of ["candidate-image", "service-user", "task-runtime", "task-previous-cid", "verify-only"]) {
      const path = join(name === "verify-only" ? f.state : f.snapshot, name);
      await writeFile(path, "first\n");
      const captured = readTransaction(f.root)!, token = confirmTransaction(captured, "continue");
      const key = name === "verify-only" ? "data/state/verify-only" : "backup/snapshots/" + record.snapshot + "/" + name;
      expect(captured.text(key)).toBe("first\n");
      expect(() => assertConfirmedTransaction(f.root, "continue", token)).not.toThrow();
      await writeFile(path, "second\n");
      expect(captured.text(key)).toBe("first\n");
      expect(() => assertConfirmedTransaction(f.root, "continue", token)).toThrow("变化");
    }
  } finally { await f.cleanup(); }
});

test("事务读取拒绝目录、超大记录和损坏 UTF-8；正常 UTF-8 BOM 仍按原始字节确认", async () => {
  const f = await fixture(), path = join(f.snapshot, "transaction");
  try {
    const text = serializeTransactionRecord(record);
    await writeFile(path, "\uFEFF" + text); expect(loadDeploymentState(f.root)?.record).toEqual(record);
    const token = confirmTransaction(readTransaction(f.root)!, "continue");
    await writeFile(path, text); expect(() => assertConfirmedTransaction(f.root, "continue", token)).toThrow("变化");
    for (const bytes of [Buffer.from([0xff, 0xfe, 0xff]), Buffer.alloc(8 * 1024 * 1024 + 1, 65)]) {
      await writeFile(path, bytes);
      expect(() => readTransaction(f.root)).toThrow("无法可靠读取事务记录");
      expect(await readFile(path)).toEqual(bytes);
    }
    await rm(path); await mkdir(path);
    expect(() => readTransaction(f.root)).toThrow("无法可靠读取事务记录");
  } finally { await f.cleanup(); }
});

test("快照父目录链接不被当作未完成事务的普通存储位置", async () => {
  const f = await fixture(), original = f.snapshot + "-original";
  try {
    await rename(f.snapshot, original); await symlink(original, f.snapshot, process.platform === "win32" ? "junction" : "dir");
    expect(() => readTransaction(f.root)).toThrow("无法可靠读取事务记录");
    expect(await readFile(join(original, "transaction"), "utf8")).toBe(serializeTransactionRecord(record));
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform === "win32")("断开的状态文件和父目录链接都拒绝，不被解释成缺少提交回执", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.root, "absent"), f.release);
    expect(() => loadDeploymentState(f.root)).toThrow("无法可靠读取事务记录");
    await rm(f.release);
    await rename(f.state, f.state + "-original"); await symlink(join(f.root, "absent"), f.state, "dir");
    expect(() => loadDeploymentState(f.root)).toThrow("无法可靠读取事务记录");
  } finally { await f.cleanup(); }
});
