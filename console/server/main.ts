#!/usr/bin/env bun
// Frozen runtime entry: the on-demand web console on 127.0.0.1. It lives only as long as this terminal; Ctrl+C, closing the
// terminal or the SSH session ending closes the port and ends every browser session.
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cliArgs } from "../../ops/lib/cli.ts";
import { AuditLog } from "./audit.ts";
import { Auth } from "./auth.ts";
import { BotLink } from "./bot.ts";
import { buildBundle } from "./bundle.ts";
import { Exports } from "./exports.ts";
import { guardConfig } from "./guard.ts";
import { hostingCheck } from "../../ops/core/hosting.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { PlanStore } from "../../ops/core/plans.ts";
import { operationObserver } from "../../ops/core/operations.ts";
import { operationPreparer } from "./prepare-operation.ts";
import { FormRoutes } from "./form-routes.ts";
import { PushPage } from "./push-page.ts";
import { PushRoutes } from "./push-routes.ts";
import { UploadStore } from "./uploads.ts";
import { BackupForms } from "./backup-forms.ts";
import { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { configurationRoutes } from "./configuration-routes.ts";
import { DeploymentDirectory } from "./deployment-directory.ts";
import { lifecycleRoutes } from "./lifecycle-routes.ts";
import { upgradeRoutes } from "./upgrade-routes.ts";
import { buildExecutor, launchTask, pruneUnusedRuntimes, reconcileTasks, taskObservers } from "./task-host.ts";
import { taskRoutes } from "./task-routes.ts";
import { openBrowser, sshForwardHint } from "./open.ts";
import { assertNoBotConflict, choosePort, parsePort } from "../../ops/core/console-port.ts";
import { startServer } from "./server.ts";
import { readRoutes } from "./read-routes.ts";
import { QueryPool } from "./exec-client.ts";
import { setQueryRunner } from "./query.ts";
import { consoleDir, liveInstance, prepareConsoleDir, readSavedPort, removeInstance, savePort, writeInstance } from "../../ops/core/console-state.ts";
import { statsRoutes } from "./stats.ts";
import { loadOverview } from "./status.ts";
import { conversationRoutes, Views } from "./views.ts";
import { hostPlatform, PROJECT_DIR, SOURCE_DIR } from "../../ops/core/platform.ts";
import { localProgram, shortBuild } from "../../ops/tools/version-info.ts";
import { CodeFence, codeDigest } from "../../ops/core/source-runtime.ts";

const USAGE = `bun run console [--port <端口>] [--forwarded-port <本地端口>] [--no-open]

在本机 127.0.0.1 启动网页控制台，打印一次性登录链接（5 分钟内有效，只能使用一次）。
  --port <端口>            控制台端口；成功启动后保存，之后默认沿用（初始为 11012）
  --forwarded-port <端口>  SSH 转发时你电脑上使用的本地端口与控制台端口不同时指定，只允许这一个额外来源
  --no-open                Windows 上不自动打开浏览器`;

/** Returns an exit code, or undefined while the server keeps the process alive. */
async function main(argv: string[]): Promise<number | undefined> {
  const { values } = cliArgs(argv, {
    port: { type: "string" }, "forwarded-port": { type: "string" }, "no-open": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) { console.log(USAGE); return 0; }
  process.chdir(PROJECT_DIR);
  const dir = consoleDir(PROJECT_DIR);
  prepareConsoleDir(dir);

  const live = await liveInstance(dir);
  if (live) {
    console.error(`控制台已经在运行：http://127.0.0.1:${live.port}/（PID ${live.pid}，${new Date(live.startedAt).toLocaleString()} 启动）。`);
    console.error("在运行它的终端按 Enter 获取新的登录链接；要重新启动，先在那个终端按 Ctrl+C 退出。");
    return 1;
  }

  const choice = choosePort(values.port, values.port === undefined ? readSavedPort(dir) : null);
  assertNoBotConflict(choice.port, PROJECT_DIR);
  const forwarded = values["forwarded-port"] === undefined ? undefined : parsePort(values["forwarded-port"], "--forwarded-port ");
  const browserPort = forwarded ?? choice.port;

  const bundle = await buildBundle();
  const executorBundle = await buildExecutor(dir);
  const tasks = new TaskStore(dir), observers = taskObservers();
  const configurations = new ConfigurationDrafts(PROJECT_DIR); await configurations.reconcile(tasks, observers);
  const uploads = new UploadStore(dir); await uploads.prune(tasks, observers);
  let pruningUploads = false;
  const uploadTimer = setInterval(() => {
    if (pruningUploads) return; pruningUploads = true;
    void uploads.prune(tasks, observers).catch(() => { console.error("上传副本清理失败，已保留文件；请检查目录权限和任务记录。"); }).finally(() => { pruningUploads = false; });
  }, 60_000); uploadTimer.unref();
  const plans = new PlanStore(dir, operationObserver(PROJECT_DIR));
  try { plans.prune(); } catch { console.error("过期操作计划清理失败，已保留文件；请检查 .console/plans 的权限。"); }
  const hosting = await hostingCheck();
  if (hosting.ok) await reconcileTasks(tasks, hosting.mechanism);
  await tasks.prune(observers);
  try { await pruneUnusedRuntimes(PROJECT_DIR, tasks, observers, [process.env.MIXIN_CONSOLE_CODE_DIGEST ?? codeDigest(SOURCE_DIR), codeDigest(PROJECT_DIR), executorBundle.digest]); }
  catch { console.error("旧版本运行包清理失败，已全部保留；下次启动控制台时重试。"); }
  const program = localProgram(PROJECT_DIR);
  const auth = new Auth();
  // Views hold member numbers in memory for their session only; a session that ends takes its views with it.
  const views = new Views();
  auth.onEnd(label => views.end(label));
  setInterval(() => auth.sweep(), 60_000).unref();
  const audit = new AuditLog(join(dir, "audit"));
  const forms = new FormRoutes(PROJECT_DIR, audit);
  const pushes = new PushRoutes(PROJECT_DIR, audit); auth.onEnd(label => pushes.end(label));
  const pushPage = new PushPage(PROJECT_DIR, audit); auth.onEnd(label => pushPage.end(label));
  const deploymentDirectory = new DeploymentDirectory(PROJECT_DIR); auth.onEnd(label => deploymentDirectory.end(label));
  const backups = new BackupForms(PROJECT_DIR); auth.onEnd(label => backups.end(label));
  let pruningConfigurations = false;
  const configurationTimer = setInterval(() => {
    if (pruningConfigurations) return; pruningConfigurations = true;
    void configurations.reconcile(tasks, observers).catch(() => { console.error("过期配置草稿清理失败，已保留现场。"); }).finally(() => { pruningConfigurations = false; });
  }, 60_000); configurationTimer.unref();
  auth.onEnd(label => { try { configurations.end(label); } catch { console.error("私有配置草稿清理失败，已保留现场。"); } });
  auth.onEnd(label => forms.end(label));
  audit.prune();
  const data = join(PROJECT_DIR, "data");
  const bot = new BotLink({ instanceFile: join(data, "state", "instance.json") });
  // Exports stream to the browser and stop with their login.
  const exporter = new Exports({ bot, audit, views, root: data });
  auth.onEnd(label => exporter.end(label));
  const instanceId = crypto.randomUUID();
  const queries = new QueryPool();
  const dataReads = new AbortController();
  const fence = new CodeFence(PROJECT_DIR, process.env.MIXIN_CONSOLE_CODE_DIGEST ?? codeDigest(PROJECT_DIR), () => {
    dataReads.abort(new Error("代码已变化，请重新运行控制台"));
    exporter.endAll("代码已变化，请重新运行控制台");
    void queries.stop().catch(() => { console.error("旧版查询回收失败，请检查运维日志。"); });
  });
  setQueryRunner((command, args, options) => {
    if (!fence.current()) return Promise.reject(new Error("代码已变化，请重新运行控制台"));
    return queries.capture(command, args, { ...options, signal: options.signal ? AbortSignal.any([options.signal, dataReads.signal]) : dataReads.signal });
  });
  const startedAt = Date.now();
  const info = { version: program.appVersion, build: program.build, hostname: hostname(), platform: hostPlatform(),
    port: choice.port, pid: process.pid, startedAt };
  const server = startServer({
    port: choice.port, guard: guardConfig(choice.port, forwarded === undefined ? [] : [forwarded]),
    bundle, auth, instanceId, current: () => fence.current(), dataSignal: dataReads.signal, overview: () => loadOverview(info),
    routes: { ...conversationRoutes({ bot, audit, views }), ...statsRoutes({ bot, audit, views, root: data }), ...exporter.routes(), ...readRoutes(PROJECT_DIR, audit), ...forms.routes(), ...pushes.routes(), ...pushPage.routes(), ...uploads.routes(), ...backups.routes(), ...configurationRoutes(configurations), ...lifecycleRoutes(PROJECT_DIR), ...upgradeRoutes(PROJECT_DIR), ...deploymentDirectory.routes(),
      ...taskRoutes({ tasks, plans, observers, audit, hosting: hostingCheck, current: () => fence.current(), prepare: operationPreparer(PROJECT_DIR, views, undefined, uploads, backups, forms, configurations, deploymentDirectory),
        created: request => { uploads.bind(request); backups.bind(request); if (request.operation === "configuration-apply") configurations.bind(String(request.params.draft), String(request.params.digest), request.id); },
        launch: id => launchTask(tasks, id, executorBundle) }) },
    download: (ticket, context) => ticket.startsWith("push-") ? pushPage.download(ticket, context) : exporter.download(ticket, context),
  });
  const versionTimer = setInterval(() => fence.current(), 3000); versionTimer.unref();

  let closing = false;
  /** Ends every login, removes our instance record and closes the port. */
  const release = () => {
    closing = true;
    clearInterval(uploadTimer);
    clearInterval(configurationTimer);
    clearInterval(versionTimer);
    exporter.endAll();
    auth.revokeAll();
    try { removeInstance(dir, instanceId); } catch {}
    return Promise.all([server.stop(true), queries.stop()]);
  };
  const shutdown = (reason: string) => {
    if (closing) return;
    void release().then(() => {
      console.log(`\n控制台已退出（${reason}）：端口 ${choice.port} 已关闭，所有登录已失效。`);
      process.exit(0);
    }, error => { console.error(`查询回收失败：${String(error)}`); process.exit(1); });
  };

  // The port is held from here on. If the rest of startup fails, the listener would keep this process alive and
  // serving with no login link and no exit handling: release everything before the error is reported.
  try {
    savePort(dir, choice.port);
    writeInstance(dir, { format: 1, instanceId, pid: process.pid, port: choice.port, startedAt, version: program.appVersion });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown(signal === "SIGINT" ? "Ctrl+C" : signal));

    const link = () => `http://127.0.0.1:${browserPort}/#login=${auth.issueToken().token}`;
    const build = shortBuild(program.build);
    console.log(`量子密信应用机器人控制台 v${program.appVersion}${build ? `（构建 ${build}）` : ""}`);
    console.log(`  监听      http://127.0.0.1:${choice.port}/   端口来源：${choice.source}，已保存到 .console/port`);
    if (info.platform === "linux" || forwarded !== undefined) {
      const hint = sshForwardHint(choice.port, browserPort);
      console.log("  在你自己的电脑上转发端口后，用那台电脑的浏览器打开登录链接：");
      console.log(`    ${hint.command}`);
      if (hint.guessed) console.log("    （主机地址取自本次 SSH 连接；经跳板、NAT 或别名登录时换成你平时使用的地址）");
    }
    const first = link();
    console.log(`  登录链接  ${first}`);
    console.log("            5 分钟内有效，只能使用一次。");
    console.log("  按 Enter 生成新的登录链接（旧链接随即失效），按 Ctrl+C 退出控制台。");
    if (info.platform === "windows" && !values["no-open"] && forwarded === undefined) {
      openBrowser(first).then(() => console.log("  已在默认浏览器打开登录链接；没有打开时复制上面的链接。"),
        error => console.log(`  无法自动打开浏览器（${(error as Error).message}），请复制上面的链接。`));
    }

    if (process.stdin.isTTY) {
      const input = createInterface({ input: process.stdin });
      input.on("line", () => {
        if (closing) return;
        console.log(`  新登录链接  ${link()}   5 分钟内有效，只能使用一次。`);
      });
      input.on("SIGINT", () => shutdown("Ctrl+C"));
    }
  } catch (error) {
    await release();
    throw new Error(`控制台未能完成启动，已关闭端口 ${choice.port}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return undefined;
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
