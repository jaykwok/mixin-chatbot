// macOS effects of a deployment transaction: the LaunchDaemon definition, the snapshot's settings copies and its state, the
// dependencies and the directories the service account writes. runDeployment owns ordering, commit boundaries and rollback;
// nothing here decides them. The core runs as root: the files it creates for the service go to the service account.
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { publish, publishJson } from "../../src/lib/atomic-file.ts";
import { parseRecord, serializeRecord, type Values } from "./key-value-record.ts";
import type { NativeRunner } from "./native-process.ts";
import { archiveEntry, captureFiles, removeCompleted, restoreFiles, serviceDirectories, type Owner } from "./deployment-files.ts";
import { EXIT_TIMEOUT_SECONDS, LAUNCHD_LABEL, plistDocument, SERVICE_ACCOUNT, type LaunchdPlatform, type LaunchdService } from "./launchd-host.ts";
import { MaintenanceRefused } from "./maintenance.ts";

// The deploy entry finds these before the stop; the service definition runs exactly them.
const TOOL_KEYS = ["format", "bun", "git", "uv", "bash", "coreutils"] as const;
export type MacosTools = Values<typeof TOOL_KEYS[number]>;
const toolPath = /^\/[^\x00-\x1f\x7f]*$/;
export const parseMacosTools = (text: string): MacosTools => parseRecord(text, TOOL_KEYS,
  { format: /^1$/, bun: toolPath, git: toolPath, uv: toolPath, bash: toolPath, coreutils: toolPath }, "部署工具记录");
export const serializeMacosTools = (tools: MacosTools) => serializeRecord(tools, TOOL_KEYS);

/** Providers, model selection and the dynamic catalogue restore together, so a rolled-back instance still resolves its model offline. */
export const MACOS_FILES = ["data/config", "data/runtime/pi/settings.json", "data/runtime/models-store.json", "data/state/bot-port", "data/state/workspace-root"] as const;
/** What the service account writes. Created for it when missing; an existing one must already be its own. */
export const SERVICE_DIRECTORIES = ["data", "data/config", "data/state", "data/runtime", "data/runtime/home", "logs", "backup", "backup/snapshots", "backup/rm"];
const SYSTEM = { cp: "/bin/cp", mv: "/bin/mv" }, STATE_FILE = "macos-state.json", PLIST_COPY = "service.plist";

export interface MacosSnapshot {
  format: 1;
  operation: "upgrade" | "deploy";
  project: string;
  identity: string;
  wasRunning: boolean;
  hasService: boolean;
  dependenciesAttempted: boolean;
  dependenciesMoved: boolean;
}

