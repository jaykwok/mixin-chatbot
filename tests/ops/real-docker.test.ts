// Opt-in end-to-end check against a real Docker Engine with synthetic data: first deployment, upgrade,
// cancelled migration preview, rollback after a failed verification and a later successful upgrade.
// It builds the mixin-chatbot image and uses the fixed container names, so run it only on a disposable
// Docker host (a WSL distro or VM): MIXIN_REAL_DOCKER=1 bun run test tests/ops/real-docker.test.ts
// Run it as root against the rootful daemon, as the owner of a rootless daemon (DOCKER_HOST), and as an ordinary
// docker-group user against the rootful daemon:
// - root: the lifecycle above with the image's default identity, then an instance that a docker-group user deployed with
//   the 98f1b4a scripts is upgraded, resumed and rolled back by root through its old recovery entry, keeping the
//   original container's UID/GID and the owners of its existing data.
// - rootless: the lifecycle; the container runs as the mapped 0:0 and ports are published; a privileged saved port is
//   refused before the stop, or used when rootlesskit has CAP_NET_BIND_SERVICE.
// - docker-group user: deploying and upgrading are refused before any question, build or stop.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.MIXIN_REAL_DOCKER === "1" && process.platform === "linux";
const ROOT_PREFIX = "/var/tmp/mixin-real-docker-";
// The first upgrade to a version with candidate images starts from this commit's scripts.
const LEGACY_ENTRY = "98f1b4a94575ebeb0f4653e221ad6c701a00598e";
const baseImage = /^FROM\s+(oven\/bun:\S+)/m.exec(readFileSync(join(project, "Dockerfile"), "utf8"))?.[1] ?? "";
// Scripts must take the Docker path of a host without Bun (validate-models falls back to the image).
const hostPath = (process.env.PATH ?? "").split(":").filter(dir => dir && !existsSync(join(dir, "bun"))).join(":");
const passthrough = Object.fromEntries(["HOME", "USER", "DOCKER_HOST", "XDG_RUNTIME_DIR"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]!]));

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

interface Container { id: string; name: string; image: string; user: string; sources: string[]; mounts: { Source: string; Destination: string; RW: boolean }[] }
function containers(): Container[] {
  const ids = must("docker", ["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean);
  if (!ids.length) return [];
  const inspected = JSON.parse(must("docker", ["inspect", ...ids])) as { Id: string; Name: string; Config: { Image: string; User: string };
    Mounts: { Source: string; Destination: string; RW: boolean }[] }[];
  return inspected.map(item => ({ id: item.Id, name: item.Name.replace(/^\//, ""), image: item.Config.Image, user: item.Config.User,
    sources: item.Mounts.map(mount => mount.Source), mounts: item.Mounts }));
}
const ours = (container: Container) => container.sources.length > 0 && container.sources.every(source => source.startsWith(ROOT_PREFIX));
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
function removeOurImages(): void {
  for (const id of projects) {
    for (const image of new Set(docker("image", "ls", "-aq", "--no-trunc", "--filter", `label=org.mixin-chatbot.project=${id}`).out.split("\n").filter(Boolean))) {
      docker("image", "rm", "--force", image);
    }
  }
  for (const image of unlabelled) docker("image", "rm", "--force", image);
}

interface Running { child: ChildProcess; done: Promise<{ code: number | null; signal: string | null; output: string }> }
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
  const done = new Promise<{ code: number | null; signal: string | null; output: string }>(resolve => child.on("close", (code, signal) => {
    writeFileSync(join(root, "logs", `${name}.log`), output);
    resolve({ code, signal, output });
  }));
  return { child, done };
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

// The owner of every file and directory below the paths.
function owners(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string) => {
    const info = lstatSync(path);
    result[path] = `${info.uid}:${info.gid}`;
    if (info.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
  };
  for (const path of paths) if (existsSync(path)) walk(path);
  return result;
}
/** Paths from before that still exist and now have another owner. */
function changedOwners(before: Record<string, string>): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [path, owner] of Object.entries(before)) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path), now = `${info.uid}:${info.gid}`;
    if (now !== owner) changed[path] = `${owner} -> ${now}`;
  }
  return changed;
}

