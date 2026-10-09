import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";
import { executeProcess } from "../../scripts/lib/process.ts";
import { tempFixture } from "../helpers/temp.ts";

const enabled = process.platform === "linux" && process.env.MIXIN_REAL_TASKS === "1";
test.skipIf(!enabled)("real daemon rejects a delayed start after sealing, before scratch and work reclamation", async () => {
  const f = await tempFixture("real-rootless-late-start-"), temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const image = process.env.MIXIN_TASK_TEST_IMAGE!; let pending: string[] | undefined;
  const native = (args: string[], options?: Parameters<TaskDriver["run"]>[1]) => executeProcess({ command: "docker", args, cwd: f.root, timeoutMs: options?.timeoutMs ?? 30_000, ...options });
  const driver: TaskDriver = { async run(args, options) {
    if (args[0] === "start") { pending = args; throw new Error("synthetic lost start acknowledgement; delayed real request"); }
    return native(args, options);
  } };
  const tasks = new RootlessTasks(control, image, driver), task = await tasks.create(temp);
  try {
    await mkdir(join(task.path, ".work")); await writeFile(join(task.path, ".work/private"), "owned");
    await expect(task.run({ command: "bun", args: ["-e", "setInterval(()=>{},1000)"], cwd: task.path, timeoutMs: 30_000 })).rejects.toThrow("lost start acknowledgement");
    expect(pending).toBeDefined(); await task.seal({ discardScratch: true });
    await expect(readFile(join(task.path, ".work/private"))).rejects.toThrow("ENOENT");
    const late = await native(pending!); expect(late.exitCode).not.toBe(0); expect(late.output).toContain("No such container");
    expect((await tasks.describe(task.id, temp)).phase).toBe("writers-reaped");
    expect((await tasks.reclaim(task.id)).status).toBe("removed");
  } finally { await task.seal(); await tasks.reclaim(task.id); await f.cleanup(); }
}, 120_000);
test.skipIf(!enabled)("real rootless bash and codemode front doors preserve references and reclaim registered results", async () => {
  const f = await tempFixture("real-rootless-frontdoors-");
  try {
    const result = await executeProcess({ command: process.execPath,
      args: [fileURLToPath(new URL("../helpers/rootless-frontdoors.ts", import.meta.url)), f.root], cwd: f.root, timeoutMs: 90_000,
      env: { ...process.env, BOT_TASK_IMAGE: process.env.MIXIN_TASK_TEST_IMAGE, BOT_TASK_CONTROL_ROOT: join(f.root, "control") } });
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ bash: true, protectedWrite: true, sealedInputs: true, activeCodemodeInput: true, privateControl: true, privateDocuments: true, codemode: true, references: true, expiry: true });
  } finally {
    const recovery = new RootlessTasks(join(f.root, "control"), process.env.MIXIN_TASK_TEST_IMAGE!);
    const results = await recovery.sweep(join(f.root, "caller"), Infinity, []);
    expect(results.every(item => item.status === "removed")).toBe(true);
    await f.cleanup();
  }
}, 120_000);
test.skipIf(!enabled)("real rootless worker cannot alter its mount parent, another task or manager proc; writers exit before top/nested reclaim", async () => {
  const f = await tempFixture("real-rootless-tasks-"); const temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const image = process.env.MIXIN_TASK_TEST_IMAGE!, tasks = new RootlessTasks(control, image), first = await tasks.create(temp), sibling = await tasks.create(temp);
  try {
    await writeFile(join(sibling.path, "foreign"), "keep");
    const code = `const fs=require('fs'); const path=require('path'); const denied=[]; for(const [name,action] of [
      ['parent',()=>fs.renameSync(path.dirname(${JSON.stringify(first.path)}),path.dirname(${JSON.stringify(first.path)})+'-moved')],
      ['mount',()=>fs.renameSync(${JSON.stringify(first.path)},${JSON.stringify(first.path + "-moved")})],
      ['sibling',()=>fs.readFileSync(${JSON.stringify(join(sibling.path, "foreign"))})],
      ['journal',()=>fs.readFileSync(${JSON.stringify(join(control, "manager.json"))})],
      ['proc',()=>fs.readdirSync('/proc/${process.pid}/fd')],
      ['signal',()=>process.kill(${process.pid},'SIGKILL')]
    ]){try{action();throw Error('allowed:'+name)}catch(error){if(String(error).includes('allowed:'))throw error;denied.push(name)}}
    fs.mkdirSync(${JSON.stringify(join(first.path, "nested/deeper"))},{recursive:true});fs.writeFileSync(${JSON.stringify(join(first.path, "nested/deeper/owned"))},'owned');console.log(JSON.stringify({denied}));`;
    const result = await first.run({ command: "bun", args: ["-e", code], cwd: first.path, timeoutMs: 30_000 });
    expect(result.exitCode, result.output).toBe(0); expect(JSON.parse(result.output).denied).toHaveLength(6);
    expect(await readFile(join(sibling.path, "foreign"), "utf8")).toBe("keep");
    await first.seal(); expect((await tasks.reclaim(first.id)).status).toBe("removed");
    expect((await tasks.reclaim(sibling.id)).status).toBe("deferred");
    await sibling.seal(); expect((await tasks.reclaim(sibling.id)).status).toBe("removed");
  } finally { await first.seal(); await sibling.seal(); await tasks.reclaim(first.id); await tasks.reclaim(sibling.id); await f.cleanup(); }
}, 120_000);

