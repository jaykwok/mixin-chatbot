// Opt-in end-to-end check against a real Docker Engine with synthetic data: first deployment, upgrade,
// cancelled migration preview, rollback after a failed verification and a later successful upgrade.
// It builds the mixin-chatbot image and uses the fixed container names, so run it only on a disposable
// Docker host (a WSL distro or VM): MIXIN_REAL_DOCKER=1 bun run test tests/ops/real-docker.test.ts
// Run only current-format deployments; historical instances must be prepared manually.
// The deployed trees talk to a local fake platform (tests/helpers/fake-platform-server.ts, in its own process) instead of
// the real one: the exported working tree's platform endpoints are replaced by the fixture, the production code keeps its
// fixed hosts. Rootful containers use the host network (127.0.0.1); rootless ones reach the host at the source address of
// its default route (or MIXIN_REAL_DOCKER_PLATFORM_HOST). MIXIN_REAL_DOCKER_LAYOUTS=external (comma list) limits the
// shared workspace layouts that run (default data/workspace, or an external WORKSPACE_ROOT mounted read-only).
// With the default workspace both operators also check the preparation before the stop: a slowed build while the original
// service keeps answering (host load recorded), a single build with every container on the candidate's ID, work-tree files
// kept out of the image, and tags moved while the preview waits.
// Every layout first checks that an unusable WORKSPACE_ROOT (a link into the project's logs/) is refused before the stop; the
// external one also checks after each deployment that its read-only workspace is unchanged and cannot be written. When a
// layout's first deployment fails, its later steps fail at once as "前置失败，未执行" instead of running against no service.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readQuietly } from "../../src/durable/revision-cleanup/inspect.ts";
import { readJournal } from "../../src/durable/revision-cleanup/journal.ts";
import type { Point } from "../../src/durable/revision-cleanup/run.ts";
import { chainState, kindOf, writeLongChains, type ChainState } from "../helpers/revision-chains.ts";
import { LifecycleConsole, taskResult } from "../helpers/console-lifecycle.ts";
import { webHealthGate } from "../helpers/lifecycle-gates.ts";
import { configurationSnapshot } from "../../scripts/config/configuration-form.ts";
import { serializeConfigurationStage } from "../../scripts/config/configuration-stage.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { validateRelayConfig } from "../../src/integrations/relay-s3.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.MIXIN_REAL_DOCKER === "1" && process.platform === "linux";
// A separate acceptance group: keep the original CLI lifecycle and its prerequisite order intact.
const webLifecycle = process.env.MIXIN_REAL_DOCKER_CONSOLE === "1";
const ROOT_PREFIX = "/var/tmp/mixin-real-docker-";
const layouts = (["default", "external"] as const).filter(layout =>
  (process.env.MIXIN_REAL_DOCKER_LAYOUTS ?? "default,external").split(",").includes(layout));
const baseImage = /^FROM\s+(oven\/bun:\S+)/m.exec(readFileSync(join(project, "Dockerfile"), "utf8"))?.[1] ?? "";
// Scripts must take the Docker path of a host without Bun (validate-models falls back to the image).
const hostPath = (process.env.PATH ?? "").split(":").filter(dir => dir && !existsSync(join(dir, "bun"))).join(":");
// The ops core needs host Bun 1.4.4+: this test's own, handed over explicitly (only the ops core reads it), so that nothing is
// downloaded and every other script still sees a host without Bun.
const passthrough = { ...Object.fromEntries(["HOME", "USER", "DOCKER_HOST", "XDG_RUNTIME_DIR"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]!])), MIXIN_OPS_BUN: process.execPath };

function run(command: string, args: string[], cwd = project, input?: string) {
  const result = spawnSync(command, args, { cwd, input, env: { ...passthrough, PATH: hostPath, LANG: "C.UTF-8" }, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
function must(command: string, args: string[], cwd = project): string {
  const result = run(command, args, cwd);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.out}`);
  return result.out;
}
const docker = (...args: string[]) => run("docker", args);
// rootlesskit publishes ports as the deploying user; the kernel's unprivileged port start applies to it.
const rootless = enabled && docker("info", "--format", "{{.SecurityOptions}}").out.includes("name=rootless");
const unprivilegedStart = rootless ? Number(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8").trim()) : 0;
const operator = rootless ? "rootless" : process.getuid?.() === 0 ? "root" : "group";

// The fixture's synthetic application credentials and its one directory member.
const FIXTURE_APP_ID = "fixture-app", FIXTURE_PHONE = "13800000000", FIXTURE_IM_USER = "im-fixture";
let fixtureSecret = "";
const platformHost = rootless
  ? process.env.MIXIN_REAL_DOCKER_PLATFORM_HOST || (/\bsrc (\S+)/.exec(must("ip", ["-4", "route", "get", "1.1.1.1"]))?.[1] ?? "")
  : "127.0.0.1";
let platform: { child: ChildProcess; origin: string } | undefined;
// Run from its own directory: the modules it shares with the service read data/config relative to the working directory.
async function startPlatform(cwd: string): Promise<{ child: ChildProcess; origin: string }> {
  const script = fileURLToPath(new URL("../helpers/fake-platform-server.ts", import.meta.url));
  const child = spawn(process.execPath, [script], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...passthrough, PATH: hostPath,
    FAKE_PLATFORM_HOST: platformHost, FAKE_PLATFORM_ADVERTISE: platformHost, FAKE_PLATFORM_APP_ID: FIXTURE_APP_ID,
    FAKE_PLATFORM_APP_SECRET: fixtureSecret, FAKE_PLATFORM_MEMBER: `${FIXTURE_PHONE}:${FIXTURE_IM_USER}` } });
  let output = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake platform did not start: ${output}`)), 20_000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const ready = /FAKE_PLATFORM_READY=(\{.*\})/.exec(output);
      if (ready) { clearTimeout(timer); resolve({ child, origin: (JSON.parse(ready[1]!) as { origin: string }).origin }); }
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`fake platform exited (${code}): ${output}`)); });
  });
}
interface PlatformState { sockets: number; tokens: number; sent: { body: Record<string, unknown>; content: unknown }[] }
async function platformState(): Promise<PlatformState> {
  return await (await fetch(`${platform!.origin}/__fixture/state`)).json() as PlatformState;
}

