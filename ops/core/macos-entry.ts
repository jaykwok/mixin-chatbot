#!/usr/bin/env bun
// macOS ops entry. On Darwin scripts/deploy.sh, ops.sh and upgrade.sh hand their arguments to scripts/lib/macos-entry.sh,
// which runs this file: `deploy [deploy|repair]`, `ops <command> [arguments]` (the commands and arguments of ops.sh) or
// `upgrade <project> <target> [continue|rollback]` (the target release's upgrader). The shared core (ops/core/cli.ts) owns
// every write that needs deploy.lock; this entry asks, checks and hands over, like ops.ps1 does on Windows.
import { chmodSync, existsSync, lchownSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { acquireDeploymentLock, DeploymentBusy } from "./deployment-lock.ts";
import { loadDeploymentState, type DeploymentState } from "./deployment-state.ts";
import { describePendingTransaction } from "./pending-transaction.ts";
import { accountIdentity, LaunchdPlatform, SERVICE_ACCOUNT, trustCheckout, type Identity, type ServiceDefinition } from "./launchd-host.ts";
import { checkoutOperator } from "./macos-lifecycle.ts";
import { accountEnvironment, deployEntry, runCore, upgradeEntry } from "./macos-deploy.ts";
import { doctorReport, printDoctor } from "./macos-doctor.ts";
import { serviceReady } from "./readiness.ts";
import { assertUninstallable } from "./uninstall.ts";
import { assertConfirmedTransaction } from "../lib/confirmed-transaction.ts";
import { askTransactionAction, askYesNo, attached, captured, EntryError, fail, hint, ok, requireRoot, setStage, silence, SOURCE, startLog, step, warn, writeResult } from "./macos-terminal.ts";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Data actions of the core, with the names ops.sh gives them. */
const MAINTENANCE = new Set(["runtime-configure", "configuration-apply", "configuration-restore", "relay-ls", "relay-test", "relay-purge", "tmp-ls", "tmp-purge",
  "tmp-preview", "tmp-reclaim", "tmp-discard", "history-clear", "history-compact", "stat-import", "backup-scan", "backup-clean"]);
const WIZARDS: Record<string, [label: string, wizard: string, kind: string]> = { "relay-configure": ["外链配置", "configure-relay.ts", "relay"],
  "model-configure": ["模型配置", "configure.ts", "models"], "configure-app-bot": ["应用机器人配置", "configure-app-bot.ts", "app"] };

interface Context {
  project: string;
  env: NodeJS.ProcessEnv;
  /** The installed definition, or null before the first deployment. */
  definition: ServiceDefinition | null;
  account: Identity | null;
}
/** The service's Bun and PATH once deployed; this Bun before. */
const serviceBun = (context: Context) => context.definition?.args[0] ?? process.execPath;
const servicePath = (context: Context) => context.definition?.env.PATH ?? `${dirname(process.execPath)}:${SYSTEM_PATH}`;
const core = (context: Context, args: string[]) => runCore(context.project, [...args, "--project", context.project], context.env);

function needAccount(context: Context): Identity {
  if (!context.account) throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 不存在；请先使用 ${hint("deploy")}`);
  return context.account;
}
/** A data tool of the project on this terminal, as the service account (ops.sh runs these inside the container). */
function dataTool(context: Context, script: string, args: string[]): Promise<number> {
  const bun = serviceBun(context);
  return attached([bun, "--no-env-file", "run", join(context.project, script), ...args],
    { cwd: context.project, env: { ...accountEnvironment(context.project, bun), PATH: servicePath(context) }, identity: needAccount(context) });
}

async function runState(project: string): Promise<"running" | "stopped" | "unknown"> {
  try { const facts = await new LaunchdPlatform(project).inspect(); return facts.state === "running" || facts.leftovers > 0 ? "running" : "stopped"; }
  catch { return "unknown"; }
}
/**
 * Console deploy and upgrade: the core reports its own result; without one (a refusal before the hand-off, or a core that
 * was killed first) the observed end state is reported instead.
 */
async function lifecycle(context: Context, command: string, work: () => Promise<number>): Promise<number> {
  const file = context.env.MIXIN_OPS_RESULT_FILE;
  if (!file) return work();
  const wasRunning = await runState(context.project) === "running";
  let code = 1, message = "操作未完成，请查看任务日志和恢复状态";
  try { code = await work(); }
  catch (error) { message = error instanceof Error ? error.message : String(error); fail(message); code = error instanceof EntryError ? error.code : 1; }
  if (existsSync(file)) return code;
  let state: "running" | "stopped" | "unknown" | "start-requested" = await runState(context.project);
  if (state === "running" && !await serviceReady(context.project, 10_000)) { state = "start-requested"; code ||= 1; }
  else if (state === "unknown") code ||= 1;
  let outcome: "success" | "failed" = "failed";
  if (["deploy-transaction", "upgrade-transaction"].some(name => existsSync(join(context.project, "data/state", name)))) { code ||= 1; message = "事务尚未结束，请刷新维护页后继续或回滚"; }
  else if (code === 0) { outcome = "success"; message = "操作完成"; }
  const written = writeResult({ command, outcome, wasRunning, finalState: state, exitCode: code, message }, context.env);
  return code === 0 && !written ? 1 : code;
}

async function git(context: Context, args: string[]) {
  const path = context.definition?.git ?? "/usr/bin/git";
  return captured([path, "-C", context.project, ...args], { env: { ...context.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
}

/** The upgrader of the target commit, exported to tmp/upgrade-* outside the checkout, so switching the code cannot change the running script. */
async function runTargetUpgrader(context: Context, target: string, action: "" | "continue" | "rollback"): Promise<number> {
  const { project } = context;
  setStage("export-target-upgrader");
  mkdirSync(join(project, "tmp"), { recursive: true, mode: 0o755 });
  const stage = mkdtempSync(join(project, "tmp", "upgrade-"));
  try {
    // The upgrader's data preview runs as the service account and reads this tree.
    chmodSync(stage, 0o755);
    // The whole tree: the upgrader previews the data with the target's own code.
    const archive = Bun.spawn([context.definition?.git ?? "/usr/bin/git", "-C", project, "archive", "--format=tar", target], { stdout: "pipe", stderr: "inherit", env: context.env });
    const unpack = Bun.spawn(["/usr/bin/tar", "-x", "-C", stage], { stdin: archive.stdout, stdout: "inherit", stderr: "inherit" });
    if (await archive.exited !== 0 || await unpack.exited !== 0) throw new EntryError(`无法从目标提交 ${target.slice(0, 7)} 导出升级器`);
    setStage("target-upgrader");
    const code = await attached(["/bin/bash", join(stage, "scripts/upgrade.sh"), project, target, ...(action ? [action] : [])],
      { cwd: project, env: { ...context.env, MIXIN_OPS_BUN: process.execPath } });
    if (code !== 0 && existsSync(join(project, "data/state/upgrade-transaction")))
      warn(`升级未完成，事务已保留；处理上方原因后，可用 ${hint("resume")} 继续，或 ${hint("rollback")} 回滚（数据已提交时只能继续）。`);
    return code;
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); }
    catch { warn(`升级导出目录清理失败，保留 ${stage}`); }
  }
}

/** The pinned core of a transaction (its snapshot's host-runtime), when it is still there. */
function pinnedCore(project: string, pending: DeploymentState): string | null {
  const digest = pending.confirmation.text(`backup/snapshots/${pending.snapshot}/host-runtime`)?.trim();
  const path = digest && /^[a-f0-9]{64}$/.test(digest) ? join(project, ".console/runtime", `source-${digest}`, "ops/core/cli.ts") : "";
  return path && existsSync(path) ? path : null;
}

async function resumeUpgrade(context: Context, pending: DeploymentState, action: "continue" | "rollback"): Promise<number> {
  const { project } = context, target = pending.record.target_sha;
  if (!/^[0-9a-f]{40}$/.test(target)) throw new EntryError("升级事务缺少目标提交，请人工检查 backup/snapshots");
  if ((await git(context, ["cat-file", "-e", `${target}^{commit}`])).code === 0) return runTargetUpgrader(context, target, action);
  if (action === "continue") throw new EntryError(`事务记录的目标提交 ${target.slice(0, 7)} 在本地不存在，无法继续；请使用 ${hint("rollback")} 回滚`);
  const head = (await git(context, ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== pending.record.original_sha) throw new EntryError(`目标提交 ${target.slice(0, 7)} 在本地不存在，当前代码也不是升级前的 ${pending.record.original_sha.slice(0, 7)}；请人工检查 git 状态`);
  const pinned = pinnedCore(project, pending);
  if (!pinned) throw new EntryError(`目标提交 ${target.slice(0, 7)} 和事务固定的运维运行包都不在本地，无法回滚；请取回该提交（git fetch）后重试，服务和数据保持现状`);
  warn(`目标提交 ${target.slice(0, 7)} 在本地不存在；由事务固定的运维运行包回滚`);
  return attached([process.execPath, "--no-env-file", pinned, "deployment", "upgrade", "--project", project, "--original", pending.record.original_sha, "--target", target,
    "--branch", pending.record.original_branch, "--rollback", ...(context.definition?.git ? ["--git-path", context.definition.git] : [])], { cwd: project, env: context.env });
}

/** update, resume and rollback: an unfinished transaction first, then (for a fresh upgrade) origin/main or the confirmed commit. */
async function update(context: Context, confirmedTarget: string, action: "" | "continue" | "rollback", confirmation: string): Promise<number> {
  const { project, env } = context;
  if (confirmedTarget && !/^[0-9a-f]{40}$/.test(confirmedTarget)) throw new EntryError("已确认的升级目标必须是完整提交 SHA；请重新检查版本");
  const log = startLog(project, "upgrade");
  if (log.path && log.ownsLog && context.account) lchownSync(log.path, context.account.uid, context.account.gid);
  if (log.name) context.env = { ...env, BOT_OPERATION_LOG: log.name };
  setStage("upgrade-preflight");
  if (confirmation) {
    try { assertConfirmedTransaction(project, action || "continue", confirmation); }
    catch (error) { throw new EntryError(error instanceof Error ? error.message : "事务确认无效"); }
  }
  let pending: DeploymentState | null;
  try { pending = loadDeploymentState(project); }
  catch (error) { throw new EntryError(`未完成事务的记录无法读取：${(error as Error).message}；保持现状，请人工检查 backup/snapshots`); }
  if (pending) {
    if (confirmedTarget) throw new EntryError("预览后出现未完成的事务，请刷新后继续或回滚");
    const described = describePendingTransaction(pending);
    warn([described.subject, ...described.record].join("；"));
    const chosen = action || askTransactionAction();
    if (!chosen) { warn("未处理上次操作，服务保持当前状态"); return 1; }
    if (pending.operation === "upgrade") return resumeUpgrade(context, pending, chosen);
    return core(context, ["deployment", "deploy", ...(chosen === "rollback" ? ["--rollback"] : []), ...(confirmation ? ["--confirmation", confirmation] : []),
      ...(context.definition?.git ? ["--git-path", context.definition.git] : [])]);
  }
  if (action) {
    if (confirmation) throw new EntryError("确认后的事务已消失，请刷新预览");
    ok("没有未完成的部署或升级");
    return 0;
  }
  if (env.MIXIN_OPS_CONSOLE === "1" && !confirmedTarget) throw new EntryError("控制台升级缺少已确认目标，未拉取或停止服务");
  step("同步到 origin/main，由目标版本的升级器完成升级");
  if ((await git(context, ["rev-parse", "--is-inside-work-tree"])).code !== 0)
    throw new EntryError(`${project} 不是 git 仓库，无法自动更新；这份部署可能是解压得到的，请改用 git clone 重新部署后再使用 update`);
  // Tracked changes would be overwritten by the switch; untracked files are not touched, and data/ and logs/ are ignored.
  const dirty = await git(context, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0 || dirty.stdout.trim()) {
    fail("已跟踪文件有未提交的改动，已停止升级：");
    console.error(dirty.stdout.trimEnd().split("\n").map(line => "      " + line).join("\n"));
    warn("请先提交、撤销（git restore <文件>）或备份这些改动，然后重试");
    return 1;
  }
  let target = confirmedTarget;
  if (target) {
    const resolved = await git(context, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
    if (resolved.code !== 0 || resolved.stdout.trim() !== target) throw new EntryError("已确认的提交在本地不存在，请重新检查版本");
  } else {
    step("拉取 origin/main...");
    setStage("fetch");
    // As the checkout's owner, with their Git credentials: .git stays theirs.
    const operator = await checkoutOperator(project);
    const code = await attached([context.definition?.git ?? "/usr/bin/git", "-C", project, "fetch", "--prune", "origin", "refs/heads/main:refs/remotes/origin/main"],
      { cwd: project, env: { ...context.env, ...operator.env, GIT_TERMINAL_PROMPT: "0" }, ...(operator.identity ? { identity: operator.identity } : {}) });
    if (code !== 0) throw new EntryError("git fetch 失败");
    target = (await git(context, ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(target)) throw new EntryError("无法解析 origin/main；请确认远端存在 main 分支");
  }
  const code = await runTargetUpgrader(context, target, "");
  // A console task's result is the core's; on a terminal a restarted service gets a full check.
  if (code === 0 && !env.MIXIN_OPS_RESULT_FILE && await runState(project) === "running") return await doctor(context, [], false);
  return code;
}

async function doctor(context: Context, args: string[], allowFlags = true): Promise<number> {
  const json = allowFlags && args.includes("--json"), repair = allowFlags && args.includes("--repair");
  if (args.some(arg => !["--json", "--repair"].includes(arg)) || json && repair) throw new EntryError("用法：doctor [--json | --repair]", 2);
  const report = () => doctorReport({ project: context.project, bun: serviceBun(context), path: servicePath(context), env: context.env });
  if (json) {
    silence();
    const result = await report();
    console.log(JSON.stringify(result));
    return result.fail > 0 ? 1 : 0;
  }
  let healthy = printDoctor(await report());
  if (!repair) return healthy ? 0 : 1;
  console.log("");
  const repaired = await core(context, ["service", "repair"]);
  console.log("");
  healthy = printDoctor(await report());
  return repaired === 0 && healthy ? 0 : 1;
}

/** The wizards fill a private stage while the bot keeps running; the core then applies it like a console configuration. */
async function configure(context: Context, command: string): Promise<number> {
  const [label, wizard, kind] = WIZARDS[command]!;
  const account = needAccount(context);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new EntryError(`${label}需要在终端里运行向导；配置和服务保持原状`);
  if (["deploy-transaction", "upgrade-transaction"].some(name => existsSync(join(context.project, "data/state", name))))
    throw new EntryError(`有未完成的部署或升级；请先用 ${hint("resume")} 继续，或 ${hint("rollback")} 回滚`);
  mkdirSync(join(context.project, "tmp"), { recursive: true, mode: 0o755 });
  const stage = mkdtempSync(join(context.project, "tmp", "configure-stage-"));
  try {
    lchownSync(stage, account.uid, account.gid);
    const bun = serviceBun(context);
    const code = await attached([bun, "--no-env-file", "run", join(context.project, "ops/config", wizard), "--stage", stage],
      { cwd: context.project, env: { ...accountEnvironment(context.project, bun), PATH: servicePath(context) }, identity: account });
    const staged = join(stage, `configuration-${kind}.json`);
    if (!existsSync(staged)) {
      if (code === 0 || code === 2) { warn(`${label}已取消；配置和服务保持原状`); return 0; }
      fail(`${label}未完成（原因见上方）；配置和服务保持原状`);
      return 1;
    }
    return await core(context, ["maintenance", "configuration-apply", "--stage", staged]);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

async function foreground(context: Context): Promise<number> {
  const service = new LaunchdPlatform(context.project), facts = await service.inspect();
  if (facts.state === "running") throw new EntryError(`LaunchDaemon 正在运行；请先使用 ${hint("stop")}，再切换到前台模式`);
  if (facts.leftovers > 0) throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 已有进程在运行（前台机器人或残留进程）；请先结束它们`);
  if (!context.definition || !facts.owned) throw new EntryError(`没有本项目的服务定义；请先使用 ${hint("deploy")}`);
  step("以前台方式运行机器人（Ctrl+C 停止）；启动 LaunchDaemon 时会先结束它...");
  // Exactly what the LaunchDaemon runs, as its account and with its environment.
  const code = await attached(context.definition.args, { cwd: context.definition.directory,
    env: { ...context.definition.env, ...(context.env.TERM ? { TERM: context.env.TERM } : {}) }, identity: needAccount(context) });
  return code === 0 || code === 130 ? 0 : code;
}

