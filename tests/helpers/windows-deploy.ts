// Windows only. The scheduler is synthetic: one task definition (none, the original or the installed candidate) and the
// instance it runs. Git, the deployment lock, the pinned runtime, the disk journal, the runtime and configuration installs
// and the local readiness protocol are real. No real task, bot or credential.
import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { configurationSnapshot } from "../../ops/config/configuration-form.ts";
import { installConfigurationStage, parseConfigurationStage, serializeConfigurationStage, stageName, type StagedKind } from "../../ops/config/configuration-stage.ts";
import { installRuntimeValues } from "../../ops/config/runtime-settings.ts";
import { RUNTIME_VALUES_FILE, runtimeDigest, serializeRuntimeValues } from "../../ops/config/runtime-values.ts";
import { DEPLOY_CHOICES_FILE, type DeployChoices } from "../../ops/core/deploy-stage.ts";
import type { DeployInput } from "../../ops/core/deployment-host.ts";
import { runNative, type NativeResult, type NativeRunner } from "../../ops/core/native-process.ts";
import type { OpsResult } from "../../ops/core/result.ts";
import { serializeWindowsTools, type WindowsTools } from "../../ops/core/windows-deployment.ts";
import { preflightWindowsDeploy, runWindowsLifecycle } from "../../ops/core/windows-lifecycle.ts";
import { PROTOCOL, PROTOCOL_VERSION } from "../../ops/lib/maintenance-protocol.ts";
import { releaseDataResult } from "../../ops/lib/release-data-protocol.ts";
import { APP, DIRECTORY, MODELS } from "./docker-upgrade.ts";
import { tempFixture } from "./temp.ts";

const source = resolve(import.meta.dir, "../..");
/** What the entry found before the stop. Fixture paths; the synthetic scheduler never runs them. */
export const TOOLS: WindowsTools = { format: "1", bun: "C:\\fixture\\bun\\bun.exe", git: "C:\\fixture\\Git\\cmd\\git.exe", uv: "C:\\fixture\\uv\\uv.exe",
  bash: "C:\\fixture\\Git\\bin\\bash.exe" };
// The snapshot's restore range (windows-deployment-platform.ps1 $paths).
const SAVED = ["data/config", "data/runtime/pi/settings.json", "data/runtime/models-store.json", "data/runtime/bot-launcher.ps1", "data/state/bot-port", "data/state/workspace-root"];

/** interrupt: the entry dies right after publishing the transaction, before the stop (confirming the snapshot then fails once). */
export type WindowsDeployFailure = "verification-health" | "start-verification" | "apply" | "commit-reply" | "interrupt";
export interface WindowsDeployOptions {
  /** A task of this project exists: a redeployment. */
  original?: boolean;
  running?: boolean;
  /** Without a Git checkout (an unpacked release) the candidate reports no build. */
  git?: boolean;
  /** The task belongs to another directory. */
  foreign?: boolean;
  failures?: WindowsDeployFailure[];
}
export interface WindowsStageOptions {
  target?: string;
  port?: number;
  workspace?: string;
  runtime?: Record<string, string>;
  /** A first deployment answers both configurations and the directory scope and previews after the stop; a redeployment keeps its configuration and previews before. */
  app?: string | null;
  models?: { models: string; settings: string } | null;
  directory?: string | null;
  plan?: string | null;
  /** The record as written; null leaves it out. */
  tools?: string | null;
}

