// How this host runs a detached console task: a Windows one-shot scheduled task, a one-shot LaunchDaemon on macOS, a system
// transient service (rootful) or a user transient service with linger (rootless). Launching, observing and reconciling the tasks is in task-host.ts.
import { existsSync } from "node:fs";

const UNIT_PREFIX = "mixin-console-";
export const WINDOWS_TASK_PATH = "\\MixinConsole\\";

export type Mechanism = "windows-task" | "launchd-system" | "systemd-system" | "systemd-user";
export type HostingCheck = { ok: true; mechanism: Mechanism; facts: string[] } | { ok: false; reason: string; facts: string[] };

interface Run { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[], env?: Record<string, string>) => Promise<Run>;

export const runCommand: Runner = async (argv, env = {}) => {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...env } });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { code: 127, stdout: "", stderr: (error as Error).message };
  }
};

export const unitName = (id: string) => `${UNIT_PREFIX}${id}`;

const WINDOWS_ADMIN = "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
  ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";

/**
 * Whether this host can run a detached task, and which way. Refuses (with the missing condition) instead of
 * enabling linger, changing logout policy, switching identity or installing a resident service.
 */
export interface HostFacts {
  run: Runner;
  platform: NodeJS.Platform;
  uid: number | undefined;
  /** Booted with systemd as the system manager. */
  systemdBooted: () => boolean;
  which: (command: string) => string | null;
}

const realHost = (): HostFacts => ({ run: runCommand, platform: process.platform, uid: process.geteuid?.(),
  systemdBooted: () => existsSync("/run/systemd/system"), which: command => Bun.which(command) });

export async function hostingCheck(host: HostFacts = realHost()): Promise<HostingCheck> {
  const { run, platform, uid } = host;
  if (platform === "win32") {
    const admin = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ADMIN]);
    if (admin.code !== 0) return { ok: false, reason: `无法确认管理员权限：${admin.stderr.trim() || admin.code}`, facts: [] };
    if (admin.stdout.trim() !== "True") return { ok: false, reason: "需要在管理员终端运行：后台任务沿用运维操作的管理员权限", facts: ["当前终端未提升权限"] };
    return { ok: true, mechanism: "windows-task", facts: ["管理员终端"] };
  }
  if (platform === "darwin") {
    if (uid !== 0) return { ok: false, reason: "需要用 sudo 运行控制台：后台任务以 LaunchDaemon 运行，沿用运维操作的 root 权限", facts: ["当前不是 root"] };
    return { ok: true, mechanism: "launchd-system", facts: ["root（sudo）"] };
  }
  const facts: string[] = [];
  if (!host.systemdBooted()) return { ok: false, reason: "本机没有以 systemd 启动，无法托管后台任务；只读功能和 CLI 不受影响", facts };
  if (!host.which("systemd-run")) return { ok: false, reason: "找不到 systemd-run", facts };
  const version = await run(["systemctl", "--version"]);
  facts.push(version.stdout.split("\n")[0]?.trim() || "systemctl --version 无输出");
  if (uid === 0) {
    const state = await run(["systemctl", "is-system-running"]);
    facts.push(`系统管理器：${state.stdout.trim() || state.stderr.trim()}`);
    // During boot the manager already accepts transient services. The executor's receipt remains the final proof.
    if (!["running", "degraded", "starting"].includes(state.stdout.trim())) return { ok: false, reason: "系统管理器未处于运行状态", facts };
    return { ok: true, mechanism: "systemd-system", facts };
  }
  if (uid === undefined) return { ok: false, reason: "无法确定当前用户", facts };
  const linger = await run(["loginctl", "show-user", String(uid), "--property=Linger", "--value"]);
  facts.push(`linger：${linger.stdout.trim() || linger.stderr.trim() || "未知"}`);
  if (linger.code !== 0 || linger.stdout.trim() !== "yes") {
    return { ok: false, reason: `用户 ${uid} 未启用 linger，注销后用户级任务会随之结束。需要管理员确认后执行 loginctl enable-linger；控制台不会自动启用`, facts };
  }
  const manager = await run(["systemctl", "--user", "is-system-running"]);
  facts.push(`用户管理器：${manager.stdout.trim() || manager.stderr.trim()}`);
  if (!["running", "degraded"].includes(manager.stdout.trim())) return { ok: false, reason: "用户级 systemd 管理器不可用（检查 XDG_RUNTIME_DIR 与登录方式）", facts };
  return { ok: true, mechanism: "systemd-user", facts };
}

/** systemd-run argv: a service (not a scope), collected when it ends, no terminal, no inherited environment except `env`. */
export function systemdRunArgv(mechanism: "systemd-system" | "systemd-user", unit: string, cwd: string, command: string[], env: Record<string, string>): string[] {
  return ["systemd-run", ...(mechanism === "systemd-user" ? ["--user"] : []), `--unit=${unit}`, "--collect", "--service-type=exec", "--quiet",
    `--working-directory=${cwd}`, ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`), "--", ...command];
}

/** Windows command line for the task action: each argument quoted (paths cannot contain quotes). */
export function windowsArguments(args: string[]): string {
  return args.map(arg => {
    if (arg.includes('"')) throw new Error(`参数不能包含引号：${arg}`);
    return `"${arg}"`;
  }).join(" ");
}

/**
 * Registers and starts the one-shot task: S4U first, Interactive when policy rejects S4U (as deploy.ps1 does). No run-time
 * limit, as for the bot's own task: the core bounds each of its steps, and the scheduler's stop would skip its cancellation.
 */
export const WINDOWS_REGISTER = `
$ErrorActionPreference = 'Stop'
$name = $env:MIXIN_CONSOLE_TASK; $path = $env:MIXIN_CONSOLE_TASK_PATH
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $env:MIXIN_CONSOLE_TASK_EXECUTE -Argument $env:MIXIN_CONSOLE_TASK_ARGUMENTS -WorkingDirectory $env:MIXIN_CONSOLE_TASK_CWD
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
function Start-ConsoleTask([string]$logon) {
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logon -RunLevel Highest
  Register-ScheduledTask -TaskName $name -TaskPath $path -Action $action -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $name -TaskPath $path
}
$logon = 'S4U'
try { Start-ConsoleTask 'S4U' } catch { $logon = 'Interactive'; Start-ConsoleTask 'Interactive' }
if ($logon -eq 'S4U') {
  Start-Sleep -Seconds 2
  $code = '0x' + ([Convert]::ToString(([int64](Get-ScheduledTaskInfo -TaskName $name -TaskPath $path).LastTaskResult -band 0xffffffff), 16)).PadLeft(8, '0').ToUpperInvariant()
  if ($code -in @('0x8007052E', '0x80070569')) { $logon = 'Interactive'; Start-ConsoleTask 'Interactive' }
}
Write-Output "logon=$logon user=$user"
`;
