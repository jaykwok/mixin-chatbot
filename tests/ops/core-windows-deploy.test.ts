import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeText } from "../../scripts/config/runtime-values.ts";
import { confirmTransaction } from "../../scripts/lib/confirmed-transaction.ts";
import { STAGE_UNCHANGED } from "../../scripts/ops/core/deploy-stage.ts";
import { loadDeploymentState } from "../../scripts/ops/core/deployment-state.ts";
import { APP, DIRECTORY, MODELS } from "../helpers/docker-upgrade.ts";
import { TOOLS, windowsDeployFixture as fixture } from "../helpers/windows-deploy.ts";

const windows = process.platform === "win32";
type Fixture = Awaited<ReturnType<typeof fixture>>;
const pointer = (f: Fixture) => join(f.project, "data/state/deploy-transaction");
const tools = { bun: TOOLS.bun, git: TOOLS.git, uv: TOOLS.uv, bash: TOOLS.bash };
/** A first deployment from staging to the running candidate; the configuration steps install what the entry staged. */
const FIRST = ["capture", "stop", "prepare-directories", "save-dependencies", "dependencies:install", "runtime-settings:values", "configuration-install:app",
  "configuration-install:models", "directory-scope:install", "data-current:preview", "data-current:apply", "install-task", "start:verification", "stop:candidate",
  "data-current:commit", "start:candidate", "cleanup"];

test.skipIf(!windows)("Windows 首次部署：停机前暂存的运行参数、凭据、模型和通讯录范围由目标版本写入，再注册任务、验证、提交并启动；验证启动允许回退为登录启动", async () => {
  // A Git checkout with the default workspace, and an unpacked release with a shared one.
  for (const checkout of [true, false]) {
    const f = await fixture({ git: checkout }), shared = join(f.root, "shared");
    if (!checkout) mkdirSync(shared);
    try {
      const stage = f.stage(checkout ? {} : { workspace: shared });
      expect(await f.deploy(stage)).toMatchObject({ command: "deploy", outcome: "success", exitCode: 0, finalState: "running", wasRunning: false, message: "部署已完成" });
      expect(f.events).toEqual(FIRST); expect(f.unexpected).toEqual([]);
      expect(f.installs).toEqual([tools]);
      expect(f.starts).toEqual([{ role: "verification", fallback: true }, { role: "candidate", fallback: false }]);
      expect([f.task, f.running]).toEqual(["candidate", true]);
      expect([f.read("data/config/app-bot.json"), f.read("data/config/models.json"), f.read("data/runtime/pi/settings.json"), f.read("data/config/directory.json")])
        .toEqual([APP, MODELS.models, MODELS.settings, DIRECTORY]);
      expect(f.read("data/config/runtime.json")).toBe(runtimeText({ BOT_PORT: "1011" }));
      expect([f.read("data/state/bot-port"), f.read("data/state/workspace-root")]).toEqual(["1011", checkout ? "" : shared]);
      if (!checkout) expect(f.build()).toBe("");
      for (const relative of ["data/state/verify-only", "data/state/deploy-transaction", "backup"]) expect(existsSync(join(f.project, relative)), relative).toBe(false);
      expect(loadDeploymentState(f.project)).toBeNull();
      expect(existsSync(stage)).toBe(true); // The entry removes its stage.
      expect(f.results).toHaveLength(1);
    } finally { await f.cleanup(); }
  }
}, 120_000);

test.skipIf(!windows)("Windows 重新部署：沿用原配置时只写运行参数并按停机前的计划准备数据；重新注册任务，原来停止的服务也启动；修复命令走同一流程", async () => {
  for (const [running, command] of [[true, "deploy"], [false, "repair"]] as const) {
    const f = await fixture({ original: true, running });
    try {
      expect(await f.deploy(f.stage({ port: 1012 }), command)).toMatchObject({ command, outcome: "success", exitCode: 0, finalState: "running", wasRunning: running });
      expect(f.events).toEqual(["capture", running ? "stop:original" : "stop", "prepare-directories", "save-dependencies", "dependencies:install", "runtime-settings:values",
        "data-current:apply", "install-task", "start:verification", "stop:candidate", "data-current:commit", "start:candidate", "cleanup"]);
      expect(f.unexpected).toEqual([]);
      expect([f.task, f.running]).toEqual(["candidate", true]);
      expect([f.read("data/config/runtime.json"), f.read("data/state/bot-port")]).toEqual([runtimeText({ BOT_PORT: "1012" }), "1012"]);
      expect([f.read("data/config/app-bot.json"), f.read("data/config/models.json"), f.read("data/runtime/pi/settings.json")]).toEqual([APP, MODELS.models, MODELS.settings]);
      expect(loadDeploymentState(f.project)).toBeNull(); expect(existsSync(join(f.project, "backup"))).toBe(false);
    } finally { await f.cleanup(); }
  }
}, 120_000);

