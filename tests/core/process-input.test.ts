import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeProcess, PROCESS_INPUT_MAX_BYTES } from "../../src/lib/process.ts";
import { runNative } from "../../ops/core/native-process.ts";
import { tempFixture } from "../helpers/temp.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("独立输入管道传递完整二进制与中文，同时排空超出管道缓冲的大量 stderr", async () => {
  const f = await tempFixture("process-input-");
  try {
    const script = join(f.root, "read.ts"), input = Buffer.concat([Buffer.from("合成秘密\0\n".repeat(300_000)), Buffer.from([0, 128, 255])]);
    await writeFile(script, `import {createHash} from 'node:crypto';
const logs=Buffer.from('输入进度\\n'.repeat(60000));
await Bun.write(Bun.stderr,logs);
const input=await Bun.stdin.arrayBuffer();
console.log(JSON.stringify({bytes:input.byteLength,digest:createHash('sha256').update(new Uint8Array(input)).digest('hex')}));`);
    let stderr = "";
    const result = await runNative({ command: process.execPath, args: ["--no-env-file", script], cwd: f.root, protocol: true, input }, (text, stream) => {
      expect(stream).toBe("stderr"); stderr += text;
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ bytes: input.byteLength, digest: hash(input) });
    expect(stderr).toBe("输入进度\n".repeat(60000));
    expect(result.stdout + stderr).not.toContain("合成秘密");
  } finally { await f.cleanup(); }
}, 30_000);

test("空输入也发送 EOF，输入只经过管道而不进入参数或环境", async () => {
  const f = await tempFixture("process-input-empty-");
  try {
    const script = join(f.root, "empty.ts");
    await writeFile(script, `const value=await Bun.stdin.text(); console.log(JSON.stringify({value,args:process.argv.slice(2),env:process.env.PROCESS_INPUT}));`);
    const result = await runNative({ command: process.execPath, args: ["--no-env-file", script], cwd: f.root, protocol: true,
      input: new Uint8Array(), env: { ...process.env, PROCESS_INPUT: undefined } });
    expect(result).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toEqual({ value: "", args: [] });
  } finally { await f.cleanup(); }
}, 20_000);

test("输入超过 40 MiB 在启动任何进程前拒绝", async () => {
  const events: unknown[] = [];
  expect(PROCESS_INPUT_MAX_BYTES).toBe(40 * 1024 * 1024);
  await expect(executeProcess({ command: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 1000,
    input: new Uint8Array(PROCESS_INPUT_MAX_BYTES + 1), observe: event => events.push(event) })).rejects.toThrow("40 MiB");
  expect(events).toEqual([]);
});

test("子进程未读完输入便退出仍保留真实退出码，不因 EPIPE 覆盖原因", async () => {
  const f = await tempFixture("process-input-exit-");
  try {
    const result = await executeProcess({ command: process.execPath, args: ["--no-env-file", "-e", "process.exit(23)"], cwd: f.root,
      timeoutMs: 15_000, input: new Uint8Array(8 * 1024 * 1024) });
    expect(result.exitCode).toBe(23);
    expect(result.lastPhase).toBe("reaped");
  } finally { await f.cleanup(); }
}, 20_000);

test.each(["cancel", "parent-death"])("输入受背压阻塞时仍回收整个进程树：%s", async (mode) => {
  const f = await tempFixture("process-input-lifeline-");
  const command = join(f.root, "wait.ts"), parentFile = join(f.root, "parent.ts");
  const abort = new AbortController(); let parent: ReturnType<typeof Bun.spawn> | undefined;
  let running: Promise<unknown> | undefined, ready = "", ids: number[] = [], endedAt = 0;
  const module = fileURLToPath(new URL("../../src/lib/process.ts", import.meta.url));
  try {
    await writeFile(command, `import {spawn} from 'node:child_process';
process.stdin.pause();
const child=spawn(process.execPath,['--no-env-file','-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
child.on('spawn',()=>console.log('READY:'+JSON.stringify([process.pid,child.pid])));
setInterval(()=>{},1000);`);
    const observe = (data: Uint8Array) => {
      ready += Buffer.from(data).toString(); const match = ready.match(/READY:(\[[\d,]+\])/);
      if (!match || ids.length) return;
      ids = JSON.parse(match[1]); endedAt = Date.now();
      if (mode === "cancel") abort.abort(new Error("input test cancelled"));
      else parent!.kill("SIGKILL");
    };
    if (mode === "cancel") {
      running = executeProcess({ command: process.execPath, args: ["--no-env-file", command], cwd: f.root, timeoutMs: 25_000,
        input: new Uint8Array(16 * 1024 * 1024), signal: abort.signal, onData: observe });
      await expect(running).rejects.toThrow("input test cancelled");
    } else {
      await writeFile(parentFile, `import {executeProcess} from ${JSON.stringify(module)};
await executeProcess({command:process.execPath,args:['--no-env-file',${JSON.stringify(command)}],cwd:process.cwd(),timeoutMs:25000,
input:new Uint8Array(16*1024*1024),onData:data=>process.stdout.write(data)});`);
      parent = Bun.spawn([process.execPath, "--no-env-file", parentFile], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
      const stderr = new Response(parent.stderr as ReadableStream).text();
      const watchdog = setTimeout(() => parent?.kill("SIGKILL"), 28_000);
      try {
        for await (const chunk of parent.stdout as ReadableStream<Uint8Array>) observe(chunk);
        await parent.exited;
        expect(ids, await stderr).toHaveLength(2);
      } finally { clearTimeout(watchdog); }
    }
    expect(ids).toHaveLength(2);
    const deadline = endedAt + 3500;
    while (ids.some(alive) && Date.now() < deadline) await Bun.sleep(20);
    expect(ids.filter(alive)).toEqual([]);
    expect(Date.now() - endedAt).toBeLessThan(4000);
  } finally {
    abort.abort(); await running?.catch(() => {});
    if (parent && parent.exitCode === null) { parent.kill("SIGKILL"); await parent.exited; }
    for (const pid of ids) { if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }
    await f.cleanup();
  }
}, 35_000);
