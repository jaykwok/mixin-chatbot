import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assessMaintenanceAction, readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { acquireDeploymentLock, DeploymentBusy } from "../../ops/core/deployment-lock.ts";
import { loadPendingTransaction } from "../../ops/core/pending-transaction.ts";
import { PROJECT_DIR, SOURCE_DIR } from "../../ops/core/platform.ts";
import { runCommand, systemdRunArgv, unitName, windowsArguments, WINDOWS_REGISTER, WINDOWS_TASK_PATH } from "../../ops/core/hosting.ts";
import type { Mechanism, Runner } from "../../ops/core/hosting.ts";
import { pruneRuntimes } from "../../ops/core/source-runtime.ts";
import { consoleDir, writeAtomic } from "../../ops/core/console-state.ts";
import type { ExecutorIdentity, HostedState, TaskObservers, TaskRequest } from "../../ops/core/tasks.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { processIncarnation } from "../../src/lib/darwin.ts";
import { parseLaunchctlPrint, plistDocument } from "../../ops/core/launchd-host.ts";

// macOS: one LaunchDaemon per task in launchd's system domain, from a definition under .console/launchd. It runs once
// (RunAtLoad, no KeepAlive) and stays loaded, not running, after it ends; reconcileTasks boots ended ones out.
const LAUNCHD_TASK = "com.mixin-bot.console.";
const launchdLabel = (id: string) => LAUNCHD_TASK + id;
const launchdPlist = (project: string, id: string) => join(consoleDir(project), "launchd", `${launchdLabel(id)}.plist`);
async function launchdJob(id: string, run: Runner) {
  const printed = await run(["/bin/launchctl", "print", `system/${launchdLabel(id)}`]);
  if (printed.code === 113) return { loaded: false as const };
  return printed.code === 0 ? parseLaunchctlPrint(printed.stdout) : null;
}

/** Stable process creation identity, including across a PID being reused. */
export async function executorIdentity(pid = process.pid, run: Runner = runCommand): Promise<ExecutorIdentity> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("执行者 PID 无效");
  let startedAt: string;
  if (process.platform === "win32") {
    const value = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; (Get-Process -Id ([int]$env:MIXIN_TASK_PID)).StartTime.ToUniversalTime().Ticks.ToString()"], { MIXIN_TASK_PID: String(pid) });
    if (value.code !== 0) throw new Error("无法核对执行者创建时间");
    startedAt = value.stdout.trim();
  } else if (process.platform === "darwin") {
    startedAt = processIncarnation(pid) ?? "";
  } else {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    // comm may contain spaces or parentheses. Field 22 follows the final ')' and fields 3..21.
    const ticks = value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
    if (!ticks || !/^\d+$/.test(ticks)) throw new Error("无法核对执行者创建时间");
    startedAt = `${boot}:${ticks}`;
  }
  if (!startedAt) throw new Error("执行者创建时间为空");
  return { pid, startedAt };
}

export async function hostedTask(request: TaskRequest, accepted: ExecutorIdentity, run: Runner = runCommand): Promise<HostedState> {
  if (request.mechanism === "launchd-system") {
    const job = await launchdJob(request.id, run);
    if (!job) return { state: "unknown" };
    if (!job.loaded || job.state === "not running" || job.state === "exited") return { state: "ended" };
    if (job.state !== "running" || !job.pid) return { state: "unknown" };
    try { return { state: "running", executor: await executorIdentity(job.pid, run) }; }
    catch { return { state: "unknown" }; }
  }
  if (request.mechanism === "windows-task") {
    const found = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $t=Get-ScheduledTask -TaskName $env:MIXIN_CONSOLE_TASK -TaskPath $env:MIXIN_CONSOLE_TASK_PATH -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() } else { 'absent' }"],
      { MIXIN_CONSOLE_TASK: unitName(request.id), MIXIN_CONSOLE_TASK_PATH: WINDOWS_TASK_PATH });
    if (found.code !== 0) return { state: "unknown" };
    if (["Ready", "Disabled", "absent"].includes(found.stdout.trim())) return { state: "ended" };
    if (found.stdout.trim() !== "Running") return { state: "unknown" };
    try { return { state: "running", executor: await executorIdentity(accepted.pid, run) }; }
    catch { return { state: "unknown" }; }
  }
  const found = await run(["systemctl", ...(request.mechanism === "systemd-user" ? ["--user"] : []), "show", "-p", "ActiveState", "-p", "MainPID", `${unitName(request.id)}.service`]);
  if (found.code !== 0) return { state: "unknown" };
  const values = Object.fromEntries(found.stdout.trim().split("\n").map(line => line.split("=")));
  if (["inactive", "failed"].includes(values.ActiveState ?? "")) return { state: "ended" };
  if (!["active", "activating", "deactivating"].includes(values.ActiveState ?? "")) return { state: "unknown" };
  const pid = Number(values.MainPID);
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try { return { state: "running", executor: await executorIdentity(pid, run) }; }
  catch { return { state: "unknown" }; }
}