test.skipIf(!windows)("Windows 重新部署重配了模型并整理修订，验证未就绪时显示任务结果并自动回滚：先撤销整理和数据，再恢复原配置、运行参数和原任务", async () => {
  const f = await fixture({ original: true, running: true, failures: ["verification-health"] });
  try {
    const next = { models: '{"providers":{"next":{}}}\n', settings: '{"defaultProvider":"next"}\n' };
    const result = await f.deploy(f.stage({ port: 1012, models: next, cleanup: "apply" }));
    expect(result).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "running", wasRunning: true, message: "验证实例未就绪，未提交数据；已自动恢复到操作前的状态" });
    expect(f.events).toEqual(["capture", "stop:original", "prepare-directories", "save-dependencies", "dependencies:install", "runtime-settings:values",
      "configuration-install:models", "data-current:apply", "revision-cleanup:apply", "install-task", "start:verification", "stop:candidate", "revision-cleanup:abandon",
      "data-current:rollback", "restore-dependencies", "restore-configuration", "restore-task", "start:original"]);
    expect(f.unexpected).toEqual([]);
    const output = f.outputs.join("");
    expect(output).toContain("实例未就绪；计划任务的最后结果：0x00000001 / 1");
    expect(output.indexOf("正在自动恢复到操作前的状态")).toBeLessThan(output.indexOf("部署阶段：rollback/stop"));
    expect(f.starts.at(-1)).toEqual({ role: "original", fallback: false });
    expect([f.task, f.running]).toEqual(["original", true]);
    expect([f.read("data/config/models.json"), f.read("data/runtime/pi/settings.json"), f.read("data/config/app-bot.json")]).toEqual([MODELS.models, MODELS.settings, APP]);
    expect([f.read("data/config/runtime.json"), f.read("data/state/bot-port"), f.read("data/state/release-data.json")]).toEqual([null, "1011", null]);
    expect(f.read("data/runtime/bot-launcher.ps1")).toBe("original launcher\n");
    expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!windows)("Windows 首次部署验证启动被拒：回滚注销新任务，不留配置、端口和启动器，快照保留", async () => {
  const f = await fixture({ failures: ["start-verification"] });
  try {
    const result = await f.deploy(f.stage());
    expect(result).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "stopped", wasRunning: false });
    expect(f.events.slice(f.events.indexOf("start:verification"))).toEqual(["start:verification", "stop", "data-current:rollback", "restore-dependencies",
      "restore-configuration", "restore-task"]);
    expect(f.unexpected).toEqual([]);
    expect([f.task, f.running]).toEqual([null, false]);
    for (const relative of ["data/config/app-bot.json", "data/config/models.json", "data/runtime/pi/settings.json", "data/config/runtime.json", "data/config/directory.json",
      "data/runtime/bot-launcher.ps1", "data/state/bot-port", "data/state/workspace-root", "data/state/release-data.json", "data/state/verify-only"])
      expect(existsSync(join(f.project, relative)), relative).toBe(false);
    expect(loadDeploymentState(f.project)).toBeNull();
    expect(readdirSync(join(f.project, "backup/snapshots"))).toEqual([f.snapshot]);
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!windows)("Windows 首次部署在指针发布后中断：不接受新的暂存，续做完成；另一次中断后显式回滚，最后没有任务", async () => {
  const f = await fixture({ failures: ["interrupt"] });
  try {
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "failed", exitCode: 1 });
    expect(f.events).toEqual(["capture"]); expect(existsSync(pointer(f))).toBe(true);
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "refused", message: expect.stringContaining("续做和回滚只使用事务中记录的选择") });
    expect(await f.preflight()).toMatchObject({ outcome: "refused" });
    // A console confirmation binds the action and the transaction as previewed: another action's token runs nothing.
    const confirmation = (action: "continue" | "rollback") => confirmTransaction(loadDeploymentState(f.project)!.confirmation, action);
    expect(await f.resume({}, confirmation("rollback"))).toMatchObject({ outcome: "refused", message: expect.stringContaining("重新确认") });
    expect(await f.rollback({}, confirmation("continue"))).toMatchObject({ outcome: "refused", message: expect.stringContaining("重新确认") });
    expect(f.events).toEqual(["capture"]);
    expect(await f.resume({}, confirmation("continue"))).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running" });
    expect(f.events).toEqual(FIRST); expect(f.unexpected).toEqual([]);
    expect(f.starts).toEqual([{ role: "verification", fallback: true }, { role: "candidate", fallback: false }]);
  } finally { await f.cleanup(); }
  const g = await fixture({ failures: ["interrupt"] });
  try {
    expect(await g.deploy(g.stage())).toMatchObject({ outcome: "failed" });
    expect(await g.rollback()).toMatchObject({ command: "rollback", outcome: "success", exitCode: 0, finalState: "stopped", wasRunning: false });
    expect([g.task, g.running]).toEqual([null, false]); expect(g.unexpected).toEqual([]);
    expect(g.events).not.toContain("install-task"); expect(g.events.filter(value => value.startsWith("start:"))).toEqual([]);
    expect(existsSync(pointer(g))).toBe(false); expect(loadDeploymentState(g.project)).toBeNull();
  } finally { await g.cleanup(); }
}, 120_000);

