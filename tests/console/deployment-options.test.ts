import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { deploymentOptions, deploymentEnvironment, deploymentScope } from "../../scripts/ops/console/deployment-options.ts";
import { operationArgs, operationCommand } from "../../scripts/ops/console/operations.ts";
import { codeDigest } from "../../scripts/ops/console/runtime.ts";
import { checkTaskPlan } from "../../scripts/ops/console/check-plan.ts";
import { PlanStore, type PlanFacts } from "../../scripts/ops/console/plans.ts";
import { TaskStore } from "../../scripts/ops/console/tasks.ts";
import type { Runner } from "../../scripts/ops/console/hosting.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";
import { directoryAppHash } from "../../scripts/lib/directory-choice.ts";

const target = "a".repeat(40);
const choice = { target, switchMain: false, cleanup: "apply", directory: "saved" };
async function fixture() {
  const f = await tempFixture("console-deployment-");
  for (const name of ["scripts", "src", "ui"]) mkdirSync(join(f.root, name), { recursive: true });
  for (const [path, value] of Object.entries({ "data/state/data-version.json": "{}", "data/state/bot-port": "1011", ".console/port": "11012",
    "data/config/app-bot.json": '{"secret":"synthetic-secret"}', "data/config/models.json": "{}", "data/runtime/pi/settings.json": "{}", "data/config/directory.json": '{"format":1,"all":true}' })) {
    mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), value);
  }
  const state = { branch: "main", dirty: "", identity: "first", capability: 1 };
  const run: Runner = async argv => {
    let stdout: string;
    if (argv[0] === "git" && argv[3] === "rev-parse") stdout = state.branch;
    else if (argv[0] === "git" && argv[3] === "status") stdout = state.dirty;
    else if (argv[0] === "git" && argv[3] === "show") stdout = JSON.stringify({ protocol: "mixin-console-lifecycle", version: state.capability });
    else if (argv[0] === "powershell") stdout = JSON.stringify({ Principal: { UserId: state.identity }, Actions: [{ WorkingDirectory: f.root, Execute: "fixture" }] });
    else if (argv[0] === "docker") stdout = JSON.stringify([{ Id: state.identity, Image: "synthetic-image", Config: { User: "10001:10001" }, Mounts: [{ Type: "bind", RW: true, Source: realpathSync(join(f.root, "data")), Destination: "/app/data" }] }]);
    else throw new Error(`unexpected command ${argv}`);
    return { code: 0, stdout, stderr: "" };
  };
  return { ...f, state, run };
}

test("升级只接收完整显式选择；环境覆盖受限，不接受 argv、no-backup 或隐式目标", () => {
  expect(operationArgs("update", choice)).toEqual(["update", target]);
  for (const params of [{}, { ...choice, target: "origin/main" }, { ...choice, switchMain: "false" }, { ...choice, cleanup: "no-backup" },
    { ...choice, directory: ["saved"] }, { ...choice, env: { BOT_PORT: "1" } }, { ...choice, argv: [] }, { ...choice, ai: "keep" }]) {
    expect(() => operationArgs("update", params)).toThrow();
  }
  const command = operationCommand("fixture", "update", choice);
  expect(command.env.BOT_REVISION_CLEANUP).toBe("apply"); expect(command.env.MIXIN_OPS_SWITCH_MAIN).toBe("0");
  expect(command.env.BOT_DIRECTORY_SCOPE).toBe("");
  const deploy = { port: 2022, workspace: "", cleanup: "skip", directory: "saved" };
  expect(operationArgs("deploy", deploy)).toEqual(["deploy"]);
  expect(operationCommand("fixture", "deploy", deploy).env.BOT_PORT).toBe("2022");
  expect(operationArgs("repair", process.platform === "win32" ? {} : deploy)).toEqual(["repair"]);
  expect(() => operationArgs("repair", process.platform === "win32" ? { argv: [] } : {})).toThrow();
  for (const key of RUNTIME_KEYS) expect(command.env[key], key).toBe("");
  for (const params of [{ port: 11012, workspace: "relative" }, { port: 1.5, workspace: "" }, { port: 0, workspace: "" }]) {
    expect(() => deploymentOptions("deploy", { cleanup: "skip", directory: "saved", ...params })).toThrow();
  }
});