export function taskObservers(run: Runner = runCommand): TaskObservers {
  return { hosting: (request, executor) => hostedTask(request, executor, run), needsRecovery: async request => {
    const state = readMaintenanceState(request.project);
    return !!loadPendingTransaction(request.project) || state.configuration?.status === "present"
      || state.orchestration?.status === "present" && state.orchestration.pending || !assessMaintenanceAction(state, "service").allowed;
  } };
}

export async function unregisterTask(request: TaskRequest, run: Runner = runCommand): Promise<void> {
  if (request.mechanism === "launchd-system") {
    const job = await launchdJob(request.id, run);
    // The executor cleaning up after itself is the job's own process: a bootout would end it here. Reconciliation does that later.
    if (job?.loaded && job.pid !== process.pid) {
      await run(["/bin/launchctl", "bootout", `system/${launchdLabel(request.id)}`]);
      if ((await launchdJob(request.id, run))?.loaded !== false) throw new Error("任务已结束，但托管项尚未清除");
    }
    rmSync(launchdPlist(request.project, request.id), { force: true });
    return;
  }
  if (request.mechanism !== "windows-task") return; // transient services use --collect
  const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Unregister-ScheduledTask -TaskName $env:MIXIN_CONSOLE_TASK -TaskPath $env:MIXIN_CONSOLE_TASK_PATH -Confirm:$false -ErrorAction SilentlyContinue"],
    { MIXIN_CONSOLE_TASK: unitName(request.id), MIXIN_CONSOLE_TASK_PATH: WINDOWS_TASK_PATH });
  if (result.code !== 0) throw new Error("任务已结束，但托管项尚未清除");
}

export interface ExecutorBundle { path: string; digest: string }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function buildExecutor(consoleDir: string, project = SOURCE_DIR): Promise<ExecutorBundle> {
  const result = await Bun.build({ entrypoints: [join(project, "console/server/executor.ts")], target: "bun", format: "esm",
    define: { "process.env.MIXIN_CONSOLE_PROJECT_ROOT": JSON.stringify(PROJECT_DIR), "process.env.MIXIN_CONSOLE_SOURCE_ROOT": JSON.stringify(project) },
    splitting: false, sourcemap: "none" });
  if (!result.success || result.outputs.length !== 1) throw new Error(`任务执行器构建失败：${result.logs.map(String).join("\n")}`);
  const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer()), sha = digest(bytes);
  const path = join(consoleDir, "runtime", sha, "executor.js");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeAtomic(path, new TextDecoder().decode(bytes));
  const bundle = { path, digest: sha };
  verifyExecutor(bundle);
  return bundle;
}

export function verifyExecutor(bundle: ExecutorBundle): void {
  if (!/^[a-f0-9]{64}$/.test(bundle.digest) || digest(readFileSync(bundle.path)) !== bundle.digest) throw new Error("固定版本执行器摘要不符，拒绝启动任务");
}

