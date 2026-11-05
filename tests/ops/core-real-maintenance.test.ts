// Opt-in real native host + Docker + storage integration. Only synthetic documents and UID 0 / dedicated UID 1002.
import { expect, test } from "bun:test";
import { cp, chown, chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { freezeRuntime } from "../../scripts/ops/console/runtime.ts";
import { prepareConsoleDir } from "../../scripts/ops/console/state.ts";
import { runCore } from "../../scripts/ops/core/cli.ts";
import { serviceReady } from "../../scripts/ops/core/readiness.ts";
import { DockerPlatform } from "../../scripts/ops/core/docker-host.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { readJournal } from "../../src/durable/revision-cleanup/journal.ts";
import { writeLongChains, chainState } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const enabled = process.platform === "linux" && process.env.MIXIN_CORE_DOCKER === "1";
const repo = resolve(import.meta.dir, "../..");
async function waitFor(work: () => Promise<boolean>, timeout = 30_000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) { if (await work()) return; await Bun.sleep(100); }
  throw new Error("synthetic maintenance did not reach the expected state");
}

test.skipIf(!enabled)("真实 Docker 维护：先预检后停机、强杀后的写入者回收、显式续做整理和收缩保持值", async () => {
  const uid = process.geteuid!(), endpoint = uid === 0 ? "unix:///var/run/docker.sock" : "unix:///run/user/1002/docker.sock";
  if (![0, 1002].includes(uid) || process.env.DOCKER_HOST !== endpoint || process.env.DOCKER_CONTEXT) throw new Error("unauthorized fixture daemon");
  const base = process.env.MIXIN_CORE_DOCKER_IMAGE;
  if (!base || !/^sha256:[a-f0-9]{64}$/.test(base)) throw new Error("pre-pulled immutable Bun image required");
  const f = await tempFixture("core-real-maintenance-");
  if (f.root.startsWith("/mnt/")) throw new Error("real Docker fixture must use ext4");
  const id = randomUUID().replaceAll("-", ""), label = "org.mixin.core-fixture=" + id;
  let container: string | undefined, image: string | undefined, child: ReturnType<typeof Bun.spawn> | undefined;
  const docker = async (...args: string[]) => {
    const command = Bun.spawn(["docker", "--host", endpoint, ...args], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([command.exited, new Response(command.stdout).text(), new Response(command.stderr).text()]);
    if (code) throw new Error(`fixture docker ${args.slice(0, 2).join(" ")} exit ${code}: ${err}`);
    return out.trim();
  };
  const data = join(f.root, "data"), file = join(data, "conversations/direct/durable.sqlite");
  const command = async (...args: string[]) => (await runCore([...args, "--project", f.root], { source: repo, env: {} })).result;
  try {
    if (await docker("container", "ls", "--all", "--quiet")) throw new Error("fixture daemon must be empty; no existing container will be changed");
    const cached = JSON.parse(await docker("image", "inspect", base))[0];
    if (cached.Id !== base) throw new Error("cached base digest differs from pinned fixture image");
    // The image ID hashes its config, not its manifest. FROM accepts a repository manifest digest.
    const baseRef = (cached.RepoDigests as string[]).find(value => /^oven\/bun@sha256:[a-f0-9]{64}$/.test(value));
    if (!baseRef || JSON.parse(await docker("image", "inspect", baseRef))[0].Id !== base) throw new Error("cached base has no matching repository digest");
    await mkdir(join(data, "state"), { recursive: true, mode: 0o700 });
    await mkdir(join(f.root, "backup"), { mode: 0o755 });
    await writeLongChains(file, 70);
    const read = () => { const db = new Database(file, { readonly: true }); try { return chainState(db); } finally { db.close(); } };
    const before = read();
    await writeFile(join(data, "state/data-version.json"), JSON.stringify({ dataVersion: 1, appVersion: "1.0.1", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }), port = probe.port; probe.stop(true);
    const build = join(f.root, "image"); await mkdir(build);
    prepareConsoleDir(join(f.root, ".console"));
    const runtime = freezeRuntime(join(f.root, ".console"), repo);
    for (const tree of ["scripts", "src"]) await cp(join(runtime.root, tree), join(build, tree), { recursive: true });
    // Storage commands use this subset; no install, network access, environment file or production config is copied.
    for (const name of ["@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-telemetry", "typebox",
      "proper-lockfile", "fs-extra", "retry", "signal-exit", "graceful-fs", "jsonfile", "universalify"]) {
      await cp(join(repo, "node_modules", name), join(build, "node_modules", name), { recursive: true, dereference: true });
    }
    const runPath = join(build, "src/durable/revision-cleanup/run.ts"), point = '  async point(point: Point) { await this.options.hooks?.point?.(point); }';
    const source = await readFile(runPath, "utf8"); if (source.split(point).length !== 2) throw new Error("missing fixture hook boundary");
    await writeFile(runPath, source.replace(point, () => `  async point(point: Point) {
      const fs = await import("node:fs");
      if (point === "committed" && fs.existsSync("/app/data/state/hold-core-cleanup")) {
        fs.writeFileSync("/app/data/state/core-cleanup-held", "committed");
        while (fs.existsSync("/app/data/state/hold-core-cleanup")) await Bun.sleep(100);
      }
      await this.options.hooks?.point?.(point);
    }`));
    await writeFile(join(build, "fixture.ts"), `import {writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {acquireLease} from "./src/core/maintenance.ts";
import {assertMaintenanceAction} from "./src/core/maintenance-state.ts";
assertMaintenanceAction("/app", "service");
const release = await acquireLease("synthetic service");
const body={service:"mixin-chatbot",version:1,status:"ready",instanceId:randomUUID(),pid:process.pid,startedAt:Date.now()};
writeFileSync("data/state/instance.json",JSON.stringify({...body,port:${port}}));
const server=Bun.serve({hostname:"0.0.0.0",port:8181,fetch:()=>Response.json(body)});
process.on("SIGTERM",async()=>{server.stop(true);await release();process.exit(0);});`);
    await writeFile(join(build, "Dockerfile"), `FROM ${baseRef}
WORKDIR /app
COPY . /app
ENTRYPOINT ["bun"]
CMD ["--no-env-file", "fixture.ts"]
`);
    const iid = join(f.root, "image-id");
    await docker("build", "--pull=false", "--network=none", "--label", label, "--iidfile", iid, build);
    image = (await readFile(iid, "utf8")).trim(); if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("invalid fixture image id");
    if (uid === 0) {
      const own = async (path: string) => { await chown(path, 10001, 10001); for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name); if (entry.isDirectory()) await own(child); else await chown(child, 10001, 10001);
      } }; await own(data);
    }
    await chmod(data, 0o755);
    container = await docker("container", "create", "--name", "mixin-chatbot", "--label", label, "--user", uid ? "0:0" : "10001:10001",
      "--publish", `127.0.0.1:${port}:8181`, "--mount", `type=bind,src=${data},dst=/app/data`, image);
    await docker("container", "start", container); await waitFor(() => serviceReady(f.root));
    await writeFile(join(data, "state/hold-core-cleanup"), "hold");
    child = Bun.spawn([process.execPath, "--no-env-file", join(repo, "scripts/ops/core/cli.ts"), "revision-cleanup", "apply", "--project", f.root, "--json"],
      { cwd: f.root, env: { ...process.env, MIXIN_OPS_CONSOLE: "", MIXIN_OPS_TASK_ID: "", MIXIN_OPS_EXPECT_STATE: "", MIXIN_OPS_RESULT_FILE: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]);
    await waitFor(async () => {
      if (child!.exitCode !== null) throw new Error("core exited before the hold: " + (await output).join("\n"));
      return Bun.file(join(data, "state/core-cleanup-held")).exists();
    }, 60_000);
    const held = readOpsMaintenanceRecord(f.root)!;
    expect(held.checkpoint.phase).toBe("acting"); expect(held.writer).toMatchObject({ kind: "docker", phase: "starting" });
    expect(readJournal(data)?.current).toBeDefined(); expect(await serviceReady(f.root)).toBe(false);
    child.kill("SIGKILL"); await child.exited;
    const host = await DockerPlatform.connect(f.root);
    if (held.writer?.kind !== "docker") throw new Error("expected daemon writer");
    expect((await host.taskDriver().inspect(held.writer))?.state).toBe("running");
    const recovery = await command("maintenance-recover");
    expect(recovery).toMatchObject({ outcome: "failed", finalState: "stopped" });
    expect(await host.taskDriver().inspect(held.writer)).toBeNull();
    expect(readMaintenanceState(f.root).cleanup).toMatchObject({ status: "present", inFlight: { space: "direct" } });
    expect(readOpsMaintenanceRecord(f.root)?.result?.outcome).toBe("failed");
    await unlink(join(data, "state/hold-core-cleanup"));
    // The data child was killed in a commit hook: proper-lockfile's ordinary stale lease delay is respected.
    const applied = await command("revision-cleanup", "apply");
    expect(applied).toMatchObject({ outcome: "success", wasRunning: false, finalState: "stopped" });
    expect(readJournal(data)?.state).toBe("finished"); expect(read().values).toEqual(before.values);
    expect(await command("service", "start")).toMatchObject({ outcome: "success", finalState: "running" });
    expect(await command("revision-cleanup", "apply")).toMatchObject({ outcome: "success", wasRunning: true, finalState: "running" });
    expect(await command("revision-cleanup", "shrink", "--space", "direct")).toMatchObject({ outcome: "success", finalState: "running" });
    expect(read().values).toEqual(before.values);
    expect(await docker("container", "ls", "--all", "--filter", "name=^/mixin-maint-", "--quiet")).toBe("");
    console.log(`PASS real maintenance UID ${uid}: ${f.root}, service ${container}, image ${image}`);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    const record = readOpsMaintenanceRecord(f.root);
    if (record?.writer?.kind === "docker") await (await DockerPlatform.connect(f.root)).taskDriver().reap(record.writer);
    if (container) {
      const inspect = JSON.parse(await docker("container", "inspect", container))[0];
      if (inspect.Config?.Labels?.["org.mixin.core-fixture"] !== id || !inspect.Mounts.some((m: any) => m.Source === data && m.Destination === "/app/data")) throw new Error("fixture cleanup ownership mismatch");
      await docker("container", "rm", "--force", container);
    }
    if (image) {
      const inspect = JSON.parse(await docker("image", "inspect", image))[0];
      if (inspect.Config?.Labels?.["org.mixin.core-fixture"] !== id) throw new Error("fixture image label mismatch");
      await docker("image", "rm", image);
    }
    await f.cleanup();
  }
}, 240_000);
