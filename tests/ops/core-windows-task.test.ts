import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { tempFixture } from "../helpers/temp.ts";
import { newWindowsTask, recoverWindowsTask, runWindowsTask } from "../../scripts/ops/core/windows-task.ts";
import type { WindowsTaskRecord } from "../../src/contracts/ops-writer.ts";
import { publishJson } from "../../scripts/lib/atomic-file.ts";
import type { NativeCommand } from "../../scripts/ops/core/native-process.ts";

const windows = process.platform === "win32";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until<T>(work: () => Promise<T | null>): Promise<T> {
  const limit = performance.now() + 10_000;
  while (performance.now() < limit) { const value = await work(); if (value !== null) return value; await Bun.sleep(25); }
  throw new Error("fixture did not reach ready state");
}
async function json(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

test.skipIf(!windows)("Windows 持久 Global Job：中文进程输出完成后回收；取消返回前子进程确实退出", async () => {
  const f = await tempFixture("core-windows-task-");
  try {
    const writer = join(f.root, "writer.ts"), pidPath = join(f.root, "pid.json");
    await writeFile(writer, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.pid)); setInterval(()=>{}, 100);');
    const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", "-e", 'process.stdout.write(JSON.stringify({message:"正常完成"}))'], cwd: f.root, protocol: true };
    const events: WindowsTaskRecord[] = [], save = async (value: WindowsTaskRecord) => { events.push(value); };
    const result = await runWindowsTask(command, newWindowsTask(command), save);
    expect(JSON.parse(result.stdout)).toEqual({ message: "正常完成" }); expect(events.map(r => r.phase)).toEqual(["prepared", "reaped"]);
    const abort = new AbortController(), writing = { ...command, args: ["--no-env-file", writer, pidPath], signal: abort.signal };
    const pending = runWindowsTask(writing, newWindowsTask(writing), save).then(() => null, error => error);
    const pid = await until<number>(() => json(pidPath)); expect(alive(pid)).toBe(true); abort.abort(new Error("cancelled"));
    expect(await pending).toBeInstanceOf(Error); expect(alive(pid)).toBe(false); expect(events.at(-1)?.phase).toBe("reaped");
    const before = events.length; await recoverWindowsTask(events.at(-1)!, save); expect(events).toHaveLength(before + 1);
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(!windows)("Windows 强杀父运维进程后，从磁盘 Job 名称恢复且不会重跑数据命令", async () => {
  const f = await tempFixture("core-windows-task-kill-");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const writer = join(f.root, "writer.ts"), launcher = join(f.root, "launcher.ts"), pidPath = join(f.root, "pid.json"), recordPath = join(f.root, "record.json");
    await writeFile(writer, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.pid)); setInterval(()=>{}, 100);');
    const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", writer, pidPath], cwd: f.root, protocol: true };
    const taskModule = pathToFileURL(join(import.meta.dir, "../../scripts/ops/core/windows-task.ts")).href;
    const publishModule = pathToFileURL(join(import.meta.dir, "../../scripts/lib/atomic-file.ts")).href;
    await writeFile(launcher, `import {newWindowsTask,runWindowsTask} from ${JSON.stringify(taskModule)};
import {publishJson} from ${JSON.stringify(publishModule)};
const command=${JSON.stringify(command)};
await runWindowsTask(command,newWindowsTask(command), value=>publishJson(${JSON.stringify(recordPath)},value));`);
    child = Bun.spawn([process.execPath, "--no-env-file", launcher], { cwd: f.root, stdout: "ignore", stderr: "ignore", windowsHide: true });
    const pid = await until<number>(() => json(pidPath)); expect(alive(pid)).toBe(true);
    const record = await json(recordPath) as WindowsTaskRecord; expect(record.phase).toBe("prepared");
    child.kill("SIGKILL"); await child.exited;
    await recoverWindowsTask(record, value => publishJson(recordPath, value));
    expect(alive(pid)).toBe(false); expect((await json(recordPath)).phase).toBe("reaped");
    expect(await json(pidPath)).toBe(pid); // No second writer started.
  } finally { if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } await f.cleanup(); }
}, 30_000);