/** Await an actual receipt, not just successful task registration. A late launcher loses to abandonment. */
export async function launchTask(store: TaskStore, id: string, bundle: ExecutorBundle, run: Runner = runCommand): Promise<void> {
  const request = store.request(id);
  verifyExecutor(bundle);
  const argv = [process.execPath, bundle.path, "--project", request.project, "--task", id];
  let result;
  if (request.mechanism === "launchd-system") {
    const plist = launchdPlist(request.project, id);
    mkdirSync(dirname(plist), { recursive: true, mode: 0o700 });
    writeAtomic(plist, plistDocument({ Label: launchdLabel(id), ProgramArguments: argv, WorkingDirectory: request.project, RunAtLoad: true,
      ProcessType: "Standard", StandardOutPath: "/dev/null", StandardErrorPath: "/dev/null", EnvironmentVariables: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" } }));
    result = await run(["/bin/launchctl", "bootstrap", "system", plist]);
  } else if (request.mechanism === "windows-task") {
    result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_REGISTER], {
      MIXIN_CONSOLE_TASK: unitName(id), MIXIN_CONSOLE_TASK_PATH: WINDOWS_TASK_PATH,
      MIXIN_CONSOLE_TASK_EXECUTE: argv[0]!, MIXIN_CONSOLE_TASK_ARGUMENTS: windowsArguments(argv.slice(1)), MIXIN_CONSOLE_TASK_CWD: request.project,
    });
  } else {
    const env: Record<string, string> = {};
    // The executor must reach the daemon the preview saw: the same endpoint, context and context store.
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[name]) env[name] = process.env[name]!;
    result = await run(systemdRunArgv(request.mechanism, unitName(id), request.project, argv, env));
  }
  if (result.code !== 0) throw new Error("任务托管启动失败；接单期限结束前仍在等待回执，请查看任务状态");
  while (store.now() < request.acceptBy && !existsSync(join(store.dir(id), "claim"))) await Bun.sleep(100);
  store.abandon(id);
}

/** Unknown names and missing records are retained for inspection. Never remove another project's unit. */
export async function reconcileTasks(store: TaskStore, mechanism: Mechanism, run: Runner = runCommand): Promise<string[]> {
  const list = mechanism === "launchd-system" ? await run(["/bin/launchctl", "list"])
    : mechanism === "windows-task"
    ? await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "Get-ScheduledTask -TaskPath $env:MIXIN_CONSOLE_TASK_PATH -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }"], { MIXIN_CONSOLE_TASK_PATH: WINDOWS_TASK_PATH })
    : await run(["systemctl", ...(mechanism === "systemd-user" ? ["--user"] : []), "list-units", "--all", "--no-legend", "--plain", "mixin-console-task-*.service"]);
  if (list.code !== 0) return [];
  const removed: string[] = [];
  for (const line of list.stdout.split("\n")) {
    const id = mechanism === "launchd-system" ? /\scom\.mixin-bot\.console\.(task-[a-f0-9]{32})$/.exec(line.trim())?.[1]
      : /^mixin-console-(task-[a-f0-9]{32})(?:\.service)?(?:\s|$)/.exec(line.trim())?.[1];
    if (!id) continue;
    const view = await store.view(id, taskObservers(run));
    if (!view.request || view.request.mechanism !== mechanism || resolve(view.request.project, ".console", "tasks") !== store.root) continue;
    if (!["succeeded", "failed", "not-accepted"].includes(view.state)) continue;
    // A final record may precede the process exit. Never stop a still-running unit while reconciling.
    const state = await hostedTask(view.request, { pid: 1, startedAt: "reconcile" }, run);
    if (state.state !== "ended") continue;
    if (mechanism === "windows-task" || mechanism === "launchd-system") await unregisterTask(view.request, run);
    else {
      const reset = await run(["systemctl", ...(mechanism === "systemd-user" ? ["--user"] : []), "reset-failed", `${unitName(id)}.service`]);
      if (reset.code !== 0) continue;
    }
    removed.push(id);
  }
  return removed;
}

/**
 * Frozen versions under .console/runtime build up with each code change. At console start the old ones go, but only when
 * nothing can still name them: every task final, deploy.lock free (and held meanwhile), no open transaction and no
 * unfinished maintenance. A busy lock removes nothing; an unreadable record throws and removes nothing.
 */
export async function pruneUnusedRuntimes(project: string, store: TaskStore, observers: TaskObservers, keep: Iterable<string>): Promise<string[]> {
  for (const view of await store.list(observers)) if (view.needsRecovery || !["succeeded", "failed", "not-accepted"].includes(view.state)) return [];
  let lock;
  try { lock = acquireDeploymentLock(project); }
  catch (error) { if (error instanceof DeploymentBusy) return []; throw error; }
  try {
    const maintenance = readOpsMaintenanceRecord(project);
    if (loadPendingTransaction(project) || maintenance && !maintenance.result) return [];
    return pruneRuntimes(consoleDir(project), new Set(keep));
  } finally { lock.close(); }
}
