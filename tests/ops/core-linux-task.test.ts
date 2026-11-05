import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { tempFixture } from "../helpers/temp.ts";
import { newLinuxTask, recoverLinuxTask, runLinuxTask } from "../../scripts/ops/core/linux-task.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { publishJson } from "../../scripts/lib/atomic-file.ts";
import { writeProcessReceipt } from "../../scripts/lib/process-receipt.ts";
import { validateHostProcess, type LinuxTaskRecord } from "../../src/contracts/ops-host-process.ts";
import type { NativeCommand } from "../../scripts/ops/core/native-process.ts";
const linux = process.platform === "linux";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function read(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function until<T>(get: () => Promise<T | null>): Promise<T> {
  const end = performance.now() + 10_000;
  while (performance.now() < end) { const value = await get(); if (value !== null) return value; await Bun.sleep(25); }
  throw new Error("合成子进程没有就绪");
}
test("Linux 宿主写入者元数据拒绝未知字段、目录身份缺失和伪造状态", () => {
  const good: LinuxTaskRecord = { version: 1, kind: "linux-supervisor", id: "a".repeat(32), commandDigest: "b".repeat(64), directory: { dev: "1", ino: "2" }, phase: "prepared" };
  expect(() => validateHostProcess(good)).not.toThrow();
  for (const value of [{ ...good, version: 2 }, { ...good, pid: 123 }, { ...good, phase: "succeeded" }, { ...good, directory: {} }, { ...good, commandDigest: "argv" }])
    expect(() => validateHostProcess(value)).toThrow();
});

test.skipIf(!linux)("Linux 宿主命令的完成、非零退出、取消均等待子进程回收凭据", async () => {
  const f = await tempFixture("core-linux-task-"), lock = acquireDeploymentLock(f.root);
  try {
    const held = () => lock.assertHeld(), records: LinuxTaskRecord[] = [], save = async (r: LinuxTaskRecord) => { records.push(r); };
    const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", "-e", 'process.stdout.write(JSON.stringify({message:"正常完成"}));process.exit(7)'], cwd: f.root, protocol: true };
    const result = await runLinuxTask(f.root, command, newLinuxTask(f.root, command, held), save, held);
    expect(result.code).toBe(7); expect(JSON.parse(result.stdout)).toEqual({ message: "正常完成" }); expect(records.map(r => r.phase)).toEqual(["prepared", "reaped"]);
    const pidPath = join(f.root, "pid.json"), abort = new AbortController();
    const writing = { ...command, args: ["--no-env-file", "-e", 'require("fs").writeFileSync(process.argv[1],JSON.stringify(process.pid));setInterval(()=>{},100)', pidPath], signal: abort.signal };
    const pending = runLinuxTask(f.root, writing, newLinuxTask(f.root, writing, held), save, held).then(() => null, error => error);
    const pid = await until<number>(() => read(pidPath)); expect(alive(pid)).toBe(true); abort.abort(new Error("cancel fixture"));
    expect(await pending).toBeInstanceOf(Error); expect(alive(pid)).toBe(false); expect(records.at(-1)?.phase).toBe("reaped");
  } finally { lock.close(); await f.cleanup(); }
}, 30_000);

test.skipIf(!linux)("Linux 强杀宿主后凭 ECHILD 收尾记录恢复，独立进程组孙进程也结束且不重跑命令", async () => {
  const f = await tempFixture("core-linux-task-kill-"), moduleUrl = (name: string) => pathToFileURL(join(import.meta.dir, "../../scripts", name)).href;
  let host: ReturnType<typeof Bun.spawn> | undefined, pids: number[] = [];
  try {
    const writer = join(f.root, "writer.ts"), launcher = join(f.root, "launcher.ts"), pidPath = join(f.root, "pid.json"), recordPath = join(f.root, "record.json"), beat = join(f.root, "beats");
    await writeFile(writer, `import{spawn}from"node:child_process";import{writeFileSync,appendFileSync}from"node:fs";
if(process.argv[2]==="child"){writeFileSync(process.argv[5],"x");writeFileSync(process.argv[3],JSON.stringify([Number(process.argv[4]),process.pid]));setInterval(()=>appendFileSync(process.argv[5],"x"),20)}
else{spawn(process.execPath,["--no-env-file",import.meta.path,"child",process.argv[2],String(process.pid),process.argv[3]],{detached:true,stdio:"ignore"}).unref();setInterval(()=>{},100)}
setTimeout(()=>process.exit(0),15000);`);
    const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", writer, pidPath, beat], cwd: f.root, protocol: true };
    await writeFile(launcher, `import{acquireDeploymentLock}from${JSON.stringify(moduleUrl("ops/core/deployment-lock.ts"))};
import{newLinuxTask,runLinuxTask}from${JSON.stringify(moduleUrl("ops/core/linux-task.ts"))};import{publishJson}from${JSON.stringify(moduleUrl("lib/atomic-file.ts"))};
const root=${JSON.stringify(f.root)},lock=acquireDeploymentLock(root),command=${JSON.stringify(command)};
try{await runLinuxTask(root,command,newLinuxTask(root,command,()=>lock.assertHeld()),r=>publishJson(${JSON.stringify(recordPath)},r),()=>lock.assertHeld())}finally{lock.close()}`);
    const launched = Bun.spawn([process.execPath, "--no-env-file", launcher], { cwd: f.root, stdout: "ignore", stderr: "pipe" });
    host = launched;
    const diagnostics = new Response(launched.stderr).text();
    pids = await until<number[]>(() => read(pidPath)); expect(pids.filter(alive)).toHaveLength(2);
    const record = await read(recordPath) as LinuxTaskRecord; expect(record.phase).toBe("prepared");
    host.kill("SIGKILL"); await host.exited; await diagnostics;
    const lock = acquireDeploymentLock(f.root);
    try { await recoverLinuxTask(f.root, record, value => publishJson(recordPath, value), () => lock.assertHeld()); }
    finally { lock.close(); }
    expect(pids.filter(alive)).toEqual([]); expect((await read(recordPath)).phase).toBe("reaped");
    expect(await read(pidPath)).toEqual(pids);
    const before = await readFile(beat, "utf8"); await Bun.sleep(60); expect(await readFile(beat, "utf8")).toBe(before);
  } finally {
    if (host && host.exitCode === null) { host.kill("SIGKILL"); await host.exited; }
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await f.cleanup();
  }
}, 30_000);

test.skipIf(!linux)("没授权的命令可收尾；授权后缺少或损坏的完成凭据保持阻止", async () => {
  const f = await tempFixture("core-linux-task-proof-"), lock = acquireDeploymentLock(f.root);
  try {
    const held = () => lock.assertHeld(), command: NativeCommand = { command: process.execPath, args: ["--no-env-file", "-e", "process.exit()"], cwd: f.root };
    const unopened = newLinuxTask(f.root, command, held), saved: LinuxTaskRecord[] = [], save = async (r: LinuxTaskRecord) => { saved.push(r); };
    await recoverLinuxTask(f.root, unopened, save, held, 0); expect(saved.at(-1)?.phase).toBe("reaped");
    const record = newLinuxTask(f.root, command, held), receipt = { ...record, path: join(f.root, ".console/processes", record.id) };
    writeProcessReceipt(receipt, "authorized");
    await expect(recoverLinuxTask(f.root, record, save, held, 0)).rejects.toThrow("没有确认"); expect(saved).toHaveLength(1);
    writeProcessReceipt(receipt, "reaped");
    await writeFile(join(receipt.path, "reaped"), "changed");
    await expect(recoverLinuxTask(f.root, record, save, held, 0)).rejects.toThrow("凭据不完整"); expect(saved).toHaveLength(1);
  } finally { lock.close(); await f.cleanup(); }
});