async function uninstall(context: Context): Promise<number> {
  const { project } = context;
  step("卸载 mixin-bot");
  let lock;
  try { lock = acquireDeploymentLock(project); }
  catch (error) { if (error instanceof DeploymentBusy) throw new EntryError("部署、升级或另一个维护操作正在进行；卸载未开始"); throw error; }
  try {
    try { assertUninstallable(project); }
    catch (error) { throw new EntryError(error instanceof Error ? error.message : String(error)); }
    const service = new LaunchdPlatform(project), facts = await service.inspect();
    if (!facts.owned) throw new EntryError("LaunchDaemon 属于其他目录或其他账户；卸载已停止");
    if (facts.state !== "absent" || facts.leftovers > 0) {
      try { await service.halt(); }
      catch (error) { throw new EntryError(`停止机器人失败（${(error as Error).message}）；为避免删除仍在使用的数据，卸载已停止`); }
    }
    if (facts.state !== "absent") { unlinkSync(service.plist); ok("LaunchDaemon 已删除"); }
    else warn("没有可删除的 LaunchDaemon");
    if (askYesNo("是否删除 data/（配置、部署状态、runtime、默认共享资料、会话、临时文件和统计）和 logs/？[y/N] ", false, context.env)) {
      // Moved aside under backup/rm, never deleted: same volume, one rename each.
      const archive = join(project, "backup/rm");
      for (const name of ["data", "logs"]) {
        const path = join(project, name);
        if (!existsSync(path)) continue;
        mkdirSync(archive, { recursive: true });
        renameSync(path, join(archive, `${Math.floor(Date.now() / 1000)}-${randomBytes(4).toString("hex")}-${basename(path)}`));
      }
      ok("data/ 和 logs/ 已移入 backup/rm");
    } else ok("已保留 data/ 和 logs/（配置、状态、资料、会话与统计保留）");
    let workspace = "";
    try { workspace = (await Bun.file(join(project, "data/state/workspace-root")).text()).trim(); } catch { workspace = ""; }
    if (workspace) warn(`外置共享资料目录不属于本项目，未删除：${workspace}`);
    if (context.account) warn(`服务账户 ${SERVICE_ACCOUNT} 已保留（data/ 及其归档仍属于它）；不再需要时：sudo dscl . -delete /Users/${SERVICE_ACCOUNT} 和 sudo dscl . -delete /Groups/${SERVICE_ACCOUNT}`);
    ok("卸载流程完成。");
    return 0;
  } finally { lock.close(); }
}

