import { expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OPS_DEPLOYMENT_FILE, readOpsDeploymentRecord, deploymentAllows } from "../../src/core/ops-deployment-state.ts";
import { readMaintenanceState, assessMaintenanceAction, MAINTENANCE_INTENTS } from "../../src/core/maintenance-state.ts";
import { type DeploymentExecution, type DeploymentStep } from "../../src/contracts/ops-deployment.ts";
import { loadDeploymentState } from "../../ops/core/deployment-state.ts";
import { newDockerTask } from "../../ops/core/docker-task.ts";
import { tempFixture } from "../helpers/temp.ts";

const initial: DeploymentExecution = { version: 1, checkpoint: { version: 1, snapshot: "deploy-synthetic", runtime: "a".repeat(64), direction: "forward", step: "prepare-data" } };
const writer = newDockerTask({ daemon: "fixture", endpoint: "unix:///fixture/docker.sock", image: "sha256:" + "a".repeat(64), user: "1001:1001",
  data: "/fixture/data", backup: "/fixture/backup", network: "none" }, ["synthetic"]);

test("部署阶段只允许对应的验证、提交或业务启动；数据写入者未回收不能启动", () => {
  for (const [step, allowed] of [
    ["prepare-data", []], ["install-candidate", []], ["start-verification", ["verify"]], ["commit-data", ["release"]],
    ["retire-previous-writers", []], ["disable-verification", []], ["start-candidate", ["service"]], ["publish-target", ["service"]],
  ] as [DeploymentStep, string[]][]) {
    for (const active of [false, true]) for (const intent of ["service", "verify", "release"] as const) {
      const record: DeploymentExecution = { ...initial, checkpoint: { ...initial.checkpoint, step }, writer: { ...writer, phase: active ? "starting" : "reaped", container: "b".repeat(64) } };
      expect(deploymentAllows(record, intent), `${step}/${active}/${intent}`).toBe(allowed.includes(intent) && (!active || intent === "release"));
    }
  }
  for (const step of ["restore-data", "restore-code", "restore-service", "start-original"] as const) {
    const record: DeploymentExecution = { ...initial, checkpoint: { ...initial.checkpoint, direction: "rollback", step } };
    expect(deploymentAllows(record, "service")).toBe(step === "start-original");
    expect(deploymentAllows(record, "verify")).toBe(false); expect(deploymentAllows(record, "release")).toBe(false);
  }
});

test("启动判断只需 data 挂载；不需要宿主快照目录，未完成且缺指针仍阻止新的部署", async () => {
  const f = await tempFixture("ops-deployment-guard-");
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    expect(readOpsDeploymentRecord(f.root)).toBeNull();
    await writeFile(join(f.root, OPS_DEPLOYMENT_FILE), JSON.stringify(initial));
    expect(readOpsDeploymentRecord(f.root)).toEqual(initial);
    expect(() => loadDeploymentState(f.root)).toThrow("事务指针缺失");
    const state = readMaintenanceState(f.root);
    for (const intent of ["service", "verify", "release"] as const) expect(assessMaintenanceAction(state, intent).allowed).toBe(false);
    const complete: DeploymentExecution = { ...initial, checkpoint: { ...initial.checkpoint, step: "publish-target" }, completion: "forward",
      result: { protocol: "mixin-ops", version: 1, command: "update", outcome: "success", exitCode: 0, wasRunning: true, finalState: "running", message: "已完成" } };
    await writeFile(join(f.root, OPS_DEPLOYMENT_FILE), JSON.stringify(complete));
    expect(loadDeploymentState(f.root)).toBeNull();
    for (const intent of ["service", "verify", "release"] as const) expect(assessMaintenanceAction(readMaintenanceState(f.root), intent).allowed).toBe(true);
  } finally { await f.cleanup(); }
});

test("部署启动记录损坏、版本未知、超大或不是普通文件时，各维护动作均拒绝", async () => {
  const f = await tempFixture("ops-deployment-bad-");
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true }); const path = join(f.root, OPS_DEPLOYMENT_FILE);
    for (const value of ["invalid-secret", "null", JSON.stringify({ ...initial, version: 2 }), "x".repeat(32769), Buffer.from([0xff])]) {
      await writeFile(path, value);
      expect(() => readOpsDeploymentRecord(f.root)).toThrow("无法读取");
      const state = readMaintenanceState(f.root); expect(JSON.stringify(state)).not.toContain("invalid-secret");
      for (const intent of MAINTENANCE_INTENTS) expect(assessMaintenanceAction(state, intent).allowed).toBe(false);
    }
    await rm(path); await mkdir(path);
    expect(() => readOpsDeploymentRecord(f.root)).toThrow("无法读取");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform === "win32")("断链部署记录不当作不存在，也不允许启动", async () => {
  const f = await tempFixture("ops-deployment-link-");
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await symlink(join(f.root, "missing"), join(f.root, OPS_DEPLOYMENT_FILE));
    expect(() => readOpsDeploymentRecord(f.root)).toThrow("无法读取");
    expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(false);
  } finally { await f.cleanup(); }
});