test("预览绑定配置、部署身份及选择；拒绝脏树、旧协议、未确认分支和通讯录默认值", async () => {
  const f = await fixture();
  try {
    const initial = await deploymentScope(f.root, "update", choice, f.run);
    expect(initial.summary.join(" ")).not.toContain("synthetic-secret");
    writeFileSync(join(f.root, "data/config/app-bot.json"), '{"secret":"rotated-synthetic"}');
    expect((await deploymentScope(f.root, "update", choice, f.run)).scope).not.toBe(initial.scope);
    f.state.identity = "replacement"; const changed = await deploymentScope(f.root, "update", choice, f.run);
    expect(changed.scope).not.toBe(initial.scope);
    f.state.branch = "feature"; await expect(deploymentScope(f.root, "update", choice, f.run)).rejects.toThrow("允许切换");
    await deploymentScope(f.root, "update", { ...choice, switchMain: true }, f.run);
    f.state.branch = "main"; f.state.dirty = " M tracked";
    await expect(deploymentScope(f.root, "update", choice, f.run)).rejects.toThrow("已跟踪");
    f.state.dirty = ""; f.state.capability = 2;
    await expect(deploymentScope(f.root, "update", choice, f.run)).rejects.toThrow("协议");
    f.state.capability = 1;
    await expect(deploymentScope(f.root, "update", { ...choice, directory: "all" }, f.run)).rejects.toThrow("已有同步范围");
    unlinkSync(join(f.root, "data/config/directory.json"));
    await expect(deploymentScope(f.root, "update", choice, f.run)).rejects.toThrow("没有已保存");
    await deploymentScope(f.root, "update", { ...choice, directory: "all" }, f.run);
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "corrupt");
    await expect(deploymentScope(f.root, "update", choice, f.run)).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test("重部署目标端口与控制台相同时停机前拒绝；预览期间配置变化也拒绝", async () => {
  const f = await fixture();
  try {
    const params = { cleanup: "skip", directory: "saved", port: 11012, workspace: "" };
    await expect(deploymentScope(f.root, "deploy", params, f.run)).rejects.toThrow("控制台端口");
    params.port = 1011; await deploymentScope(f.root, "deploy", params, f.run);
    await expect(deploymentScope(f.root, "deploy", params, async (...args) => {
      writeFileSync(join(f.root, "data/config/runtime.json"), '{"BOT_BASH_TIMEOUT":"123"}'); return f.run(...args);
    })).rejects.toThrow("预览期间");
  } finally { await f.cleanup(); }
});

test("锁内复核拒绝丢失或污染的命名选择，不只检查保存的计划", async () => {
  const f = await fixture();
  const env = deploymentEnvironment("update", choice, f.root), previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    const facts: PlanFacts = { project: f.root, identity: "fixture", platform: process.platform, head: target, protocol: 1, scope: "fixture", runState: "running" };
    const observe = async () => ({ facts, summary: [] });
    const plan = await new PlanStore(join(f.root, ".console"), observe).create("update", choice);
    const task = new TaskStore(join(f.root, ".console")).create({ project: f.root, planId: plan.id, operation: "update", params: choice,
      mechanism: process.platform === "win32" ? "windows-task" : "systemd-system" }, "fixture");
    Object.assign(process.env, env); const digest = codeDigest(f.root);
    await checkTaskPlan(f.root, task.id, digest, observe);
    for (const key of ["BOT_REVISION_CLEANUP", "MIXIN_OPS_DIRECTORY", "MIXIN_OPS_DIRECTORY_INPUT", "MIXIN_OPS_DIRECTORY_APP", "MIXIN_OPS_SWITCH_MAIN", "BOT_PORT", "BOT_BASH_TIMEOUT"]) {
      process.env[key] = "polluted";
      await expect(checkTaskPlan(f.root, task.id, digest, observe)).rejects.toThrow("选择未完整传递"); process.env[key] = env[key];
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.cleanup();
  }
});

test("部署部门选择绑定应用摘要并进入锁内环境核对，已有范围时拒绝覆盖", async () => {
  const f = await fixture();
  try {
    const selected = { ...choice, directory: { departments: ["d1"], names: ["合成研发"], appHash: directoryAppHash(f.root) } };
    await expect(deploymentScope(f.root, "update", selected, f.run)).rejects.toThrow("已有同步范围");
    unlinkSync(join(f.root, "data/config/directory.json"));
    const result = await deploymentScope(f.root, "update", selected, f.run);
    expect(result.summary.join(" ")).toContain("合成研发");
    const env = deploymentEnvironment("update", selected, f.root);
    expect(env.MIXIN_OPS_DIRECTORY_APP).toBe(selected.directory.appHash);
    expect(env.MIXIN_OPS_DIRECTORY_INPUT).not.toContain("合成研发");
    writeFileSync(join(f.root, "data/config/app-bot.json"), "{}");
    await expect(deploymentScope(f.root, "update", selected, f.run)).rejects.toThrow("应用配置已变化");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("Docker mount order is not a deployment change; mount properties and identity still are", async () => {
  const f = await fixture();
  try {
    const mount = (source: string, destination: string) => ({ Type: "bind", Source: source, Destination: destination, RW: true, Propagation: "rprivate" });
    const original = [mount(realpathSync(join(f.root, "data")), "/app/data"), mount("/run/user/1001/docker.sock", "/run/mixin-task/docker.sock"),
      mount(join(f.root, "data/workspace"), "/app/workspace")];
    let mounts = structuredClone(original), user = "1001:1001", id = "same-container";
    const run: Runner = async (argv, env) => argv[0] === "docker"
      ? { code: 0, stderr: "", stdout: JSON.stringify([{ Id: id, Image: "same-image", Config: { User: user }, Mounts: mounts }]) }
      : f.run(argv, env);
    const scope = async () => (await deploymentScope(f.root, "update", choice, run)).scope;
    const initial = await scope();
    for (const order of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
      mounts = order.map(index => structuredClone(original[index]!));
      expect(await scope()).toBe(initial);
    }
    mounts[0]!.RW = false; expect(await scope()).not.toBe(initial);
    mounts = structuredClone(original); mounts[1]!.Source = "/run/user/1002/docker.sock";
    expect(await scope()).not.toBe(initial);
    mounts = structuredClone(original); user = "0:0"; expect(await scope()).not.toBe(initial);
    user = "1001:1001"; id = "replaced-container"; expect(await scope()).not.toBe(initial);
  } finally { await f.cleanup(); }
});