test.skipIf(!windows)("Windows 提交回复丢失保留已提交事务，续做只启动新实例不重复写数据；事务中从备份恢复由记录的版本执行，事务不变", async () => {
  const f = await fixture({ original: true, running: true, failures: ["commit-reply"] });
  try {
    expect(await f.restore("groups/g1")).toMatchObject({ outcome: "refused", message: expect.stringContaining("没有未完成的部署或升级") });
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "failed", exitCode: 1 });
    expect(loadDeploymentState(f.project)?.committed).toBe(true);
    expect(await f.restore("groups/g1")).toMatchObject({ command: "revision-cleanup", outcome: "success", exitCode: 0, finalState: "stopped",
      message: "已从备份恢复；事务和停机状态不变，之后回滚（会先结束整理）或继续" });
    expect(f.events.at(-1)).toBe("revision-cleanup:restore"); expect(f.running).toBe(false);
    expect(existsSync(pointer(f))).toBe(true); expect(loadDeploymentState(f.project)!.committed).toBe(true);
    const before = f.events.length;
    // Refused before any effect: the service, the task and the data stay as the commit left them.
    expect(await f.rollback()).toMatchObject({ outcome: "failed", message: "数据已提交，不能回滚；请继续完成新实例启动和收尾" });
    expect(f.events).toHaveLength(before); expect([f.task, f.running]).toEqual(["candidate", false]);
    expect(await f.resume()).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
    expect(f.events.slice(before).filter(value => value.startsWith("data-current:"))).toEqual([]);
    expect(f.events.at(-2)).toBe("start:candidate"); expect([f.task, f.running]).toEqual(["candidate", true]);
    expect(loadDeploymentState(f.project)).toBeNull(); expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!windows)("Windows 部署在发布事务之前拒绝：他项目任务、缺少或无效的工具记录、确认后代码变化；不停服务、不留快照；预检只读", async () => {
  const foreign = await fixture({ foreign: true, running: true });
  try {
    expect(await foreign.preflight()).toMatchObject({ outcome: "refused", message: expect.stringContaining("属于其他目录") });
    expect(await foreign.deploy(foreign.stage())).toMatchObject({ outcome: "refused", message: expect.stringContaining("属于其他目录") });
    expect(foreign.events).toEqual([]); expect(foreign.running).toBe(true);
  } finally { await foreign.cleanup(); }
  const f = await fixture({ original: true, running: true });
  try {
    expect(await f.preflight()).toMatchObject({ outcome: "success", wasRunning: true });
    for (const [stage, message] of [[f.stage({ tools: null }), "部署暂存缺少工具路径记录"],
      [f.stage({ tools: `format=1\nbun=C:\\it"s\\bun.exe\ngit=${TOOLS.git}\nuv=${TOOLS.uv}\nbash=${TOOLS.bash}\n` }), STAGE_UNCHANGED]] as const) {
      const result = await f.deploy(stage);
      expect(result).toMatchObject({ outcome: "refused" }); expect(result.message).toContain(message); expect(result.message).toContain(STAGE_UNCHANGED);
    }
    const stage = f.stage();
    writeFileSync(join(f.project, "version.txt"), "moved\n"); f.git("commit", "-q", "-am", "moved");
    expect(await f.deploy(stage)).toMatchObject({ outcome: "refused", message: expect.stringContaining("代码的提交在部署选择确认之后已变化") });
    expect(f.events).toEqual([]); expect(f.running).toBe(true); expect(f.unexpected).toEqual([]);
    expect(existsSync(join(f.project, "backup"))).toBe(false); expect(existsSync(pointer(f))).toBe(false);
    // Corrected, the same deployment goes through.
    expect(await f.deploy(f.stage({ target: f.git("rev-parse", "HEAD") }))).toMatchObject({ outcome: "success", finalState: "running" });
  } finally { await f.cleanup(); }
}, 120_000);
