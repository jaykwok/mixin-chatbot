import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDeployArgs, parseUpgradeArgs, runDeploymentCli } from "../../ops/core/deployment-cli.ts";
import { runCore } from "../../ops/core/cli.ts";
import { loadDeploymentState } from "../../ops/core/deployment-state.ts";
import { serializeTransactionRecord } from "../../ops/core/transaction-record.ts";
import { MaintenanceRefused } from "../../ops/core/maintenance.ts";
import type { preflightWindowsUpgrade } from "../../ops/core/windows-lifecycle.ts";
import type { DockerInput, DockerUpgradeInput, preflightDockerDeploy, runDockerLifecycle } from "../../ops/core/docker-lifecycle.ts";
import type { OpsResult } from "../../ops/core/result.ts";
import { tempFixture } from "../helpers/temp.ts";
import { confirmTransaction } from "../../ops/lib/confirmed-transaction.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { consoleDir } from "../../ops/core/console-state.ts";

const original = "a".repeat(40), target = "b".repeat(40);
const args = (project: string) => ["upgrade", "--project", project, "--original", original, "--target", target, "--branch", "main"];
/** A new upgrade's choices on this platform; Docker also takes the candidate-image record and the facts prepared before the stop. */
const fresh = (root: string) => ["--plan", join(root, "plan.json"), ...(process.platform === "win32" ? [] : ["--candidate", join(root, "candidate-image"), "--facts", join(root, "upgrade-facts")])];
const done: OpsResult = { protocol: "mixin-ops", version: 1, command: "update", outcome: "success", exitCode: 0,
  wasRunning: false, finalState: "stopped", message: "合成部署完成" };

async function pending(project: string, operation: "deploy" | "upgrade" = "upgrade") {
  const name = "deploy-clifixture", snapshot = join(project, "backup/snapshots", name), upgrade = operation === "upgrade";
  await mkdir(snapshot, { recursive: true }); await mkdir(join(project, "data/state"), { recursive: true });
  await writeFile(join(snapshot, "transaction"), serializeTransactionRecord({ format: "2", operation, snapshot: name,
    target_sha: target, original_sha: upgrade ? original : "", original_branch: upgrade ? "original-branch" : "", was_running: "0", bot_port: "1011",
    target_workspace_root: "", original_workspace_root: "", reconfigure_ai: "0" }));
  await writeFile(join(project, "data/state", operation + "-transaction"), name + "\n");
  return snapshot;
}

test("升级入口逐动作拒绝未知、重复和无值参数，不把错误选择变成默认值", () => {
  expect(parseUpgradeArgs([...args("/fixture"), "--plan", "p.json", "--json"]))
    .toMatchObject({ project: "/fixture", plan: "p.json", json: true, rollback: false });
  for (const tail of [["--no-backup"], ["--cleanup", "skip"], ["--plan"], ["--plan", "--json"],
    ["--json", "--json"], ["--original", original], ["--branch", "other"], ["extra"], ["--confirmation", "bad"],
    ["--rollback", "--plan", "p"], ["--rollback", "--directory-plan", "d"],
    ["--preflight", "--preflight"], ["--preflight", "--rollback"], ["--preflight", "--plan", "p"],
    ["--preflight", "--directory-plan", "d"], ["--preflight", "--confirmation", "bad"]]) {
    expect(() => parseUpgradeArgs([...args("/fixture"), ...tail]), tail.join(" ")).toThrow("用法");
  }
  expect(parseUpgradeArgs([...args("/fixture"), "--preflight", "--json"])).toMatchObject({ preflight: true, json: true, rollback: false });
  expect(parseUpgradeArgs(args("/fixture")).preflight).toBe(false);
  expect(() => parseUpgradeArgs(["deploy", ...args("/fixture").slice(1)])).toThrow();
  expect(() => parseUpgradeArgs(args("/fixture").slice(0, -2))).toThrow();
});

