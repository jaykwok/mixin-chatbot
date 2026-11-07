// The service as a LaunchDaemon: its definition in /Library/LaunchDaemons, its job in launchd's system domain and the
// dedicated role account it runs as. Facts measured on macOS 15 and 26 (docs/dev/macos-spike-20261106.md):
// - bootout returns while the process is still exiting, and a bootstrap before it is gone fails with EIO (5). So a stop waits
//   for the real exit, and a start retries that one error for a short time.
// - A disabled job refuses bootstrap, so a start enables it first.
// - `launchctl print` changes between versions; only state, pid and last exit code are read.
// A stopped service stays disabled, also across a reboot: nothing starts it behind a maintenance or an explicit stop.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountProcesses, killAccount } from "../../src/lib/darwin.ts";
import { runCommand, type Runner } from "./hosting.ts";
import { MaintenanceRefused } from "./maintenance.ts";

export const LAUNCHD_LABEL = "com.mixin-bot.service";
export const LAUNCHD_PLIST = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
/** The service's own account: nothing else runs as it, so what is left of the service can be listed by UID. */
export const SERVICE_ACCOUNT = "_mixinbot";
const LAUNCHCTL = "/bin/launchctl", JOB = `system/${LAUNCHD_LABEL}`;
/** launchd's own wait before SIGKILL (ExitTimeOut in the plist) plus time to report it. */
export const STOP_TIMEOUT_MS = 90_000, EXIT_TIMEOUT_SECONDS = 60;
const SWEEP_TIMEOUT_MS = 5000, BOOTSTRAP_RETRY_MS = 15_000;
const NOT_LOADED = 113, BOOTSTRAP_BUSY = 5;

