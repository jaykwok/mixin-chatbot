// macOS deploy entry, and the target release's upgrader. Like deploy.ps1 and upgrade.ps1: everything that needs a question or
// a check happens while the old service keeps running (tools, service account, port, shared files, data version, the
// configuration wizards, the directory scope, the runtime values); the shared core (ops/core/cli.ts) then rechecks it all
// under deploy.lock and owns the stop, the transaction, its recovery and the result.
// Runs as root. Data tools and wizards run as the service account, Git and dependency installs as the checkout's owner.
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensureServiceAccount } from "./macos-account.ts";
import { accountIdentity, LaunchdPlatform, SERVICE_ACCOUNT, serviceEnvironment, trustCheckout, type Identity } from "./launchd-host.ts";
import { serializeMacosTools, SERVICE_DIRECTORIES, type MacosTools } from "./macos-deployment.ts";
import { checkoutOperator } from "./macos-lifecycle.ts";
import { attached, captured, EntryError, event, fail, hint, ok, requireRoot, setStage, SOURCE, startLog, step, warn, askYesNo } from "./macos-terminal.ts";

const BUN_MINIMUM = [1, 4, 4];
const UNCHANGED = "服务尚未停止，未做任何改动";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Paths under these keep a LaunchDaemon out (home directories are not readable to others; the rest is under privacy control). */
const UNREACHABLE = /^\/Users\/[^/]+\/(Desktop|Documents|Downloads|Library|Movies|Music|Pictures)(\/|$)/;

/** An account's view of one command: through macos-become.ts, with the service's environment. */
async function asAccount(account: Identity, project: string, argv: string[]) {
  return captured([process.execPath, "--no-env-file", join(SOURCE, "ops/core/macos-become.ts"), String(account.uid), String(account.gid), "--", ...argv],
    { cwd: "/", env: { ...serviceEnvironment(project), PATH: SYSTEM_PATH } });
}
/** The environment of a data tool or wizard on this terminal, as the service account. */
export function accountEnvironment(project: string, bun: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...serviceEnvironment(project), PATH: `${dirname(bun)}:${SYSTEM_PATH}`, ...extra };
}

const versionAtLeast = (text: string, minimum: number[]) => {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
  if (!parts) return false;
  for (let index = 0; index < minimum.length; index++) if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  return true;
};

/**
 * The tools the LaunchDaemon runs, found before the stop and recorded as absolute paths: each must work for the service
 * account, which cannot enter the operator's home. Homebrew's are the expected ones.
 */
export async function findMacosTools(project: string, account: Identity): Promise<MacosTools> {
  const works = async (candidates: (string | null | undefined)[], args: string[], accept: (text: string) => boolean) => {
    for (const candidate of [...new Set(candidates.filter((path): path is string => !!path && isAbsolute(path)))]) {
      if (!existsSync(candidate)) continue;
      const result = await asAccount(account, project, [candidate, ...args]);
      if (result.code === 0 && accept(result.stdout)) return candidate;
    }
    return null;
  };
  const bun = await works([Bun.which("bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun", process.execPath], ["--version"], text => versionAtLeast(text, BUN_MINIMUM));
  if (!bun) throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 无法运行 Bun 1.4.4 或更高版本（装在个人目录里的 Bun 它进不去）。请用 Homebrew 安装：brew install oven-sh/bun/bun`);
  const xcode = (await captured(["/usr/bin/xcode-select", "-p"])).code === 0;
  const git = await works(["/opt/homebrew/bin/git", "/usr/local/bin/git", xcode ? "/usr/bin/git" : null], ["--version"], text => /^git version /.test(text));
  if (!git) throw new EntryError("缺少 git：brew install git（或安装 Xcode 命令行工具：xcode-select --install）");
  const uv = await works([Bun.which("uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"], ["--version"], text => /^uv /.test(text));
  if (!uv) throw new EntryError("缺少 uv（agent 的 Python 工具需要它）：brew install uv");
  const bash = await works(["/opt/homebrew/bin/bash", "/usr/local/bin/bash"], ["--version"], text => /GNU bash, version (\d+)/.test(text) && Number(/version (\d+)/.exec(text)![1]) >= 5);
  if (!bash) throw new EntryError("缺少 bash 5（系统自带的是 3.2，agent 的 bash 工具需要 5 或更高）：brew install bash");
  const coreutils = ["/opt/homebrew/opt/coreutils/libexec/gnubin", "/usr/local/opt/coreutils/libexec/gnubin"];
  let gnubin: string | null = null;
  for (const directory of coreutils) if (await works([join(directory, "ls")], ["--version"], text => text.includes("GNU coreutils"))) { gnubin = directory; break; }
  if (!gnubin) throw new EntryError("缺少 GNU coreutils（agent 的命令按 GNU 的参数写）：brew install coreutils");
  return { format: "1", bun, git, uv, bash, coreutils: gnubin };
}

/** The checkout must be readable to the service account all the way down: it runs this code. */
export async function checkProjectAccess(project: string, account: Identity): Promise<void> {
  const root = resolve(project);
  if (UNREACHABLE.test(root)) throw new EntryError(`项目在 ${root}：LaunchDaemon 进不去个人目录下的「桌面」「文稿」「下载」等受保护位置。请把检出放到例如 /opt/mixin-bot（属主为你自己，权限 755），再从那里部署`);
  const probe = await asAccount(account, root, ["/bin/test", "-r", join(root, "package.json"), "-a", "-r", join(root, "src/server/index.ts"), "-a", "-x", join(root, "src")]);
  if (probe.code !== 0) throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 读不到 ${root} 中的代码（多半是某一级目录不允许其他用户进入，例如个人目录）。请把检出放到例如 /opt/mixin-bot（属主为你自己，权限 755），或放宽沿途目录的权限后重试；${UNCHANGED}`);
}