interface Container { id: string; name: string; image: string; user: string; sources: string[]; mounts: { Source: string; Destination: string; RW: boolean }[] }
function containers(): Container[] {
  const ids = must("docker", ["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean);
  if (!ids.length) return [];
  // A short-lived container (the service's task daemon probes) may be gone by the time it is inspected: Docker then
  // prints the others on stdout and only "no such object" errors.
  const result = spawnSync("docker", ["inspect", ...ids], { env: { ...passthrough, PATH: hostPath, LANG: "C.UTF-8" }, encoding: "utf8" });
  const errors = (result.stderr ?? "").split("\n").filter(line => line.trim() && !/no such object/i.test(line));
  if (result.status !== 0 && (errors.length || !result.stdout?.trim())) throw new Error(`docker inspect failed (${result.status}): ${result.stderr}`);
  const inspected = JSON.parse(result.stdout) as { Id: string; Name: string; Config: { Image: string; User: string };
    Mounts: { Source: string; Destination: string; RW: boolean }[] }[];
  return inspected.map(item => ({ id: item.Id, name: item.Name.replace(/^\//, ""), image: item.Config.Image, user: item.Config.User,
    sources: item.Mounts.map(mount => mount.Source), mounts: item.Mounts }));
}
// The task daemon's socket (scripts/lib/task-runtime.sh, rootless) is the only mount allowed outside the fixture.
const runRoots = new Set<string>();
const ours = (container: Container) => [...runRoots].some(root => container.mounts.some(mount => mount.Source.startsWith(root + "/"))
  && container.mounts.every(mount => mount.Source.startsWith(root + "/") || mount.Destination === "/run/mixin-task/docker.sock"));
const previews = (root: string) => containers().filter(item => item.name.startsWith("mixin-chatbot-preview-") && item.sources.some(source => source.startsWith(root)));

// Everything the tests create: every container whose mounts all lie in a fixture (the service, the rollback container,
// previews and migration containers left by a killed upgrade). A container of a real deployment stops the run first.
function removeOurContainers(): void {
  for (const item of containers()) if (ours(item)) docker("rm", "-f", item.id);
}
// Images carry the project label of the checkout they were built for (candidate_project_id); the 98f1b4a deployment's
// image has none and is removed by its recorded ID.
const projects: string[] = [], unlabelled: string[] = [];
const projectId = (work: string) => createHash("sha256").update(realpathSync(work)).digest("hex").slice(0, 12);
// Under root the deployment also loads its image into the service UID's task daemon (scripts/lib/task-runtime.sh);
// rootless shares the deploying user's daemon.
const TASK_DAEMON = "unix:///run/user/1001/docker.sock";
function removeOurImages(): void {
  const hosts = [[], ...(operator === "root" && existsSync(TASK_DAEMON.slice(7)) ? [["--host", TASK_DAEMON]] : [])];
  for (const host of hosts) {
    for (const id of projects) {
      for (const image of new Set(docker(...host, "image", "ls", "-aq", "--no-trunc", "--filter", `label=org.mixin-chatbot.project=${id}`).out.split("\n").filter(Boolean))) {
        docker(...host, "image", "rm", "--force", image);
      }
    }
  }
  for (const image of unlabelled) docker("image", "rm", "--force", image);
}

interface Ended { code: number | null; signal: string | null; output: string }
interface Running { child: ChildProcess; done: Promise<Ended>; ended(): Ended | undefined }
// Answers each "?> " prompt line once, matched by text; unmatched prompts (headings) need no input. A prefix runs the
// script as another user (setpriv).
function start(root: string, name: string, args: string[], cwd: string, env: Record<string, string>,
  answers: [RegExp, string][] = [], detached = false, prefix: string[] = []): Running {
  const command = [...prefix, "bash", ...args];
  const child = spawn(command[0]!, command.slice(1), { cwd, detached, env: { ...passthrough, PATH: hostPath, LANG: "C.UTF-8", TERM: "dumb", ...env },
    stdio: [answers.length ? "pipe" : "ignore", "pipe", "pipe"] });
  const pending = [...answers];
  let output = "", scanned = 0;
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    for (;;) {
      const at = output.indexOf("?> ", scanned), end = at < 0 ? -1 : output.indexOf("\n", at);
      if (end < 0) break;
      const line = output.slice(at, end);
      scanned = end;
      const index = pending.findIndex(([pattern]) => pattern.test(line));
      if (index >= 0) { child.stdin?.write(`${pending[index]![1]}\n`); pending.splice(index, 1); }
    }
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  let ended: Ended | undefined;
  const done = new Promise<Ended>(resolve => child.on("close", (code, signal) => {
    writeFileSync(join(root, "logs", `${name}.log`), output);
    resolve(ended = { code, signal, output });
  }));
  return { child, done, ended: () => ended };
}

// Fixture files the operations must never change; the running service may add its own state beside them.
function digest(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string) => {
    const info = lstatSync(path);
    if (info.isDirectory()) { for (const entry of readdirSync(path).sort()) walk(join(path, entry)); return; }
    result[path] = info.isSymbolicLink() ? `link:${readlinkSync(path)}` : createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  for (const path of paths) walk(path);
  return result;
}

// With an operation that should still be running (held or about to be killed), stops waiting as soon as it ends: a build
// that failed on the network then fails the step at once instead of after the whole timeout.
async function until<T>(what: string, probe: () => T | undefined | false, timeout: number, running?: Running): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value;
    const ended = running?.ended();
    if (ended) throw new Error(`${what}: the operation ended first (code ${ended.code}, signal ${ended.signal}): ${ended.output.slice(-3000)}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// Evidence while an upgrade runs: every Docker CLI call of the scripts (through a logging shim first on PATH) and the
// daemon's container and image events. Both are kept in the fixture's logs.
interface DockerEvent { Type: string; Action: string; timeNano: number; Actor: { ID: string; Attributes: Record<string, string> } }
function observe(root: string, name: string) {
  const shim = join(root, "shim"), calls = join(root, "logs", `${name}-docker-calls.log`), eventLog = join(root, "logs", `${name}-docker-events.log`);
  const real = must("sh", ["-c", "command -v docker"]);
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${real}' "$@"\n`);
  chmodSync(join(shim, "docker"), 0o755);
  writeFileSync(calls, "");
  const events = spawn("docker", ["events", "--format", "{{json .}}", "--filter", "type=container", "--filter", "type=image"],
    { env: { ...passthrough, PATH: hostPath }, stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  events.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  return {
    path: `${shim}:${hostPath}`,
    async finish() {
      await Bun.sleep(1000);
      events.kill();
      writeFileSync(eventLog, text);
      return { calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
        events: text.split("\n").filter(Boolean).map(line => JSON.parse(line) as DockerEvent) };
    },
  };
}

// Samples the original service while an upgrade runs: its health endpoint on the host port and its container's ID and
// start time (every 250 ms), and the host load with the container's CPU and memory (every 2 s).
interface Sample { t: number; ok: boolean; id: string; started: string; running: boolean }
function sampler(port: number, file: string) {
  const samples: Sample[] = [], load: string[] = [];
  const env = { ...passthrough, PATH: hostPath };
  let stopped = false;
  const health = async () => {
    while (!stopped) {
      const t = Date.now();
      const curl = Bun.spawn(["curl", "--noproxy", "*", "--max-time", "2", "-fsS", `http://127.0.0.1:${port}/health`], { env, stdout: "ignore", stderr: "ignore" });
      const inspect = Bun.spawn(["docker", "inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.State.Running}}", "mixin-chatbot"], { env, stdout: "pipe", stderr: "ignore" });
      const [code, text] = await Promise.all([curl.exited, new Response(inspect.stdout).text()]);
      const [id = "", started = "", running = ""] = text.trim().split(" ");
      samples.push({ t, ok: code === 0, id, started, running: running === "true" });
      await Bun.sleep(250);
    }
  };
  const resources = async () => {
    while (!stopped) {
      const stats = Bun.spawn(["docker", "stats", "--no-stream", "--format", "cpu={{.CPUPerc}} mem={{.MemUsage}}", "mixin-chatbot"], { env, stdout: "pipe", stderr: "pipe" });
      const usage = (await new Response(stats.stdout).text()).trim() || "container not running";
      load.push(`${new Date().toISOString()} loadavg=${readFileSync("/proc/loadavg", "utf8").trim()} ${usage}`);
      await Bun.sleep(2000);
    }
  };
  const running = Promise.all([health(), resources()]);
  return {
    samples, load,
    async finish() {
      stopped = true;
      await running;
      writeFileSync(file, [...samples.map(sample => JSON.stringify(sample)), ...load].join("\n") + "\n");
    },
  };
}

/** When each text first appears in the output of a running script (ms since the epoch). */
function marks(running: Running, texts: Record<string, string>): Record<string, number> {
  const seen: Record<string, number> = {};
  let output = "";
  const watch = (chunk: Buffer) => {
    output += chunk.toString();
    for (const [key, text] of Object.entries(texts)) if (!seen[key] && output.includes(text)) seen[key] = Date.now();
  };
  running.child.stdout!.on("data", watch);
  running.child.stderr!.on("data", watch);
  return seen;
}

/** SQLite write-ahead logs below a directory: the running service's databases in WAL mode. */
function walFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(path, entry.name));
      else if (entry.name.endsWith("-wal")) found.push(join(path, entry.name));
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

// The migration preview of targets with this hook waits while data/preview-gate exists (the data mount is read-only in
// the preview; /preview is its writable scratch).
const previewGate = 'if (process.argv.includes("preview") && (await import("node:fs")).existsSync("/app/data/preview-gate")) { (await import("node:fs")).writeFileSync("/preview/held", ""); while ((await import("node:fs")).existsSync("/app/data/preview-gate")) await Bun.sleep(200); } // fixture: preview gate';
// The health check of targets with this hook waits while data/hold-health exists, but only once the data is committed:
// not for the verification instance (verify-only marker, --allow-verification), only for the activation afterwards.
// It marks the hold in data/state, which the service identity may write; data/ itself belongs to the deployer.
const holdHealth = 'if ((await import("node:fs")).existsSync("data/hold-health") && !(await import("node:fs")).existsSync("data/state/verify-only") && !process.argv.includes("--allow-verification")) { (await import("node:fs")).writeFileSync("data/state/health-held", ""); while ((await import("node:fs")).existsSync("data/hold-health")) await Bun.sleep(200); } // fixture: hold health';
// The revision cleanup of targets with this hook waits after the first commit of a document (the temporary key is
// stored) while data/hold-cleanup exists, and writes its host name (the container ID) to data/state/cleanup-held.
const cleanupPoint = "  async point(point: Point) { await this.options.hooks?.point?.(point); }";
const heldCleanupPoint: Point = "committed";
const holdCleanup = `  async point(point: Point) { const fs = await import("node:fs"); if (point === "${heldCleanupPoint}" && fs.existsSync("/app/data/hold-cleanup")) { fs.writeFileSync("/app/data/state/cleanup-held", (await import("node:os")).hostname()); while (fs.existsSync("/app/data/hold-cleanup")) await Bun.sleep(200); } await this.options.hooks?.point?.(point); } // fixture: hold cleanup`;

// The working tree as a fresh repository: uncommitted changes under review are part of the deployed base.
// Modes come from the index (a Windows checkout mounted into WSL reports every file as executable).
function exportWorkingTree(target: string): void {
  const source = (...args: string[]) => must("git", ["-c", "safe.directory=*", "-C", project, "ls-files", "-z", ...args]).split("\0").filter(Boolean);
  const modes = new Map<string, string>();
  for (const entry of source("--stage")) modes.set(entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6));
  for (const path of source("--others", "--exclude-standard")) modes.set(path, "100644");
  for (const [path, mode] of modes) {
    const from = join(project, path), destination = join(target, path);
    if (!existsSync(from) || lstatSync(from).isDirectory()) continue;
    mkdirSync(dirname(destination), { recursive: true });
    if (mode === "120000") symlinkSync(readFileSync(from, "utf8"), destination);
    else { copyFileSync(from, destination); chmodSync(destination, mode === "100755" ? 0o755 : 0o644); }
  }
}

// The exported tree with the fake platform's endpoints: every target published from it keeps them.
function exportWithFakePlatform(target: string): void {
  exportWorkingTree(target);
  const path = join(target, "src/integrations/open-platform/config.ts"), anchor = "  const api = API_HOSTS[environment];\n";
  const text = readFileSync(path, "utf8"), origin = platform!.origin;
  if (text.split(anchor).length !== 2) throw new Error("platformEndpoints() changed: update the fake platform hook");
  writeFileSync(path, text.replace(anchor, () => `  if (environment) return { api: "${origin}", stream: "${origin.replace(/^http:/, "ws:")}/open-apis/v1/events/stream", ` +
    `storage: url => url.origin === "${origin}" && url.pathname.startsWith("/storage/") }; // fixture: local fake platform\n` + anchor));
  if (webLifecycle) {
    // Shared fault gates start inert. Any selected web test can use the first deployment as its prerequisite;
    // rerunning a later failure need not repeat the successful disconnect test just to install these hooks.
    prepend(join(target, "scripts/ops/health-check.ts"), webHealthGate);
    const runPath = join(target, "src/durable/revision-cleanup/run.ts"), runText = readFileSync(runPath, "utf8");
    if (runText.split(cleanupPoint).length !== 2) throw new Error("cleanup hook changed");
    writeFileSync(runPath, runText.replace(cleanupPoint, holdCleanup));
  }
}

// The tests read and publish in checkouts that another user may own; the scripts get no such exception.
const git = (cwd: string, ...args: string[]) =>
  must("git", ["-c", "safe.directory=*", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], cwd);
function publish(upstream: string, message: string, change: () => void): string {
  change();
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", message);
  git(upstream, "push", "-q", "origin", "main");
  return git(upstream, "rev-parse", "HEAD");
}
function prepend(file: string, line: string): void {
  const text = readFileSync(file, "utf8");
  const shebang = text.startsWith("#!") ? text.slice(0, text.indexOf("\n") + 1) : "";
  writeFileSync(file, `${shebang}${line}\n${text.slice(shebang.length)}`);
}

// A repository with origin and a separate clone to publish targets from; the base commit's files come from fill().
function repository(base: string, fill: (work: string) => void) {
  const work = join(base, "work"), upstream = join(base, "upstream"), origin = join(base, "origin.git");
  mkdirSync(work, { recursive: true });
  fill(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  must("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");
  must("git", ["clone", "-q", origin, upstream]);
  return { work, upstream };
}

// Synthetic configuration and shared materials; returns the files no operation may change.
function syntheticData(work: string, shared: string): string[] {
  mkdirSync(join(work, "data/config"), { recursive: true });
  mkdirSync(join(work, "data/runtime/pi"), { recursive: true });
  writeFileSync(join(work, "data/config/models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
    models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 512, reasoning: false }],
  } } }));
  writeFileSync(join(work, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  // Synthetic credentials of the local fake platform; the deployed tree never contacts the real one.
  writeFileSync(join(work, "data/config/app-bot.json"), JSON.stringify({ environment: "production", appId: FIXTURE_APP_ID, appSecret: fixtureSecret }));
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "notes.md"), "synthetic shared materials\n");
  return [join(work, "data/config/models.json"), join(work, "data/config/app-bot.json"),
    join(work, "data/runtime/pi/settings.json"), join(shared, "notes.md")];
}

