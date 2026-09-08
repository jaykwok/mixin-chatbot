import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../../src/core/process.ts";
import { tempFixture } from "../helpers/temp.ts";
import { fileURLToPath } from "node:url";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("supervised real subprocesses", () => {
  test("reaps detached descendants when the bot parent is forcibly killed", async () => {
    const fixture = await tempFixture("supervised-force-");
    const command = join(fixture.root, "command.cjs");
    const bot = join(fixture.root, "bot.ts");
    await writeFile(command, `const {spawn}=require('child_process'); spawn(process.execPath,['-e',"console.log('READY:'+process.pid); setTimeout(()=>process.exit(0),8000)"],{detached:true,stdio:['ignore','inherit','inherit'],windowsHide:true}).unref(); setTimeout(()=>process.exit(0),10000);`);
    const module = fileURLToPath(new URL("../../src/core/process.ts", import.meta.url));
    await writeFile(bot, `import {runProcess} from ${JSON.stringify(module)}; await runProcess({command:process.execPath,args:[${JSON.stringify(command)}],cwd:process.cwd(),timeoutMs:20000,onData:data=>process.stdout.write(data)});`);
    const parent = Bun.spawn([process.execPath, bot], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    let pid = 0;
    let killedAt = 0;
    const stderr = new Response(parent.stderr).text();
    const watchdog = setTimeout(() => parent.kill(), 22000);
    try {
      for await (const data of parent.stdout) {
        const match = Buffer.from(data).toString().match(/READY:(\d+)/);
        if (match) { pid = Number(match[1]); killedAt = Date.now(); parent.kill("SIGKILL"); break; }
      }
      await parent.exited;
      expect(pid).toBeGreaterThan(0);
      const deadline = killedAt + 3000;
      while (alive(pid) && Date.now() < deadline) await Bun.sleep(30);
      expect(alive(pid)).toBe(false);
      expect(Date.now() - killedAt).toBeLessThan(4000);
      await stderr;
    } finally { clearTimeout(watchdog); parent.kill(); await parent.exited; await fixture.cleanup(); }
  }, 30000);

  test.each(["exit", "cancel"])("reaps a detached child on parent %s", async (mode) => {
    const fixture = await tempFixture("supervised-process-");
    const childFile = join(fixture.root, "child.cjs");
    const parentFile = join(fixture.root, "parent.cjs");
    const pidFile = join(fixture.root, "child.pid");
    await writeFile(childFile, `require('fs').writeFileSync(process.argv[2],String(process.pid)); process.stdout.write('READY:'+process.pid+'\\n'); const tick=setInterval(()=>process.stdout.write('alive\\n'),30); setTimeout(()=>{clearInterval(tick);process.exit(0)},8000);`);
    await writeFile(parentFile, `const {spawn}=require('child_process'); const fs=require('fs'); spawn(process.execPath,[process.argv[2],process.argv[3]],{detached:true,stdio:['ignore','inherit','inherit'],windowsHide:true}).unref(); const tick=setInterval(()=>{if(process.argv[4]==='exit'&&fs.existsSync(process.argv[3]))process.exit(0)},25);setTimeout(()=>process.exit(0),10000);`);
    const controller = new AbortController();
    let pid = 0;
    let readyAt = 0;
    try {
      const result = runProcess({ command: process.execPath, args: [parentFile, childFile, pidFile, mode], cwd: fixture.root,
        timeoutMs: 20000, signal: controller.signal, onData: (data) => {
          const match = String(data).match(/READY:(\d+)/);
          if (match) { pid = Number(match[1]); readyAt = Date.now(); if (mode === "cancel") controller.abort(new DOMException("test stop", "AbortError")); }
        },
      });
      if (mode === "cancel") await expect(result).rejects.toThrow("test stop");
      else expect((await result).exitCode).toBe(0);
      expect(pid).toBeGreaterThan(0);
      expect(Date.now() - readyAt).toBeLessThan(4000);
      expect(alive(pid)).toBe(false);
    } finally { controller.abort(); await fixture.cleanup(); }
  }, 30000);
});
