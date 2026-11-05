import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDeploymentState } from "../../scripts/ops/core/deployment-state.ts";
import { deploymentRuntime } from "../../scripts/ops/core/deployment-runtime.ts";
import { windowsUpgradeFixture as fixture } from "../helpers/windows-upgrade.ts";

const source = resolve(import.meta.dir, "../.."), original = "a".repeat(40), target = "b".repeat(40);

test.skipIf(process.platform !== "win32")("Windows 共享升级宿主保留原运行状态，验证构建号使用 launcher 的 12 位提交", async () => {
  for (const running of [false, true]) {
    const f = await fixture(running);
    try {
      expect(await f.run()).toMatchObject({ outcome: "success", exitCode: 0, finalState: running ? "running" : "stopped", wasRunning: running });
      expect(f.running).toBe(running); expect(f.head).toBe(target); expect(loadDeploymentState(f.project)).toBeNull();
      expect(f.events.filter(value => value.startsWith("data:"))).toEqual(["data:apply", "data:commit"]);
      expect(f.events.filter(value => value.startsWith("start:"))).toEqual(running ? ["start:verify", "start:target"] : ["start:verify"]);
      expect(f.events).toContain("effect:restore-task"); expect(f.events).not.toContain("effect:restore-configuration");
    } finally { await f.cleanup(); }
  }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 验证失败先恢复数据再恢复代码和原运行状态，不提交目标", async () => {
  const f = await fixture(true);
  try {
    f.breakVerification(); const result = await f.run();
    expect(result).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "running", wasRunning: true });
    expect(f.head).toBe(original); expect(loadDeploymentState(f.project)).toBeNull();
    expect(f.events.filter(value => value.startsWith("data:"))).toEqual(["data:apply", "data:rollback"]);
    expect(f.events.indexOf("data:rollback")).toBeLessThan(f.events.indexOf("effect:restore-configuration"));
    expect(f.events.at(-1)).toBe("start:original");
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 提交回复丢失保留已提交事务；续做不重复写数据，缺少固定运行包时拒绝", async () => {
  const f = await fixture(true);
  try {
    f.loseCommit(); expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "stopped" });
    const pending = loadDeploymentState(f.project)!; expect(pending.committed).toBe(true);
    const fixed = deploymentRuntime(f.project, source, pending), file = join(fixed.root, "scripts/ops/core/windows-lifecycle.ts"), bytes = readFileSync(file);
    writeFileSync(file, "throw new Error('do not import altered code');");
    const count = f.events.length;
    expect(await f.run({ original, target, branch: "main", command: "resume" })).toMatchObject({ outcome: "refused", exitCode: 1 });
    expect(f.events).toHaveLength(count); writeFileSync(file, bytes);
    // A journal with an attempted phase retains the lifecycle's failed outcome. Refusal still must have zero data effects.
    const dataBefore = f.events.filter(value => value.startsWith("data:"));
    expect(await f.run({ original, target, branch: "main", command: "rollback", rollback: true })).toMatchObject({ outcome: "failed", exitCode: 1,
      message: "数据已提交，不能回滚；请继续完成新实例启动和收尾" });
    expect(f.events.filter(value => value.startsWith("data:"))).toEqual(dataBefore);
    expect(loadDeploymentState(f.project)?.committed).toBe(true);
    expect(f.events).not.toContain("data:rollback"); f.allowActivation();
    expect(await f.run({ original, target, branch: "main", command: "resume" })).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
    expect(f.events.filter(value => value.startsWith("data:"))).toEqual(["data:apply", "data:commit"]);
    expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 提交后正式启动失败、监督器让任务保持运行：排除原因后续做重启任务并完成", async () => {
  const f = await fixture(true);
  try {
    f.refuseActivationSupervised();
    expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "start-requested" });
    expect(loadDeploymentState(f.project)?.committed).toBe(true); expect(f.running).toBe(true);
    f.allowActivation(); const count = f.events.length;
    expect(await f.run({ original, target, branch: "main", command: "resume" })).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
    // The Running task is stopped and started under the start-candidate checkpoint, which the service accepts.
    const resumed = f.events.slice(count);
    expect(resumed.filter(value => value === "effect:stop" || value.startsWith("start:"))).toEqual(["effect:stop", "start:target"]);
    expect(resumed.filter(value => value.startsWith("data:"))).toEqual([]);
    expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 30_000);