async function until<T>(what: string, probe: () => T | undefined | false, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value;
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

// Synthetic configuration and group data; returns the files no operation may change.
function syntheticData(root: string, work: string, groups: string): string[] {
  mkdirSync(join(work, "data/config"), { recursive: true });
  mkdirSync(join(work, "data/runtime/pi"), { recursive: true });
  writeFileSync(join(work, "data/config/models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
    models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 512, reasoning: false }],
  } } }));
  writeFileSync(join(work, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
  writeFileSync(join(work, "data/config/webhook-secret"), createHash("sha256").update(root + work).digest("hex"));
  mkdirSync(join(groups, "fixture-group/workspace"), { recursive: true });
  writeFileSync(join(groups, "fixture-group/workspace/notes.md"), "synthetic group data\n");
  return [join(work, "data/config/models.json"), join(work, "data/config/webhook-secret"),
    join(work, "data/runtime/pi/settings.json"), join(groups, "fixture-group")];
}

const deployAnswers: [RegExp, string][] = [[/机器人监听端口/, ""], [/输入 1 或 2/, "1"], [/Pi 群数据总根/, ""], [/是否重新配置 AI/, "n"]];

describe.skipIf(!enabled)(`real Docker upgrade lifecycle (uid ${process.getuid?.()}, ${operator})`, () => {
  let root = "";
  let failed = false;
  const step = (name: string, body: () => Promise<void>, timeout: number) => test(name, async () => {
    try { await body(); } catch (error) { failed = true; throw error; }
  }, timeout);

  beforeAll(() => {
    if (!baseImage) throw new Error("Dockerfile has no oven/bun base image");
    const info = docker("info", "--format", "{{.ServerVersion}}");
    if (info.code !== 0) throw new Error(`Docker is not reachable: ${info.out}`);
    const foreign = containers().filter(item => item.name.startsWith("mixin-chatbot") && !ours(item));
    if (foreign.length) throw new Error(`refusing to run: containers of another deployment exist (${foreign.map(item => item.name).join(", ")})`);
    removeOurContainers();
    root = mkdtempSync(ROOT_PREFIX);
    // Another user deploys below it in the root run.
    chmodSync(root, 0o755);
    mkdirSync(join(root, "logs"));
    console.log(`real Docker fixture: ${root} (Docker ${info.out})`);
  });

  afterAll(() => {
    if (!root) return;
    removeOurContainers();
    removeOurImages();
    if (failed || process.env.MIXIN_REAL_DOCKER_KEEP === "1") console.log(`real Docker fixture kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });

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

  if (operator !== "group") for (const layout of ["default", "external"] as const) {
    describe(`${layout} group root`, () => {
      let work = "", upstream = "", groups = "", port = 0;
      let fixture: string[] = [];
      let baseline: Record<string, string> = {};
      let accepted = "";
      // The service identity: the mapped 0:0 under rootless, the image's appuser for root's first deployment.
      const identity = operator === "rootless" ? "0:0" : "1001:1001";
      const env = () => ({ BOT_PORT: String(port), ALLOW_UNMANAGED_FIREWALL: "1" });
      const head = () => git(work, "rev-parse", "HEAD");
      const bot = () => {
        const result = docker("inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.State.Running}} {{.Image}} {{.Config.User}}", "mixin-chatbot");
        const [id = "", started = "", running = "", image = "", user = ""] = result.out.split(" ");
        return { id, started, running: running === "true", image, user };
      };
      const marker = () => docker("exec", "mixin-chatbot", "cat", "/app/src/upgrade-marker.txt").out;
      // Ready inside the container and reachable on the host port, where the platform and the tunnel connect.
      const healthy = () => docker("exec", "mixin-chatbot", "bun", "run", "scripts/ops/health-check.ts").code === 0 &&
        spawnSync("curl", ["--noproxy", "*", "--max-time", "3", "-fsS", `http://127.0.0.1:${port}/health`]).status === 0;
      const pending = () => existsSync(join(work, "data/state/deploy-transaction"));
      const stages = () => existsSync(join(work, "tmp")) ? readdirSync(join(work, "tmp")).filter(entry => entry.startsWith("upgrade-")) : [];
      const snapshots = () => existsSync(join(work, "backup/snapshots")) ? readdirSync(join(work, "backup/snapshots")).length : 0;

      step("first deployment starts the service from synthetic data", async () => {
        const base = join(root, layout);
        ({ work, upstream } = repository(base, exportWorkingTree));
        projects.push(projectId(work));
        groups = layout === "default" ? join(work, "data/groups") : join(base, "group-data");
        port = await freePort();
        fixture = syntheticData(root, work, groups);
        const deploy = start(root, `${layout}-deploy`, ["scripts/deploy/deploy.sh"], work,
          { ...env(), ...(layout === "external" ? { GROUP_DATA_ROOT: groups } : {}) }, deployAnswers);
        const result = await deploy.done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(bot()).toMatchObject({ running: true, user: identity });
        expect(await until("the deployed service", () => healthy(), 60_000)).toBe(true);
        expect(pending()).toBe(false);
        baseline = digest(fixture);
        accepted = head();
      }, 1_800_000);

      step("upgrade previews in the candidate image, then restarts on the target commit as the same identity", async () => {
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
        expect({ pending: pending(), stages: stages(), previews: previews(root).length }).toEqual({ pending: false, stages: [], previews: 0 });
        accepted = target;
      }, 900_000);

      // A saved port below the unprivileged start. Whether rootlesskit may bind it (CAP_NET_BIND_SERVICE) is asked of the
      // daemon itself, not of the check under test. Refused: the upgrade stops before the preview and the stop.
      // Allowed: it upgrades onto that port and the service answers there.
      if (rootless && unprivilegedStart > 1) step("rootless: a saved privileged port is refused before the stop, or used when rootlesskit may bind it", async () => {
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
        step(`cancelling the preview (${signal}) leaves the running service, code and data untouched`, async () => {
          const runPath = join(upstream, "scripts/migrations/run.ts");
          if (!readFileSync(runPath, "utf8").includes("fixture: hold preview")) {
            publish(upstream, "hold preview", () => prepend(runPath, 'if (process.argv.includes("preview")) await Bun.sleep(600_000); // fixture: hold preview'));
          }
          const before = bot(), count = snapshots();
          const upgrade = start(root, `${layout}-cancel-${signal.startsWith("SIGINT") ? "int" : "term"}`, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
          const preview = await until("the preview container", () => previews(root)[0], 300_000);
          // Offline, in the candidate image, as the service identity; data and group roots read-only.
          expect({ image: preview.image.startsWith("sha256:"), user: preview.user }).toEqual({ image: true, user: identity });
          const mounts = Object.fromEntries(preview.mounts.map(mount => [mount.Destination, mount.RW]));
          expect(mounts).toMatchObject({ "/app/data": false, "/preview": true, ...(layout === "external" ? { "/app/group-data": false } : {}) });
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
      step("a target that fails verification rolls back to the previous image, code and data, with Ctrl+C reaching its process group meanwhile", async () => {
        const verify = join(upstream, "src/server/verify.ts");
        publish(upstream, "broken verification", () => {
          const runPath = join(upstream, "scripts/migrations/run.ts");
          writeFileSync(runPath, readFileSync(runPath, "utf8").replace(/^if \(process\.argv\.includes\("preview"\)\).*fixture: hold preview\n/m, ""));
          prepend(verify, 'throw new Error("fixture: verification failure");');
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), "B");
        });
        const before = bot(), restored = "已恢复配置、容器、网络入口和原运行状态";
        const upgrade = start(root, `${layout}-rollback`, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
        let output = "", interrupts = 0;
        const watch = (chunk: Buffer) => { output += chunk.toString(); };
        upgrade.child.stdout!.on("data", watch);
        upgrade.child.stderr!.on("data", watch);
        const timer = setInterval(() => {
          if (!/部署预检失败|部署预检超时|容器启动失败/.test(output) || output.includes(restored)) return;
          try { process.kill(-upgrade.child.pid!, "SIGINT"); interrupts++; } catch { /* the group is gone */ }
        }, 200);
        const result = await upgrade.done.finally(() => clearInterval(timer));
        expect({ failed: result.code !== 0, interrupted: interrupts > 0, restored: result.output.includes(restored) })
          .toEqual({ failed: true, interrupted: true, restored: true });
        expect({ head: head(), pending: pending(), stages: stages() }).toEqual({ head: accepted, pending: false, stages: [] });
        expect(bot()).toMatchObject({ running: true, image: before.image, user: identity });
        expect(docker("image", "inspect", "--format", "{{.Id}}", "mixin-chatbot").out).toBe(before.image);
        expect(marker()).toBe("A");
        expect(await until("the restored service", () => healthy(), 60_000)).toBe(true);
        expect(existsSync(join(work, "data/state/verify-only"))).toBe(false);
        expect(digest(fixture)).toEqual(baseline);
        expect(previews(root).length).toBe(0);
      }, 900_000);

      step("after the rollback the next good target upgrades normally", async () => {
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
        expect(digest(fixture)).toEqual(baseline);
        removeOurContainers();
      }, 900_000);
    });
  }

  // An instance a docker-group user deployed with the 98f1b4a scripts (its container runs as that user's UID:GID and
  // owns its data). Root upgrades it through the old recovery entry (first transition), then an upgrade interrupted
  // after the stop is resumed and another is rolled back. The UID/GID stays and no existing file changes owner.
  if (operator === "root") describe("instance deployed by a docker-group user", () => {
    let work = "", upstream = "", port = 0, user = "";
    let fixture: string[] = [], baseline: Record<string, string> = {}, before: Record<string, string> = {};
    let accepted = "";
    // The operator trusts the other user's checkout once (git config --global --add safe.directory), as documented.
    const env = () => ({ BOT_PORT: String(port), ALLOW_UNMANAGED_FIREWALL: "1", GIT_CONFIG_GLOBAL: join(root, "legacy/gitconfig") });
    const head = () => git(work, "rev-parse", "HEAD");
    const bot = () => {
      const [running = "", image = "", configured = ""] = docker("inspect", "--format", "{{.State.Running}} {{.Image}} {{.Config.User}}", "mixin-chatbot").out.split(" ");
      return { running: running === "true", image, user: configured };
    };
    const marker = () => docker("exec", "mixin-chatbot", "cat", "/app/src/upgrade-marker.txt").out;
    const healthy = () => docker("exec", "mixin-chatbot", "bun", "run", "scripts/ops/health-check.ts").code === 0 &&
      spawnSync("curl", ["--noproxy", "*", "--max-time", "3", "-fsS", `http://127.0.0.1:${port}/health`]).status === 0;
    const pending = () => existsSync(join(work, "data/state/deploy-transaction"));
    const kept = () => { expect(changedOwners(before)).toEqual({}); expect(digest(fixture)).toEqual(baseline); };
    // The migration apply of targets with this hook waits while data/hold-apply exists, after the stop and the checkout.
    const hold = 'if (process.argv.includes("apply") && (await import("node:fs")).existsSync("/app/data/hold-apply")) { (await import("node:fs")).writeFileSync("/app/data/apply-held", ""); await Bun.sleep(600_000); } // fixture: hold apply';
    const interrupted = async (name: string, marker: string) => {
      const target = publish(upstream, `target ${marker}`, () => {
        const runPath = join(upstream, "scripts/migrations/run.ts");
        if (!readFileSync(runPath, "utf8").includes("fixture: hold apply")) prepend(runPath, hold);
        writeFileSync(join(upstream, "src/upgrade-marker.txt"), marker);
      });
      writeFileSync(join(work, "data/hold-apply"), "");
      const upgrade = start(root, name, ["scripts/ops/ops.sh", "update"], work, env(), [], true);
      await until("the held migration", () => existsSync(join(work, "data/apply-held")), 900_000);
      process.kill(-upgrade.child.pid!, "SIGKILL");
      await upgrade.done;
      // The killed client leaves its migration container; nothing else of the upgrade runs.
      for (const item of containers()) if (ours(item) && !item.name.startsWith("mixin-chatbot")) docker("rm", "-f", item.id);
      rmSync(join(work, "data/hold-apply")); rmSync(join(work, "data/apply-held"));
      expect({ pending: pending(), head: head(), service: bot().running }).toEqual({ pending: true, head: target, service: false });
      return target;
    };

    step("a docker-group user deploys with the 98f1b4a scripts", async () => {
      removeOurContainers();
      const member = must("getent", ["group", "docker"]).split(":")[3]?.split(",").find(name => name && name !== "root");
      if (!member) throw new Error("this check needs an ordinary user in the docker group");
      const [uid = "", gid = ""] = [must("id", ["-u", member]), must("id", ["-g", member])];
      user = `${uid}:${gid}`;
      const base = join(root, "legacy");
      ({ work, upstream } = repository(base, target => {
        spawnSync("bash", ["-c", `git -c safe.directory='*' -C '${project}' archive ${LEGACY_ENTRY} | tar -x -C '${target}'`], { stdio: "inherit" });
        if (!existsSync(join(target, "scripts/deploy/deploy.sh"))) throw new Error(`cannot export ${LEGACY_ENTRY}; the history must include it`);
      }));
      projects.push(projectId(work));
      writeFileSync(join(base, "gitconfig"), `[safe]\n\tdirectory = ${work}\n`);
      port = await freePort();
      fixture = syntheticData(root, work, join(work, "data/groups"));
      // The user's own clone and data.
      spawnSync("chown", ["-R", user, work]);
      chownSync(base, Number(uid), Number(gid));
      const home = must("getent", ["passwd", member]).split(":")[5] ?? "/tmp";
      // The old scripts build without labels; an identical earlier build has the same ID and is not this run's to remove.
      const existing = new Set(docker("image", "ls", "-aq", "--no-trunc").out.split("\n"));
      const deploy = start(root, "legacy-deploy", ["scripts/deploy/deploy.sh"], work, { ...env(), HOME: home, USER: member }, deployAnswers, false,
        ["setpriv", "--reuid", uid, "--regid", gid, "--init-groups", "--"]);
      const result = await deploy.done;
      expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
      expect(bot()).toMatchObject({ running: true, user });
      if (!existing.has(bot().image)) unlabelled.push(bot().image);
      expect(await until("the deployed service", () => healthy(), 60_000)).toBe(true);
      baseline = digest(fixture);
      before = owners([join(work, "data"), join(work, "logs")]);
      expect(Object.values(before).every(owner => owner === user), JSON.stringify(before)).toBe(true);
      accepted = head();
    }, 1_800_000);

    step("root upgrades it through the old recovery entry and keeps the UID/GID", async () => {
      const target = publish(upstream, "current", () => {
        git(upstream, "rm", "-rq", ".");
        exportWorkingTree(upstream);
        writeFileSync(join(upstream, "src/upgrade-marker.txt"), "A");
      });
      // Without the operator's trust the old entry cannot read the checkout at all.
      const untrusted = await start(root, "legacy-untrusted", ["scripts/ops/ops.sh", "update"], work, { ...env(), GIT_CONFIG_GLOBAL: "/dev/null" }).done;
      expect(untrusted.code === 0).toBe(false);
      expect(head()).toBe(accepted);
      const result = await start(root, "legacy-upgrade", ["scripts/ops/ops.sh", "update"], work, env()).done;
      // The upgrade completes. The old entry's own check afterwards still runs its one-off container as 1001:1001, which
      // cannot read the service identity's 600 configuration, so only its model check fails; the new doctor passes.
      const plain = result.output.replace(/\x1b\[[0-9;]*m/g, "");
      expect({ code: result.code, done: plain.includes("升级完成："), models: plain.includes("[x] 模型配置（models.json + Pi 设置） 缺少或无效"),
        failed: /结果：\d+ 项通过，1 项失败/.test(plain) }, plain.slice(-3000)).toEqual({ code: 1, done: true, models: true, failed: true });
      const doctor = await start(root, "legacy-doctor", ["scripts/ops/ops.sh", "doctor"], work, env()).done;
      expect({ code: doctor.code, tail: doctor.output.slice(-3000) }).toMatchObject({ code: 0 });
      expect(result.output).toContain(`沿用原容器的运行身份 ${user}`);
      expect(head()).toBe(target);
      expect(bot()).toMatchObject({ running: true, user });
      expect(marker()).toBe("A");
      expect(await until("the upgraded service", () => healthy(), 60_000)).toBe(true);
      expect(pending()).toBe(false);
      kept();
      accepted = target;
    }, 1_800_000);

    step("an upgrade killed after the stop is resumed by root with the recorded image and identity", async () => {
      const target = await interrupted("legacy-kill-resume", "B");
      expect(readFileSync(join(work, `backup/snapshots/${readFileSync(join(work, "data/state/deploy-transaction"), "utf8").trim()}/service-user`), "utf8"))
        .toBe(`format=1\nuser=${user}\nsource=container\n`);
      const result = await start(root, "legacy-resume", ["scripts/ops/ops.sh", "resume"], work, env()).done;
      expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
      expect(result.output).toContain("不重新构建"); expect(result.output).not.toContain("构建目标版本");
      expect({ head: head(), pending: pending() }).toEqual({ head: target, pending: false });
      expect(bot()).toMatchObject({ running: true, user });
      expect(marker()).toBe("B");
      expect(await until("the resumed service", () => healthy(), 60_000)).toBe(true);
      kept();
      accepted = target;
    }, 1_800_000);

    step("an upgrade killed after the stop is rolled back by root to the previous image, code and identity", async () => {
      const previous = bot().image;
      await interrupted("legacy-kill-rollback", "C");
      const result = await start(root, "legacy-rollback", ["scripts/ops/ops.sh", "rollback"], work, env()).done;
      expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
      expect({ head: head(), pending: pending() }).toEqual({ head: accepted, pending: false });
      expect(bot()).toMatchObject({ running: true, image: previous, user });
      expect(docker("image", "inspect", "--format", "{{.Id}}", "mixin-chatbot").out).toBe(previous);
      expect(marker()).toBe("B");
      expect(await until("the restored service", () => healthy(), 60_000)).toBe(true);
      kept();
      expect(docker("image", "ls", "--format", "{{.Tag}}", "--filter", `label=org.mixin-chatbot.project=${projectId(work)}`).out)
        .not.toContain("candidate-");
      removeOurContainers();
    }, 1_800_000);
  });
});
