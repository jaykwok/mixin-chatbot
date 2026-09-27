// Opt-in end-to-end check against a real Docker Engine with synthetic data: first deployment, upgrade,
// cancelled migration preview, rollback after a failed verification and a later successful upgrade.
// It builds the mixin-chatbot image and uses the fixed container names, so run it only on a disposable
// Docker host (a WSL distro or VM): MIXIN_REAL_DOCKER=1 bun run test tests/ops/real-docker.test.ts
// Run it once as an ordinary docker-group user and once as root; both container user choices differ. Against a rootless
// daemon (DOCKER_HOST) the container runs as root and ports are published; a privileged saved port is refused before the
// stop, or used when rootlesskit has CAP_NET_BIND_SERVICE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.MIXIN_REAL_DOCKER === "1" && process.platform === "linux";
const ROOT_PREFIX = "/var/tmp/mixin-real-docker-";
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

interface Container { id: string; name: string; image: string; sources: string[]; mounts: { Source: string; Destination: string; RW: boolean }[] }
function containers(): Container[] {
  const ids = must("docker", ["ps", "-aq", "--no-trunc"]).split("\n").filter(Boolean);
  if (!ids.length) return [];
  const inspected = JSON.parse(must("docker", ["inspect", ...ids])) as { Id: string; Name: string; Config: { Image: string };
    Mounts: { Source: string; Destination: string; RW: boolean }[] }[];
  return inspected.map(item => ({ id: item.Id, name: item.Name.replace(/^\//, ""), image: item.Config.Image,
    sources: item.Mounts.map(mount => mount.Source), mounts: item.Mounts }));
}
const ours = (container: Container) => container.sources.length > 0 && container.sources.every(source => source.startsWith(ROOT_PREFIX));
const previews = (root: string) => containers().filter(item => item.image === baseImage && item.sources.some(source => source.startsWith(root)));

// Everything the tests create; a mixin-chatbot container of a real deployment stops the run before any change.
function removeOurContainers(): void {
  for (const item of containers()) {
    if (!ours(item)) continue;
    if (item.name.startsWith("mixin-chatbot") || item.image === baseImage) docker("rm", "-f", item.id);
  }
}

interface Running { child: ChildProcess; done: Promise<{ code: number | null; signal: string | null; output: string }> }
// Answers each "?> " prompt line once, matched by text; unmatched prompts (headings) need no input.
function start(root: string, name: string, args: string[], cwd: string, env: Record<string, string>,
  answers: [RegExp, string][] = [], detached = false): Running {
  const child = spawn("bash", args, { cwd, detached, env: { ...passthrough, PATH: hostPath, LANG: "C.UTF-8", TERM: "dumb", ...env },
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

const git = (cwd: string, ...args: string[]) => must("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], cwd);
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

describe.skipIf(!enabled)(`real Docker upgrade lifecycle (uid ${process.getuid?.()})`, () => {
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
    mkdirSync(join(root, "logs"));
    console.log(`real Docker fixture: ${root} (Docker ${info.out})`);
  });

  afterAll(() => {
    if (!root) return;
    removeOurContainers();
    if (failed || process.env.MIXIN_REAL_DOCKER_KEEP === "1") console.log(`real Docker fixture kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  });

  for (const layout of ["default", "external"] as const) {
    describe(`${layout} group root`, () => {
      let work = "", upstream = "", groups = "", port = 0;
      let fixture: string[] = [];
      let baseline: Record<string, string> = {};
      let accepted = "";
      const env = () => ({ BOT_PORT: String(port), ALLOW_UNMANAGED_FIREWALL: "1" });
      const head = () => must("git", ["-C", work, "rev-parse", "HEAD"]);
      const bot = () => {
        const result = docker("inspect", "--format", "{{.Id}} {{.State.StartedAt}} {{.State.Running}} {{.Image}}", "mixin-chatbot");
        const [id = "", started = "", running = "", image = ""] = result.out.split(" ");
        return { id, started, running: running === "true", image };
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
        work = join(base, "work");
        upstream = join(base, "upstream");
        groups = layout === "default" ? join(work, "data/groups") : join(base, "group-data");
        port = await freePort();
        exportWorkingTree(work);
        git(work, "init", "-q", "-b", "main");
        git(work, "add", "-A");
        git(work, "commit", "-qm", "base");
        must("git", ["init", "-q", "--bare", "-b", "main", join(base, "origin.git")]);
        git(work, "remote", "add", "origin", join(base, "origin.git"));
        git(work, "push", "-q", "-u", "origin", "main");
        must("git", ["clone", "-q", join(base, "origin.git"), upstream]);

        mkdirSync(join(work, "data/config"), { recursive: true });
        mkdirSync(join(work, "data/runtime/pi"), { recursive: true });
        writeFileSync(join(work, "data/config/models.json"), JSON.stringify({ providers: { fixture: {
          api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
          models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 512, reasoning: false }],
        } } }));
        writeFileSync(join(work, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model" }));
        writeFileSync(join(work, "data/config/webhook-secret"), createHash("sha256").update(root).digest("hex"));
        mkdirSync(join(groups, "fixture-group/workspace"), { recursive: true });
        writeFileSync(join(groups, "fixture-group/workspace/notes.md"), "synthetic group data\n");
        fixture = [join(work, "data/config/models.json"), join(work, "data/config/webhook-secret"),
          join(work, "data/runtime/pi/settings.json"), join(groups, "fixture-group")];

        const deploy = start(root, `${layout}-deploy`, ["scripts/deploy/deploy.sh"], work,
          { ...env(), ...(layout === "external" ? { GROUP_DATA_ROOT: groups } : {}) },
          [[/机器人监听端口/, ""], [/输入 1 或 2/, "1"], [/Pi 群数据总根/, ""], [/是否重新配置 AI/, "n"]]);
        const result = await deploy.done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(bot().running).toBe(true);
        expect(await until("the deployed service", () => healthy(), 60_000)).toBe(true);
        expect(pending()).toBe(false);
        baseline = digest(fixture);
        accepted = head();
      }, 1_800_000);

      step("upgrade previews read-only, rebuilds and restarts on the target commit", async () => {
        const target = publish(upstream, "target A", () => writeFileSync(join(upstream, "src/upgrade-marker.txt"), "A"));
        const before = bot();
        const result = await start(root, `${layout}-upgrade-a`, ["scripts/ops/ops.sh", "update"], work, env()).done;
        expect({ code: result.code, tail: result.output.slice(-3000) }).toMatchObject({ code: 0 });
        expect(head()).toBe(target);
        expect(bot()).toMatchObject({ running: true });
        expect(bot().image).not.toBe(before.image);
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
          const mounts = Object.fromEntries(preview.mounts.map(mount => [mount.Destination, mount.RW]));
          expect(mounts).toMatchObject({ "/app/data": false, "/upgrade": false, "/preview": true,
            ...(layout === "external" ? { "/app/group-data": false } : {}) });
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
        }, 600_000);
      }

      step("a target that fails verification rolls back to the previous image, code and data", async () => {
        const verify = join(upstream, "src/server/verify.ts");
        publish(upstream, "broken verification", () => {
          const runPath = join(upstream, "scripts/migrations/run.ts");
          writeFileSync(runPath, readFileSync(runPath, "utf8").replace(/^if \(process\.argv\.includes\("preview"\)\).*fixture: hold preview\n/m, ""));
          prepend(verify, 'throw new Error("fixture: verification failure");');
          writeFileSync(join(upstream, "src/upgrade-marker.txt"), "B");
        });
        const before = bot();
        const result = await start(root, `${layout}-rollback`, ["scripts/ops/ops.sh", "update"], work, env()).done;
        expect(result.code === 0).toBe(false);
        expect({ head: head(), pending: pending(), stages: stages() }).toEqual({ head: accepted, pending: false, stages: [] });
        expect(bot()).toMatchObject({ running: true, image: before.image });
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
        expect(healthy()).toBe(true);
        expect(digest(fixture)).toEqual(baseline);
        removeOurContainers();
      }, 900_000);
    });
  }
});
