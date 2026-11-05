import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installConfigurationStage, parseConfigurationStage, stageName, STAGED_KINDS } from "../../scripts/config/configuration-stage.ts";
import { installRuntimeValues } from "../../scripts/config/runtime-settings.ts";
import { RUNTIME_VALUES_FILE, runtimeText } from "../../scripts/config/runtime-values.ts";
import { STAGE_UNCHANGED } from "../../scripts/ops/core/deploy-stage.ts";
import { DeploymentRecord } from "../../scripts/ops/core/deployment-record.ts";
import { loadDeploymentState } from "../../scripts/ops/core/deployment-state.ts";
import { parseTaskRuntime, serializeCandidateRecord, serializeServiceUser } from "../../scripts/ops/core/docker-deployment.ts";
import { CONFIGURATION_STATE_FILE } from "../../src/core/configuration-state.ts";
import { APP, DIRECTORY, dockerDeployFixture as fixture, MODELS } from "../helpers/docker-upgrade.ts";

const linux = process.platform === "linux";
type Fixture = Awaited<ReturnType<typeof fixture>>;
const pointer = (f: Fixture) => join(f.project, "data/state/deploy-transaction");
const read = (f: Fixture, relative: string) => existsSync(join(f.project, relative)) ? readFileSync(join(f.project, relative), "utf8") : null;
const git = (f: Fixture, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", f.project, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};
const containers = (f: Fixture) => [...f.main.containers.values()].map(c => [c.Name.replace(/-\d+-[a-f0-9]+$/, ""), c.Id === f.originalContainer?.Id ? "original" : "candidate", c.State.Running]).sort();
/** A first deployment from staging to the running candidate; the configuration steps install what the entry staged. */
const FIRST = ["runtime-settings:values", "configuration-install:app", "configuration-install:models", "directory-scope:install", "data-current:preview", "data-current:apply",
  "task-deployment:write", "create:candidate", "start:verification", "stop:candidate", "layout-check", "data-current:commit", "start:candidate", "tag:mixin-chatbot:latest:candidate"];

test.skipIf(!linux)("首次部署：停机前暂存的运行参数、应用凭据、模型配置和通讯录范围由目标版本写入，装好后才预检数据；验证通过才提交并启动，不动代码", async () => {
  // A Git checkout with the default workspace, and an unpacked release with a shared one.
  for (const checkout of [true, false]) {
    const f = await fixture({ git: checkout }), shared = join(f.root, "shared");
    if (!checkout) mkdirSync(shared);
    try {
      const stage = f.stage(checkout ? {} : { workspace: shared });
      expect(await f.deploy(stage)).toMatchObject({ command: "deploy", outcome: "success", exitCode: 0, finalState: "running", wasRunning: false, message: "部署已完成" });
      expect(f.events).toEqual(FIRST); expect(f.unexpected).toEqual([]);
      if (checkout) expect([f.head(), f.branch()]).toEqual([f.original, "main"]);
      else expect(existsSync(join(f.project, ".git"))).toBe(false);
      expect(loadDeploymentState(f.project)).toBeNull();
      expect(containers(f)).toEqual([["/mixin-chatbot", "candidate", true]]);
      expect(Object.fromEntries(f.main.tags)).toEqual({ "mixin-chatbot:latest": f.candidateImage });
      expect([read(f, "data/config/app-bot.json"), read(f, "data/config/models.json"), read(f, "data/runtime/pi/settings.json"), read(f, "data/config/directory.json")])
        .toEqual([APP, MODELS.models, MODELS.settings, DIRECTORY]);
      expect(read(f, "data/config/runtime.json")).toBe(runtimeText({ BOT_PORT: "1011" }));
      // Published inside the restore range, once verification passed: the ops entries read them from now on.
      expect([read(f, "data/state/bot-port"), read(f, "data/state/workspace-root")]).toEqual(["1011", checkout ? "" : shared]);
      expect(parseTaskRuntime(read(f, "data/state/task-runtime")!)).toEqual({ endpoint: f.taskEndpoint, daemon: f.task.id });
      const service = f.main.container("mixin-chatbot")!;
      expect(service.Mounts.filter(mount => mount.Destination === "/app/workspace")).toEqual(checkout ? [] : [{ Type: "bind", Source: shared, Destination: "/app/workspace", RW: false }]);
      for (const relative of ["data/state/verify-only", "backup/snapshots", "backup/rm"]) expect(existsSync(join(f.project, relative)), relative).toBe(false);
      // The stage is the entry's to remove; nothing of it is needed after the snapshot.
      expect(existsSync(stage)).toBe(true);
      expect(f.results).toHaveLength(1);
    } finally { await f.cleanup(); }
  }
}, 120_000);

test.skipIf(!linux)("重新部署：沿用原配置时只写运行参数并按停机前的计划准备数据；原容器提交后才撤销；原来停止的服务也启动；修复命令走同一流程", async () => {
  for (const [running, command] of [[true, "deploy"], [false, "repair"]] as const) {
    const f = await fixture({ original: true, running });
    try {
      expect(await f.deploy(f.stage({ port: 1012 }), command)).toMatchObject({ command, outcome: "success", exitCode: 0, finalState: "running", wasRunning: running });
      expect(f.events).toEqual(["tag:mixin-chatbot:previous:original", ...running ? ["stop:original"] : [], "runtime-settings:values", "data-current:apply", "task-deployment:write",
        "rename:original:mixin-chatbot-rollback", "create:candidate", "start:verification", "stop:candidate", "layout-check", "data-current:commit", "rm:original", "start:candidate",
        "tag:mixin-chatbot:latest:candidate"]);
      expect(f.unexpected).toEqual([]);
      expect([f.head(), f.branch(), f.mainRef()]).toEqual([f.original, "main", f.original]);
      expect(containers(f)).toEqual([["/mixin-chatbot", "candidate", true]]);
      expect(f.main.container("mixin-chatbot")!.Config.Env).toContain("BOT_PORT=1012");
      expect([read(f, "data/config/runtime.json"), read(f, "data/state/bot-port")]).toEqual([runtimeText({ BOT_PORT: "1012" }), "1012"]);
      expect([read(f, "data/config/app-bot.json"), read(f, "data/config/models.json"), read(f, "data/runtime/pi/settings.json")]).toEqual([APP, MODELS.models, MODELS.settings]);
      // The old image left with its last reference; on the separate task daemon only its unreferenced copy goes.
      expect(Object.fromEntries(f.main.tags)).toEqual({ "mixin-chatbot:latest": f.candidateImage }); expect(f.main.images.has(f.originalImage)).toBe(false);
      expect([...f.task.images.keys()].sort()).toEqual([f.candidateImage, f.keptImage, f.foreignImage].sort());
      expect(loadDeploymentState(f.project)).toBeNull(); expect(existsSync(join(f.project, "backup/snapshots"))).toBe(false);
    } finally { await f.cleanup(); }
  }
}, 120_000);

test.skipIf(!linux)("重新部署重配了模型并整理修订，验证未就绪时自动回滚：先撤销整理和数据，再恢复原配置、运行参数和原容器；代码始终不动", async () => {
  const f = await fixture({ original: true, running: true, failures: ["verification-health"] });
  try {
    const next = { models: '{"providers":{"next":{}}}\n', settings: '{"defaultProvider":"next"}\n' };
    const result = await f.deploy(f.stage({ port: 1012, models: next, cleanup: "apply" }));
    expect(result).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "running", wasRunning: true, message: "验证实例未就绪，未提交数据；已自动恢复到操作前的状态" });
    expect(f.events).toEqual(["tag:mixin-chatbot:previous:original", "stop:original", "runtime-settings:values", "configuration-install:models", "data-current:apply",
      "revision-cleanup:apply", "task-deployment:write", "rename:original:mixin-chatbot-rollback", "create:candidate", "start:verification", "stop:candidate",
      "revision-cleanup:abandon", "data-current:rollback", "rename:candidate:mixin-chatbot-failed", "tag:mixin-chatbot:latest:original", "rename:original:mixin-chatbot", "start:original"]);
    expect(f.unexpected).toEqual([]);
    expect([read(f, "data/config/models.json"), read(f, "data/runtime/pi/settings.json"), read(f, "data/config/app-bot.json")]).toEqual([MODELS.models, MODELS.settings, APP]);
    expect([read(f, "data/config/runtime.json"), read(f, "data/state/bot-port"), read(f, "data/state/release-data.json")]).toEqual([null, "1011", null]);
    expect(containers(f)).toEqual([["/mixin-chatbot", "original", true], ["/mixin-chatbot-failed", "candidate", false]]);
    expect(Object.fromEntries(f.main.tags)).toEqual({ "mixin-chatbot:latest": f.originalImage });
    expect([f.head(), f.branch(), f.mainRef()]).toEqual([f.original, "main", f.original]); expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("首次部署的验证实例退出：回滚后没有服务，也没有正式标签；写入的配置归档在本事务名下，快照保留", async () => {
  const f = await fixture({ failures: ["verification-exit"] });
  try {
    // Waiting out this deadline would overrun the test's own timeout.
    const result = await f.deploy(f.stage(), "deploy", { readyTimeoutMs: 300_000 });
    expect(result).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "stopped", wasRunning: false, message: "验证实例未就绪，未提交数据；已自动恢复到操作前的状态" });
    expect(f.outputs.join("")).toContain("fixture: the instance exited during verification");
    expect(f.events.slice(f.events.indexOf("start:verification"))).toEqual(["start:verification", "data-current:rollback", "rename:candidate:mixin-chatbot-failed"]);
    expect(f.unexpected).toEqual([]);
    expect(containers(f)).toEqual([["/mixin-chatbot-failed", "candidate", false]]); expect(Object.fromEntries(f.main.tags)).toEqual({});
    expect(loadDeploymentState(f.project)).toBeNull();
    for (const relative of ["data/config/app-bot.json", "data/config/models.json", "data/runtime/pi/settings.json", "data/config/runtime.json", "data/config/directory.json",
      "data/state/task-runtime", "data/state/bot-port", "data/state/workspace-root", "data/state/release-data.json", "data/state/verify-only"])
      expect(existsSync(join(f.project, relative)), relative).toBe(false);
    const [snapshot, ...others] = readdirSync(join(f.project, "backup/snapshots"));
    expect(others).toEqual([]);
    const archived = readdirSync(join(f.project, "backup/rm", snapshot!)).find(name => name.endsWith("-config"))!;
    expect(readFileSync(join(f.project, "backup/rm", snapshot!, archived, "app-bot.json"), "utf8")).toBe(APP);
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("首次部署在指针发布后中断：不接受新的暂存；代码离开部署的提交时续做拒绝；回到原提交后续做完成", async () => {
  const f = await fixture({ failures: ["interrupt"] });
  try {
    expect(await f.deploy(f.stage())).toMatchObject({ command: "deploy", outcome: "failed", exitCode: 1, message: "synthetic: the entry died after publishing the transaction" });
    expect(loadDeploymentState(f.project)).toMatchObject({ operation: "deploy", committed: false, dataPhase: "unprepared",
      record: { target_sha: f.original, original_sha: "", original_branch: "", was_running: "0", bot_port: "1011", reconfigure_ai: "1", target_workspace_root: "" } });
    expect(f.events).toEqual([]);
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "refused", exitCode: 1, message: "有未完成的部署或升级，续做和回滚只使用事务中记录的选择" });
    git(f, "commit", "-q", "--allow-empty", "-m", "operator commit");
    const moved = await f.resume();
    expect(moved).toMatchObject({ command: "resume", outcome: "refused", exitCode: 1, finalState: "stopped", wasRunning: false });
    expect(moved.message).toContain(`当前代码不是上次部署的目标提交 ${f.original.slice(0, 7)}`);
    expect(f.events).toEqual([]); expect(existsSync(pointer(f))).toBe(true);
    git(f, "reset", "-q", "--hard", f.original);
    expect(await f.resume()).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running", wasRunning: false, message: "部署已完成" });
    expect(f.events).toEqual(FIRST); expect(f.unexpected).toEqual([]);
    expect(read(f, "data/config/app-bot.json")).toBe(APP); expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("首次部署在指针发布后中断：显式回滚撤销数据准备，没有服务可恢复，最后不留服务和标签", async () => {
  const f = await fixture({ failures: ["interrupt"] });
  try {
    await f.deploy(f.stage());
    expect(await f.rollback()).toMatchObject({ command: "rollback", outcome: "success", exitCode: 0, finalState: "stopped", wasRunning: false, message: "部署已回滚" });
    expect(f.events).toEqual(["data-current:rollback"]); expect(f.unexpected).toEqual([]);
    expect(containers(f)).toEqual([]); expect(Object.fromEntries(f.main.tags)).toEqual({});
    expect(loadDeploymentState(f.project)).toBeNull(); expect(read(f, "data/config/app-bot.json")).toBeNull();
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("首次部署写完配置、预检之后被杀：续做从停止重跑，已在位的运行参数和配置不重写，沿用第一次的预检计划", async () => {
  const f = await fixture({ failures: ["interrupt"] });
  try {
    await f.deploy(f.stage());
    const pending = loadDeploymentState(f.project)!, snapshot = join(f.project, "backup/snapshots", pending.snapshot);
    // What a kill during prepare-data leaves: the target release installed the staged files, previewed into the snapshot, and that step's checkpoint.
    expect(await installRuntimeValues(join(snapshot, RUNTIME_VALUES_FILE), join(f.project, "data/config/runtime.json"))).toBe(true);
    for (const kind of STAGED_KINDS) expect(await installConfigurationStage(f.project, parseConfigurationStage(readFileSync(join(snapshot, stageName(kind)), "utf8"), kind))).toBe(true);
    writeFileSync(f.directoryFile, DIRECTORY); writeFileSync(join(snapshot, "data-plan.json"), "{}\n");
    const runtime = readFileSync(join(snapshot, "host-runtime"), "utf8").trim();
    await new DeploymentRecord(f.project, pending.record, runtime, () => {}).checkpoint({ version: 1, snapshot: pending.snapshot, runtime, direction: "forward", step: "prepare-data" });
    expect(await f.resume()).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running", wasRunning: false });
    expect(f.events).toEqual(["runtime-settings:values:in-place", "configuration-install:app:in-place", "configuration-install:models:in-place", ...FIRST.slice(3)
      .filter(event => event !== "data-current:preview")]);
    expect(f.unexpected).toEqual([]); expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("首次部署缺少停机前的配置、通讯录范围或记录与现场不符时拒绝：不发布事务、不写配置；补齐后可以部署", async () => {
  const f = await fixture({});
  try {
    const refused = async (message: string, stage: string) => {
      const result = await f.deploy(stage);
      expect(result).toMatchObject({ outcome: "refused", exitCode: 1, finalState: "unknown", wasRunning: false });
      expect(result.message).toContain(message); expect(result.message.endsWith(STAGE_UNCHANGED)).toBe(true);
      expect(f.events).toEqual([]); expect(f.unexpected).toEqual([]);
      expect(existsSync(pointer(f))).toBe(false); expect(existsSync(join(f.project, "backup"))).toBe(false); expect(existsSync(join(f.project, "data/config"))).toBe(false);
    };
    await refused("缺少应用机器人配置，也没有停机前完成的配置", f.stage({ app: null }));
    await refused("缺少模型配置，也没有停机前完成的配置", f.stage({ models: null }));
    await refused("缺少通讯录同步范围，也没有停机前选定的范围", f.stage({ directory: null }));
    await refused("服务身份记录来自原容器，但原容器不存在", f.stage({ platform: { "service-user": serializeServiceUser({ format: "1", user: f.user, source: "container" }) } }));
    await refused("原容器 mixin-chatbot 在准备期间被删除、替换或改动", f.stage({ platform: { facts: `format=1\ncontainer=${"e".repeat(64)}\nimage=\ndata=\n` } }));
    await refused("部署暂存目录不存在或是链接", join(f.root, "missing"));
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("重新部署的暂存与现场不符时在发布事务之前拒绝：不停服务、不写配置、不留快照；纠正后可以部署", async () => {
  const f = await fixture({ original: true, running: true });
  try {
    const refused = async (message: string, stage: string, unchanged = true) => {
      const result = await f.deploy(stage);
      expect(result).toMatchObject({ outcome: "refused", exitCode: 1, finalState: "unknown", wasRunning: false });
      expect(result.message).toContain(message); expect(result.message.endsWith(STAGE_UNCHANGED)).toBe(unchanged);
      expect(f.events).toEqual([]); expect(f.unexpected).toEqual([]);
      expect(existsSync(pointer(f))).toBe(false); expect(existsSync(join(f.project, "backup/snapshots"))).toBe(false);
      expect(f.originalContainer!.State.Running).toBe(true);
    };
    await refused("代码的提交在部署选择确认之后已变化", f.stage({ target: "e".repeat(40) }));
    await refused("候选镜像不是从本次部署的工作区构建的", f.stage({ platform: { "candidate-image": serializeCandidateRecord({ ...f.candidate, source: "commit" }) } }));
    await refused("部署暂存缺少候选镜像、服务身份或任务 daemon 记录", f.stage({ platform: { "task-runtime": null } }));
    await refused("原容器 mixin-chatbot 在准备期间被删除、替换或改动", f.stage({ platform: { facts: "format=1\ncontainer=\nimage=\ndata=\n" } }));
    await refused("服务身份记录与原容器不一致", f.stage({ platform: { "service-user": serializeServiceUser({ format: "1", user: f.user, source: "default" }) } }));
    await refused("停机前的数据准备计划缺失", f.stage({ plan: null }));
    // Answered, then changed before the lock: the stage no longer fits.
    const app = f.stage({ app: APP.replace("fixture-app", "other-app") });
    writeFileSync(join(f.project, "data/config/app-bot.json"), APP.replace("production", "sandbox"));
    await refused("应用机器人配置在确认之后被改动，请重新部署", app);
    writeFileSync(join(f.project, "data/config/app-bot.json"), APP);
    // An unfinished configuration transaction owns the files a staged configuration would replace.
    const transaction = { version: 1, id: "config-" + "e".repeat(32), kind: "relay", phase: "ready", binding: null, rows: [{ key: "relay", before: null, after: "f".repeat(64) }] };
    writeFileSync(join(f.project, CONFIGURATION_STATE_FILE), JSON.stringify(transaction));
    await refused(`配置事务 ${transaction.id} 尚未结束（ready），请先在控制台恢复或收尾`, f.stage({ app: APP.replace("secret", "rotated-secret") }));
    rmSync(join(f.project, CONFIGURATION_STATE_FILE));
    const runtime = f.stage();
    writeFileSync(join(f.project, "data/config/runtime.json"), runtimeText({ BOT_PORT: "1011" }));
    await refused("运行参数在确认之后被改动，请重新部署", runtime);
    rmSync(join(f.project, "data/config/runtime.json"));
    const copy = f.task.images.get(f.candidateImage)!;
    f.task.images.delete(f.candidateImage);
    await refused("任务 daemon 中没有候选镜像；服务尚未停止，请重新部署", f.stage(), false);
    f.task.images.set(f.candidateImage, copy);
    const stale = { ...f.originalContainer!, Id: "e".repeat(64), Name: "/mixin-chatbot-rollback" };
    f.main.containers.set(stale.Id, stale);
    await refused("发现旧回滚容器 mixin-chatbot-rollback", f.stage(), false);
    f.main.containers.delete(stale.Id);
    const none = await f.lifecycle({ operation: "deploy", command: "deploy" });
    expect(none).toMatchObject({ outcome: "refused", exitCode: 1, message: "没有未完成的部署事务" });
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("部署预检只读检查部署锁、未完成的事务和回滚容器，不写快照也不写结果；首次部署没有原容器也能通过", async () => {
  const first = await fixture({});
  try {
    expect(await first.preflight()).toMatchObject({ command: "deploy", outcome: "success", exitCode: 0, wasRunning: false });
    expect(first.results).toEqual([]); expect(existsSync(join(first.project, "backup"))).toBe(false);
  } finally { await first.cleanup(); }
  const f = await fixture({ original: true, running: true, failures: ["interrupt"] });
  try {
    expect(await f.preflight()).toMatchObject({ outcome: "success", exitCode: 0, wasRunning: true });
    expect(f.events).toEqual([]); expect(f.results).toEqual([]); expect(f.originalContainer!.State.Running).toBe(true);
    const stale = { ...f.originalContainer!, Id: "e".repeat(64), Name: "/mixin-chatbot-rollback" };
    f.main.containers.set(stale.Id, stale);
    const left = await f.preflight();
    expect(left).toMatchObject({ outcome: "refused", exitCode: 1 }); expect(left.message).toContain("发现旧回滚容器 mixin-chatbot-rollback");
    f.main.containers.delete(stale.Id);
    await f.deploy(f.stage());
    expect(await f.preflight()).toMatchObject({ outcome: "refused", exitCode: 1, message: "有未完成的部署或升级，请先继续或回滚；旧服务尚未停止" });
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("部署完成后才回收任务 daemon 的旧镜像；回收失败只警告，部署仍然完成；回滚不回收", async () => {
  const f = await fixture({ original: true, running: true, failures: ["task-cleanup"] });
  try {
    expect(await f.deploy(f.stage())).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
    expect(f.reclaims).toEqual([false]);
    expect(f.outputs.join("")).toContain("部署已完成，但独立任务 daemon 的旧镜像清理未完成；下次成功部署会重试");
    expect(f.task.images.has(f.originalImage)).toBe(true);
    expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
  const failed = await fixture({ original: true, running: true, failures: ["verification-health"] });
  try {
    expect(await failed.deploy(failed.stage())).toMatchObject({ outcome: "failed", finalState: "running" });
    expect(failed.reclaims).toEqual([]); expect(failed.task.images.has(failed.originalImage)).toBe(true);
  } finally { await failed.cleanup(); }
}, 60_000);

test.skipIf(!linux)("事务中从备份恢复：由记录的版本执行，事务和停机状态不变；事务尚未开始、服务在运行或记录的版本不能运行时拒绝；之后回滚仍然可行；没有事务时拒绝", async () => {
  const f = await fixture({ original: true, running: true, failures: ["interrupt"] });
  try {
    const none = await f.restore("groups/g1");
    expect(none).toMatchObject({ command: "revision-cleanup", outcome: "refused", exitCode: 1, message: "没有未完成的部署或升级，恢复不需要事务记录的版本" });
    await f.deploy(f.stage());
    const pending = loadDeploymentState(f.project)!, name = pending.snapshot;
    // Nothing of the transaction has run yet: its release has no writer to record, so restoring waits for the rollback that asks for it.
    const early = await f.restore("groups/g1");
    expect(early).toMatchObject({ outcome: "refused", exitCode: 1 }); expect(early.message).toContain("事务还没有开始执行");
    // What a kill during the stop leaves: that step's checkpoint.
    const runtime = readFileSync(join(f.project, "backup/snapshots", name, "host-runtime"), "utf8").trim();
    await new DeploymentRecord(f.project, pending.record, runtime, () => {}).checkpoint({ version: 1, snapshot: name, runtime, direction: "forward", step: "stop" });
    const running = await f.restore("groups/g1");
    expect(running).toMatchObject({ outcome: "refused", exitCode: 1 }); expect(running.message).toContain("机器人却在运行");
    // The operator stopped it, as the refusal asks.
    f.originalContainer!.State = { Status: "exited", Running: false, Paused: false, Restarting: false, ExitCode: 0 };
    expect(await f.restore("groups/g1")).toMatchObject({ command: "revision-cleanup", outcome: "success", exitCode: 0, finalState: "stopped", wasRunning: true });
    expect(f.events).toEqual(["tag:mixin-chatbot:previous:original", "revision-cleanup:restore"]);
    expect(loadDeploymentState(f.project)?.snapshot).toBe(name); expect(f.originalContainer!.State.Running).toBe(false);
    const copy = f.main.images.get(f.candidateImage)!;
    f.main.images.delete(f.candidateImage);
    const gone = await f.restore("groups/g1");
    expect(gone).toMatchObject({ outcome: "refused", exitCode: 1 }); expect(gone.message).toContain("从备份恢复需要事务记录的版本");
    expect(f.events).toHaveLength(2); expect(existsSync(pointer(f))).toBe(true);
    f.main.images.set(f.candidateImage, copy);
    expect(await f.rollback()).toMatchObject({ command: "rollback", outcome: "success", exitCode: 0, finalState: "running" });
  } finally { await f.cleanup(); }
}, 60_000);