/**
 * The directories the service writes belong to the service account. Missing ones are created for it; existing ones that are
 * not its own (data restored by hand, or created by an earlier root process) are handed over after a question.
 */
export function prepareServiceData(project: string, account: Identity, deployed: boolean): void {
  const foreign = SERVICE_DIRECTORIES.filter(relative => {
    try { const info = lstatSync(join(project, relative)); return info.isSymbolicLink() || !info.isDirectory() || info.uid !== account.uid; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  for (const relative of foreign) {
    const info = lstatSync(join(project, relative));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new EntryError(`${relative} 不是目录（或是链接），无法交给服务账户；${UNCHANGED}`);
  }
  const top = [...new Set(foreign.map(relative => relative.split("/")[0]!))];
  if (top.length) {
    if (deployed) warn(`${top.join("、")} 中有不属于服务账户 ${SERVICE_ACCOUNT} 的目录`);
    if (!askYesNo(`把 ${top.map(name => name + "/").join("、")} 整个交给服务账户 ${SERVICE_ACCOUNT}（chown -R）？[Y/n] `, true)) throw new EntryError(`数据目录不属于服务账户，未部署；${UNCHANGED}`);
    for (const name of top) {
      const result = Bun.spawnSync(["/usr/sbin/chown", "-R", "-h", `${account.uid}:${account.gid}`, join(project, name)], { stdout: "inherit", stderr: "inherit" });
      if (result.exitCode !== 0) throw new EntryError(`无法把 ${name}/ 交给服务账户；${UNCHANGED}`);
    }
    ok(`${top.map(name => name + "/").join("、")} 已交给服务账户 ${SERVICE_ACCOUNT}`);
  }
  for (const relative of SERVICE_DIRECTORIES) {
    const path = join(project, relative);
    if (existsSync(path)) continue;
    mkdirSync(path, { mode: 0o700 });
    lchownSync(path, account.uid, account.gid);
  }
}

/** A private directory under tmp/ for one run, owned by the service account whose tools write into it. */
function accountStage(project: string, prefix: string, account: Identity): string {
  mkdirSync(join(project, "tmp"), { recursive: true, mode: 0o755 });
  const stage = mkdtempSync(join(project, "tmp", prefix));
  chmodSync(stage, 0o700);
  lchownSync(stage, account.uid, account.gid);
  return stage;
}

function pendingPointer(project: string): string | null {
  for (const [pointer, noun] of [["deploy-transaction", "部署"], ["upgrade-transaction", "升级"]] as const)
    if (existsSync(join(project, "data/state", pointer))) return noun;
  return null;
}

/** Fresh console operations carry explicit choices (deployment-options.ts sets them); recovery uses the transaction instead. */
export function assertConsoleLifecycle(operation: "deploy" | "update", project: string, branch = "main", env: NodeJS.ProcessEnv = process.env): void {
  if (env.MIXIN_OPS_CONSOLE !== "1") return;
  if (env.MIXIN_OPS_LIFECYCLE !== operation || !env.MIXIN_OPS_TASK_ID) throw new EntryError("控制台部署缺少明确选择或任务记录；服务尚未停止");
  if (!["0", "1"].includes(env.MIXIN_OPS_SWITCH_MAIN ?? "")) throw new EntryError("必须明确选择是否允许切换分支；服务尚未停止");
  if (operation === "update" && branch !== "main" && env.MIXIN_OPS_SWITCH_MAIN !== "1") throw new EntryError("未允许切换到 main；服务尚未停止");
  const saved = existsSync(join(project, "data/config/directory.json"));
  switch (env.MIXIN_OPS_DIRECTORY) {
    case "saved": if (!saved || env.BOT_DIRECTORY_SCOPE) throw new EntryError("已保存的通讯录范围与确认不符；服务尚未停止"); break;
    case "all": if (saved || env.BOT_DIRECTORY_SCOPE !== "all") throw new EntryError("首次通讯录范围与确认不符；服务尚未停止"); break;
    case "selected": if (saved || env.BOT_DIRECTORY_SCOPE || !env.MIXIN_OPS_DIRECTORY_INPUT || !env.MIXIN_OPS_DIRECTORY_APP) throw new EntryError("部门选择与确认不符；服务尚未停止"); break;
    default: throw new EntryError("必须明确选择通讯录范围；服务尚未停止");
  }
  for (const required of ["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json"])
    if (!existsSync(join(project, required))) throw new EntryError("缺少已有配置，请先完成首次部署；服务尚未停止");
}

const portInUse = (port: number) => new Promise<boolean>(done => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const finish = (value: boolean) => { socket.destroy(); done(value); };
  socket.setTimeout(2000, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});
const readState = (project: string, name: string) => { try { return readFileSync(join(project, "data/state", name), "utf8").trim(); } catch { return null; } };

/** The local management port, not asked: an explicit BOT_PORT, else the saved one, else 10000. A new port must be free. */
async function choosePort(project: string, env: NodeJS.ProcessEnv): Promise<number> {
  const saved = readState(project, "bot-port");
  const [raw, source] = env.BOT_PORT?.trim() ? [env.BOT_PORT.trim(), "BOT_PORT"] : saved !== null ? [saved, "data/state/bot-port"] : ["10000", ""];
  const fix = `改端口：sudo BOT_PORT=<端口> ./scripts/ops.sh deploy；${UNCHANGED}`;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new EntryError(`${source || "默认值"} 中的端口无效（应为 1–65535 的整数）：${raw}；${fix}`);
  // A kept port may be the running service's own: only a new one is probed.
  if (String(port) !== saved && await portInUse(port)) throw new EntryError(`本机端口 ${port} 已被其他程序占用；${fix}`);
  ok(`本机管理端口：127.0.0.1:${port}${source ? `（来自 ${source}）` : ""}`);
  return port;
}

/** Default data/workspace, or an existing external directory the service account can read (WORKSPACE_ROOT, else the saved one). */
async function chooseWorkspace(project: string, account: Identity, env: NodeJS.ProcessEnv): Promise<{ external: string; final: string }> {
  const fallback = join(project, "data/workspace"), request = env.WORKSPACE_ROOT?.trim() || readState(project, "workspace-root") || "";
  let external = "";
  if (request) {
    const candidate = resolve(project, request);
    if (candidate !== fallback) {
      if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) throw new EntryError(`共享资料目录不存在或不是目录：${candidate}；外置资料目录必须已存在；${UNCHANGED}`);
      if ((await asAccount(account, project, ["/bin/test", "-r", candidate, "-a", "-x", candidate])).code !== 0)
        throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 读不到共享资料目录 ${candidate}；请放宽它（及沿途目录）的权限；${UNCHANGED}`);
      external = candidate;
    }
  }
  ok(`共享资料目录：${external ? `${external}（外置，服务只读）` : `${fallback}（默认）`}`);
  return { external, final: external || fallback };
}

/** A tool of the project run on this terminal as the service account; returns its exit code. */
function projectTool(project: string, bun: string, account: Identity, script: string, args: string[], extra: Record<string, string> = {}): Promise<number> {
  return attached([bun, "--no-env-file", "run", script, ...args], { cwd: project, env: accountEnvironment(project, bun, extra), identity: account });
}

async function stagedWizard(project: string, bun: string, account: Identity, stage: string, label: string, wizard: string, staged: string): Promise<void> {
  if (!process.stdin.isTTY) throw new EntryError(`${label}需要在终端里运行向导；${UNCHANGED}`);
  step(`${label}（回答先暂存，停止服务后写入）...`);
  setStage(label);
  const code = await projectTool(project, bun, account, join(project, "ops/config", wizard), ["--stage", stage]);
  if (code !== 0 || !existsSync(join(stage, staged))) throw new EntryError(`配置未完成（取消或失败，原因见上方）；${UNCHANGED}`);
}

async function chooseDirectoryScope(project: string, bun: string, account: Identity, script: string, plan: string, app = ""): Promise<void> {
  setStage("directory-scope");
  rmSync(plan, { force: true });
  const code = await projectTool(project, bun, account, script, ["choose", "--plan", plan, "--project", project, ...(app ? ["--app", app] : [])]);
  if (code === 2) throw new EntryError(`已取消选择通讯录同步范围；${UNCHANGED}`);
  if (code !== 0 || !existsSync(plan)) throw new EntryError(`没有选定通讯录同步范围（原因见上方）；${UNCHANGED}`);
}

/** Removes deploy stages a killed run left behind (they hold app credentials); younger ones may belong to a running deployment. */
function removeStaleStages(project: string): void {
  const directory = join(project, "tmp");
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!/^(deploy|configure)-stage-[A-Za-z0-9]{6,}$/.test(name)) continue;
    const info = lstatSync(join(directory, name));
    if (info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < Date.now() - 86_400_000) rmSync(join(directory, name), { recursive: true, force: true });
  }
}

const coreArgs = (...args: string[]) => [process.execPath, "--no-env-file", join(SOURCE, "ops/core/cli.ts"), ...args];
/** The core on this terminal, as root. */
export function runCore(project: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return attached(coreArgs(...args), { cwd: project, env });
}

/** deploy (and the console's deploy): prepare while the service runs, then hand the stage to the core. */
export async function deployEntry(project: string, command: "deploy" | "repair", env: NodeJS.ProcessEnv = process.env): Promise<number> {
  requireRoot("部署");
  trustCheckout(project);
  step("检查运行环境...");
  for (const required of ["package.json", "src/server/index.ts", "ops/config/configure.ts"])
    if (!existsSync(join(project, required))) throw new EntryError(`缺少必要文件：${required}`);
  const pending = pendingPointer(project);
  if (pending) throw new EntryError(`发现未完成的${pending}。续做和回滚只使用事务记录，不重新部署；请使用 ${hint("resume")} 继续，或 ${hint("rollback")} 回滚。`);
  assertConsoleLifecycle("deploy", project, "main", env);
  const service = new LaunchdPlatform(project), deployed = (await service.inspect()).state !== "absent";
  let account = await accountIdentity(SERVICE_ACCOUNT);
  if (!account) {
    if (env.MIXIN_OPS_CONSOLE === "1") throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 不存在；请先在终端里完成首次部署`);
    const made = await ensureServiceAccount();
    account = made.identity;
    ok(`已创建服务账户 ${SERVICE_ACCOUNT}（UID/GID ${account.uid}，无登录、无密码、不在登录窗口显示）`);
  } else ok(`服务账户：${SERVICE_ACCOUNT}（UID ${account.uid}）`);
  await checkProjectAccess(project, account);
  const tools = await findMacosTools(project, account);
  ok(`已找到 bun（${tools.bun}）、git（${tools.git}）、uv（${tools.uv}）、bash（${tools.bash}）和 GNU coreutils（${tools.coreutils}）`);
  prepareServiceData(project, account, deployed);
  const log = startLog(project, "deploy");
  if (log.path && log.ownsLog) { lchownSync(log.path, account.uid, account.gid); ok(`本次操作日志：logs/operations/${log.name}`); }
  const childEnv = { ...env, ...(log.name ? { BOT_OPERATION_LOG: log.name } : {}) };

  // deploy.lock, ops tasks and the service's ownership are checked once read-only before anything is asked; the core repeats it under the lock.
  setStage("deploy-preflight");
  if (await runCore(project, ["deployment", "deploy", "--project", project, "--preflight", "--git-path", tools.git], childEnv) !== 0)
    throw new EntryError(`部署预检未通过（原因见上方）；${UNCHANGED}`);
  removeStaleStages(project);
  // The checks before the stop and the wizards need the dependencies: a first deployment installs them now (nothing runs yet).
  if (!existsSync(join(project, "node_modules"))) {
    step("首次部署：先安装依赖（bun install --frozen-lockfile），供停机前的核对和配置向导使用...");
    const operator = await checkoutOperator(project);
    const code = await attached([tools.bun, "install", "--frozen-lockfile"], { cwd: project, env: { ...childEnv, ...operator.env, PATH: `${dirname(tools.bun)}:${dirname(tools.git)}:${SYSTEM_PATH}` },
      ...(operator.identity ? { identity: operator.identity } : {}) });
    if (code !== 0) throw new EntryError(`bun install 执行失败（退出码 ${code}）；${UNCHANGED}`);
  }
  const port = await choosePort(project, env);
  const workspace = await chooseWorkspace(project, account, env);

  const stage = accountStage(project, "deploy-stage-", account);
  try {
    const config = (name: string) => existsSync(join(project, "data", name));
    const dataTool = join(project, "ops/tools/data-current.ts");
    if (config("config/models.json") && config("runtime/pi/settings.json") && config("config/app-bot.json")) {
      // Complete configuration is checked before the stop; the plan's marker digest is what the core applies after it.
      setStage("data-preparation-preview");
      if (await projectTool(project, tools.bun, account, dataTool, ["preview", "--project", project, "--plan", join(stage, "data-plan.json"), "--workspace", workspace.final], { BOT_OPERATION_LOG: log.name ?? "" }) !== 0)
        throw new EntryError(`数据版本或配置校验未通过（原因见上方）；${UNCHANGED}`);
    } else if (await projectTool(project, tools.bun, account, dataTool, ["check", "--project", project, "--workspace", workspace.final], { BOT_OPERATION_LOG: log.name ?? "" }) !== 0)
      throw new EntryError(`数据版本核对未通过（原因见上方）；${UNCHANGED}`);
    if (env.MIXIN_OPS_CONSOLE === "1") ok("沿用网页确认的模型与机器人配置");
    else if (!config("config/models.json") || !config("runtime/pi/settings.json")) {
      // Without the app bot's configuration this wizard asks for it first.
      await stagedWizard(project, tools.bun, account, stage, "首次配置 AI（provider/key/model）", "configure.ts", "configuration-models.json");
    } else {
      if (!config("config/app-bot.json")) await stagedWizard(project, tools.bun, account, stage, "配置应用机器人凭据（AppID/AppSecret）", "configure-app-bot.ts", "configuration-app.json");
      ok("data/config/models.json 已存在");
      if (askYesNo("是否重新配置 AI（provider/key/model）？[y/N] ", false, env))
        await stagedWizard(project, tools.bun, account, stage, "重新配置 AI（provider/key/model）", "configure.ts", "configuration-models.json");
    }
    const stagedApp = join(stage, "configuration-app.json");
    if (!config("config/app-bot.json") && !existsSync(stagedApp)) throw new EntryError(`没有得到应用机器人凭据（AppID/AppSecret）；${UNCHANGED}`);
    if (!config("config/directory.json"))
      await chooseDirectoryScope(project, tools.bun, account, join(project, "ops/config/directory-scope.ts"), join(stage, "directory-scope-plan.json"), existsSync(stagedApp) ? stagedApp : "");
    // runtime.json as the deployment installs it: the current file plus the supported keys set in this environment.
    setStage("runtime-values");
    if (await projectTool(project, tools.bun, account, join(project, "ops/config/runtime-settings.ts"), ["--prepare-values", join(stage, "runtime-values.json"), "--deployment", "native"],
      { BOT_PORT: String(port), BOT_HOST: "127.0.0.1", WORKSPACE_ROOT: workspace.final }) !== 0) throw new EntryError(`运行参数校验未通过（原因见上方）；${UNCHANGED}`);
    const head = await captured([tools.git, "-C", project, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const target = head.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.stdout.trim()) ? head.stdout.trim() : "";
    writeFileSync(join(stage, "deployment.json"), JSON.stringify({ format: 1, target, port, workspace: workspace.external }) + "\n", { mode: 0o600 });
    writeFileSync(join(stage, "macos-tools"), serializeMacosTools(tools), { mode: 0o600 });

    setStage("shared-deployment-core");
    step("交给运维核心：在部署锁内复核后记录事务并停止机器人服务；此后写入配置、安装依赖、迁移和验证期间服务保持停止");
    const code = await runCore(project, ["deployment", "deploy", "--project", project, "--stage", stage, "--command", command, "--git-path", tools.git], childEnv);
    if (code !== 0) {
      if (pendingPointer(project)) fail(`部署未完成，事务已保留（原因见上方）；处理后可用 ${hint("resume")} 继续，或 ${hint("rollback")} 回滚（数据已提交时只能继续）。`);
      return code;
    }
    ok(`机器人已启动（共享资料目录=${workspace.final}）。停止请用 ${hint("stop")}；日志：${hint("logs")}`);
    ok("消息接收：平台事件 Stream（主动连出 imtwo.zdxlz.com、imfl.zdxlz.com 的 443 端口，无需入站端口或公网域名）。");
    ok(`可选大文件外链：不超过 30 MiB 的文件直接发送；更大的文件需要外链，用 ${hint("relay-configure")} 按需启用。`);
    return 0;
  } finally {
    // Only this run's stage; the transaction snapshot has its own copies.
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * The target release's upgrader (scripts/upgrade.sh on macOS), exported from the target commit to tmp/upgrade-* by the
 * current release's update. A fresh upgrade previews the data with the target's code before the core stops anything.
 */
export async function upgradeEntry(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [projectArgument, target, action = ""] = argv;
  if (!projectArgument || !target || argv.length > 3 || !["", "continue", "rollback"].includes(action) || !/^[0-9a-f]{40}$/.test(target))
    throw new EntryError("用法：bash <导出目录>/scripts/upgrade.sh <项目目录> <目标提交> [continue|rollback]", 2);
  const project = resolve(projectArgument);
  if (resolve(SOURCE) === project) throw new EntryError("升级器需要从目标提交导出后运行（ops.sh update 会自动导出），不能在工作区内直接执行", 2);
  requireRoot("升级");
  trustCheckout(project);
  const log = startLog(project, "upgrade");
  const account = await accountIdentity(SERVICE_ACCOUNT);
  if (!account) throw new EntryError(`服务账户 ${SERVICE_ACCOUNT} 不存在；请先部署`);
  const service = await new LaunchdPlatform(project).serviceDefinition();
  const git = service?.git, bun = env.MIXIN_OPS_BUN || process.execPath;
  if (!git) throw new EntryError("LaunchDaemon 的定义里没有 git 路径；请先部署");
  const read = async (...args: string[]) => {
    const result = await captured([git, "-C", project, ...args]);
    if (result.code !== 0) throw new EntryError(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const original = await read("rev-parse", "HEAD"), branch = await read("rev-parse", "--abbrev-ref", "HEAD");
  const core = ["deployment", "upgrade", "--project", project, "--original", original, "--target", target, "--branch", branch, "--git-path", git];
  if (action === "rollback") core.push("--rollback");
  const childEnv = { ...env, ...(log.name ? { BOT_OPERATION_LOG: log.name } : {}) };
  let plans = "";
  try {
    if (!existsSync(join(project, "data/state/upgrade-transaction")) && action !== "rollback") {
      assertConsoleLifecycle("update", project, branch, env);
      if (!existsSync(join(project, "data/config/app-bot.json"))) throw new EntryError("缺少 data/config/app-bot.json；升级沿用已有应用机器人配置，请先完成部署。服务尚未停止。");
      const saved = readState(project, "workspace-root");
      if (saved && !existsSync(saved)) throw new EntryError("共享资料目录不存在；服务尚未停止。");
      plans = accountStage(project, "upgrade-plan-", account);
      const plan = join(plans, "data-plan.json");
      setStage("data-preparation-preview");
      if (await projectTool(project, bun, account, join(SOURCE, "ops/tools/data-current.ts"), ["preview", "--project", project, "--plan", plan, "--upgrade", "--workspace", saved || join(project, "data/workspace")],
        { BOT_OPERATION_LOG: log.name ?? "" }) !== 0) throw new EntryError("数据版本或配置校验未通过；旧服务尚未停止。");
      // The core repeats these rules under deploy.lock; checking first means nothing is asked when main, the service or the switch refuse.
      setStage("upgrade-preflight");
      if (await runCore(project, [...core, "--preflight"], childEnv) !== 0) throw new EntryError("升级预检未通过（原因见上方）；旧服务尚未停止。");
      core.push("--plan", plan);
      if (!existsSync(join(project, "data/config/directory.json"))) {
        const scope = join(plans, "directory-scope-plan.json");
        await chooseDirectoryScope(project, bun, account, join(SOURCE, "ops/config/directory-scope.ts"), scope);
        core.push("--directory-plan", scope);
      }
    }
    setStage("shared-deployment-core");
    return await runCore(project, core, childEnv);
  } finally {
    if (plans) rmSync(plans, { recursive: true, force: true });
    event("info", "upgrader finished");
  }
}