test.skipIf(!enabled)("real rootless cancellation stops detached writers; sealed receipt survives restart and reclaims exactly once", async () => {
  const f = await tempFixture("real-rootless-cancel-"); const temp = join(f.root, "caller"), control = join(f.root, "control"); await mkdir(temp);
  const image = process.env.MIXIN_TASK_TEST_IMAGE!, tasks = new RootlessTasks(control, image), task = await tasks.create(temp), controller = new AbortController();
  let ready: () => void; const started = new Promise<void>(done => { ready = done; }); let output = "", pids: number[] = [];
  const child = `require('fs').writeFileSync(${JSON.stringify(join(task.path, "writer"))},'alive'); console.log('DESC_READY');setInterval(()=>require('fs').appendFileSync(${JSON.stringify(join(task.path, "writer"))},'.'),25);`;
  const code = `require('child_process').spawn('bun',['-e',${JSON.stringify(child)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref();setInterval(()=>{},1000);`;
  const running = task.run({ command: "bun", args: ["-e", code], cwd: task.path, timeoutMs: 30_000, signal: controller.signal, onData: data => { output += data; if (output.includes("DESC_READY")) ready(); } });
  const outcome = running.then(() => undefined, error => error);
  try {
    await Promise.race([started, running.then(() => { throw new Error("writer exited before READY"); })]);
    const record = JSON.parse(JSON.parse(await readFile(join(control, "receipts", task.id + ".json"), "utf8")).payload);
    const top = await executeProcess({ command: "docker", args: ["top", record.containers[0], "-eo", "pid"], cwd: f.root, timeoutMs: 15_000 });
    expect(top.exitCode).toBe(0); pids = top.output.trim().split(/\s+/).slice(1).map(Number); expect(pids.length).toBeGreaterThan(1);
    controller.abort(new Error("synthetic rootless cancel")); expect(await outcome).toBeInstanceOf(Error); await task.seal();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    const before = await readFile(join(task.path, "writer")); await Bun.sleep(150); expect(await readFile(join(task.path, "writer"))).toEqual(before);
    const recovered = new RootlessTasks(control, image); expect((await recovered.reclaim(task.id)).status).toBe("removed"); expect((await recovered.reclaim(task.id)).status).toBe("removed");
  } finally { controller.abort(); await outcome; await task.seal(); await tasks.reclaim(task.id); await f.cleanup(); }
}, 120_000);
