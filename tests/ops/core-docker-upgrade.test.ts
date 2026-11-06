import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDeploymentState } from "../../ops/core/deployment-state.ts";
import { DeploymentRecord } from "../../ops/core/deployment-record.ts";
import { serializeCandidateRecord } from "../../ops/core/docker-deployment.ts";
import type { OpsResult } from "../../ops/core/result.ts";
import { dockerUpgradeFixture as fixture } from "../helpers/docker-upgrade.ts";

const linux = process.platform === "linux", source = resolve(import.meta.dir, "../..");
type Fixture = Awaited<ReturnType<typeof fixture>>;
const pointer = (f: Fixture) => join(f.project, "data/state/deploy-transaction");
const git = (f: Fixture, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", f.project, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};
const containers = (f: Fixture) => [...f.main.containers.values()].map(c => [c.Name.replace(/-\d+-[a-f0-9]+$/, ""), c.Id === f.originalContainer.Id ? "original" : "candidate", c.State.Running]).sort();

/** The shell entries (ops.sh, deploy.sh, upgrade.sh) read a pending core transaction with these parsers to offer resume or rollback. */
async function shellView(project: string): Promise<string[]> {
  const script = ["set -euo pipefail", 'PROJECT_DIR="$1"', `. ${JSON.stringify(join(source, "scripts/lib/deployment.sh"))}`, "load_pending_transaction",
    'task_runtime_read "$TRANSACTION_SNAPSHOT/task-runtime"', "describe_pending_transaction >&2",
    `printf '%s\\n' "\${TRANSACTION[target_sha]}" "\${TRANSACTION[was_running]}" "$TASK_DOCKER_ENDPOINT"`].join("\n");
  const child = Bun.spawn(["bash", "-c", script, "bash", project], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stderr).toContain("未完成的升级：目标提交");
  return stdout.trim().split("\n");
}

test.skipIf(!linux)("Docker 升级：验证通过才提交，候选镜像按 ID 运行，原运行状态保留，旧容器、标签和快照都收尾", async () => {
  for (const running of [true, false]) {
    const f = await fixture(running);
    try {
      expect(await f.run()).toMatchObject({ command: "update", outcome: "success", exitCode: 0, finalState: running ? "running" : "stopped", wasRunning: running, message: `升级完成：${f.original.slice(0, 7)} -> ${f.target.slice(0, 7)}` });
      expect(f.events).toEqual(["tag:mixin-bot:previous:original", ...running ? ["stop:original"] : [], "git:checkout", "git:merge", "data-current:apply", "task-deployment:write",
        "rename:original:mixin-bot-rollback", "create:candidate", "start:verification", "stop:candidate", "layout-check", "data-current:commit", "rm:original",
        ...running ? ["start:candidate"] : [], "tag:mixin-bot:latest:candidate"]);
      expect(f.unexpected).toEqual([]);
      expect([f.head(), f.branch(), f.mainRef()]).toEqual([f.target, "main", f.target]);
      expect(loadDeploymentState(f.project)).toBeNull();
      expect(containers(f)).toEqual([["/mixin-bot", "candidate", running]]);
      // The candidate's own tag and the rollback tag are gone; the old image left with its last reference.
      expect(Object.fromEntries(f.main.tags)).toEqual({ "mixin-bot:latest": f.candidateImage }); expect(f.main.images.has(f.originalImage)).toBe(false);
      // On the separate task daemon only the unreferenced old copy goes, never a named or foreign image.
      expect([...f.task.images.keys()].sort()).toEqual([f.candidateImage, f.keptImage, f.foreignImage].sort());
      for (const relative of ["data/state/verify-only", "backup/snapshots", "backup/rm"]) expect(existsSync(join(f.project, relative))).toBe(false);
      expect(JSON.parse(readFileSync(join(f.project, "data/config/task-deployment.json"), "utf8"))).toEqual({ image: f.candidateImage });
      expect(f.results).toHaveLength(1);
    } finally { await f.cleanup(); }
  }
}, 120_000);

test.skipIf(!linux || process.geteuid?.() === 0)("通讯录范围按停机前的选择写入；任务与服务共用 daemon 时不回收镜像", async () => {
  const f = await fixture(true, { directory: true, sharedDaemon: true });
  try {
    expect(await f.run()).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
    const tools = f.events.filter(value => /^(data-current|directory-scope|task-deployment):/.test(value));
    expect(tools).toEqual(["directory-scope:install", "data-current:apply", "task-deployment:write", "data-current:commit"]);
    expect(readFileSync(f.directoryFile, "utf8")).toBe(readFileSync(f.directoryPlan, "utf8"));
    expect([...f.main.images.keys()].sort()).toEqual([f.candidateImage, f.keptImage, f.foreignImage].sort());
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("验证未就绪自动回滚：先恢复数据，再恢复代码、配置和原容器；失败实例保留现场，标签收尾", async () => {
  const f = await fixture(true, { failures: ["verification-health"], directory: true });
  try {
    expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "running", wasRunning: true, message: "验证实例未就绪，未提交数据；已自动恢复到操作前的状态" });
    expect(f.events.slice(f.events.indexOf("start:verification"))).toEqual(["start:verification", "stop:candidate", "data-current:rollback", "git:checkout", "git:reset",
      "rename:candidate:mixin-bot-failed", "tag:mixin-bot:latest:original", "rename:original:mixin-bot", "start:original"]);
    // The timed-out instance shows its own last log lines, and the cause is announced before the first restoration step.
    const shown = f.outputs.join(""), notice = shown.indexOf("验证实例未就绪，未提交数据；正在自动恢复到操作前的状态\n");
    expect(shown).toContain("fixture: the instance exited during verification");
    expect(notice).toBeGreaterThan(-1); expect(notice).toBeLessThan(shown.indexOf("部署阶段：rollback/stop"));
    expect(f.unexpected).toEqual([]);
    expect([f.head(), f.branch(), f.mainRef()]).toEqual([f.original, "main", f.original]);
    expect(loadDeploymentState(f.project)).toBeNull();
    // The recorded configuration came back whole: this upgrade's scope and task manifest left with it, the writes kept under backup/rm.
    expect(existsSync(f.directoryFile)).toBe(false); expect(existsSync(join(f.project, "data/config/task-deployment.json"))).toBe(false);
    expect(existsSync(join(f.project, "data/state/release-data.json"))).toBe(false);
    expect(containers(f)).toEqual([["/mixin-bot", "original", true], ["/mixin-bot-failed", "candidate", false]]);
    expect(Object.fromEntries(f.main.tags)).toEqual({ "mixin-bot:latest": f.originalImage });
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("验证实例启动后退出：不等完就绪时限，报告容器日志并回滚", async () => {
  const f = await fixture(false, { failures: ["verification-exit"] });
  try {
    // Waiting out this deadline would overrun the test's own timeout.
    expect(await f.run(f.input, { readyTimeoutMs: 300_000 })).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "stopped", wasRunning: false });
    expect(f.outputs.join("")).toContain("fixture: the instance exited during verification");
    expect(f.events).not.toContain("start:original");
    expect(containers(f)).toEqual([["/mixin-bot", "original", false], ["/mixin-bot-failed", "candidate", false]]);
    expect(f.head()).toBe(f.original); expect(loadDeploymentState(f.project)).toBeNull();
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("准备记录与实际不符时在发布事务之前拒绝：不停服务、不改代码、不留快照，纠正后可正常升级", async () => {
  const f = await fixture(true);
  try {
    const candidate = f.candidateImage, wrongUser = process.geteuid!() ? "1001:1001" : "0:0";
    const refused = async (message: string, change: () => void, undo: () => void, input = f.input, outcome = "refused") => {
      change();
      const result = await f.run(input); undo();
      expect(result).toMatchObject({ outcome, exitCode: 1, finalState: "unknown", wasRunning: false });
      expect(result.message).toContain(message);
      expect(f.events).toEqual([]); expect(f.unexpected).toEqual([]);
      expect(existsSync(pointer(f))).toBe(false); expect(existsSync(join(f.project, "backup/snapshots"))).toBe(false);
      expect(f.originalContainer.State.Running).toBe(true); expect(f.head()).toBe(f.original);
    };
    const facts = (change: Record<string, string>) => [() => f.writeFacts({ ...f.facts, ...change }), () => f.writeFacts()] as const;
    await refused("被删除、替换或改动", ...facts({ container: "e".repeat(64) }));
    await refused("被删除、替换或改动", ...facts({ image: "sha256:" + "e".repeat(64) }));
    await refused("被删除、替换或改动", ...facts({ user: "1234:1234" }));
    await refused("升级开始后检出发生了变化", ...facts({ main: "e".repeat(40) }));
    await refused("任务 daemon 与部署记录不同", ...facts({ daemon: "fixture-other-daemon" }), f.input, "failed");
    const record = (change: Partial<typeof f.candidate>) => [() => writeFileSync(f.candidateFile, serializeCandidateRecord({ ...f.candidate, ...change })),
      () => writeFileSync(f.candidateFile, serializeCandidateRecord(f.candidate))] as const;
    await refused("不是从本次目标提交构建的", ...record({ target_sha: "e".repeat(40) }));
    await refused("不是本次构建的候选镜像", ...record({ operation_id: "e".repeat(16), image_tag: `mixin-bot:candidate-${f.candidate.project_id}-${"e".repeat(16)}` }));
    await refused("候选镜像核对未通过", () => f.main.tags.delete(f.candidate.image_tag), () => f.main.tags.set(f.candidate.image_tag, candidate));
    const copy = f.task.images.get(candidate)!;
    await refused("任务 daemon 中没有候选镜像", () => f.task.images.delete(candidate), () => f.task.images.set(candidate, copy));
    const stale = { ...f.originalContainer, Id: "e".repeat(64), Name: "/mixin-bot-rollback" };
    await refused("发现旧回滚容器", () => f.main.containers.set(stale.Id, stale), () => f.main.containers.delete(stale.Id));
    await refused("运行身份", () => { f.originalContainer.Config.User = "01:01"; f.writeFacts({ ...f.facts, user: "01:01" }); },
      () => { f.originalContainer.Config.User = f.facts.user; f.writeFacts(); });
    await refused("Docker 下服务", () => { f.originalContainer.Config.User = wrongUser; f.writeFacts({ ...f.facts, user: wrongUser }); },
      () => { f.originalContainer.Config.User = f.facts.user; f.writeFacts(); });
    await refused("本次升级没有停止服务", () => writeFileSync(join(f.project, "version.txt"), "edited\n"), () => writeFileSync(join(f.project, "version.txt"), "original\n"));
    // A local file on a path the target adds, e.g. one that appeared while the image built: refused under the lock before the stop.
    const notes = join(f.project, "release-notes.md");
    await refused("未跟踪的文件会被目标版本覆盖：release-notes.md", () => writeFileSync(notes, "operator notes\n"), () => rmSync(notes));
    await refused("Linux 升级参数不完整", () => {}, () => {}, { ...f.input, facts: undefined });
    await refused("数据准备计划缺失", () => {}, () => {}, { ...f.input, plan: join(f.root, "missing.json") });
    const scope = readFileSync(f.directoryFile, "utf8");
    await refused("缺少通讯录同步范围，也没有停机前选定的范围；旧服务尚未停止", () => rmSync(f.directoryFile), () => writeFileSync(f.directoryFile, scope));
    const shared = join(f.project, "data/state/workspace-root"), missing = join(f.root, "missing-shared");
    await refused(`共享资料目录不存在或是链接：${missing}`, () => writeFileSync(shared, missing + "\n"), () => rmSync(shared));
    expect(await f.run()).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("停机前预检只读：通过不留记录；未完成事务、旧回滚容器、缺少原容器或代码切换会覆盖的本地文件都在构建前拒绝", async () => {
  const f = await fixture(true);
  try {
    expect(await f.preflight()).toMatchObject({ outcome: "success", exitCode: 0, wasRunning: true, message: "停机前检查通过：部署锁、未完成的事务和运维任务、main、原容器与代码切换均可进行" });
    expect(f.events).toEqual([]); expect(existsSync(join(f.project, "backup"))).toBe(false); expect(f.results).toEqual([]);
    const notes = join(f.project, "release-notes.md"); writeFileSync(notes, "operator notes\n");
    const conflict = await f.preflight();
    expect(conflict).toMatchObject({ outcome: "refused", exitCode: 1 }); expect(conflict.message).toContain("本次升级没有停止服务");
    expect(conflict.message).toContain("未跟踪的文件会被目标版本覆盖：release-notes.md"); expect(readFileSync(notes, "utf8")).toBe("operator notes\n");
    rmSync(notes);
    git(f, "checkout", "-q", "--detach");
    expect(await f.preflight()).toMatchObject({ outcome: "refused", exitCode: 1, message: "升级开始后检出发生了变化（提交或分支）；旧服务尚未停止，请处理后重新运行升级" });
    git(f, "checkout", "-q", "main");
    const stale = { ...f.originalContainer, Id: "e".repeat(64), Name: "/mixin-bot-rollback" };
    f.main.containers.set(stale.Id, stale);
    expect(await f.preflight()).toMatchObject({ outcome: "refused", exitCode: 1, message: "发现旧回滚容器 mixin-bot-rollback，请先确认其状态；旧服务尚未停止" });
    f.main.containers.delete(stale.Id); f.main.containers.delete(f.originalContainer.Id);
    expect(await f.preflight()).toMatchObject({ outcome: "refused", exitCode: 1, message: "找不到原容器 mixin-bot；升级沿用原服务，请先部署；旧服务尚未停止" });
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("提交回复丢失：事务保留为已提交，脚本入口读得懂；禁止回滚，固定运行包只按相同摘要重建，续做不重复写数据", async () => {
  const f = await fixture(true, { failures: ["commit-reply"] });
  try {
    expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "stopped", wasRunning: true, message: "synthetic: the attach client lost the reply" });
    const pending = loadDeploymentState(f.project)!, snapshot = join(f.project, "backup/snapshots", pending.snapshot);
    expect(pending.committed).toBe(true); expect(f.head()).toBe(f.target);
    expect(await shellView(f.project)).toEqual([f.target, "1", f.facts.endpoint]);
    expect(await f.preflight()).toMatchObject({ outcome: "refused", message: "有未完成的部署或升级，请先继续或回滚；旧服务尚未停止" });
    const effects = f.events.length;
    expect(await f.rollback()).toMatchObject({ outcome: "failed", exitCode: 1, message: "数据已提交，不能回滚；请继续完成新实例启动和收尾" });
    f.main.id = "fixture-other-daemon";
    expect(await f.resume()).toMatchObject({ outcome: "refused", exitCode: 1, message: "Docker daemon 与开始事务时不同：拒绝继续和自动回滚，不操作另一个 Docker 上的同名容器；请回到原来的 Docker 后重试" });
    f.main.id = f.candidate.daemon_id;
    const digest = readFileSync(join(snapshot, "host-runtime"), "utf8").trim(), runtime = join(f.project, ".console/runtime/source-" + digest);
    rmSync(runtime, { recursive: true, force: true });
    const other = join(f.root, "other-release");
    for (const tree of ["console", "ops", "scripts", "src"]) mkdirSync(join(other, tree), { recursive: true });
    expect(await f.resume({ source: other })).toMatchObject({ outcome: "refused", exitCode: 1, message: "此事务的固定运维运行包缺失或变化，请使用对应版本恢复" });
    expect(existsSync(runtime)).toBe(false); expect(f.events).toHaveLength(effects);
    expect(await f.resume()).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running", wasRunning: true });
    expect(existsSync(runtime)).toBe(true);
    expect(f.events.slice(effects)).toEqual(["rm:original", "start:candidate", "tag:mixin-bot:latest:candidate"]);
    expect(containers(f)).toEqual([["/mixin-bot", "candidate", true]]); expect(loadDeploymentState(f.project)).toBeNull();
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("提交后正式容器启动失败、处于重启循环：排除原因后续做重启容器并完成", async () => {
  const f = await fixture(true, { failures: ["candidate-loop"] });
  try {
    expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "start-requested", wasRunning: true });
    expect(loadDeploymentState(f.project)?.committed).toBe(true);
    f.failures.delete("candidate-loop"); const effects = f.events.length;
    expect(await f.resume()).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running", wasRunning: true });
    // docker start leaves a restarting container alone: the candidate is stopped and started under the start-candidate checkpoint.
    expect(f.events.slice(effects)).toEqual(["stop:candidate", "start:candidate", "tag:mixin-bot:latest:candidate"]);
    expect(containers(f)).toEqual([["/mixin-bot", "candidate", true]]); expect(loadDeploymentState(f.project)).toBeNull();
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("自动回滚中断后事务保留：不能再继续发布；记录的镜像缺失时拒绝撤销已开始的迁移，恢复镜像后显式回滚完成", async () => {
  const f = await fixture(true, { failures: ["verification-health", "restore-data"] });
  try {
    const first = await f.run();
    expect(first).toMatchObject({ outcome: "failed", exitCode: 1, wasRunning: true });
    expect(first.message).toContain("验证实例未就绪，未提交数据；恢复未完成：数据准备 rollback 未完成");
    expect(loadDeploymentState(f.project)).toMatchObject({ committed: false, dataPhase: "prepared", rollbackPending: true });
    expect(f.head()).toBe(f.target);
    const started = f.events.length;
    expect(await f.resume()).toMatchObject({ outcome: "failed", exitCode: 1, message: "上次操作已经开始回滚，请完成回滚，不能继续发布" });
    const image = f.main.images.get(f.candidateImage)!;
    f.main.images.delete(f.candidateImage);
    const missing = await f.rollback();
    expect(missing).toMatchObject({ outcome: "failed", exitCode: 1 }); expect(missing.message).toContain("上次操作的数据迁移已经开始");
    expect(f.events).toHaveLength(started); f.main.images.set(f.candidateImage, image);
    expect(await f.rollback()).toMatchObject({ command: "rollback", outcome: "success", exitCode: 0, finalState: "running", wasRunning: true, message: `升级已回滚：代码恢复到 ${f.original.slice(0, 7)}，数据、配置和原运行状态已恢复` });
    expect(f.events.slice(started)).toEqual(["data-current:rollback", "git:checkout", "git:reset", "rename:candidate:mixin-bot-failed", "tag:mixin-bot:latest:original",
      "rename:original:mixin-bot", "start:original"]);
    expect(f.head()).toBe(f.original); expect(loadDeploymentState(f.project)).toBeNull();
    expect(containers(f)).toEqual([["/mixin-bot", "original", true], ["/mixin-bot-failed", "candidate", false]]);
    expect(readdirSync(join(f.project, "backup/snapshots"))).toHaveLength(1);
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 120_000);

// Killed after the transaction was published but before the stop: the service still runs, nothing has a checkpoint.
const interrupted = async (f: Fixture) => {
  expect(await f.run()).toMatchObject({ command: "update", outcome: "failed", exitCode: 1, message: "synthetic: the entry died after publishing the transaction" });
  const pending = loadDeploymentState(f.project)!;
  expect(pending).toMatchObject({ committed: false, dataPhase: "unprepared", record: { was_running: "1" } }); expect(pending.execution).toBeUndefined();
  expect(f.events).toEqual(["tag:mixin-bot:previous:original"]); expect(f.originalContainer.State.Running).toBe(true); expect(f.head()).toBe(f.original);
  return pending;
};

test.skipIf(!linux)("指针发布后、停机前中断：续做在停机前复核切换冲突、main 和 Docker，干净时完成；外部共享资料目录按事务记录只读挂载", async () => {
  const f = await fixture(true, { failures: ["interrupt"] });
  try {
    const shared = join(f.root, "shared");
    mkdirSync(shared); writeFileSync(join(f.project, "data/state/workspace-root"), shared + "\n");
    const pending = await interrupted(f);
    expect(pending.record).toMatchObject({ original_workspace_root: shared, target_workspace_root: shared });
    const kept = (result: OpsResult, values: Partial<OpsResult>, message: string) => {
      expect(result).toMatchObject({ exitCode: 1, wasRunning: true, ...values }); expect(result.message).toContain(message);
      expect(f.events).toEqual(["tag:mixin-bot:previous:original"]); expect(f.originalContainer.State.Running).toBe(true);
      expect(loadDeploymentState(f.project)?.snapshot).toBe(pending.snapshot); expect(f.head()).not.toBe(f.target);
    };
    writeFileSync(join(f.project, "release-notes.md"), "operator notes\n");
    kept(await f.resume(), { command: "resume", outcome: "refused", finalState: "running" }, "未跟踪的文件会被目标版本覆盖：release-notes.md");
    rmSync(join(f.project, "release-notes.md"));
    // An operator commit on main (same tree): main can no longer fast-forward. HEAD moved with main, so the final state
    // cannot be attributed to the recorded code and is reported as unknown; nothing changed, so it stays a refusal (A3-6).
    const diverged = git(f, "commit-tree", "-p", f.original, "-m", "operator commit", `${f.original}^{tree}`);
    git(f, "update-ref", "refs/heads/main", diverged);
    const refused = await f.resume();
    kept(refused, { command: "resume", outcome: "refused", finalState: "unknown" }, `本地 main（${diverged.slice(0, 7)}）无法快进到目标提交 ${f.target.slice(0, 7)}`);
    expect(refused.message).not.toContain("最终状态");
    git(f, "update-ref", "refs/heads/main", f.original);
    f.main.id = "fixture-other-daemon";
    // Refused while the session opens, before the transaction's run state is read.
    for (const attempt of [() => f.resume(), () => f.rollback()])
      kept(await attempt(), { outcome: "refused", finalState: "unknown", wasRunning: false }, "Docker daemon 与开始事务时不同");
    f.main.id = f.candidate.daemon_id;
    expect(await f.resume()).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running", wasRunning: true, message: `升级完成：${f.original.slice(0, 7)} -> ${f.target.slice(0, 7)}` });
    expect(f.events.slice(1)).toEqual(["stop:original", "git:checkout", "git:merge", "data-current:apply", "task-deployment:write", "rename:original:mixin-bot-rollback",
      "create:candidate", "start:verification", "stop:candidate", "layout-check", "data-current:commit", "rm:original", "start:candidate", "tag:mixin-bot:latest:candidate"]);
    const service = f.main.container("mixin-bot")!;
    expect(service.Mounts.filter(mount => mount.Destination === "/app/workspace")).toEqual([{ Type: "bind", Source: shared, Destination: "/app/workspace", RW: false }]);
    expect(service.Config.Env).toContain("WORKSPACE_ROOT=/app/workspace");
    expect([f.head(), f.branch(), f.mainRef()]).toEqual([f.target, "main", f.target]); expect(loadDeploymentState(f.project)).toBeNull();
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 120_000);

test.skipIf(!linux)("指针发布后、停机前中断且候选镜像已丢失：不能继续；回滚停机、恢复代码和配置并按原状态重启", async () => {
  const f = await fixture(true, { failures: ["interrupt"] });
  try {
    await interrupted(f);
    f.main.images.delete(f.candidateImage);
    const refused = await f.resume();
    expect(refused).toMatchObject({ command: "resume", outcome: "refused", exitCode: 1, finalState: "running", wasRunning: true });
    expect(refused.message).toContain("重新构建的镜像不能代替");
    expect(f.events).toEqual(["tag:mixin-bot:previous:original"]); expect(f.originalContainer.State.Running).toBe(true);
    expect(await f.rollback()).toMatchObject({ command: "rollback", outcome: "success", exitCode: 0, finalState: "running", wasRunning: true, message: `升级已回滚：代码恢复到 ${f.original.slice(0, 7)}，数据、配置和原运行状态已恢复` });
    expect(f.events.slice(1)).toEqual(["stop:original", "git:checkout", "git:reset", "tag:mixin-bot:latest:original", "start:original"]);
    expect([f.head(), f.branch(), f.mainRef()]).toEqual([f.original, "main", f.original]); expect(loadDeploymentState(f.project)).toBeNull();
    expect(containers(f)).toEqual([["/mixin-bot", "original", true]]);
    expect(f.main.tags.get("mixin-bot:latest")).toBe(f.originalImage); expect(f.main.tags.has("mixin-bot:previous")).toBe(false);
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!linux)("停机并切换代码后被杀：续做拒绝已跟踪文件的改动（未暂存或已暂存），不自动回滚、不改文件和索引；清理后续做完成", async () => {
  const f = await fixture(true, { failures: ["interrupt"] });
  try {
    const pending = await interrupted(f);
    // What a kill right after the code switch leaves: the service stopped, the target checked out, that step's checkpoint.
    f.originalContainer.State = { ...f.originalContainer.State, Status: "exited", Running: false };
    git(f, "merge", "--ff-only", "--quiet", f.target);
    const runtime = readFileSync(join(f.project, "backup/snapshots", pending.snapshot, "host-runtime"), "utf8").trim();
    await new DeploymentRecord(f.project, pending.record, runtime, () => {}).checkpoint({ version: 1, snapshot: pending.snapshot, runtime, direction: "forward", step: "switch-code" });
    for (const staged of [false, true]) {
      writeFileSync(join(f.project, "version.txt"), "operator edit\n");
      if (staged) git(f, "add", "version.txt");
      const index = readFileSync(join(f.project, ".git/index"));
      const result = await f.resume();
      // Failed, not refused: the transaction already holds the earlier run's changes. But nothing new runs, no recovery either.
      expect(result).toMatchObject({ command: "resume", outcome: "failed", exitCode: 1, wasRunning: true, finalState: "stopped" });
      expect(result.message).toContain("未提交的改动"); expect(result.message).not.toContain("恢复");
      expect(f.events).toEqual(["tag:mixin-bot:previous:original"]);
      expect(readFileSync(join(f.project, ".git/index"))).toEqual(index); expect(readFileSync(join(f.project, "version.txt"), "utf8")).toBe("operator edit\n");
      expect(loadDeploymentState(f.project)?.execution?.checkpoint).toMatchObject({ direction: "forward", step: "switch-code" });
    }
    git(f, "reset", "--hard", "--quiet", f.target); writeFileSync(join(f.project, "notes.txt"), "untracked notes\n");
    expect(await f.resume()).toMatchObject({ command: "resume", outcome: "success", exitCode: 0, finalState: "running", wasRunning: true });
    expect(f.events.slice(1)).toEqual(["git:checkout", "git:merge", "data-current:apply", "task-deployment:write", "rename:original:mixin-bot-rollback",
      "create:candidate", "start:verification", "stop:candidate", "layout-check", "data-current:commit", "rm:original", "start:candidate", "tag:mixin-bot:latest:candidate"]);
    expect(readFileSync(join(f.project, "notes.txt"), "utf8")).toBe("untracked notes\n"); expect(loadDeploymentState(f.project)).toBeNull();
    expect(f.unexpected).toEqual([]);
  } finally { await f.cleanup(); }
}, 120_000);