test("共享入口转交部署命令且保留结果文件、退出码与中文消息", async () => {
  const f = await tempFixture("core-deployment-cli-");
  try {
    const file = join(f.root, "result.json"), calls: DockerInput[] = [];
    const host: typeof runDockerLifecycle = async (input, options) => {
      calls.push(input); await options.verify(); const result = { ...done, command: input.command! }; await options.finish(result); return result;
    };
    const input = [...args(f.root), ...fresh(f.root), "--json"];
    const result = await runCore(["deployment", ...input], { env: { MIXIN_OPS_RESULT_FILE: file },
      deployment: (argv, options, signal) => runDeploymentCli(argv, { ...options, host }, signal) });
    expect(result).toEqual({ result: done, json: true }); expect(JSON.parse(await readFile(file, "utf8"))).toEqual(done);
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ command: "update", original, target, branch: "main", plan: join(f.root, "plan.json"),
      ...(process.platform === "win32" ? {} : { candidate: join(f.root, "candidate-image"), facts: join(f.root, "upgrade-facts") }) });
    await expect(runDeploymentCli(args(f.root), { host })).rejects.toThrow("新升级必须"); expect(calls).toHaveLength(1);
    await expect(runDeploymentCli([...input, "--no-backup"], { host })).rejects.toThrow("用法"); expect(calls).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("Docker 新升级缺停机前的候选镜像记录或准备记录时拒绝；Windows 升级不接受这两个参数", async () => {
  const f = await tempFixture("core-deployment-platform-cli-");
  try {
    const calls: unknown[] = [], host: typeof runDockerLifecycle = async input => { calls.push(input); return done; };
    const base = [...args(f.root), "--plan", "p.json"];
    for (const extra of [[], ["--candidate", "c"], ["--facts", "f"]])
      await expect(runDeploymentCli([...base, ...extra], { host, platform: "linux" }), extra.join(" ")).rejects.toThrow("候选镜像记录和准备记录");
    for (const extra of [["--candidate", "c"], ["--facts", "f"], ["--candidate", "c", "--facts", "f"]])
      await expect(runDeploymentCli([...base, ...extra], { host, platform: "win32" }), extra.join(" ")).rejects.toThrow("Windows 升级不使用");
    expect(calls).toEqual([]);
    expect((await runDeploymentCli([...base, "--candidate", "c", "--facts", "f"], { host, platform: "linux" })).result).toEqual(done);
    expect((await runDeploymentCli(base, { host, platform: "win32" })).result).toEqual(done);
    expect(calls).toMatchObject([{ candidate: resolve("c"), facts: resolve("f") }, { plan: resolve("p.json") }]);
    expect(calls[1]).not.toHaveProperty("candidate"); expect(calls[1]).not.toHaveProperty("facts");
  } finally { await f.cleanup(); }
});

test("预检只做只读检查：不进入升级宿主、不写结果文件，原样返回拒绝原因", async () => {
  const f = await tempFixture("core-deployment-preflight-cli-");
  try {
    const file = join(f.root, "result.json"), calls: unknown[] = [];
    const host: typeof runDockerLifecycle = async () => { throw new Error("preflight entered the upgrade host"); };
    const refused: OpsResult = { ...done, outcome: "refused", exitCode: 1, finalState: "unknown", message: "本地 main 分支不存在；旧服务尚未停止" };
    const preflight: typeof preflightWindowsUpgrade = async (input, options) => { calls.push([input, options]); return refused; };
    const result = await runCore(["deployment", ...args(f.root), "--preflight", "--git-path", "C:/fixture/git.exe"], { env: { MIXIN_OPS_RESULT_FILE: file },
      source: "C:/fixture/release", deployment: (argv, options, signal) => runDeploymentCli(argv, { ...options, host, preflight }, signal) });
    expect(result).toEqual({ result: refused, json: false }); expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([[{ original, target, branch: "main", command: "update" }, { project: resolve(f.root), source: "C:/fixture/release", gitPath: "C:/fixture/git.exe" }]]);
  } finally { await f.cleanup(); }
});

test("续做和回滚只读原事务选择；兼容旧包装传来的当前 HEAD，但拒绝不同目标或新计划", async () => {
  const f = await tempFixture("core-deployment-recovery-cli-");
  try {
    await pending(f.root); const calls: DockerInput[] = [];
    const host: typeof runDockerLifecycle = async (input, options) => { await options.verify(); calls.push(input); return { ...done, command: input.command! }; };
    const input = args(f.root).map(value => value === original ? target : value);
    expect((await runDeploymentCli(input, { host })).result.command).toBe("resume");
    const confirmation = confirmTransaction(loadDeploymentState(f.root)!.confirmation, "rollback");
    expect(parseUpgradeArgs([...input, "--rollback", "--confirmation", confirmation]).confirmation).toBe(confirmation);
    expect((await runDeploymentCli([...input, "--rollback", "--confirmation", confirmation], { host })).result.command).toBe("rollback");
    expect(calls[1]!.confirmation).toBe(confirmation);
    expect(() => parseUpgradeArgs([...input, "--confirmation", confirmation])).toThrow("用法");
    expect((calls as DockerUpgradeInput[]).map(value => [value.original, value.branch])).toEqual([[original, "original-branch"], [original, "original-branch"]]);
    for (const extra of [["--plan", "new.json"], ["--directory-plan", "new.json"]])
      await expect(runDeploymentCli([...input, ...extra], { host })).rejects.toThrow("只使用事务中记录");
    await expect(runDeploymentCli(input.map(value => value === target ? "c".repeat(40) : value), { host })).rejects.toThrow("目标不一致");
    expect(calls).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("锁内复核拒绝变化的事务和没有接单记录的网页命令", async () => {
  const f = await tempFixture("core-deployment-recheck-cli-");
  try {
    const input = [...args(f.root), ...fresh(f.root)], calls: string[] = [];
    const host: typeof runDockerLifecycle = async (_input, options) => { await options.verify(); calls.push("mutate"); return done; };
    await expect(runDeploymentCli(input, { host, env: { MIXIN_OPS_CONSOLE: "1" } })).rejects.toThrow("接单记录");
    await expect(runDeploymentCli(input, { host: async (value, options, signal) => { await pending(f.root); return host(value, options, signal); } }))
      .rejects.toThrow("取得部署锁前事务已变化");
    expect(loadDeploymentState(f.root)?.record.target_sha).toBe(target); expect(calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test("部署入口：新部署只接受暂存目录和命令，续做和回滚只用事务记录，网页任务须与暂存一致，未完成的升级不能从这里继续", async () => {
  expect(parseDeployArgs(["deploy", "--project", "/p", "--stage", "/s", "--command", "repair", "--json"]))
    .toMatchObject({ project: "/p", stage: "/s", command: "repair", json: true, rollback: false });
  expect(parseDeployArgs(["deploy", "--project", "/p", "--rollback"])).toMatchObject({ rollback: true, json: false });
  for (const tail of [["--stage", "/s"], ["--command", "deploy"], ["--stage", "/s", "--command", "update"], ["--stage", "/s", "--command", "deploy", "--rollback"],
    ["--stage", "/s", "--command", "deploy", "--confirmation", "x"], ["--confirmation", "bad"], ["--plan", "p"], ["--json", "--json"], ["--project", "/q"], ["extra"]])
    expect(() => parseDeployArgs(["deploy", "--project", "/p", ...tail]), tail.join(" ")).toThrow("用法");
  expect(() => parseDeployArgs(["deploy", "--json"])).toThrow("用法");
  expect(() => parseDeployArgs(["upgrade", "--project", "/p"])).toThrow("用法");

  const f = await tempFixture("core-deploy-cli-");
  try {
    const project = join(f.root, "project"), stage = join(f.root, "stage"), calls: DockerInput[] = [];
    const host: typeof runDockerLifecycle = async (input, options) => { await options.verify(); calls.push(input); return { ...done, command: input.command! }; };
    await mkdir(project); await mkdir(stage);
    await writeFile(join(stage, "deployment.json"), JSON.stringify({ format: 1, target: "", port: 1011, workspace: "" }));
    await writeFile(join(stage, "runtime-values.json"), JSON.stringify({ format: 1, base: null, values: { BOT_PORT: "1011" } }));
    await expect(runDeploymentCli(["deploy", "--project", project], { host })).rejects.toThrow("确认过的部署事务不存在");
    expect((await runDeploymentCli(["deploy", "--project", project, "--stage", stage, "--command", "repair"], { host })).result.command).toBe("repair");
    expect(calls).toEqual([{ operation: "deploy", command: "repair", rollback: false, stage: resolve(stage) }]);

    const store = new TaskStore(consoleDir(project)), task = (params: Record<string, unknown>, key: string) => store.create({ planId: "plan-" + key,
      operation: "deploy", params: { directory: "saved", ...params }, project, mechanism: "systemd-user" }, key).id;
    const accepted = (id: string) => ({ host, checkPlan: async () => {}, env: { MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: id, MIXIN_OPS_EXPECT_CODE: "code" } });
    const argv = ["deploy", "--project", project, "--stage", stage, "--command", "deploy"], same = task({ port: 1011, workspace: "" }, "same");
    expect((await runDeploymentCli(argv, accepted(same))).result.command).toBe("deploy");
    for (const [key, params] of [["port", { port: 1012, workspace: "" }], ["workspace", { port: 1011, workspace: f.root }]] as const)
      await expect(runDeploymentCli(argv, accepted(task(params, key))), key).rejects.toThrow("与已接单任务不一致");
    await expect(runDeploymentCli([...argv.slice(0, -1), "repair"], accepted(same))).rejects.toThrow("与已接单任务不一致");
    // A plan that no longer holds stops the task before anything changes: a refusal, with the plan check's own reason.
    const stale = await runDeploymentCli(argv, { ...accepted(same), checkPlan: async () => { throw new Error("fixture: plan changed"); } }).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(MaintenanceRefused); expect((stale as Error).message).toBe("fixture: plan changed");
    expect(calls).toHaveLength(2);

    await pending(project, "deploy");
    await expect(runDeploymentCli(argv, { host })).rejects.toThrow("不接受新的部署暂存");
    expect((await runDeploymentCli(["deploy", "--project", project], { host })).result.command).toBe("resume");
    const confirmation = confirmTransaction(loadDeploymentState(project)!.confirmation, "rollback");
    expect((await runDeploymentCli(["deploy", "--project", project, "--rollback", "--confirmation", confirmation], { host })).result.command).toBe("rollback");
    expect(calls.slice(2)).toEqual([{ operation: "deploy", command: "resume", rollback: false },
      { operation: "deploy", command: "rollback", rollback: true, confirmation }]);
    await expect(runDeploymentCli(args(project), { host })).rejects.toThrow("目标不一致");

    const upgrading = join(f.root, "upgrading"); await pending(upgrading);
    await expect(runDeploymentCli(["deploy", "--project", upgrading], { host })).rejects.toThrow("未完成的是升级");
    expect(calls).toHaveLength(4);
  } finally { await f.cleanup(); }
});

test("部署预检只做只读检查：不进入宿主、不写结果文件，原样返回拒绝原因；不与新部署或回滚的参数并用", async () => {
  expect(parseDeployArgs(["deploy", "--project", "/p", "--preflight", "--json"])).toMatchObject({ preflight: true, json: true, rollback: false });
  expect(parseDeployArgs(["deploy", "--project", "/p"]).preflight).toBe(false);
  for (const tail of [["--preflight", "--preflight"], ["--preflight", "--rollback"], ["--preflight", "--stage", "/s", "--command", "deploy"], ["--preflight", "--confirmation", "x"]])
    expect(() => parseDeployArgs(["deploy", "--project", "/p", ...tail]), tail.join(" ")).toThrow("用法");
  const f = await tempFixture("core-deploy-preflight-cli-");
  try {
    const file = join(f.root, "result.json"), calls: unknown[] = [];
    const host: typeof runDockerLifecycle = async () => { throw new Error("preflight entered the deployment host"); };
    const refused: OpsResult = { ...done, command: "deploy", outcome: "refused", exitCode: 1, finalState: "unknown", message: "发现旧回滚容器 mixin-bot-rollback" };
    const preflightDeploy: typeof preflightDockerDeploy = async (input, options) => { calls.push([input, options]); return refused; };
    const result = await runCore(["deployment", "deploy", "--project", f.root, "--preflight"], { env: { MIXIN_OPS_RESULT_FILE: file }, source: "/fixture/release",
      deployment: (argv, options, signal) => runDeploymentCli(argv, { ...options, host, preflightDeploy }, signal) });
    expect(result).toEqual({ result: refused, json: false }); expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([[{ operation: "deploy", command: "deploy" }, { project: resolve(f.root), source: "/fixture/release" }]]);
  } finally { await f.cleanup(); }
});
