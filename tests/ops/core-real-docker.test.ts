// Opt-in, synthetic data only. Uses a pre-pulled immutable Bun image and uniquely named maintenance containers.
import { expect, test } from "bun:test";
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DockerPlatform } from "../../ops/core/docker-host.ts";
import { newDockerTask, recoverDockerTask, runDockerTask } from "../../ops/core/docker-task.ts";
import type { DockerTaskRecord } from "../../src/contracts/ops-writer.ts";
import { publishJson } from "../../src/lib/atomic-file.ts";
import { tempFixture } from "../helpers/temp.ts";

const enabled = process.platform === "linux" && process.env.MIXIN_CORE_DOCKER === "1";
async function waitFor(work: () => Promise<boolean>): Promise<void> {
  const until = performance.now() + 20_000;
  while (performance.now() < until) { if (await work()) return; await Bun.sleep(50); }
  throw new Error("synthetic container did not reach the expected state");
}

test.skipIf(!enabled)("真实 Docker：非零退出、客户端取消、强杀宿主后按记录回收；无遗留容器", async () => {
  const uid = process.geteuid!(), endpoint = uid === 0 ? "unix:///var/run/docker.sock" : "unix:///run/user/1002/docker.sock";
  if (![0, 1002].includes(uid) || process.env.DOCKER_HOST !== endpoint || process.env.DOCKER_CONTEXT) throw new Error("only the authorized rootful / UID 1002 fixture daemon is allowed");
  const image = process.env.MIXIN_CORE_DOCKER_IMAGE;
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("pre-pulled immutable image required");
  const f = await tempFixture("core-real-docker-"), records: DockerTaskRecord[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const data = join(f.root, "data"), backup = join(f.root, "backup");
  for (const path of [data, backup]) { await mkdir(path, { mode: 0o700 }); if (uid === 0) await chown(path, 10001, 10001); }
  const host = await DockerPlatform.connect(f.root), driver = host.taskDriver();
  const make = (args: string[]) => {
    const record = newDockerTask({ daemon: host.daemon, endpoint: host.endpoint, image, user: uid ? "0:0" : "10001:10001", data, backup, network: "none" }, args);
    records.push(record); return record;
  };
  try {
    const simple = ["--no-env-file", "-e", 'await Bun.write("/app/data/simple", "synthetic"); console.log(JSON.stringify({message:"中文完成"})); process.exitCode=3;'];
    const first = make(simple), firstPath = join(f.root, "first.json");
    const result = await runDockerTask(driver, first, simple, record => publishJson(firstPath, record));
    expect(result.code).toBe(3); expect(JSON.parse(result.stdout)).toEqual({ message: "中文完成" }); expect(await driver.inspect(first)).toBeNull();

    const looping = (name: string) => ["--no-env-file", "-e", `import {appendFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); setInterval(()=>appendFileSync("/app/data/${name}","x"),50);`];
    const args = looping("cancel"), second = make(args), abort = new AbortController(), secondPath = join(f.root, "second.json");
    const pending = runDockerTask(driver, second, args, record => publishJson(secondPath, record), abort.signal).then(() => null, error => error);
    await waitFor(() => Bun.file(join(data, "cancel")).exists()); abort.abort(new Error("synthetic cancel"));
    expect(await pending).toBeInstanceOf(Error); expect(await driver.inspect(second)).toBeNull();

    const crashArgs = looping("crash"), third = make(crashArgs), thirdPath = join(f.root, "third.json"), launcher = join(f.root, "launcher.ts");
    const moduleUrl = (relative: string) => pathToFileURL(join(import.meta.dir, "../../", relative)).href;
    await writeFile(launcher, `import {DockerPlatform} from ${JSON.stringify(moduleUrl("ops/core/docker-host.ts"))};
import {runDockerTask} from ${JSON.stringify(moduleUrl("ops/core/docker-task.ts"))};
import {publishJson} from ${JSON.stringify(moduleUrl("src/lib/atomic-file.ts"))};
const host=await DockerPlatform.connect(${JSON.stringify(f.root)});
await runDockerTask(host.taskDriver(),${JSON.stringify(third)},${JSON.stringify(crashArgs)},value=>publishJson(${JSON.stringify(thirdPath)},value));`);
    child = Bun.spawn([process.execPath, "--no-env-file", launcher], { cwd: f.root, env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const errorText = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    await waitFor(() => Bun.file(join(data, "crash")).exists()); child.kill("SIGKILL"); await child.exited;
    const interrupted = JSON.parse(await readFile(thirdPath, "utf8")) as DockerTaskRecord;
    expect(interrupted.phase).toBe("starting");
    expect((await driver.inspect(interrupted))?.state).toBe("running"); // Observed daemon writer outlives its host process.
    await recoverDockerTask(driver, interrupted, record => publishJson(thirdPath, record));
    expect(await driver.inspect(interrupted)).toBeNull();
    const stopped = await readFile(join(data, "crash"), "utf8"); await Bun.sleep(150);
    expect(await readFile(join(data, "crash"), "utf8")).toBe(stopped); await errorText;
    console.log(`PASS real Docker UID ${uid}: normal/cancel/host-kill recovered ${records.map(r => r.id).join(", ")}`);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    // Only our recorded random names; never scan or remove unrelated containers or images.
    for (const record of records) await driver.reap(record);
    await f.cleanup();
  }
}, 120_000);