/** The LaunchDaemon: the service account, the supervisor of this checkout, and the recorded tools first in PATH. */
export function servicePlist(project: string, tools: MacosTools): string {
  const root = resolve(project);
  const path = [...new Set([tools.coreutils, dirname(tools.bash), dirname(tools.uv), dirname(tools.bun), dirname(tools.git), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])];
  const definition = {
    Label: LAUNCHD_LABEL, UserName: SERVICE_ACCOUNT, WorkingDirectory: root,
    ProgramArguments: [tools.bun, "--no-env-file", "run", join(root, "ops/core/launchd-supervisor.ts"), "--bun", tools.bun, "--git", tools.git],
    EnvironmentVariables: { PATH: path.join(":"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: join(root, "data/runtime/home"),
      // The checkout belongs to the operator: the service only reads it, and Git refuses that without this.
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: root },
    RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 10, ExitTimeOut: EXIT_TIMEOUT_SECONDS, Umask: 0o077, ProcessType: "Standard",
    SoftResourceLimits: { NumberOfFiles: 8192 }, HardResourceLimits: { NumberOfFiles: 8192 },
    StandardOutPath: "/dev/null", StandardErrorPath: join(root, "logs/service-stderr.log"),
  };
  return plistDocument(definition);
}

const present = (path: string) => {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

export class MacosDeployment {
  readonly snapshot: string;
  /** An upgrade binds every effect to the definition it confirmed (expected); a deployment replaces it and only requires it to be this project's. */
  constructor(readonly project: string, readonly name: string, private readonly service: LaunchdPlatform, private readonly run: NativeRunner,
    private readonly account: Owner, readonly operation: "upgrade" | "deploy", readonly expected = "") {
    this.snapshot = join(project, "backup/snapshots", name);
  }
  private async current(): Promise<LaunchdService> {
    const facts = await this.service.inspect();
    if (!facts.owned) throw new MaintenanceRefused("LaunchDaemon 属于其他目录或其他账户");
    if (this.operation === "upgrade" && facts.identity !== this.expected) throw new Error("服务定义已变化，未执行操作");
    if (facts.user && (facts.user.uid !== this.account.uid || facts.user.gid !== this.account.gid)) throw new Error("服务账户的身份已变化，未执行操作");
    return facts;
  }
  /** Files, dependencies and the definition change only while nothing of the service runs. */
  private async stopped(): Promise<LaunchdService> {
    const facts = await this.current();
    if (facts.state === "running" || facts.leftovers > 0) throw new Error("服务仍在运行，未改动文件或服务定义");
    return facts;
  }
  private own(): void {
    serviceDirectories(this.project, SERVICE_DIRECTORIES, this.account);
    for (const relative of SERVICE_DIRECTORIES) {
      const info = lstatSync(join(this.project, relative));
      if (info.uid !== this.account.uid) throw new MaintenanceRefused(`${relative} 不属于服务账户 ${SERVICE_ACCOUNT}；请先用部署入口把数据目录交给服务账户`);
    }
  }

  async capture(): Promise<MacosSnapshot> {
    const facts = await this.current();
    if (present(this.snapshot)) throw new Error("快照目录已存在");
    // A bot this project runs in the foreground has no definition to stop or restore.
    if (facts.state !== "running" && facts.leftovers > 0) throw new MaintenanceRefused("服务账户有进程在运行（前台运行的机器人或残留进程），未做快照");
    if (facts.state === "unsupported") throw new MaintenanceRefused(`LaunchDaemon 的状态（${facts.rawState}）不支持部署`);
    this.own();
    mkdirSync(this.snapshot, { mode: 0o700 }); chmodSync(this.snapshot, 0o700);
    // The service account's data tools read plans here; only the directory itself is handed over.
    lchownSync(this.snapshot, this.account.uid, this.account.gid);
    await captureFiles(this.project, this.snapshot, MACOS_FILES, this.run, SYSTEM);
    if (facts.state !== "absent") await publish(join(this.snapshot, PLIST_COPY), readFileSync(this.service.plist), { createOnly: true, mode: 0o644 });
    const state: MacosSnapshot = { format: 1, operation: this.operation, project: resolve(this.project), identity: facts.identity, wasRunning: facts.state === "running",
      hasService: facts.state !== "absent", dependenciesAttempted: false, dependenciesMoved: false };
    await publishJson(join(this.snapshot, STATE_FILE), state, { createOnly: true });
    return state;
  }
  read(): MacosSnapshot {
    const info = lstatSync(join(this.snapshot, STATE_FILE));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("快照状态不是普通文件");
    const state = JSON.parse(readFileSync(join(this.snapshot, STATE_FILE), "utf8")) as MacosSnapshot;
    if (!state || state.format !== 1 || state.operation !== this.operation || state.project !== resolve(this.project) || !/^[a-f0-9]{64}$/.test(String(state.identity))
      || [state.wasRunning, state.hasService, state.dependenciesAttempted, state.dependenciesMoved].some(value => typeof value !== "boolean")
      || this.operation === "upgrade" && (state.identity !== this.expected || !state.hasService)) throw new Error("macOS 部署快照属于其他项目或格式不支持");
    return state;
  }
  private save(state: MacosSnapshot): Promise<void> { return publishJson(join(this.snapshot, STATE_FILE), state); }

  async stop(): Promise<void> { await this.current(); await this.service.halt(); }
  async start(): Promise<void> {
    const facts = await this.current();
    if (facts.state === "absent") throw new Error("LaunchDaemon 不存在，无法启动");
    await this.service.boot();
  }

  async saveDependencies(): Promise<void> {
    await this.stopped();
    const state = this.read(), source = join(this.project, "node_modules"), target = join(this.snapshot, "node_modules");
    // A resumed transaction already recorded that there were no original dependencies; the ones present now came from the interrupted install.
    if (state.dependenciesAttempted && !state.dependenciesMoved) return;
    if (present(target)) { await this.save({ ...state, dependenciesAttempted: true, dependenciesMoved: true }); return; }
    // Intent before the same-volume move: recovery tells a completed move by the backup directory and never overwrites it.
    const moved = present(source);
    await this.save({ ...state, dependenciesAttempted: true, dependenciesMoved: moved });
    if (moved) renameSync(source, target);
  }
  async restoreDependencies(): Promise<void> {
    await this.stopped();
    const state = this.read(), current = join(this.project, "node_modules"), saved = join(this.snapshot, "node_modules");
    if (!state.dependenciesAttempted) return;
    if (!state.dependenciesMoved) { await archiveEntry(this.project, current, this.name, this.run, SYSTEM, this.account); return; }
    if (present(saved)) { await archiveEntry(this.project, current, this.name, this.run, SYSTEM, this.account); renameSync(saved, current); }
    else if (!present(current)) throw new Error("原依赖和备份都不存在");
  }
  async restoreConfiguration(): Promise<void> {
    await this.stopped(); this.read();
    await restoreFiles(this.project, this.snapshot, this.name, MACOS_FILES, this.run, SYSTEM, this.account);
  }
  /** The definition the transaction found, or none for a first deployment. Stays disabled: a start boots it. */
  async restoreService(): Promise<void> {
    await this.current();
    const state = this.read();
    await this.service.halt();
    if (state.hasService) await publish(this.service.plist, readFileSync(join(this.snapshot, PLIST_COPY)), { mode: 0o644, owner: { uid: 0, gid: 0 } });
    else if (present(this.service.plist)) unlinkSync(this.service.plist);
  }
  async prepareDirectories(): Promise<void> {
    await this.stopped();
    this.own();
    for (const relative of ["data/config", "data/state"]) chmodSync(join(this.project, relative), 0o700);
    // The service account's data tools test this lock to prove that the core still holds it.
    const lock = join(this.project, "data/state/deploy.lock");
    if (existsSync(lock)) lchownSync(lock, this.account.uid, this.account.gid);
  }
  /** Written, not loaded: the core boots the verification instance once the other steps agree. */
  async installService(tools: MacosTools): Promise<void> {
    await this.stopped();
    await this.service.halt();
    await publish(this.service.plist, servicePlist(this.project, tools), { mode: 0o644, owner: { uid: 0, gid: 0 } });
  }
  cleanup(): void { removeCompleted(this.project, this.name); }
}
