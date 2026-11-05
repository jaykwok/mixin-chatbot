// Opt-in only; pre-pulled immutable image, synthetic input, no network or service container.
import { expect, test } from "bun:test";
import { chown, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerPlatform } from "../../scripts/ops/core/docker-host.ts";
import { newDockerTask, recoverDockerTask, runDockerTask, taskInput } from "../../scripts/ops/core/docker-task.ts";
import type { DockerTaskRecord } from "../../src/contracts/ops-writer.ts";
import { freezeRuntime } from "../../scripts/ops/console/runtime.ts";
import { prepareConsoleDir } from "../../scripts/ops/console/state.ts";
import { tempFixture } from "../helpers/temp.ts";

test.skipIf(process.platform !== "linux" || process.env.MIXIN_CORE_DOCKER !== "1")("真实 Docker 输入：二进制与空输入 EOF、只读固定代码、退出码、无需秘密回收", async () => {
  const uid = process.geteuid!(), endpoint = uid === 0 ? "unix:///var/run/docker.sock" : "unix:///run/user/1002/docker.sock";
  if (![0, 1002].includes(uid) || process.env.DOCKER_HOST !== endpoint || process.env.DOCKER_CONTEXT) throw new Error("only authorized fixture daemons allowed");
  const image = process.env.MIXIN_CORE_DOCKER_IMAGE;
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("pre-pulled immutable image required");
  const f = await tempFixture("core-real-input-"), records: DockerTaskRecord[] = [];
  const data = join(f.root, "data"), backup = join(f.root, "backup");
  const host = await DockerPlatform.connect(f.root);
  try {
    for (const path of [data, backup]) { await mkdir(path, { mode: 0o700 }); if (!uid) await chown(path, 10001, 10001); }
    for (const tree of ["scripts", "src", "ui"]) await mkdir(join(f.root, tree));
    await writeFile(join(f.root, "src/version.ts"), 'export const version="frozen fixture";');
    await writeFile(join(f.root, "ui/fixture.ts"), "export {};");
    await writeFile(join(f.root, "scripts/input.ts"), `import {createHash} from 'node:crypto'; import {version} from '../src/version.ts';
await Bun.write(Bun.stderr,'中文进度\\n'.repeat(40000));
const input=new Uint8Array(await Bun.stdin.arrayBuffer());
let readonly=false;try{await Bun.write('/app/scripts/input.ts','invalid')}catch{readonly=true}
console.log(JSON.stringify({version,readonly,bytes:input.byteLength,digest:createHash('sha256').update(input).digest('hex')}));
process.exitCode=Number(process.argv[2]);`);
    prepareConsoleDir(join(f.root, ".console")); const runtime = freezeRuntime(join(f.root, ".console"), f.root);
    for (const code of [0, 23]) {
      const input = code ? new Uint8Array() : Buffer.concat([Buffer.from("合成秘密\0\n".repeat(250_000)), Buffer.from([255, 128, 0])]);
      const args = ["--no-env-file", "/app/scripts/input.ts", String(code)];
      const record = newDockerTask({ daemon: host.daemon, endpoint: host.endpoint, image, user: uid ? "0:0" : "10001:10001",
        data, backup, network: "none", input: taskInput(input), runtime: runtime.digest }, args); records.push(record);
      let stderr = "";
      const snapshots: DockerTaskRecord[] = [];
      const result = await runDockerTask(host.taskDriver(30_000, true, (text, stream) => { expect(stream).toBe("stderr"); stderr += text; }, input),
        record, args, async value => { snapshots.push(structuredClone(value)); });
      expect(result.code).toBe(code); expect(JSON.parse(result.stdout)).toEqual({ version: "frozen fixture", readonly: true, ...taskInput(input) });
      expect(stderr).toBe("中文进度\n".repeat(40000)); expect(result.stdout + stderr + JSON.stringify(snapshots)).not.toContain("合成秘密");
      expect(await host.taskDriver().inspect(record)).toBeNull();
    }
    // Losing the pinned source must prevent start, but must not prevent reaping an already-created writer.
    const input = Buffer.from("synthetic"), args = ["--no-env-file", "/app/scripts/input.ts", "0"];
    const record = newDockerTask({ daemon: host.daemon, endpoint: host.endpoint, image, user: uid ? "0:0" : "10001:10001",
      data, backup, network: "none", input: taskInput(input), runtime: runtime.digest }, args); records.push(record);
    const driver = host.taskDriver(30_000, true, () => {}, input), container = await driver.create(record, args);
    await writeFile(join(runtime.root, "src/version.ts"), "changed");
    const created = { ...record, container, phase: "created" as const };
    await expect(driver.attach(created)).rejects.toThrow("运行包摘要不符");
    await recoverDockerTask(host.taskDriver(), created, async () => {});
    expect(await driver.inspect(created)).toBeNull();
    console.log(`PASS input UID ${uid}: ${records.map(record => record.id).join(", ")}`);
  } finally {
    for (const record of records) await host.taskDriver().reap(record);
    await f.cleanup();
  }
}, 90_000);