const deployAnswers: [RegExp, string][] = [[/是否重新配置 AI/, "n"]];

describe.skipIf(!enabled)(`real Docker upgrade lifecycle (uid ${process.getuid?.()}, ${operator})`, () => {
  let root = "";
  let failed = false;
  const step = (name: string, body: () => Promise<void>, timeout: number) => test(name, async () => {
    try { await body(); } catch (error) { failed = true; throw error; }
  }, timeout);

  beforeAll(async () => {
    if (!baseImage) throw new Error("Dockerfile has no oven/bun base image");
    const info = docker("info", "--format", "{{.ServerVersion}}");
    if (info.code !== 0) throw new Error(`Docker is not reachable: ${info.out}`);
    const foreign = containers().filter(item => item.name.startsWith("mixin-chatbot") && !ours(item));
    if (foreign.length) throw new Error(`refusing to run: containers of another deployment exist (${foreign.map(item => item.name).join(", ")})`);
    removeOurContainers();
    root = mkdtempSync(ROOT_PREFIX);
    runRoots.add(root);
    // Another user deploys below it in the root run.
    chmodSync(root, 0o755);
    mkdirSync(join(root, "logs"));
    fixtureSecret = createHash("sha256").update(root).digest("hex");
    if (!platformHost) throw new Error("no host address for the rootless containers to reach the fake platform");
    mkdirSync(join(root, "platform"));
    platform = await startPlatform(join(root, "platform"));
    console.log(`real Docker fixture: ${root} (Docker ${info.out}, fake platform ${platform.origin})`);
  });

  // Removing every container and image of the run takes longer than the default five seconds of a hook.
  afterAll(() => {
    platform?.child.stdin?.end();
    platform?.child.kill();
    if (!root) return;
    removeOurContainers();
    removeOurImages();
    if (failed || process.env.MIXIN_REAL_DOCKER_KEEP === "1") console.log(`real Docker fixture kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }, 120_000);

  // A docker-group user against the rootful daemon: refused before any question, build or stop, with nothing created.
  if (operator === "group") describe("docker-group operator", () => {
    step("deploying and upgrading are refused before any question, build or stop", async () => {
      const { work } = repository(join(root, "group"), exportWorkingTree);
      projects.push(projectId(work));
      mkdirSync(join(work, "data/config"), { recursive: true });
      writeFileSync(join(work, "data/config/models.json"), "{}");
      const labelled = () => docker("image", "ls", "-aq", "--filter", `label=org.mixin-chatbot.project=${projectId(work)}`).out;
      for (const [name, args] of [["group-deploy", ["scripts/deploy/deploy.sh"]], ["group-update", ["scripts/ops/ops.sh", "update"]]] as const) {
        const result = await start(root, name, [...args], work, { BOT_PORT: String(await freePort()) }).done;
        expect(result.code === 0, result.output).toBe(false);
        expect(result.output).toContain("Docker 以 root 身份运行（rootful）");
        expect(result.output).toContain("脚本不会自动 sudo");
        expect(result.output).not.toContain("?> ");
        expect({ containers: containers().filter(item => item.sources.some(source => source.startsWith(root))).length, images: labelled() })
          .toEqual({ containers: 0, images: "" });
        expect(existsSync(join(work, "data/state/deploy-transaction"))).toBe(false);
      }
    }, 300_000);
  });

  if (operator !== "group") for (const layout of layouts) {
    describe(`${layout} workspace`, () => {
      let work = "", upstream = "", shared = "", port = 0;
      let fixture: string[] = [];
      let baseline: Record<string, string> = {};
      let accepted = "";
      // The service identity: the mapped 0:0 under rootless, the image's appuser for root's first deployment.
      const identity = operator === "rootless" ? "0:0" : "1001:1001";
      const env = () => ({ BOT_PORT: String(port) });
      const head = () => git(work, "rev-parse", "HEAD");
      const bot = () => {
        const result = docker("inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.State.Running}} {{.Image}} {{.Config.User}}", "mixin-chatbot");
        const [id = "", started = "", running = "", image = "", user = ""] = result.out.split(" ");
        return { id, started, running: running === "true", image, user };
      };
      const marker = () => docker("exec", "mixin-chatbot", "cat", "/app/src/upgrade-marker.txt").out;
      // Ready inside the container and reachable on the host port, where the health check and the console connect.
      const healthy = () => docker("exec", "mixin-chatbot", "bun", "run", "scripts/ops/health-check.ts").code === 0 &&
        spawnSync("curl", ["--noproxy", "*", "--max-time", "3", "-fsS", `http://127.0.0.1:${port}/health`]).status === 0;
      // The service holds the fake platform's Stream, has mapped the directory member and answers a direct /help over OpenAPI.
      const converses = async (what: string) => {
        type Health = { stream?: { connected?: boolean }; directory?: { mappings?: number; running?: unknown } };
        const health = async () => await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json() as Promise<Health>, () => ({} as Health));
        const ready = async () => {
          const value = await health();
          return value.stream?.connected === true && value.directory?.mappings === 1 && value.directory.running === undefined;
        };
        for (const end = Date.now() + 60_000; !await ready();) {
          if (Date.now() > end) throw new Error(`${what}: no Stream or directory: ${JSON.stringify(await health())}`);
          await Bun.sleep(250);
        }
        const replies = async () => (await platformState()).sent.filter(item => item.body.receive_id === FIXTURE_IM_USER).length;
        const before = await replies();
        await fetch(`${platform!.origin}/__fixture/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          eventType: "callback:direct", groupId: "", userId: FIXTURE_IM_USER, msgUid: `uid-${crypto.randomUUID()}`, type: "text",
          content: { content: "/help" }, extraContent: "" }) });
        for (const end = Date.now() + 30_000; await replies() === before;) {
          if (Date.now() > end) throw new Error(`${what}: no reply to /help: ${JSON.stringify(await platformState())}`);
          await Bun.sleep(250);
        }
      };
      const pending = () => existsSync(join(work, "data/state/deploy-transaction"));
      const stages = () => existsSync(join(work, "tmp")) ? readdirSync(join(work, "tmp")).filter(entry => entry.startsWith("upgrade-")) : [];
      const snapshots = () => existsSync(join(work, "backup/snapshots")) ? readdirSync(join(work, "backup/snapshots")).length : 0;
      // Every later step builds on the service of the first deployment.
      let blocked = "";
      const first = (name: string, body: () => Promise<void>, timeout: number) => step(name, async () => {
        try { await body(); } catch (error) { blocked = name; throw error; }
      }, timeout);
      const dependent = (name: string, body: () => Promise<void>, timeout: number) => step(name, async () => {
        if (blocked) throw new Error(`前置失败，未执行（${layout}：${blocked}）`);
        try { await body(); } catch (error) { blocked = name; throw error; }
      }, timeout);
      // The external workspace: every entry with its content and modification time, and the service cannot write it.
      const sharedEntries = () => {
        const entries: Record<string, string> = {};
        const walk = (path: string) => {
          for (const entry of readdirSync(path).sort()) {
            const full = join(path, entry), info = lstatSync(full);
            entries[full.slice(shared.length + 1)] = `${info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : "file"} ${info.mtimeMs}`;
            if (info.isDirectory()) walk(full);
          }
        };
        walk(shared);
        return entries;
      };
      let sharedBaseline: Record<string, string> = {};
      const externalUnchanged = () => {
        if (layout !== "external") return;
        expect(sharedEntries()).toEqual(sharedBaseline);
        const write = docker("exec", "mixin-chatbot", "sh", "-c", "echo probe > /app/workspace/.write-probe");
        expect({ refused: write.code !== 0, readOnly: /read-only file system/i.test(write.out) }, write.out).toEqual({ refused: true, readOnly: true });
        expect(existsSync(join(shared, ".write-probe"))).toBe(false);
      };

      first("first deployment starts the service from synthetic data", async () => {
        const base = join(root, layout);
        ({ work, upstream } = repository(base, exportWithFakePlatform));
        projects.push(projectId(work));
        shared = layout === "default" ? join(work, "data/workspace") : join(base, "shared-files");
        port = await freePort();
        fixture = syntheticData(work, shared);
        if (layout === "external") sharedBaseline = sharedEntries();
        // The credentials are in place, so the directory scope is chosen before the stop; without a terminal it comes from
        // BOT_DIRECTORY_SCOPE. Only this run gets it: a later step that asked again would fail.
        const deploy = start(root, `${layout}-deploy`, ["scripts/deploy/deploy.sh"], work,
          { ...env(), BOT_DIRECTORY_SCOPE: "all", ...(layout === "external" ? { WORKSPACE_ROOT: shared } : {}) }, deployAnswers);
        const result = await deploy.done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(result.output).toContain("选择通讯录同步范围（服务尚未停止）");
        expect(JSON.parse(readFileSync(join(work, "data/config/directory.json"), "utf8"))).toEqual({ format: 1, all: true });
        expect(existsSync(join(work, "data/state/directory-scope-plan.json"))).toBe(false);
        expect(bot()).toMatchObject({ running: true, user: identity });
        expect(await until("the deployed service", () => healthy(), 60_000)).toBe(true);
        await converses("the deployed service");
        expect(pending()).toBe(false);
        // An external workspace is mounted read-only at /app/workspace; the default one is part of data/.
        const mounts = JSON.parse(docker("inspect", "--format", "{{json .Mounts}}", "mixin-chatbot").out) as { Destination: string; RW: boolean }[];
        expect(mounts.find(mount => mount.Destination === "/app/workspace")?.RW).toBe(layout === "external" ? false : undefined);
        externalUnchanged();
        baseline = digest(fixture);
        accepted = head();
      }, 1_800_000);

      // The CLI redeploy and repair go through the shared core like the first deployment: the saved port, workspace and
      // directory scope are kept (only the AI question is asked), the container is replaced from a fresh candidate image on
      // the same commit, and the stage that held the answers is removed.
      dependent("CLI redeploy and repair keep the saved choices and restart on the same commit", async () => {
        for (const command of ["deploy", "repair"]) {
          const before = bot();
          const result = await start(root, `${layout}-cli-${command}`, ["scripts/ops/ops.sh", command], work, env(), deployAnswers).done;
          expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
          expect(result.output).not.toContain("选择通讯录同步范围");
          expect(bot()).toMatchObject({ running: true, user: identity });
          expect(bot().id).not.toBe(before.id);
          expect(head()).toBe(accepted);
          expect(await until("the redeployed service", () => healthy(), 60_000)).toBe(true);
          expect(digest(fixture)).toEqual(baseline);
          externalUnchanged();
          const left = existsSync(join(work, "tmp")) ? readdirSync(join(work, "tmp")).filter(entry => entry.startsWith("deploy-stage-")) : [];
          expect({ pending: pending(), left, previews: previews(root).length }).toEqual({ pending: false, left: [], previews: 0 });
        }
        await converses("after the CLI redeploy and repair");
      }, 1_800_000);

      // relay-configure, model-configure and configure-app-bot need a terminal for their wizard; what they hand over is a stage
      // file, published by the core exactly as here: checked while the bot runs, a brief stop, written by the service identity
      // in a data task, the original state restored and checked ready. Disabling removes relay.json again.
      dependent("a configuration stage from a terminal wizard is published by the core with a brief stop", async () => {
        const directory = join(work, "tmp/configure-stage-fixture"), stage = join(directory, "configuration-relay.json");
        const relay = JSON.stringify(validateRelayConfig({ provider: "s3", endpoint: "https://s3.example.test", region: "test-region",
          bucket: "test-bucket", accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk" }), null, 2) + "\n";
        for (const next of [relay, null]) {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const base = configurationSnapshot(work, "relay"), before = bot();
          writeFileSync(stage, serializeConfigurationStage({ version: 1, base, next: { ...base, files: { relay: next } } }), { mode: 0o600 });
          const result = run(process.execPath, ["--no-env-file", join(work, "scripts/ops/core/cli.ts"), "--project", work,
            "maintenance", "configuration-apply", "--stage", stage], work);
          rmSync(directory, { recursive: true, force: true });
          expect(result, result.out).toMatchObject({ code: 0 });
          expect(result.out).not.toContain("fixture-sk");
          const path = join(work, "data/config/relay.json");
          if (next === null) expect(existsSync(path)).toBe(false);
          else {
            expect(readFileSync(path, "utf8")).toBe(next);
            // Written in the data task as the service identity (rootless: the deploying user behind the mapped 0:0).
            expect(statSync(path).uid).toBe(rootless ? process.getuid!() : 1001);
          }
          expect(readConfigurationState(work)).toBeNull();
          expect(bot()).toMatchObject({ id: before.id, running: true, user: identity });
          expect(bot().started).not.toBe(before.started);
          expect(await until("the service after the configuration", () => healthy(), 60_000)).toBe(true);
          expect(digest(fixture)).toEqual(baseline);
        }
        await converses("after publishing staged configurations");
      }, 900_000);

      if (webLifecycle) {
        let consolePort = 0, consoleNumber = 0;
        const sessions = new Set<LifecycleConsole>(), taskIds = new Set<string>();
        const unitArgs = rootless ? ["--user"] : [];
        const openConsole = async () => {
          consolePort ||= await freePort();
          const client = new LifecycleConsole(work, consolePort, join(root, "logs", `web-${++consoleNumber}.log`),
            { ...passthrough, PATH: hostPath, LANG: "C.UTF-8", TERM: "dumb" });
          sessions.add(client); await client.login(); return client;
        };
        const closeConsole = async (client: LifecycleConsole) => { await client.close(); sessions.delete(client); };
        const submit = async (client: LifecycleConsole, operation: string, params: Record<string, unknown>) => {
          const id = await client.submit(operation, params); taskIds.add(id); return id;
        };
        const update = async (client: LifecycleConsole, target: string) => {
          const fetched = await client.json<{ target: string }>("/api/lifecycle/check-update", {});
          expect(fetched.target).toBe(target);
          return submit(client, "update", { target, switchMain: false, cleanup: "apply", directory: "saved" });
        };
        const finished = async (client: LifecycleConsole, id: string, outcome: "success" | "failed" = "success") => {
          const view = await client.wait(id);
          const log = await client.json<{ content: string }>(`/api/tasks/${id}/log`, {});
          writeFileSync(join(root, "logs", `${id}.log`), log.content);
          expect({ state: view.state, recovery: view.needsRecovery, result: view.result }, log.content.slice(-6000)).toMatchObject({
            state: outcome === "success" ? "succeeded" : "failed", recovery: false,
            result: { outcome, finalState: "running" },
          });
          expect(await until("the web task's ready service", () => healthy(), 60_000)).toBe(true);
          expect(digest(fixture)).toEqual(baseline);
          expect(pending()).toBe(false);
          return log.content;
        };
        const checkedUnit = (id: string) => {
          if (!taskIds.has(id)) throw new Error("not a task of this test");
          const request = JSON.parse(readFileSync(join(work, ".console/tasks", id, "request.json"), "utf8"));
          expect({ id: request.id, project: request.project, mechanism: request.mechanism }).toEqual({
            id, project: work, mechanism: rootless ? "systemd-user" : "systemd-system",
          });
          return `mixin-console-${id}.service`;
        };
        const killTask = async (id: string) => {
          const unit = checkedUnit(id);
          must("systemctl", [...unitArgs, "kill", "--kill-whom=all", "--signal=SIGKILL", unit]);
          await until("the killed task service", () => {
            const state = run("systemctl", [...unitArgs, "show", "-p", "ActiveState", "--value", unit]);
            return state.out.trim() === "inactive" || state.out.trim() === "failed";
          }, 30_000);
          expect(taskResult(work, id)).toBeUndefined();
        };
        afterAll(async () => {
          for (const client of sessions) await client.close();
          // Exactly the IDs returned by this fixture's HTTP submissions; never stop another console's service.
          for (const id of taskIds) {
            const unit = checkedUnit(id);
            const state = run("systemctl", [...unitArgs, "show", "-p", "ActiveState", "--value", unit]).out.trim();
            if (["active", "activating", "deactivating"].includes(state)) must("systemctl", [...unitArgs, "stop", unit]);
          }
        }, 120_000);

        dependent("web console: upgrade survives console exit and the old page only reads task results", async () => {
          const target = publish(upstream, "web target A", () => {
            writeFileSync(join(upstream, "src/upgrade-marker.txt"), "W");
          });
          const hold = join(work, "data/hold-health"), held = join(work, "data/state/health-held");
          writeFileSync(hold, "W");
          const client = await openConsole(), id = await update(client, target);
          await until("activation after the web upgrade's commit", () => {
            const result = taskResult(work, id); if (result) throw new Error(JSON.stringify(result));
            return existsSync(held);
          }, 900_000);
          expect(await client.json("/api/runtime")).toEqual({ current: false });
          expect((await client.request("/api/overview")).status).toBe(409);
          expect((await client.request("/api/plans", { operation: "stop", params: {} })).status).toBe(409);
          expect((await client.json<{ state: string }>(`/api/tasks/${id}`)).state).toBe("running");
          await closeConsole(client);
          expect(existsSync(join(work, ".console/instance.json"))).toBe(false);
          expect(run("systemctl", [...unitArgs, "show", "-p", "ActiveState", "--value", checkedUnit(id)]).out).toBe("active");
          rmSync(hold);
          await until("the detached web upgrade result", () => taskResult(work, id), 120_000);
          const reopened = await openConsole();
          await finished(reopened, id);
          expect(await reopened.json("/api/runtime")).toEqual({ current: true });
          expect({ head: head(), marker: marker() }).toEqual({ head: target, marker: "W" });
          expect((await reopened.json<{ tasks: { id: string }[] }>("/api/tasks")).tasks.some(task => task.id === id)).toBe(true);
          await converses("after the detached web upgrade");
          rmSync(held); await closeConsole(reopened); accepted = target;
        }, 1_200_000);

        dependent("web console: redeploy and repair use saved choices and report ready", async () => {
          const client = await openConsole();
          for (const operation of ["deploy", "repair"]) {
            const settings = await client.json<{ port: number; workspace: string }>("/api/lifecycle/deploy");
            expect(settings.port).toBe(port);
            const id = await submit(client, operation, { port: settings.port, workspace: settings.workspace,
              cleanup: "apply", directory: "saved" });
            await finished(client, id);
            expect(head()).toBe(accepted);
          }
          await converses("after web redeploy and repair"); await closeConsole(client);
        }, 1_800_000);

        for (const action of ["resume", "rollback"] as const) dependent(`web console: SIGKILL during cleanup then ${action}`, async () => {
          const path = join(work, "data/conversations/groups", `web-${action}`, "durable.sqlite");
          await writeLongChains(path, 200);
          if (operator === "root") must("chown", ["-R", identity, dirname(path)]);
          const before = readQuietly(path, chainState), original = { head: head(), image: bot().image };
          const target = publish(upstream, `web kill ${action}`, () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), action));
          const hold = join(work, "data/hold-cleanup"), held = join(work, "data/state/cleanup-held");
          writeFileSync(hold, "");
          const client = await openConsole(), id = await update(client, target);
          const container = await until("the web cleanup commit", () => {
            const result = taskResult(work, id); if (result) throw new Error(JSON.stringify(result));
            return existsSync(held) && readFileSync(held, "utf8").trim();
          }, 900_000);
          await killTask(id);
          expect(containers().some(item => ours(item) && item.id.startsWith(container))).toBe(true);
          must("docker", ["kill", container]);
          await until("the killed web cleanup container", () => docker("container", "inspect", container).code !== 0, 60_000);
          rmSync(hold); rmSync(held);
          expect(readJournal(join(work, "data"))?.current?.space).toBe(`groups/web-${action}`);
          await closeConsole(client);
          const recovery = await openConsole();
          expect(await recovery.json(`/api/tasks/${id}`)).toMatchObject({ state: "interrupted", needsRecovery: true });
          expect(await recovery.json("/api/lifecycle")).toMatchObject({ pending: { canResume: true, canRollback: true } });
          const resumed = await submit(recovery, action, {});
          await finished(recovery, resumed);
          expect(head()).toBe(action === "resume" ? target : original.head);
          if (action === "rollback") expect(bot().image).toBe(original.image);
          expect(readQuietly(path, chainState).values).toEqual(before.values);
          if (action === "resume") {
            const after = readQuietly(path, chainState);
            for (const [key, revisions] of Object.entries(before.chains)) {
              const kind = readQuietly(path, db => kindOf(db, Number(key)));
              expect([kind, after.chains[Number(key)]]).toEqual([kind, revisions > 64 && kind.startsWith("mixin.") ? 1 : revisions]);
            }
            accepted = target;
          }
          await closeConsole(recovery);
        }, 1_800_000);

        dependent("web console: committed interruption rejects rollback and resumes the recorded image", async () => {
          const target = publish(upstream, "web committed", () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), "committed"));
          const hold = join(work, "data/hold-health"), held = join(work, "data/state/health-held");
          writeFileSync(hold, "committed");
          const client = await openConsole(), id = await update(client, target);
          await until("the web committed activation", () => {
            const result = taskResult(work, id); if (result) throw new Error(JSON.stringify(result));
            return existsSync(held);
          }, 900_000);
          expect({ head: head(), phase: JSON.parse(readFileSync(join(work, "data/state/release-data.json"), "utf8")).phase }).toEqual({ head: target, phase: "committed" });
          await killTask(id); await closeConsole(client);
          const recovery = await openConsole(), image = bot().image;
          expect(await recovery.json("/api/lifecycle")).toMatchObject({ pending: { committed: true, canResume: true, canRollback: false } });
          expect((await recovery.request("/api/plans", { operation: "rollback", params: {} })).status).toBe(409);
          expect({ head: head(), image: bot().image, pending: pending() }).toEqual({ head: target, image, pending: true });
          rmSync(hold);
          const resumed = await submit(recovery, "resume", {}), output = await finished(recovery, resumed);
          expect(output).not.toContain("构建目标版本");
          expect(bot().image).toBe(image); expect(head()).toBe(target);
          rmSync(held); await closeConsole(recovery); accepted = target;
        }, 1_200_000);

        dependent("web console: bad target rolls back and a later good target upgrades", async () => {
          const verify = join(upstream, "src/server/verify.ts"), originalVerify = readFileSync(verify, "utf8");
          const broken = publish(upstream, "web bad target", () => prepend(verify, 'throw new Error("fixture: verification failure");'));
          const before = bot().image, client = await openConsole();
          await finished(client, await update(client, broken), "failed");
          expect({ head: head(), image: bot().image }).toEqual({ head: accepted, image: before });
          await closeConsole(client);
          const target = publish(upstream, "web good target", () => {
            writeFileSync(verify, originalVerify); writeFileSync(join(upstream, "src/upgrade-marker.txt"), "G");
          });
          const next = await openConsole();
          await finished(next, await update(next, target));
          expect({ head: head(), marker: marker() }).toEqual({ head: target, marker: "G" });
          await converses("after web automatic rollback and good upgrade"); await closeConsole(next); accepted = target;
        }, 1_800_000);
        return;
      }

      // F2: the final workspace is checked in host path space before the stop. A link that resolves into the project's
      // logs/ is refused there: the service keeps running unchanged, no transaction is recorded and the saved setting
      // stays. (A path inside data/ never gets that far: the task mapping refuses mount roots that overlap data/.)
      dependent("an unusable WORKSPACE_ROOT (a link into the project's logs/) is refused before the stop", async () => {
        const link = join(root, `${layout}-workspace-link`);
        symlinkSync(join(work, "logs"), link);
        const savedPath = join(work, "data/state/workspace-root");
        const saved = () => existsSync(savedPath) ? readFileSync(savedPath, "utf8") : null;
        const before = bot(), count = snapshots(), setting = saved();
        try {
          const result = await start(root, `${layout}-illegal-workspace`, ["scripts/deploy/deploy.sh"], work,
            { ...env(), WORKSPACE_ROOT: link }, deployAnswers).done;
          expect(result.code === 0, result.output.slice(-3000)).toBe(false);
          expect(result.output).toContain("位于受管目录");
          expect(result.output).toContain("共享资料目录不能使用");
          expect(result.output).toContain("服务尚未停止");
          expect(result.output).not.toContain("停机前复核剩余空间");
        } finally { rmSync(link); }
        expect(saved()).toBe(setting);
        expect(bot()).toEqual(before);
        expect({ head: head(), pending: pending(), stages: stages(), snapshots: snapshots(), previews: previews(root).length })
          .toEqual({ head: accepted, pending: false, stages: [], snapshots: count, previews: 0 });
        expect(labelled("{{.Tag}}").split("\n").filter(tag => tag.startsWith("candidate-"))).toEqual([]);
        expect(digest(fixture)).toEqual(baseline);
        externalUnchanged();
        expect(healthy()).toBe(true);
      }, 1_800_000);

      dependent("upgrade previews in the candidate image, then restarts on the target commit as the same identity", async () => {
        const target = publish(upstream, "target A", () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), "A"));
        const before = bot();
        const result = await start(root, `${layout}-upgrade-a`, ["scripts/ops/ops.sh", "update"], work, env()).done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(head()).toBe(target);
        expect(bot()).toMatchObject({ running: true, user: identity });
        expect(bot().image).not.toBe(before.image);
        // The official tag names the image the service runs, by ID.
        expect(docker("image", "inspect", "--format", "{{.Id}}", "mixin-chatbot").out).toBe(bot().image);
        expect(marker()).toBe("A");
        expect(healthy()).toBe(true);
        expect(digest(fixture)).toEqual(baseline);
        externalUnchanged();
        expect({ pending: pending(), stages: stages(), previews: previews(root).length }).toEqual({ pending: false, stages: [], previews: 0 });
        accepted = target;
      }, 900_000);

      // A deployment without a directory scope (1.0.1 and earlier synced the whole directory without a record): the upgrade
      // asks before the stop, in the candidate image as the service identity with data/ read-only. Without a terminal or
      // BOT_DIRECTORY_SCOPE it stops there with the service untouched; with it, the plan is installed after the stop.
      if (layout === "default") dependent("an upgrade without a directory scope asks for it before the stop and installs it after the stop", async () => {
        const scopeFile = join(work, "data/config/directory.json");
        rmSync(scopeFile);
        const target = publish(upstream, "target S", () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), "S"));
        const before = bot();
        const refused = await start(root, `${layout}-scope-refused`, ["scripts/ops/ops.sh", "update"], work, env()).done;
        expect(refused.code === 0, refused.output.slice(-3000)).toBe(false);
        expect(refused.output).toContain("请设置 BOT_DIRECTORY_SCOPE=all");
        expect(refused.output).toContain("没有选定通讯录同步范围（原因见上方）；服务尚未停止，代码和数据未改动");
        expect({ bot: bot(), head: head(), scope: existsSync(scopeFile), pending: pending(), stages: stages(), previews: previews(root).length })
          .toEqual({ bot: before, head: accepted, scope: false, pending: false, stages: [], previews: 0 });
        expect(healthy()).toBe(true);
        const result = await start(root, `${layout}-scope-upgrade`, ["scripts/ops/ops.sh", "update"], work,
          { ...env(), BOT_DIRECTORY_SCOPE: "all" }).done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect({ head: head(), marker: marker(), user: bot().user }).toEqual({ head: target, marker: "S", user: identity });
        expect(JSON.parse(readFileSync(scopeFile, "utf8"))).toEqual({ format: 1, all: true });
        expect(await until("the upgraded service", () => healthy(), 60_000)).toBe(true);
        await converses("the service with the chosen directory scope");
        expect(digest(fixture)).toEqual(baseline);
        expect({ pending: pending(), stages: stages(), previews: previews(root).length }).toEqual({ pending: false, stages: [], previews: 0 });
        accepted = target;
      }, 900_000);

      /** Every value as before; each long chain of a bot document is one base, every other chain as before. */
      const compacted = (path: string, before: ChainState) => {
        const after = readQuietly(path, chainState);
        expect(after.values).toEqual(before.values);
        for (const [id, revisions] of Object.entries(before.chains)) {
          const kind = readQuietly(path, db => kindOf(db, Number(id)));
          expect([kind, after.chains[Number(id)]]).toEqual([kind, revisions > 64 && kind.startsWith("mixin.") ? 1 : revisions]);
        }
      };

      // A database of long chains of its own, an upgrade to a target whose cleanup holds after the first commit of a
      // document, and the upgrade and the cleanup's container killed there (a host that went down mid-document).
      const killCleanup = async (name: string, mark: string) => {
        const path = join(work, "data/conversations/groups", `fixture-cleanup-${name}`, "durable.sqlite");
        await writeLongChains(path, 200);
        if (operator === "root") must("chown", ["-R", identity, dirname(path)]);
        const before = readQuietly(path, chainState);
        const runPath = join(upstream, "src/durable/revision-cleanup/run.ts");
        const target = publish(upstream, `cleanup ${name}`, () => {
          const text = readFileSync(runPath, "utf8");
          if (!text.includes("fixture: hold cleanup")) {
            if (!text.includes(cleanupPoint)) throw new Error("run.ts has no point() to hold");
            writeFileSync(runPath, text.replace(cleanupPoint, holdCleanup));
          }
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), mark);
        });
        const hold = join(work, "data/hold-cleanup"), heldMark = join(work, "data/state/cleanup-held");
        writeFileSync(hold, "");
        const upgrade = start(root, `${layout}-cleanup-${name}`, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
        const container = await until("the held cleanup", () => existsSync(heldMark) && readFileSync(heldMark, "utf8").trim(), 900_000, upgrade);
        process.kill(-upgrade.child.pid!, "SIGKILL");
        const killed = await upgrade.done;
        expect(killed.output).toContain("整理会话库的旧修订链（先备份并验证要修改的会话库）");
        must("docker", ["kill", container]);
        await until("the killed cleanup container to go away", () => docker("container", "inspect", container).code !== 0, 60_000);
        rmSync(hold); rmSync(heldMark);
        // The killed ops.sh could not remove its export directory; recovery exports its own.
        for (const stage of stages()) rmSync(join(work, "tmp", stage), { recursive: true, force: true });
        const journal = readJournal(join(work, "data"))!;
        expect({ pending: pending(), state: journal.state, space: journal.current?.space })
          .toEqual({ pending: true, state: "running", space: `groups/fixture-cleanup-${name}` });
        return { path, before, target, journal, inFlight: journal.current!.document.id };
      };

      // An older release's long revision chains in a conversation database the running service has not opened (closed, so
      // without -wal and -shm): the upgrade previews it with data/ mounted read-only, decides without a terminal to clean up
      // after a backup, and after the stop cleans up in the candidate as the service identity, which writes the backup
      // below backup/ (owned by root in the root run). Every value stays; the database records no space, so the restarted
      // service reports it and leaves it alone.
      if (layout === "default") dependent("an upgrade cleans up long revision chains after the stop, as the service identity, after a verified backup", async () => {
        const groups = join(work, "data/conversations/groups"), path = join(groups, "fixture-long-chains", "durable.sqlite");
        const created = existsSync(groups) ? dirname(path) : groups;
        await writeLongChains(path, 200);
        if (operator === "root") must("chown", ["-R", identity, created]);
        const before = readQuietly(path, chainState);
        const target = publish(upstream, "target L", () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), "L"));
        const result = await start(root, `${layout}-revision-cleanup`, ["scripts/ops/ops.sh", "update"], work, env()).done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(result.output).toMatch(/停机后整理旧修订链，约 \d+ 分钟；先备份要修改的会话库/);
        expect(result.output).toMatch(/修订整理（运行 \S+）已完成：整理文档 10 份/);
        expect({ head: head(), marker: marker(), user: bot().user }).toEqual({ head: target, marker: "L", user: identity });
        expect(await until("the upgraded service", () => healthy(), 60_000)).toBe(true);
        await converses("the service after the revision cleanup");
        const journal = readJournal(join(work, "data"))!;
        expect(journal.state).toBe("finished");
        // The service identity on the host: the image's appuser in the root run, the deploying user under rootless.
        const owner = operator === "root" ? 1001 : process.getuid!();
        const backups = join(work, "backup/revision-cleanup"), backup = join(backups, journal.run, "groups-fixture-long-chains.sqlite");
        expect({ directory: statSync(backups).uid, run: statSync(join(backups, journal.run)).uid, backup: statSync(backup).uid })
          .toEqual({ directory: owner, run: owner, backup: owner });
        expect(readQuietly(backup, chainState)).toEqual(before);
        compacted(path, before);
        expect(digest(fixture)).toEqual(baseline);
        // Two day-to-day commands that run the image's scripts in a one-off container (the image once lacked a directory
        // they import).
        for (const [name, args, output] of [
          ["revision-status", ["revision-cleanup", "status"], `修订整理（运行 ${journal.run}）已完成`],
          ["stat", ["stat"], ""],
        ] as const) {
          const command = await start(root, `${layout}-${name}`, ["scripts/ops/ops.sh", ...args], work, env()).done;
          expect({ name, code: command.code, tail: command.output.slice(-2000) }).toMatchObject({ name, code: 0 });
          expect(command.output).toContain(output);
        }
        accepted = target;
      }, 900_000);

      // Resume runs the recorded cleanup again: it settles the document in flight, goes on with the same run and keeps the
      // backup it verified before the kill.
      if (layout === "default") dependent("an upgrade killed with a cleanup document in flight is finished by resume, which keeps the verified backup", async () => {
        const { path, before, target, journal } = await killCleanup("resume", "R");
        const backup = join(work, "backup/revision-cleanup", journal.run, "groups-fixture-cleanup-resume.sqlite");
        const kept = () => ({ ...digest([backup]), mtime: statSync(backup).mtimeMs });
        const saved = kept();
        const resume = await start(root, `${layout}-cleanup-resume-continue`, ["scripts/ops/ops.sh", "resume"], work, env()).done;
        expect({ code: resume.code, tail: resume.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(resume.output).toContain(`修订整理（运行 ${journal.run}）已完成`);
        expect({ head: head(), marker: marker(), pending: pending(), user: bot().user }).toEqual({ head: target, marker: "R", pending: false, user: identity });
        expect(await until("the resumed service", () => healthy(), 60_000)).toBe(true);
        await converses("the service after the resumed cleanup");
        const finished = readJournal(join(work, "data"))!;
        expect({ run: finished.run, state: finished.state, current: finished.current }).toEqual({ run: journal.run, state: "finished", current: undefined });
        expect(kept()).toEqual(saved);
        expect(readQuietly(backup, chainState)).toEqual(before);
        compacted(path, before);
        expect(digest(fixture)).toEqual(baseline);
        accepted = target;
      }, 1_800_000);

      // Rollback ends the run first: the document in flight is settled in the recorded candidate, then the previous
      // version's code, image and container come back. The rest of the chains stay as they were.
      if (layout === "default") dependent("an upgrade killed with a cleanup document in flight rolls back after settling the document", async () => {
        const previous = { image: bot().image, marker: marker() };
        const { path, before, journal, inFlight } = await killCleanup("rollback", "Q");
        const rollback = await start(root, `${layout}-cleanup-rollback-restore`, ["scripts/ops/ops.sh", "rollback"], work, env()).done;
        expect({ code: rollback.code, tail: rollback.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(rollback.output).toContain("回滚之前结束修订整理（先收尾在途文档）");
        expect({ head: head(), pending: pending(), image: bot().image, marker: marker(), user: bot().user })
          .toEqual({ head: accepted, pending: false, image: previous.image, marker: previous.marker, user: identity });
        expect(await until("the restored service", () => healthy(), 60_000)).toBe(true);
        await converses("the service after the rollback");
        const ended = readJournal(join(work, "data"))!;
        expect({ run: ended.run, state: ended.state, current: ended.current }).toEqual({ run: journal.run, state: "abandoned", current: undefined });
        const after = readQuietly(path, chainState);
        expect(after.values).toEqual(before.values);
        expect({ ...after.chains, [inFlight]: 0 }).toEqual({ ...before.chains, [inFlight]: 0 });
        expect(after.chains[inFlight]).toBe(1);
        expect(digest(fixture)).toEqual(baseline);
      }, 1_800_000);

      const labelled =(format: string) => docker("image", "ls", "--format", format, "--filter", `label=org.mixin-chatbot.project=${projectId(work)}`).out;
      const imageId = (reference: string) => docker("image", "inspect", "--format", "{{.Id}}", reference).out;
      // An image of the test's own to move tags onto: the base image plus this project's label, so the cleanup removes it.
      let decoyId = "";
      const decoy = () => {
        if (decoyId) return decoyId;
        const tag = `mixin-chatbot-fixture:decoy-${projectId(work)}`;
        const built = run("docker", ["build", "-q", "--label", `org.mixin-chatbot.project=${projectId(work)}`, "-t", tag, "-"], project, `FROM ${baseImage}\n`);
        if (built.code !== 0) throw new Error(`cannot build the decoy image: ${built.out}`);
        return decoyId = imageId(tag);
      };
      const held = () => stages().some(stage => existsSync(join(work, "tmp", stage, "preview/held")));
      const upgradeLog = () => {
        const directory = join(work, "logs/operations");
        const latest = readdirSync(directory).filter(name => name.startsWith("upgrade-")).sort().at(-1)!;
        return readFileSync(join(directory, latest), "utf8");
      };
      /** Containers the upgrade created, in order, and the image each was created from. */
      const created = (events: DockerEvent[]) => events.filter(event => event.Type === "container" && event.Action === "create")
        .map(event => ({ name: event.Actor.Attributes.name ?? "", image: event.Actor.Attributes.image ?? "", at: event.timeNano }));
      /** When the official tag first named the image (containerd store: "mixin-chatbot:latest"). */
      const published = (events: DockerEvent[], id: string) => events.find(event => event.Type === "image" && event.Action === "tag" &&
        /^mixin-chatbot(:latest)?$/.test(event.Actor.Attributes.name ?? "") && event.Actor.ID === id)?.timeNano;

      // A target whose image takes 20 s longer to build. Meanwhile the original service keeps answering on its port and is
      // neither stopped nor replaced; the host load is recorded. The upgrade builds once, and every container it creates
      // runs the candidate by ID until the official tag names it. Files that are only in the work tree stay out of the image.
      // The operation log records the build and the downtime separately. The databases of the running service are in WAL
      // mode while the candidate previews the migration.
      if (layout === "default") dependent("a slowed build keeps the original service answering; one build, every container on the candidate ID, untracked files kept out", async () => {
        const dockerfile = join(upstream, "Dockerfile"), fast = readFileSync(dockerfile, "utf8");
        // BuildKit keeps the layer cache after the images are removed: a value of this run makes the slow step run again.
        const slow = `RUN sleep 20 && echo "fixture slow build ${process.pid}-${Date.now()}"`;
        const target = publish(upstream, "slow build", () => {
          writeFileSync(dockerfile, fast.replace("\nENV TZ=Asia/Shanghai\n", `\nENV TZ=Asia/Shanghai\n# fixture: slow build\n${slow}\n`));
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), "S");
        });
        expect(readFileSync(dockerfile, "utf8")).toContain(slow);
        writeFileSync(join(work, "src/untracked-probe.txt"), "work tree only"); writeFileSync(join(work, "local-notes.txt"), "work tree only");
        const wal = walFiles(join(work, "data"));
        const before = bot();
        const observed = observe(root, `${layout}-slow-build`);
        await Bun.sleep(1000);
        const polling = sampler(port, join(root, "logs", `${layout}-slow-build-samples.log`));
        const upgrade = start(root, `${layout}-slow-build`, ["scripts/ops/ops.sh", "update"], work, { ...env(), PATH: observed.path });
        const at = marks(upgrade, { build: "构建目标版本", built: "镜像构建成功", stop: "记录升级事务并停止机器人服务", done: "升级完成" });
        const started = Date.now();
        const result = await upgrade.done;
        await polling.finish();
        const seen = await observed.finish();
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect({ head: head(), marker: marker(), pending: pending(), stages: stages() }).toEqual({ head: target, marker: "S", pending: false, stages: [] });
        const candidate = bot().image;
        expect(imageId("mixin-chatbot")).toBe(candidate); expect(candidate).not.toBe(before.image);
        // The original service answered throughout the build and until the upgrade began to stop it, unchanged.
        expect(Object.keys(at).sort()).toEqual(["build", "built", "done", "stop"]);
        const buildMs = at.built! - at.build!;
        expect(buildMs).toBeGreaterThanOrEqual(20_000);
        const serving = polling.samples.filter(sample => sample.t < at.stop! - 1000);
        const duringBuild = serving.filter(sample => sample.t >= at.build! && sample.t <= at.built!);
        expect(duringBuild.length).toBeGreaterThanOrEqual(20);
        expect(serving.filter(sample => !sample.ok || !sample.running || sample.id !== before.id || sample.started !== before.started)).toEqual([]);
        const failures = polling.samples.filter(sample => !sample.ok);
        const outage = failures.length ? { from: failures[0]!.t, to: polling.samples.find(sample => sample.ok && sample.t > failures.at(-1)!.t)?.t ?? null } : null;
        // One build; every container before the official tag moved was created from the candidate's ID.
        const builds = seen.calls.filter(call => /^(buildx )?build /.test(call));
        expect(builds).toHaveLength(1);
        const publishedAt = published(seen.events, candidate);
        expect(publishedAt).toBeDefined();
        const containers = created(seen.events);
        expect(containers.filter(item => item.at < publishedAt!).map(item => item.image).filter(image => image !== candidate)).toEqual([]);
        expect(containers.some(item => item.name.startsWith("mixin-chatbot-preview-"))).toBe(true);
        // Later one-off containers name the official tag, which no event moved again.
        expect(seen.events.filter(event => event.Type === "image" && event.Action === "tag" && event.timeNano > publishedAt! &&
          /^mixin-chatbot(:latest)?$/.test(event.Actor.Attributes.name ?? ""))).toEqual([]);
        // Built from the target commit, not the work tree.
        expect(docker("image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', candidate).out).toBe(target);
        expect(docker("exec", "mixin-chatbot", "test", "-e", "/app/src/untracked-probe.txt").code).not.toBe(0);
        expect(docker("exec", "mixin-chatbot", "test", "-e", "/app/local-notes.txt").code).not.toBe(0);
        expect(readFileSync(join(work, "src/untracked-probe.txt"), "utf8")).toBe("work tree only");
        const operations = upgradeLog();
        const build = Number(/candidate build took (\d+)s; exit=0/.exec(operations)?.[1]), downtime = Number(/service back \(new version healthy\); downtime (\d+)s/.exec(operations)?.[1]);
        expect(build).toBeGreaterThanOrEqual(20); expect(downtime).toBeGreaterThanOrEqual(0);
        expect(operations.indexOf("candidate build took")).toBeLessThan(operations.indexOf("service stopped; downtime begins"));
        expect(await until("the upgraded service", () => healthy(), 60_000)).toBe(true);
        expect(digest(fixture)).toEqual(baseline);
        const evidence = { operator, candidate, previous: before.image, buildMs, loggedBuildS: build, loggedDowntimeS: downtime,
          observedOutageMs: outage && outage.to ? outage.to - outage.from : null, samples: polling.samples.length, servingSamples: serving.length,
          buildSamples: duringBuild.length, totalMs: Date.now() - started, wal, builds, containers, load: polling.load };
        writeFileSync(join(root, "logs", `${layout}-slow-build-evidence.json`), JSON.stringify(evidence, null, 2));
        console.log(`slow build evidence (${operator}): ${JSON.stringify({ ...evidence, load: polling.load.length, containers: containers.length })}`);
        for (const line of polling.load) console.log(`  load ${line}`);
        rmSync(join(work, "src/untracked-probe.txt")); rmSync(join(work, "local-notes.txt"));
        // The next targets build at the usual speed again.
        publish(upstream, "fast build", () => writeFileSync(dockerfile, fast));
        accepted = target;
      }, 1_200_000);

      // Tags are not identities. This upgrade's reserved tag moved to another image while the preview waits: the check
      // before the stop refuses, the service keeps running, and the moved tag is kept and reported, not removed.
      if (layout === "default") dependent("moving the reserved tag while the upgrade previews stops it before the stop; the moved tag is kept", async () => {
        const runPath = join(upstream, "scripts/runtime/data-current.ts"), gate = join(work, "data/preview-gate");
        publish(upstream, "preview gate", () => prepend(runPath, previewGate));
        const before = bot(), count = snapshots(), other = decoy();
        writeFileSync(gate, "");
        const upgrade = start(root, `${layout}-reserved-tag`, ["scripts/ops/ops.sh", "update"], work, env());
        await until("the held preview", () => held(), 900_000, upgrade);
        const reserved = labelled("{{.Repository}}:{{.Tag}}").split("\n").filter(tag => tag.includes(":candidate-"));
        expect(reserved).toHaveLength(1);
        must("docker", ["tag", other, reserved[0]!]);
        rmSync(gate);
        const result = await upgrade.done;
        expect(result.code === 0, result.output.slice(-3000)).toBe(false);
        expect(result.output).toContain("候选镜像核对未通过");
        expect(result.output).toContain(`保留标签 ${reserved[0]} 已指向其他镜像`);
        expect(bot()).toEqual(before);
        expect({ head: head(), pending: pending(), stages: stages(), snapshots: snapshots(), previews: previews(root).length })
          .toEqual({ head: accepted, pending: false, stages: [], snapshots: count, previews: 0 });
        expect(imageId(reserved[0]!)).toBe(other);
        expect(digest(fixture)).toEqual(baseline);
        expect(healthy()).toBe(true);
        // The test moved it; untagging leaves the decoy under its own tag.
        must("docker", ["image", "rm", reserved[0]!]);
        expect(imageId(other)).toBe(other);
      }, 1_200_000);

      // The official tag moved to another image while the preview waits: the migration, the verification instance and the
      // service still run the candidate by ID, and publishing moves the tag back to it.
      if (layout === "default") dependent("moving the official tag while the upgrade previews does not change the image it runs", async () => {
        const gate = join(work, "data/preview-gate");
        const target = publish(upstream, "official tag moved", () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), "T"));
        const base = decoy(), previous = bot().image;
        const observed = observe(root, `${layout}-official-tag`);
        await Bun.sleep(1000);
        writeFileSync(gate, "");
        const upgrade = start(root, `${layout}-official-tag`, ["scripts/ops/ops.sh", "update"], work, { ...env(), PATH: observed.path });
        await until("the held preview", () => held(), 900_000, upgrade);
        must("docker", ["tag", base, "mixin-chatbot"]);
        rmSync(gate);
        const result = await upgrade.done;
        const seen = await observed.finish();
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect({ head: head(), marker: marker(), pending: pending(), stages: stages() }).toEqual({ head: target, marker: "T", pending: false, stages: [] });
        const candidate = bot().image;
        expect([candidate === base, candidate === previous, imageId("mixin-chatbot") === candidate]).toEqual([false, false, true]);
        const publishedAt = published(seen.events, candidate);
        expect(publishedAt).toBeDefined();
        const containers = created(seen.events).filter(item => item.at < publishedAt!);
        expect(containers.length).toBeGreaterThanOrEqual(2);
        expect(containers.map(item => item.image).filter(image => image !== candidate)).toEqual([]);
        expect(seen.calls.filter(call => /^(buildx )?build /.test(call))).toHaveLength(1);
        console.log(`official tag evidence (${operator}): ${JSON.stringify({ candidate, base, previous, containers })}`);
        expect(await until("the upgraded service", () => healthy(), 60_000)).toBe(true);
        expect(digest(fixture)).toEqual(baseline);
        accepted = target;
      }, 1_200_000);

      // Killed after the data commit, while the new instance's first health check waits: the transaction stays with the
      // new code and the committed data. Rollback is refused before anything changes; resume only activates the recorded
      // image (no build, pull or migration), publishes the official tag and releases the reserved and rollback tags.
      if (layout === "default") dependent("an upgrade killed after the data commit refuses rollback and is finished by resume on the recorded image", async () => {
        const healthPath = join(upstream, "scripts/ops/health-check.ts");
        const hold = join(work, "data/hold-health"), heldMark = join(work, "data/state/health-held");
        const target = publish(upstream, "hold after commit", () => {
          if (!readFileSync(healthPath, "utf8").includes("fixture: hold health")) prepend(healthPath, holdHealth);
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), "K");
        });
        const previous = bot().image;
        writeFileSync(hold, "");
        const upgrade = start(root, `${layout}-kill-committed`, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
        await until("the held activation", () => existsSync(heldMark), 900_000, upgrade);
        process.kill(-upgrade.child.pid!, "SIGKILL");
        await upgrade.done;
        // The killed ops.sh could not remove its export directory; recovery exports its own.
        for (const stage of stages()) rmSync(join(work, "tmp", stage), { recursive: true, force: true });
        const snapshot = readFileSync(join(work, "data/state/deploy-transaction"), "utf8").trim();
        const recorded = /^image_id=(sha256:[0-9a-f]{64})$/m.exec(readFileSync(join(work, "backup/snapshots", snapshot, "candidate-image"), "utf8"))?.[1] ?? "no recorded image";
        const state = () => ({ pending: pending(), head: head(), running: bot().running, image: bot().image, official: imageId("mixin-chatbot") });
        const killed = state();
        expect(killed).toEqual({ pending: true, head: target, running: true, image: recorded, official: previous });
        const rollback = await start(root, `${layout}-kill-committed-rollback`, ["scripts/ops/ops.sh", "rollback"], work, env()).done;
        expect({ failed: rollback.code !== 0, committed: rollback.output.includes("已经提交") }, rollback.output.slice(-3000)).toEqual({ failed: true, committed: true });
        expect(state()).toEqual(killed);
        rmSync(hold);
        const resume = await start(root, `${layout}-kill-committed-resume`, ["scripts/ops/ops.sh", "resume"], work, env()).done;
        expect({ code: resume.code, tail: resume.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(resume.output).toContain("不再迁移或重建"); expect(resume.output).not.toContain("构建目标版本");
        expect({ ...state(), marker: marker() }).toEqual({ pending: false, head: target, running: true, image: recorded, official: recorded, marker: "K" });
        expect(labelled("{{.Tag}}").split("\n").filter(tag => tag.startsWith("candidate-") || tag === "previous")).toEqual([]);
        expect(docker("container", "inspect", "mixin-chatbot-rollback").code).not.toBe(0);
        expect(await until("the resumed service", () => healthy(), 60_000)).toBe(true);
        expect(digest(fixture)).toEqual(baseline);
        rmSync(heldMark, { force: true });
        accepted = target;
      }, 1_800_000);

      // A saved port below the unprivileged start. Whether rootlesskit may bind it (CAP_NET_BIND_SERVICE) is asked of the
      // daemon itself, not of the check under test. Refused: the upgrade stops before the preview and the stop.
      // Allowed: it upgrades onto that port and the service answers there.
      if (rootless && unprivilegedStart > 1) dependent("rootless: a saved privileged port is refused before the stop, or used when rootlesskit may bind it", async () => {
        const low = Math.min(1011, unprivilegedStart - 1), portFile = join(work, "data/state/bot-port");
        const probe = docker("run", "--rm", "-p", `127.0.0.1:${low}:${low}`, baseImage, "true");
        const allowed = probe.code === 0;
        if (!allowed && !/cannot expose privileged port|bind: permission denied/.test(probe.out)) {
          throw new Error(`cannot tell whether port ${low} is publishable: ${probe.out}`);
        }
        const target = publish(upstream, "rootless port", () => writeFileSync(join(upstream, "src/rootless-port-fixture.txt"), "pending"));
        const before = bot(), count = snapshots();
        writeFileSync(portFile, String(low));
        let moved = false;
        try {
          const result = await start(root, `${layout}-rootless-port`, ["scripts/ops/ops.sh", "update"], work, env()).done;
          if (allowed) {
            expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
            expect(result.output).not.toContain("rootless Docker 不能发布");
            // The service now listens on the saved privileged port; the following steps use it.
            port = low; moved = true;
            expect(head()).toBe(target);
            expect(await until("the service on the privileged port", () => healthy(), 60_000)).toBe(true);
            expect(digest(fixture)).toEqual(baseline);
            accepted = target;
          } else {
            expect(result.code === 0).toBe(false);
            expect(result.output).toContain(`rootless Docker 不能发布低于 ${unprivilegedStart} 的端口 ${low}`);
            expect(bot()).toEqual(before);
            expect({ head: head(), pending: pending(), stages: stages(), snapshots: snapshots(), previews: previews(root).length })
              .toEqual({ head: accepted, pending: false, stages: [], snapshots: count, previews: 0 });
            expect(digest(fixture)).toEqual(baseline);
            expect(healthy()).toBe(true);
          }
        } finally { if (!moved) writeFileSync(portFile, String(port)); }
      }, 900_000);

      // The target's preview is held open so the interruption lands while the preview container runs.
      for (const signal of ["SIGINT to the process group", "SIGTERM to ops.sh"] as const) {
        dependent(`cancelling the preview (${signal}) leaves the running service, code and data untouched`, async () => {
          const runPath = join(upstream, "scripts/runtime/data-current.ts");
          if (!readFileSync(runPath, "utf8").includes("fixture: hold preview")) {
            publish(upstream, "hold preview", () => prepend(runPath, 'if (process.argv.includes("preview")) await Bun.sleep(600_000); // fixture: hold preview'));
          }
          const before = bot(), count = snapshots();
          const upgrade = start(root, `${layout}-cancel-${signal.startsWith("SIGINT") ? "int" : "term"}`, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
          const preview = await until("the preview container", () => previews(root)[0], 300_000, upgrade);
          // Offline, in the candidate image, as the service identity; data read-only.
          expect({ image: preview.image.startsWith("sha256:"), user: preview.user }).toEqual({ image: true, user: identity });
          const mounts = Object.fromEntries(preview.mounts.map(mount => [mount.Destination, mount.RW]));
          // The data gate reads data/ only; the shared workspace is not mounted into the preview. Its layout was checked
          // just before, in a container of its own that sees the final workspace read-only at its host path
          // (check_workspace_layout in scripts/lib/deployment.sh).
          expect(mounts).toMatchObject({ "/app/data": false, "/preview": true });
          expect(mounts).not.toHaveProperty("/app/workspace");
          if (signal.startsWith("SIGINT")) process.kill(-upgrade.child.pid!, "SIGINT");
          else upgrade.child.kill("SIGTERM");
          const result = await upgrade.done;
          expect(result.code === 0).toBe(false);
          await until("the preview container to go away", () => previews(root).length === 0, 30_000);
          expect(bot()).toEqual(before);
          expect({ head: head(), pending: pending(), stages: stages(), snapshots: snapshots() })
            .toEqual({ head: accepted, pending: false, stages: [], snapshots: count });
          expect(digest(fixture)).toEqual(baseline);
          expect(healthy()).toBe(true);
          // Only this upgrade's reserved tag was taken, and it is released again.
          expect(docker("image", "ls", "--format", "{{.Tag}}", "--filter", `label=org.mixin-chatbot.project=${projectId(work)}`).out)
            .not.toContain("candidate-");
        }, 600_000);
      }

      // A terminal Ctrl+C reaches the whole foreground process group: sent over and over from the failed verification
      // until the rollback reports back, it must not cut short any of the Docker, migration or git steps.
      dependent("a target that fails verification rolls back to the previous image, code and data, with Ctrl+C reaching its process group meanwhile", async () => {
        const verify = join(upstream, "src/server/verify.ts");
        publish(upstream, "broken verification", () => {
          const runPath = join(upstream, "scripts/runtime/data-current.ts");
          writeFileSync(runPath, readFileSync(runPath, "utf8").replace(/^if \(process\.argv\.includes\("preview"\)\).*fixture: hold preview\n/m, ""));
          prepend(verify, 'throw new Error("fixture: verification failure");');
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), "B");
        });
        const before = bot(), kept = marker(), restored = "已自动恢复到操作前的状态";
        expect(kept).toMatch(/^[A-Z]$/);
        const upgrade = start(root, `${layout}-rollback`, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
        let output = "", interrupts = 0;
        const watch = (chunk: Buffer) => { output += chunk.toString(); };
        upgrade.child.stdout!.on("data", watch);
        upgrade.child.stderr!.on("data", watch);
        // The core announces the automatic rollback, with its cause, before the first restoration step.
        const timer = setInterval(() => {
          if (!output.includes("正在自动恢复到操作前的状态") || output.includes(restored)) return;
          try { process.kill(-upgrade.child.pid!, "SIGINT"); interrupts++; } catch { /* the group is gone */ }
        }, 200);
        const result = await upgrade.done.finally(() => clearInterval(timer));
        expect({ failed: result.code !== 0, interrupted: interrupts > 0, restored: result.output.includes(restored) })
          .toEqual({ failed: true, interrupted: true, restored: true });
        // The instance never became ready: its own last log lines say why.
        expect(result.output).toContain("fixture: verification failure");
        expect({ head: head(), pending: pending(), stages: stages() }).toEqual({ head: accepted, pending: false, stages: [] });
        expect(bot()).toMatchObject({ running: true, image: before.image, user: identity });
        expect(docker("image", "inspect", "--format", "{{.Id}}", "mixin-chatbot").out).toBe(before.image);
        expect(marker()).toBe(kept);
        expect(await until("the restored service", () => healthy(), 60_000)).toBe(true);
        expect(existsSync(join(work, "data/state/verify-only"))).toBe(false);
        expect(digest(fixture)).toEqual(baseline);
        externalUnchanged();
        expect(previews(root).length).toBe(0);
      }, 900_000);

      dependent("after the rollback the next good target upgrades normally", async () => {
        const target = publish(upstream, "target C", () => {
          const verify = join(upstream, "src/server/verify.ts");
          writeFileSync(verify, readFileSync(verify, "utf8").replace(/^throw new Error\("fixture: verification failure"\);\n/m, ""));
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), "C");
        });
        const result = await start(root, `${layout}-upgrade-c`, ["scripts/ops/ops.sh", "update"], work, env()).done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(head()).toBe(target);
        expect(marker()).toBe("C");
        expect(bot().user).toBe(identity);
        expect(healthy()).toBe(true);
        await converses("the upgraded service");
        expect(digest(fixture)).toEqual(baseline);
        externalUnchanged();
        if (operator === "root") {
          // Cancelled previews and rolled-back candidates were also loaded by ID into the task daemon.
          // A later successful commit must collect those copies, retaining the current worker image.
          const copies = docker("--host", TASK_DAEMON, "image", "ls", "-aq", "--no-trunc", "--filter",
            `label=org.mixin-chatbot.project=${projectId(work)}`);
          expect(copies.code, copies.out).toBe(0);
          expect([...new Set(copies.out.split("\n").filter(Boolean))]).toEqual([bot().image]);
        }
        removeOurContainers();
      }, 900_000);
    });
  }

});