function help(): void {
  console.log(`mixin-bot 运维工具（macOS，实验性支持）
用法：sudo ./scripts/ops.sh <命令>；部署：sudo ./scripts/deploy.sh
运维控制台：在项目根目录运行 sudo bun run console，在浏览器中打开。

  doctor     健康检查：共享资料目录、LaunchDaemon、本机端口、版本、事件 Stream、通讯录同步、配置
             加 --json 输出单行 JSON，供控制台使用；加 --repair 在本机实例未就绪时重启
  deploy     配置并部署当前代码；已有部署可重建，失败自动回滚
  update     同步 origin/main，停机前检查部署记录与配置，停机后切换并验证；提交前失败自动回滚
             沿用现有端口、共享资料目录、应用凭据和 AI 配置；改配置请用 deploy
  resume     按事务记录继续中断的部署或升级（不重新提问）
  rollback   回滚中断的部署或升级；数据已提交时只能继续
  restart    停止并重新启动机器人
  stop       停止机器人（LaunchDaemon 保持禁用，开机也不启动）
  start      启动机器人
  repair     本机实例未就绪时重新启动它
  foreground 以前台方式运行机器人（Ctrl+C 停止）
  logs       持续查看 logs/mixin-bot.log
  relay-configure | model-configure | configure-app-bot
             配置向导；填写期间机器人照常运行，确认后短暂停机应用并恢复原运行状态，失败时恢复原配置
  runtime-configure <草稿名>  应用控制台「设置」中已确认的高级运行参数
  directory  查看事件 Stream 与通讯录同步状态
  directory-scope [all]  修改同步范围并应用：不带参数时在终端里逐层勾选部门，带 all 时同步整个通讯录
  relay-ls | relay-test | relay-purge <关键字>|--all   大文件外链的列出、验收与清理
  tmp-ls | tmp-preview | tmp-purge | tmp-reclaim | tmp-discard   临时文件（参数同 Linux 的 ops.sh）
  stat [群号|direct] [--period …|--since <日期> --until <日期>]   使用统计
  stat-import <账本路径>  把已保存的统计账本恢复到空账本
  history-ls | history-clear <群号>|--direct|--all | history-compact <群号>|--direct <成员号码>
  maintenance-recover  回收中断的维护写入者并恢复原运行状态；不重复数据动作
  backup-scan | backup-clean <报告名> [--confirm <确认码>]
  uninstall  停止并删除 LaunchDaemon（可选归档 data/、logs/）`);
}

