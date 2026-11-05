import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { recoveryPlan, recoveryView, assertLifecycleTarget } from "../../scripts/ops/console/lifecycle.ts";
import { operationArgs, operationScope } from "../../scripts/ops/console/operations.ts";
import { operationPreparer } from "../../scripts/ops/console/prepare-operation.ts";
import { Views } from "../../scripts/ops/console/views.ts";
import { assertConfirmedTransaction } from "../../scripts/lib/confirmed-transaction.ts";
import { tempFixture } from "../helpers/temp.ts";

async function fixture() {
  const f = await tempFixture("console-recovery-");
  const state = join(f.root, "data/state"), id = "deploy-" + "a".repeat(32), snapshot = join(f.root, "backup/snapshots", id);
  mkdirSync(state, { recursive: true }); mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(state, "deploy-transaction"), id);
  writeFileSync(join(snapshot, "transaction"), Object.entries({ format: "2", operation: "deploy", snapshot: id, target_sha: "a".repeat(40), original_sha: "",
    original_branch: "", original_workspace_root: "", target_workspace_root: "", was_running: "1", bot_port: "2022", reconfigure_ai: "0" }).map(([k, v]) => `${k}=${v}\n`).join(""));
  writeFileSync(join(snapshot, "revision-cleanup"), "apply\n");
  return { ...f, state, snapshot, id };
}

test("恢复只接受动作，服务器生成凭据；整理选择、指针和提交状态改变都拒绝旧预览", async () => {
  const f = await fixture();
  try {
    const prepare = operationPreparer(f.root, new Views());
    const params = await prepare("resume", {}, "fixture");
    const initial = await operationScope(f.root, "resume", params);
    expect(operationArgs("resume", params)).toEqual(["resume", "--confirmed-transaction", params.confirmation as string]);
    await expect(prepare("resume", { confirmation: params.confirmation }, "fixture")).rejects.toThrow("未允许");
    expect(() => operationArgs("resume", {})).toThrow();
    expect(recoveryView(f.root)).toMatchObject({ canResume: true, canRollback: true });
    expect(() => assertConfirmedTransaction(f.root, "continue", String(params.confirmation))).not.toThrow();
    writeFileSync(join(f.snapshot, "revision-cleanup"), "skip\n");
    await expect(operationScope(f.root, "resume", params)).rejects.toThrow("变化");
    expect(() => assertConfirmedTransaction(f.root, "continue", String(params.confirmation))).toThrow("变化");
    const refreshed = await prepare("resume", {}, "fixture");
    expect((await operationScope(f.root, "resume", refreshed)).scope).not.toBe(initial.scope);
    writeFileSync(join(f.state, "release-data.json"), JSON.stringify({ format: 1, phase: "committed", deployment: f.id, previous: null }));
    expect(recoveryView(f.root)).toMatchObject({ committed: true, canRollback: false });
    expect(() => recoveryPlan(f.root, "rollback")).toThrow("已提交");
    expect(() => recoveryPlan(f.root, "resume", String(refreshed.confirmation))).toThrow("变化");
    // A rollback that already started can only be finished.
    unlinkSync(join(f.state, "release-data.json")); writeFileSync(join(f.state, "ops-deployment.json"), JSON.stringify({ version: 1, checkpoint: { version: 1, snapshot: f.id, runtime: "d".repeat(64), direction: "rollback", step: "restore-data" } }));
    expect(recoveryView(f.root)).toMatchObject({ canResume: false, canRollback: true });
    expect(() => recoveryPlan(f.root, "resume")).toThrow("只能完成回滚");
    expect(recoveryPlan(f.root, "rollback").summary.join(" ")).toContain("完成已开始的回滚");
    unlinkSync(join(f.state, "ops-deployment.json"));
    writeFileSync(join(f.state, "deploy-transaction"), "../other");
    expect(() => recoveryView(f.root)).toThrow();
    unlinkSync(join(f.state, "deploy-transaction"));
    expect(recoveryView(f.root)).toBeNull();
    expect(() => recoveryPlan(f.root, "resume")).toThrow("没有未完成");
  } finally { await f.cleanup(); }
});

test("有未完成的部署时，启动和重启在预览就拒绝并指向部署恢复；停止照常可以预览", async () => {
  const f = await fixture();
  try {
    for (const operation of ["start", "restart"]) await expect(operationScope(f.root, operation, {})).rejects.toThrow("部署恢复");
    expect((await operationScope(f.root, "stop", {})).scope).toMatch(/^[a-f0-9]{64}$/);
    // An unfinished execution record without the pointer is refused too, as the core would under its lock.
    unlinkSync(join(f.state, "deploy-transaction"));
    expect((await operationScope(f.root, "restart", {})).scope).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(f.state, "ops-deployment.json"), JSON.stringify({ version: 1, checkpoint: { version: 1, snapshot: f.id, runtime: "d".repeat(64), direction: "forward", step: "start-candidate" } }));
    await expect(operationScope(f.root, "restart", {})).rejects.toThrow("尚未收尾");
  } finally { await f.cleanup(); }
});

test("旧目标缺少、未知或损坏的控制台协议一律拒绝，不以命令退出成功猜能力", async () => {
  const target = "a".repeat(40);
  for (const [code, value] of [[0, "{}"], [1, '{"protocol":"mixin-console-lifecycle","version":1}'], [0, "bad"],
    [0, '{"protocol":"mixin-console-lifecycle","version":2}']] as const) {
    await expect(assertLifecycleTarget("fixture", target, async argv => {
      expect(argv).toEqual(["git", "-C", "fixture", "show", target + ":scripts/lib/console-lifecycle.json"]);
      return { code, stdout: value, stderr: "" };
    })).rejects.toThrow("不支持");
  }
  await assertLifecycleTarget("fixture", target, async () => ({ code: 0, stdout: '{"protocol":"mixin-console-lifecycle","version":1}', stderr: "" }));
});