export interface Identity { uid: number; gid: number }
export interface LaunchdService {
  identity: string;
  owned: boolean;
  state: "running" | "stopped" | "absent" | "unsupported";
  rawState: string;
  /** The service account; absent when it does not exist. */
  user?: Identity;
  /** Processes of the service account while the job is not loaded: a foreground bot or what a stop left behind. */
  leftovers: number;
}
interface Definition { user: unknown; args: unknown; directory: unknown; env: unknown }
/** What the definition runs: the foreground run repeats it, the upgrader takes its Git. */
export interface ServiceDefinition { args: string[]; env: Record<string, string>; directory: string; git?: string }
interface Job { loaded: boolean; state: string; lastExit?: string; pid?: number }
export interface LaunchdHostFacts {
  run: Runner;
  plist: string;
  processes(uid: number): ReadonlyMap<number, string>;
  kill(uid: number): number;
  euid(): number | undefined;
}
const realFacts = (): LaunchdHostFacts => ({ run: runCommand, plist: LAUNCHD_PLIST, processes: accountProcesses, kill: killAccount, euid: () => process.geteuid?.() });

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function plistValue(value: unknown, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${escape(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `${indent}<integer>${value}</integer>`;
  if (Array.isArray(value)) return `${indent}<array>\n${value.map(item => plistValue(item, indent + "  ")).join("\n")}\n${indent}</array>`;
  if (value && typeof value === "object") return `${indent}<dict>\n${Object.entries(value).map(([key, item]) =>
    `${indent}  <key>${escape(key)}</key>\n${plistValue(item, indent + "  ")}`).join("\n")}\n${indent}</dict>`;
  throw new Error("服务定义的值无法表示");
}
/** A launchd property list (XML) of strings, booleans, integers, arrays and dictionaries. */
export function plistDocument(value: Record<string, unknown>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0">\n${plistValue(value, "")}\n</plist>\n`;
}

export function parseLaunchctlPrint(text: string): Job {
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(text)?.[1]?.trim();
  const pid = Number(field("pid"));
  return { loaded: true, state: field("state") ?? "unknown", ...(field("last exit code") ? { lastExit: field("last exit code") } : {}),
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
}

/** The numeric identity of an account; null when it does not exist. */
export async function accountIdentity(name: string, run: Runner = runCommand): Promise<Identity | null> {
  const [uid, gid] = await Promise.all([run(["/usr/bin/id", "-u", name]), run(["/usr/bin/id", "-g", name])]);
  if (uid.code !== 0 || gid.code !== 0) return null;
  const [user, group] = [Number(uid.stdout.trim()), Number(gid.stdout.trim())];
  if (!Number.isSafeInteger(user) || !Number.isSafeInteger(group)) throw new Error(`账户 ${name} 的身份无法读取`);
  return { uid: user, gid: group };
}

export class LaunchdPlatform {
  private readonly facts: LaunchdHostFacts;
  constructor(readonly project: string, facts: Partial<LaunchdHostFacts> = {}) { this.facts = { ...realFacts(), ...facts }; }
  get plist(): string { return this.facts.plist; }

  private present(): boolean {
    try { lstatSync(this.plist); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async definition(): Promise<Definition | null> {
    if (!this.present()) return null;
    const result = await this.facts.run(["/usr/bin/plutil", "-convert", "json", "-o", "-", this.plist]);
    if (result.code !== 0) throw new Error(`无法读取服务定义 ${this.plist}：${result.stderr.trim() || "退出码 " + result.code}`);
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || value.Label !== LAUNCHD_LABEL) throw new Error(`服务定义 ${this.plist} 的标签不符`);
    return { user: value.UserName, args: value.ProgramArguments, directory: value.WorkingDirectory, env: value.EnvironmentVariables };
  }
  /** The installed definition's command, environment and directory; null without one. */
  async serviceDefinition(): Promise<ServiceDefinition | null> {
    const found = await this.definition();
    if (!found) return null;
    const { args, env, directory } = found;
    if (!Array.isArray(args) || !args.every(arg => typeof arg === "string") || typeof directory !== "string" || !env || typeof env !== "object"
      || !Object.values(env).every(value => typeof value === "string")) throw new Error(`服务定义 ${this.plist} 的格式不支持`);
    const git = args[args.indexOf("--git") + 1];
    return { args, env: env as Record<string, string>, directory, ...(args.includes("--git") && git ? { git } : {}) };
  }
  async job(): Promise<Job> {
    const result = await this.facts.run([LAUNCHCTL, "print", JOB]);
    if (result.code === NOT_LOADED) return { loaded: false, state: "not-loaded" };
    if (result.code !== 0) throw new Error(`无法读取 launchd 任务：${result.stderr.trim() || "退出码 " + result.code}`);
    return parseLaunchctlPrint(result.stdout);
  }
  async inspect(): Promise<LaunchdService> {
    const [definition, job] = [await this.definition(), await this.job()];
    const shape = definition ? { label: LAUNCHD_LABEL, user: definition.user, args: definition.args, directory: definition.directory } : { absent: true, project: resolve(this.project) };
    const identity = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
    const owned = !definition || typeof definition.directory === "string" && resolve(definition.directory) === resolve(this.project) && definition.user === SERVICE_ACCOUNT;
    const user = await accountIdentity(SERVICE_ACCOUNT, this.facts.run) ?? undefined;
    const leftovers = !job.loaded && user ? this.facts.processes(user.uid).size : 0;
    const state = !definition && job.loaded || definition && !user ? "unsupported" : !definition ? "absent" : job.loaded ? "running" : "stopped";
    return { identity, owned: !!owned, state, rawState: definition ? job.state : "absent", ...(user ? { user } : {}), leftovers };
  }
  private root(): void { if (this.facts.euid() !== 0) throw new MaintenanceRefused("控制 LaunchDaemon 需要 root，请用 sudo 运行"); }

  /** Enables the job and boots it from the definition; the definition's RunAtLoad starts it. Never beside a leftover writer. */
  async boot(): Promise<void> {
    this.root();
    await this.sweep();
    const enabled = await this.facts.run([LAUNCHCTL, "enable", JOB]);
    if (enabled.code !== 0) throw new Error(`launchctl enable 失败：${enabled.stderr.trim() || enabled.code}`);
    const until = performance.now() + BOOTSTRAP_RETRY_MS;
    for (;;) {
      const booted = await this.facts.run([LAUNCHCTL, "bootstrap", "system", this.plist]);
      if (booted.code === 0) return;
      if (booted.code !== BOOTSTRAP_BUSY || performance.now() >= until) throw new Error(`launchctl bootstrap 失败：${booted.stderr.trim() || booted.code}`);
      await Bun.sleep(250);
    }
  }
  /** Disables the job and boots it out; returns once it and every process of the account have really gone. */
  async halt(): Promise<void> {
    this.root();
    const disabled = await this.facts.run([LAUNCHCTL, "disable", JOB]);
    if (disabled.code !== 0) throw new Error(`launchctl disable 失败：${disabled.stderr.trim() || disabled.code}`);
    if ((await this.job()).loaded) {
      // Its exit code only repeats what the next print shows: the job is gone, going, or a real failure that times out below.
      await this.facts.run([LAUNCHCTL, "bootout", JOB]);
      const until = performance.now() + STOP_TIMEOUT_MS;
      while ((await this.job()).loaded) {
        if (performance.now() >= until) throw new Error("launchd 任务未在时限内退出");
        await Bun.sleep(100);
      }
    }
    await this.sweep();
  }
  /** Ends what the stopped service left behind: setsid() left its session, not its account. Keeps the service itself. */
  async sweep(): Promise<void> {
    if ((await this.job()).loaded) return;
    const user = await accountIdentity(SERVICE_ACCOUNT, this.facts.run);
    if (!user) return;
    const until = performance.now() + SWEEP_TIMEOUT_MS;
    while (this.facts.kill(user.uid) > 0) {
      if (performance.now() >= until) throw new Error(`服务账户 ${SERVICE_ACCOUNT} 仍有活动进程；保持启动阻止`);
      await Bun.sleep(50);
    }
  }
  /** Diagnostics only: launchd's last exit code, or null without a loaded job. */
  async lastResult(): Promise<string | null> {
    const job = await this.job();
    return job.loaded ? job.lastExit ?? null : null;
  }
  async start(identity: string): Promise<void> {
    const facts = await this.inspect();
    if (!facts.owned || facts.identity !== identity || facts.state === "unsupported" || facts.state === "absent") throw new Error("部署身份已变化或不支持启动，未执行操作");
    if (facts.state !== "running") await this.boot();
  }
  async stop(identity: string): Promise<void> {
    const facts = await this.inspect();
    if (!facts.owned || facts.identity !== identity) throw new Error("部署身份已变化，未执行操作");
    await this.halt();
  }
}

/** Tells git that root may read this checkout, for the read-only checks of a core that runs as root. Inherited by its children. */
export function trustCheckout(project: string): void {
  process.env.GIT_CONFIG_COUNT = "1"; process.env.GIT_CONFIG_KEY_0 = "safe.directory"; process.env.GIT_CONFIG_VALUE_0 = resolve(project);
}

/** The environment of a data tool as the service account: as the service's, not the operator's who ran sudo. */
export function serviceEnvironment(project: string): NodeJS.ProcessEnv {
  const { SUDO_USER: _user, SUDO_UID: _uid, SUDO_GID: _gid, SUDO_COMMAND: _command, TMPDIR: _tmp, ...env } = process.env;
  return { ...env, HOME: join(project, "data/runtime/home"), USER: SERVICE_ACCOUNT, LOGNAME: SERVICE_ACCOUNT, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}