type Definition = "original" | "candidate";
export async function windowsDeployFixture(options: WindowsDeployOptions = {}) {
  const f = await tempFixture("core-windows-deploy-"), project = join(f.root, "project");
  mkdirSync(project);
  // The fixture directory may lie inside another checkout: Git must not find that one.
  const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: f.root };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  if (options.git !== false) {
    git("init", "-q", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "fixture"); git("config", "commit.gpgsign", "false");
    writeFileSync(join(project, ".gitignore"), "data/\nbackup/\nlogs/\n.console/\nnode_modules/\ntmp/\n"); writeFileSync(join(project, "version.txt"), "deployed\n");
    git("add", "-A"); git("commit", "-q", "-m", "deployed");
  }
  const head = options.git === false ? "" : git("rev-parse", "HEAD");
  // What the launcher reports: the checkout's commit when the instance starts (Get-CheckoutBuild; this fixture keeps the tree clean).
  const checkoutBuild = () => options.git === false ? "" : git("rev-parse", "HEAD").slice(0, 12);
  const first = !options.original && !options.foreign;
  if (options.original) {
    // A redeployment's original runs with a complete configuration.
    for (const directory of ["data/config", "data/state", "data/runtime/pi"]) mkdirSync(join(project, directory), { recursive: true });
    writeFileSync(join(project, "data/config/app-bot.json"), APP); writeFileSync(join(project, "data/config/models.json"), MODELS.models);
    writeFileSync(join(project, "data/runtime/pi/settings.json"), MODELS.settings); writeFileSync(join(project, "data/config/directory.json"), DIRECTORY);
    writeFileSync(join(project, "data/state/bot-port"), "1011"); writeFileSync(join(project, "data/runtime/bot-launcher.ps1"), "original launcher\n");
  }

  const failures = new Set(options.failures ?? []), events: string[] = [], unexpected: string[] = [], outputs: string[] = [], results: OpsResult[] = [];
  const starts: { role: string; fallback: boolean }[] = [], installs: unknown[] = [];
  let task: Definition | null = options.original || options.foreign ? "original" : null, running = !!options.running && task !== null, verification = false, build = "0".repeat(12);
  let snapshot = "", captured: { task: Definition | null; running: boolean; files: Map<string, string> } | null = null, attempted = false;
  const identity = (definition: Definition | null) => createHash("sha256").update(definition ?? "absent:" + project).digest("hex");
  const instance = { instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(): Response {
    if (!running) return new Response("no instance", { status: 503 });
    return Response.json({ ...instance, service: "mixin-bot", version: 1, build,
      status: verification && failures.has("verification-health") ? "starting" : "ready", verificationOnly: verification, port: server.port });
  } });
  const instanceFile = join(project, "data/state/instance.json"), instanceText = JSON.stringify({ ...instance, port: server.port });
  if (running) { mkdirSync(dirname(instanceFile), { recursive: true }); writeFileSync(instanceFile, instanceText); }

  // The restore range as files: what capture saves and restore-configuration puts back (Save-/Restore-DeploymentFiles).
  const files = (path: string, into: Map<string, string>) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) files(join(path, name), into); return; }
    into.set(relative(project, path).replaceAll("\\", "/"), readFileSync(path, "utf8"));
  };
  const save = () => { const saved = new Map<string, string>(); for (const path of SAVED) files(join(project, path), saved); return saved; };
  const restore = (saved: Map<string, string>) => {
    for (const path of SAVED) rmSync(join(project, path), { recursive: true, force: true });
    for (const [path, text] of saved) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), text); }
  };
  const ok = (stdout = ""): NativeResult => ({ code: 0, stdout });
  const maintenanceReply = (command: string, code: number) => ({ code, stdout: JSON.stringify({ protocol: PROTOCOL, version: PROTOCOL_VERSION, command,
    outcome: code === 3 ? "stopped" : code ? "failed" : "success", result: null }) });
  const writeRelease = (phase: "prepared" | "committed") => writeFileSync(join(project, "data/state/release-data.json"),
    JSON.stringify({ format: 1, deployment: snapshot, phase, previous: null }, null, 2) + "\n");

  const platform = (action: string, request: Record<string, unknown>, effect: boolean, output?: (text: string, stream: "stdout" | "stderr") => void): NativeResult => {
    const refuse = (message: string) => { output?.(message + "\n", "stderr"); return { code: 1, stdout: "" }; };
    let value: unknown = null;
    const meta = () => ({ identity: identity(captured!.task), wasRunning: captured!.running, hasTask: captured!.task !== null, dependenciesAttempted: attempted, dependenciesMoved: false });
    if (!effect) {
      if (action === "inspect") value = { identity: identity(task), owned: !options.foreign, state: task ? running ? "running" : "stopped" : "absent", rawState: task ? running ? "Running" : "Ready" : "" };
      else if (action === "last-result") value = task ? "0x00000001 / 1" : null;
      else { unexpected.push("platform " + action); return refuse("fixture: unexpected service action"); }
    } else {
      expect(request.operation).toBe("deploy"); expect(request.expected).toBeUndefined();
      if (action !== "capture") expect(request.snapshot).toBe(snapshot);
      const writer = ["prepare-directories", "save-dependencies", "install-task", "restore-task", "restore-dependencies", "restore-configuration"].includes(action);
      if (writer && running) { unexpected.push(action + " while running"); return refuse("Service still running; no files or task definition changed"); }
      switch (action) {
        case "capture":
          expect([request.original, request.branch, request.target]).toEqual(["", "", options.git === false ? "" : git("rev-parse", "HEAD")]);
          snapshot = String(request.snapshot); captured = { task, running, files: save() };
          mkdirSync(join(project, "backup/snapshots", snapshot), { recursive: true });
          writeFileSync(join(project, "backup/snapshots", snapshot, "deployment.xml"), "fixture native metadata");
          events.push("capture"); value = meta(); break;
        case "read":
          if (failures.delete("interrupt")) return refuse("fixture: the entry was killed after publishing the transaction");
          value = meta(); break;
        case "stop":
          events.push(running ? "stop:" + task : "stop"); running = false; verification = false; break;
        case "prepare-directories":
          for (const directory of ["data/config", "data/state", "data/runtime", "logs"]) mkdirSync(join(project, directory), { recursive: true });
          events.push(action); break;
        case "save-dependencies": attempted = true; events.push(action); break;
        case "install-task":
          installs.push(request.tools); task = "candidate";
          writeFileSync(join(project, "data/runtime/bot-launcher.ps1"), "candidate launcher\n"); events.push(action); break;
        case "start-task": {
          if (!task) return refuse("Service task is absent; nothing to start");
          const verifying = existsSync(join(project, "data/state/verify-only")), role = verifying ? "verification" : task;
          starts.push({ role, fallback: request.fallback as boolean }); events.push("start:" + role);
          if (verifying && failures.has("start-verification")) return refuse("fixture: the scheduler refused the task");
          running = true; verification = verifying; build = task === "candidate" ? checkoutBuild() : "0".repeat(12); writeFileSync(instanceFile, instanceText); break;
        }
        case "restore-task": task = captured!.task; events.push(action); break;
        case "restore-dependencies": events.push(action); break;
        case "restore-configuration": restore(captured!.files); events.push(action); break;
        case "cleanup": rmSync(join(project, "backup"), { recursive: true, force: true }); events.push(action); break;
        default: unexpected.push("effect " + action); return refuse("fixture: unexpected effect");
      }
    }
    return ok(JSON.stringify({ protocol: "mixin-platform", version: 1, action, ok: true, value }));
  };

  /** What the target release's tool does on the host; the installs are the real ones. */
  const tool = async (path: string, args: string[], env: NodeJS.ProcessEnv, output?: (text: string, stream: "stdout" | "stderr") => void): Promise<NativeResult & { lost?: boolean }> => {
    expect(running).toBe(false); expect(env.APP_BUILD).toBe(checkoutBuild());
    const option = (name: string) => args[args.indexOf(name) + 1]!, name = path.replace(/^.*[\\/]|\.ts$/g, ""), action = args[0]!;
    const install = async (label: string, command: string, work: () => Promise<boolean>) => {
      try { events.push(label + (await work() ? "" : ":in-place")); return maintenanceReply(command, 0); }
      catch (error) { events.push(label + ":failed"); output?.((error as Error).message + "\n", "stderr"); return maintenanceReply(command, 1); }
    };
    if (name === "runtime-settings") {
      expect(args).toEqual(["--values", option("--values"), "--json"]);
      return install(`${name}:values`, "values", () => installRuntimeValues(option("--values"), join(project, "data/config/runtime.json")));
    }
    if (name === "configuration-install") {
      const kind = option("--kind") as StagedKind;
      return install(`${name}:${kind}`, "install", () => installConfigurationStage(project, parseConfigurationStage(readFileSync(option("--stage"), "utf8"), kind)));
    }
    events.push(`${name}:${action}`);
    if (name === "data-current") {
      expect(option("--deployment")).toBe(snapshot);
      const reply = (code: number) => ({ code, stdout: JSON.stringify(releaseDataResult(action, code)) });
      if (action === "preview") { expect(existsSync(option("--plan"))).toBe(false); writeFileSync(option("--plan"), "{}\n"); return reply(0); }
      if (action !== "rollback") expect(existsSync(option("--plan"))).toBe(true);
      if (action === "apply") { if (failures.has("apply")) return reply(1); writeRelease("prepared"); return reply(0); }
      if (action === "commit") { writeRelease("committed"); return { ...reply(0), lost: failures.delete("commit-reply") }; }
      expect(action).toBe("rollback"); rmSync(join(project, "data/state/release-data.json"), { force: true }); return reply(0);
    }
    if (name === "directory-scope") { writeFileSync(join(project, "data/config/directory.json"), readFileSync(option("--plan"))); return maintenanceReply(action, 0); }
    unexpected.push("tool " + path); return { code: 1, stdout: "" };
  };

  const native: NativeRunner = async (command, output) => {
    if (command.command === "git") return runNative({ ...command, env: { ...command.env, GIT_CEILING_DIRECTORIES: f.root } }, output);
    if (command.command === "powershell.exe") {
      const request = JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString("utf8"));
      return platform(request.action, request, command.args.some(value => value.endsWith("windows-deployment-platform.ps1")), output);
    }
    if (command.command === process.execPath && command.args[0] === "install") {
      expect(running).toBe(false); events.push("dependencies:install"); return ok();
    }
    if (command.command === process.execPath && command.args[0] === "--no-env-file" && command.args[1] === "run") {
      // Every tool runs from the pinned runtime, never the project's own scripts.
      expect(command.args[2]).toContain("source-");
      const result = await tool(command.args[2]!, command.args.slice(3), command.env ?? {}, output);
      if (result.lost) throw new Error("fixture: the reply was lost");
      return result;
    }
    unexpected.push(command.command + " " + command.args.join(" ")); return { code: 1, stdout: "" };
  };

  const current = (path: string) => existsSync(join(project, path)) ? readFileSync(join(project, path), "utf8") : null;
  const staged = (kind: StagedKind, values: Record<string, string | null>) => {
    const base = configurationSnapshot(project, kind);
    return serializeConfigurationStage({ version: 1, base, next: { kind, binding: base.binding, files: values } });
  };
  let stages = 0;
  /** A new stage directory with what the entry answers now: every base is the project's current file. */
  const stage = (choices: WindowsStageOptions = {}) => {
    const directory = join(f.root, `stage-${stages++}`), port = choices.port ?? 1011;
    const pick = <T>(value: T | null | undefined, fallback: T | null) => value === undefined ? fallback : value;
    const app = pick(choices.app, first ? APP : null), models = pick(choices.models, first ? MODELS : null);
    const values: Record<string, string | null> = {
      [DEPLOY_CHOICES_FILE]: JSON.stringify({ format: 1, target: choices.target ?? head, port, workspace: choices.workspace ?? "" } satisfies DeployChoices),
      [RUNTIME_VALUES_FILE]: serializeRuntimeValues({ format: 1, base: runtimeDigest(current("data/config/runtime.json")), values: { BOT_PORT: String(port), ...choices.runtime } }),
      "data-plan.json": pick(choices.plan, first ? null : "{}\n"), "directory-scope-plan.json": pick(choices.directory, first ? DIRECTORY : null),
      [stageName("app")]: app === null ? null : staged("app", { app }),
      [stageName("models")]: models === null ? null : staged("models", { models: models.models, settings: models.settings, catalog: null }),
      "windows-tools": pick(choices.tools, serializeWindowsTools(TOOLS)) };
    mkdirSync(directory);
    for (const [name, text] of Object.entries(values)) if (text !== null) writeFileSync(join(directory, name), text);
    return directory;
  };

  const settings = { project, source, native, output: (text: string) => { outputs.push(text); }, readyTimeoutMs: 1500, async verify() {}, async finish(result: OpsResult) { results.push(result); } };
  type Overrides = Partial<typeof settings>;
  const lifecycle = (value: Omit<DeployInput, "operation">, overrides: Overrides = {}) => runWindowsLifecycle({ operation: "deploy", ...value }, { ...settings, ...overrides });
  return { root: f.root, project, head, build: checkoutBuild, first, events, unexpected, outputs, results, starts, installs, stage, git, read: current,
    get task() { return task; }, get running() { return running; }, get snapshot() { return snapshot; },
    deploy: (directory: string, command: "deploy" | "repair" = "deploy", overrides: Overrides = {}) => lifecycle({ stage: directory, command }, overrides),
    resume: (overrides: Overrides = {}, confirmation?: string) => lifecycle({ command: "resume", ...(confirmation ? { confirmation } : {}) }, overrides),
    rollback: (overrides: Overrides = {}, confirmation?: string) => lifecycle({ command: "rollback", rollback: true, ...(confirmation ? { confirmation } : {}) }, overrides),
    preflight: () => preflightWindowsDeploy({ operation: "deploy", command: "deploy" }, { project, source, native }),
    async cleanup() { await server.stop(true); await f.cleanup(); } };
}