async function ops(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command = "", ...rest] = args;
  if (["", "help", "-h", "--help"].includes(command)) { help(); return 0; }
  const known = ["deploy", "repair", "doctor", "status", "update", "upgrade", "resume", "rollback", "start", "stop", "restart", "logs", "foreground", "run-foreground",
    "directory", "directory-scope", "stat", "history-ls", "maintenance-recover", "uninstall", ...MAINTENANCE, ...Object.keys(WIZARDS)];
  if (!known.includes(command)) { fail(`无法识别的命令：${command}`); help(); return 1; }
  requireRoot(`${command} `);
  const project = resolve(env.MIXIN_OPS_PROJECT || SOURCE);
  trustCheckout(project);
  const definition = await new LaunchdPlatform(project).serviceDefinition().catch(() => null);
  const context: Context = { project, env: { ...process.env }, definition, account: await accountIdentity(SERVICE_ACCOUNT) };
  const transaction = (action: "continue" | "rollback") => {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--confirmed-transaction" || !rest[1])) throw new EntryError("事务确认参数无效");
    return lifecycle(context, command, () => update(context, "", action, rest[1] ?? ""));
  };
  switch (command) {
    case "deploy":
      if (rest.length) throw new EntryError("deploy 不接受参数；端口和共享资料目录用 BOT_PORT、WORKSPACE_ROOT 设置", 2);
      return env.MIXIN_OPS_CONSOLE === "1" ? lifecycle(context, command, () => deployEntry(project, "deploy", env)) : deployEntry(project, "deploy", env);
    case "repair": return core(context, ["service", "repair", ...rest]);
    case "doctor": case "status": return doctor(context, rest);
    case "update": case "upgrade":
      if (rest.length > 1) throw new EntryError("用法：update [已确认的目标提交]", 2);
      return lifecycle(context, command, () => update(context, rest[0] ?? "", "", ""));
    case "resume": return transaction("continue");
    case "rollback": return transaction("rollback");
    case "start": case "stop": case "restart": return core(context, ["service", command, ...rest]);
    case "maintenance-recover": return core(context, ["maintenance-recover", ...rest]);
    case "logs": {
      const log = join(project, "logs/mixin-bot.log");
      if (!existsSync(log)) throw new EntryError(`找不到日志文件 ${log}（机器人可能从未启动）`);
      step("持续查看 logs/mixin-bot.log（Ctrl+C 退出）");
      const code = await attached(["/usr/bin/tail", "-n", "50", "-F", log], { cwd: project, env });
      return code === 130 ? 0 : code;
    }
    case "foreground": case "run-foreground": return foreground(context);
    case "directory": return dataTool(context, "ops/tools/directory-admin.ts", ["status", ...rest]);
    case "directory-scope": return dataTool(context, "ops/tools/directory-admin.ts", ["scope", ...rest]);
    case "stat": return dataTool(context, "ops/tools/stats-admin.ts", rest);
    case "history-ls": return dataTool(context, "ops/tools/history-admin.ts", ["list", ...rest]);
    case "uninstall": return uninstall(context);
  }
  if (WIZARDS[command]) return configure(context, command);
  return core(context, ["maintenance", command, ...rest]);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [entry, ...rest] = argv;
  try {
    if (process.platform !== "darwin") throw new EntryError("这个入口只用于 macOS");
    if (entry === "ops") return await ops(rest, env);
    if (entry === "upgrade") return await upgradeEntry(rest, env);
    if (entry === "deploy") {
      const command = rest[0] ?? "deploy";
      if (rest.length > 1 || command !== "deploy" && command !== "repair") throw new EntryError("用法：sudo ./scripts/deploy.sh [deploy|repair]", 2);
      if (command === "repair") return await ops(["repair"], env);
      return await ops(["deploy"], env);
    }
    throw new EntryError("用法：macos-entry.ts deploy|ops|upgrade …", 2);
  } catch (error) {
    if (!(error instanceof EntryError)) throw error;
    fail(error.message);
    return error.code;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
