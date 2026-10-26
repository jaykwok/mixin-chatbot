// Opt-in short check of the task-daemon mapping proof against real Docker: the deployment preflight
// (task_runtime_manifest from scripts/lib/task-runtime.sh) on the default layout and on an external workspace mounted
// read-only, refusals for a twin directory and a missing one, and one real task that reads the materials, cannot write
// them and writes its own work directory in the request tmp. It builds a small image from the working tree on the
// oven/bun base (the service code, Bun and the Docker CLI; no document toolchain), labels it with this run and removes it
// by ID afterwards. It never touches containers it did not create or a container named mixin-chatbot.
//
// Two topologies, run one after the other on a disposable Docker host:
// - rootful service daemon + the service UID's rootless task daemon (run as root; tasks go to /run/user/1001):
//   MIXIN_REAL_DOCKER=1 bun run test tests/ops/real-docker-mapping.test.ts
// - one rootless daemon for both (run as its owner, with HOME, XDG_RUNTIME_DIR and DOCKER_HOST of that user).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.MIXIN_REAL_DOCKER === "1" && process.platform === "linux";
const ROOT_PREFIX = "/var/tmp/mixin-real-docker-mapping-";
const dockerfile = readFileSync(join(project, "Dockerfile"), "utf8");
const baseImage = /^FROM\s+(oven\/bun:\S+)\s*$/m.exec(dockerfile)?.[1] ?? "";
const cliImage = /^FROM\s+(docker:\S+)\s+AS\s+docker_cli\s*$/m.exec(dockerfile)?.[1] ?? "";
const passthrough = Object.fromEntries(["HOME", "USER", "PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]!]));

function run(command: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const result = spawnSync(command, args, { cwd: project, env: { ...passthrough, LANG: "C.UTF-8", ...env }, encoding: "utf8", input,
    maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}
function must(command: string, args: string[], env: Record<string, string> = {}): string {
  const result = run(command, args, env);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.out}\n${result.err}`);
  return result.out;
}
const docker = (...args: string[]) => run("docker", args);
const rootless = enabled && docker("info", "--format", "{{json .SecurityOptions}}").out.includes("name=rootless");
const operator = rootless ? "rootless" : process.getuid?.() === 0 ? "root" : "group";
// Rootless shares the deploying user's daemon; under root the service UID 1001 has its own rootless task daemon.
const taskEndpoint = rootless ? process.env.DOCKER_HOST ?? "" : "unix:///run/user/1001/docker.sock";
const serviceUser = rootless ? "0:0" : "1001:1001";
const onTask = (...args: string[]) => run("docker", ["--host", taskEndpoint, ...args]);
const daemonId = (host: string[]) => must("docker", [...host, "info", "--format", "{{.ID}}"]);

// Only the files the small image needs, taken from the working tree (tracked and untracked, not ignored).
function exportTree(target: string): void {
  const listed = (...args: string[]) => must("git", ["-c", "safe.directory=*", "-C", project, "ls-files", "-z", ...args]).split("\0").filter(Boolean);
  const wanted = (path: string) => ["package.json", "bun.lock"].includes(path) || ["src/", "scripts/"].some(prefix => path.startsWith(prefix));
  for (const path of new Set([...listed(), ...listed("--others", "--exclude-standard")])) {
    const from = join(project, path);
    if (!wanted(path) || !existsSync(from) || lstatSync(from).isDirectory() || lstatSync(from).isSymbolicLink()) continue;
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(from, join(target, path)); chmodSync(join(target, path), 0o644);
  }
  writeFileSync(join(target, "Dockerfile"), [
    `FROM ${cliImage} AS docker_cli`, `FROM ${baseImage}`,
    "COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker",
    "RUN groupadd -r -g 1001 appgroup && useradd -r -u 1001 -g appgroup -m -d /home/appuser -s /bin/bash appuser",
    "WORKDIR /app", "COPY package.json bun.lock ./", "COPY scripts/patches ./scripts/patches",
    "RUN bun install --frozen-lockfile --production", "COPY src ./src", "COPY scripts ./scripts", ""].join("\n"));
}

// Names, types, sizes, content digests and modification times of a tree (never access times).
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string, name: string) => {
    const info = lstatSync(path, { bigint: true });
    const kind = info.isDirectory() ? "d" : info.isFile() ? "f" : "o";
    result[name] = `${kind} ${info.mode.toString(8)} ${info.size} ${info.mtimeNs}` +
      (kind === "f" ? " " + createHash("sha256").update(readFileSync(path)).digest("hex") : "");
    if (kind === "d") for (const child of readdirSync(path).sort()) walk(join(path, child), name + "/" + child);
  };
  walk(root, ".");
  return result;
}

// The preflight exactly as deploy.sh/upgrade.sh run it. `mounted` is what is bound at /app/workspace, `claimed` the host
// path the preflight is told (they differ only in the refusal cases).
const PREFLIGHT = 'set -u; . "$1"; TASK_DOCKER_ENDPOINT="$2" TASK_DOCKER_ID=""; WORKSPACE_ARGS=(); ' +
  '[ -z "$3" ] || WORKSPACE_ARGS=(-v "$3:/app/workspace:ro" -e WORKSPACE_ROOT=/app/workspace); ' +
  'task_runtime_check_endpoint "$SERVICE_USER" "$DOCKER_ROOTLESS" && task_runtime_manifest check';

// Run inside the service container: allocate one real task, run it with the workspace as a read-only export, report.
const TASK_PROBE = `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RootlessTasks } from "/app/src/core/rootless-tasks.ts";
const [image, data, workspace] = process.argv.slice(2);
const launch = { version: 1 as const, image, controlRoot: "/app/data/runtime/task-control",
  mounts: [{ manager: "/app/data", daemon: data }, { manager: "/app/workspace", daemon: workspace }], imagePaths: ["/usr/local/bin/bun"] };
const mountOption = (text: string, path: string) => text.split("\\n").find(line => line.split(" ")[4] === path)?.split(" ")[5]?.split(",")[0] ?? null;
const tasks = new RootlessTasks(launch.controlRoot, image, undefined, undefined, launch);
await tasks.verifyDeployment();
let serviceWrite = "allowed";
try { await writeFile("/app/workspace/service-probe", "x"); } catch (error) { serviceWrite = (error as NodeJS.ErrnoException).code ?? String(error); }
const serviceMount = mountOption(await readFile("/proc/self/mountinfo", "utf8"), "/app/workspace");
const temp = "/app/data/tmp/probe-user";
await mkdir(temp, { recursive: true });
const task = await tasks.create(temp);
const worker = [
  "const fs = require('fs'), out = {};",
  "out.read = fs.readFileSync('/app/workspace/sub/a.txt', 'utf8');",
  "try { fs.writeFileSync('/app/workspace/worker-probe', 'x'); out.workspaceWrite = 'allowed'; } catch (e) { out.workspaceWrite = e.code; }",
  "fs.writeFileSync(process.cwd() + '/worker-output.txt', 'written by worker');",
  "const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\\\n');",
  "const option = p => { const l = lines.find(x => x.split(' ')[4] === p); return l ? l.split(' ')[5].split(',')[0] : null; };",
  "out.workspaceMount = option('/app/workspace'); out.workMount = option(process.cwd()); out.uid = process.getuid();",
  "process.stdout.write('WORKER=' + JSON.stringify(out));"].join(" ");
const result = await task.run({ command: "/usr/local/bin/bun", args: ["-e", worker], cwd: task.path, timeoutMs: 120_000 }, ["/app/workspace"]);
const written = await readFile(join(task.path, "worker-output.txt"), "utf8").catch(error => (error as NodeJS.ErrnoException).code);
await task.seal();
const reclaimed = (await tasks.reclaim(task.id)).status;
const report = /WORKER=(\\{.*\\})/.exec(result.output)?.[1];
console.log("PROBE=" + JSON.stringify({ serviceWrite, serviceMount, exitCode: result.exitCode, worker: report ? JSON.parse(report) : result.output, written, reclaimed }));
`;

describe.skipIf(!enabled || operator === "group")(`real Docker task mapping proof (uid ${process.getuid?.()}, ${operator})`, () => {
  let root = "", image = "", socket = "";
  const suffix = Math.random().toString(16).slice(2, 10);
  const label = `org.mixin-chatbot.mapping-test=${suffix}`;
  const daemons: Record<string, string> = {};
  let failed = false;
  const step = (name: string, body: () => void | Promise<void>, timeout = 180_000) => test(name, async () => {
    try { await body(); } catch (error) { failed = true; throw error; }
  }, timeout);

  // Every container on either daemon with a mount below this run's fixture; nothing else is touched.
  const ours = (host: string[]) => {
    const ids = run("docker", [...host, "ps", "-aq", "--no-trunc"]).out.split("\n").filter(Boolean);
    return ids.filter(id => {
      const mounts = run("docker", [...host, "container", "inspect", "--format", "{{json .Mounts}}", id]).out;
      return mounts.includes(root);
    });
  };
  const hosts = () => [[], ...(operator === "root" ? [["--host", taskEndpoint]] : [])];

  beforeAll(() => {
    if (!baseImage || !cliImage) throw new Error("Dockerfile has no oven/bun base or docker_cli stage");
    if (!taskEndpoint.startsWith("unix:///")) throw new Error("rootless run needs DOCKER_HOST of the daemon owner");
    socket = taskEndpoint.slice(7);
    if (statSync(socket).uid !== (rootless ? process.getuid!() : 1001)) throw new Error(`task socket ${socket} has the wrong owner`);
    for (const [name, host] of [["service", []], ["task", ["--host", taskEndpoint]]] as const) daemons[name] = daemonId([...host]);
    if (rootless && daemons.service !== daemons.task) throw new Error("rootless run: DOCKER_HOST and the task endpoint name different daemons");
    root = mkdtempSync(ROOT_PREFIX);
    // The task daemon of the root run belongs to UID 1001 and must traverse to the bind sources.
    chmodSync(root, 0o755);
    console.log(`mapping fixture ${root}; service daemon ${daemons.service}, task daemon ${daemons.task}, Bun ${Bun.version}`);
    const context = join(root, "image");
    exportTree(context);
    must("docker", ["build", "--pull=false", "--label", label, "--iidfile", join(root, "image-id"), context]);
    image = readFileSync(join(root, "image-id"), "utf8").trim();
    if (!/^sha256:[a-f\d]{64}$/.test(image)) throw new Error("build returned no image ID");
    if (operator === "root") {
      const loaded = spawnSync("bash", ["-c", 'set -o pipefail; docker image save "$1" | docker --host "$2" image load', "load", image, taskEndpoint],
        { env: { ...passthrough }, encoding: "utf8" });
      if (loaded.status !== 0) throw new Error("task daemon image load failed: " + loaded.stderr);
    }
    expect(onTask("image", "inspect", "--format", "{{.Id}}", image).out).toBe(image);
    console.log(`image ${image}; container Bun ${must("docker", ["run", "--rm", "--network", "none", "--entrypoint", "bun", image, "--version"])}`);
  }, 1_200_000);

  afterAll(() => {
    if (!root) return;
    for (const host of hosts()) for (const id of ours(host)) run("docker", [...host, "rm", "--force", id]);
    for (const host of hosts()) if (image) run("docker", [...host, "image", "rm", "--force", image]);
    for (const [name, host] of [["service", []], ["task", ["--host", taskEndpoint]]] as const) {
      const now = daemonId([...host]);
      if (now !== daemons[name]) console.log(`daemon identity changed during the run: ${name} ${daemons[name]} -> ${now}`);
    }
    const left = hosts().flatMap(host => run("docker", [...host, "image", "ls", "-aq", "--no-trunc", "--filter", `label=${label}`]).out.split("\n").filter(Boolean));
    console.log(`after cleanup: containers ${hosts().flatMap(ours).length}, labelled images ${left.length}`);
    if (failed || process.env.MIXIN_REAL_DOCKER_KEEP === "1") console.log(`mapping fixture kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }, 120_000);

  // A deployment directory: data/ owned by the service identity, an external workspace readable by it.
  function layout(name: string) {
    const base = join(root, name), data = join(base, "work/data"), shared = join(base, "shared-files");
    for (const dir of ["config", "state", "runtime", "workspace", "tmp"]) mkdirSync(join(data, dir), { recursive: true });
    mkdirSync(shared, { recursive: true });
    if (operator === "root") for (const path of [data, ...["config", "state", "runtime", "workspace", "tmp"].map(dir => join(data, dir))]) chownSync(path, 1001, 1001);
    for (const path of [base, join(base, "work")]) chmodSync(path, 0o755);
    return { work: join(base, "work"), data: realpathSync(data), shared: realpathSync(shared) };
  }
  const preflight = (work: string, mounted: string, claimed: string) =>
    run("bash", ["-c", PREFLIGHT, "preflight", join(project, "scripts/lib/task-runtime.sh"), taskEndpoint, mounted],
      { PROJECT_DIR: work, SERVICE_USER: serviceUser, DOCKER_ROOTLESS: rootless ? "1" : "0", IMAGE_ID: image, HOST_WORKSPACE_ROOT: claimed });
  const lastLines = (result: { out: string; err: string }) => (result.out + "\n" + result.err).split("\n").filter(line => /error:/i.test(line)).join(" | ");
  const materials = (shared: string) => {
    mkdirSync(join(shared, "sub")); writeFileSync(join(shared, "sub/a.txt"), "materials");
    writeFileSync(join(shared, "notes.md"), "# notes"); chmodSync(join(shared, "sub"), 0o755);
  };
  const noHelpers = () => {
    const helpers = onTask("ps", "-aq", "--filter", "label=org.mixin-chatbot.mapping-probe=1").out;
    const tasks = onTask("ps", "-aq", "--filter", "label=org.mixin-chatbot.task").out;
    return { helpers, tasks };
  };

  step("default layout: the preflight proves the data mapping", () => {
    const { work, data } = layout("default");
    const before = tree(join(data, "workspace"));
    const result = preflight(work, "", "");
    expect(result.code, result.out + "\n" + result.err).toBe(0);
    expect(result.out).toContain("任务隔离预检通过");
    expect(tree(join(data, "workspace"))).toEqual(before);
    expect(readdirSync(data).filter(name => name.startsWith(".task-mapping-"))).toEqual([]);
    expect(noHelpers()).toEqual({ helpers: "", tasks: "" });
  });

  for (const filled of [false, true]) step(`external ${filled ? "workspace with materials" : "empty workspace"}: read-only, proved, unchanged`, () => {
    const { work, shared } = layout(filled ? "external-filled" : "external-empty");
    if (filled) materials(shared);
    const before = tree(shared);
    const result = preflight(work, shared, shared);
    expect(result.code, result.out + "\n" + result.err).toBe(0);
    expect(result.out).toContain("任务隔离预检通过");
    expect(tree(shared)).toEqual(before);
    expect(noHelpers()).toEqual({ helpers: "", tasks: "" });
  });

  step("a twin directory with identical content is refused as another entity", () => {
    const { work, shared } = layout("twin");
    const twin = join(root, "twin/twin-files");
    mkdirSync(twin); materials(shared); materials(twin);
    const before = { shared: tree(shared), twin: tree(twin) };
    const result = preflight(work, twin, shared);
    expect(result.code).not.toBe(0);
    console.log("twin refusal: " + lastLines(result));
    expect(result.out + result.err).toContain("不指向同一实体");
    expect({ shared: tree(shared), twin: tree(twin) }).toEqual(before);
    expect(noHelpers()).toEqual({ helpers: "", tasks: "" });
  });

  step("a missing daemon-side directory is refused and not created", () => {
    const { work, shared } = layout("missing");
    const missing = join(root, "missing/not-there");
    const result = preflight(work, shared, missing);
    expect(result.code).not.toBe(0);
    console.log("missing refusal: " + lastLines(result));
    expect(result.out + result.err).toMatch(/任务容器操作失败|bind source path does not exist|not found/);
    expect(existsSync(missing)).toBe(false);
    expect(noHelpers()).toEqual({ helpers: "", tasks: "" });
  });

  step("one real task reads the materials, cannot write them and writes its own work in the request tmp", () => {
    const { data, shared } = layout("task");
    materials(shared);
    const before = tree(shared);
    const probe = join(root, "task/probe");
    mkdirSync(probe); writeFileSync(join(probe, "task.ts"), TASK_PROBE); chmodSync(probe, 0o755); chmodSync(join(probe, "task.ts"), 0o644);
    const result = run("docker", ["run", "--rm", "--user", serviceUser, "--read-only", "--network", "none", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "-e", "HOME=/tmp",
      "-e", "DOCKER_HOST=unix:///run/mixin-task/docker.sock", "--mount", `type=bind,src=${socket},dst=/run/mixin-task/docker.sock`,
      "-v", `${shared}:/app/workspace:ro`, "-e", "WORKSPACE_ROOT=/app/workspace", "-v", `${data}:/app/data`,
      "--mount", `type=bind,src=${probe},dst=/probe,readonly`, "--entrypoint", "bun", image, "/probe/task.ts", image, data, shared]);
    const line = /^PROBE=(.*)$/m.exec(result.out)?.[1];
    expect(result.code === 0 && line, result.out + "\n" + result.err).toBeTruthy();
    expect(JSON.parse(line!)).toEqual({ serviceWrite: "EROFS", serviceMount: "ro", exitCode: 0,
      worker: { read: "materials", workspaceWrite: "EROFS", workspaceMount: "ro", workMount: "rw", uid: 0 },
      written: "written by worker", reclaimed: "removed" });
    expect(tree(shared)).toEqual(before);
    expect(noHelpers()).toEqual({ helpers: "", tasks: "" });
  }, 300_000);
});
