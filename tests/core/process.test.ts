import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../../src/core/process.ts";
import { tempFixture } from "../helpers/temp.ts";
import { fileURLToPath } from "node:url";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("supervised real subprocesses", () => {
  test.skipIf(process.platform !== "linux")("finishes reaping a detached process tree despite repeated termination signals", async () => {
    const fixture = await tempFixture("supervised-signals-");
    const command = join(fixture.root, "tree.cjs");
    const supervisor = fileURLToPath(new URL("../../src/core/process-supervisor.ts", import.meta.url));
    // Several generations require repeated adoption/reaping rounds, so later
    // signals arrive while cleanup is in progress, rather than after it exits.
    await writeFile(command, `const {spawn}=require('child_process'); const ids=[...JSON.parse(process.argv[2]),process.pid]; if(ids.length<8){spawn(process.execPath,[__filename,JSON.stringify(ids)],{detached:true,stdio:['ignore','inherit','inherit']}).unref()}else{console.log('READY:'+JSON.stringify(ids))} setTimeout(()=>process.exit(0),8000);`);
    const child = Bun.spawn([process.execPath, supervisor], { cwd: fixture.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ command: process.execPath, args: [command, "[]"], cwd: fixture.root, env: process.env }) + "\n");
    await child.stdin.flush();
    const stderr = new Response(child.stderr).text();
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
    let signals: ReturnType<typeof setInterval> | undefined;
    let ids: number[] = [];
    try {
      let output = "";
      for await (const data of child.stdout) {
        output += Buffer.from(data).toString();
        const match = output.match(/READY:(\[[\d,]+\])/);
        if (!match) continue;
        ids = JSON.parse(match[1]);
        child.kill("SIGTERM");
        signals = setInterval(() => child.kill("SIGTERM"), 2);
        break;
      }
      const code = await child.exited;
      if (signals) clearInterval(signals);
      expect(ids).toHaveLength(8);
      expect(code).toBe(143);
      expect(ids.filter(alive)).toEqual([]);
      await stderr;
    } finally {
      if (signals) clearInterval(signals);
      clearTimeout(watchdog);
      child.kill("SIGKILL");
      await child.exited;
      for (const pid of ids) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await fixture.cleanup();
    }
  }, 20000);

  test.skipIf(process.platform !== "linux")("finishes reaping with closed output pipes when waitpid wins the child-exit race", async () => {
    const fixture = await tempFixture("supervised-reap-race-");
    const command = join(fixture.root, "command.cjs");
    const reaped = join(fixture.root, "reaped.pid");
    const supervisor = fileURLToPath(new URL("../../src/core/process-supervisor.ts", import.meta.url));
    const preload = fileURLToPath(new URL("../helpers/process-reap-race.ts", import.meta.url));
    await writeFile(command, `const {spawn}=require('child_process'); console.log('DIRECT:'+process.pid); spawn(process.execPath,['-e',"console.log('READY:'+process.pid); setTimeout(()=>process.exit(0),8000)"],{detached:true,stdio:['ignore','inherit','inherit']}).unref(); setTimeout(()=>process.exit(0),10000);`);
    const child = Bun.spawn([process.execPath, "--preload", preload, supervisor, reaped], {
      cwd: fixture.root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ command: process.execPath, args: [command], cwd: fixture.root, env: process.env }) + "\n");
    await child.stdin.flush();
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
    let ids: number[] = [];
    try {
      let output = "";
      for await (const data of child.stdout) {
        output += Buffer.from(data).toString();
        const direct = output.match(/DIRECT:(\d+)\n/);
        const ready = output.match(/READY:(\d+)\n/);
        if (!direct || !ready) continue;
        ids = [Number(direct[1]), Number(ready[1])];
        break; // Cancels stdout, closing its read end.
      }
      // Reproduce the dead parent's pipes without losing the supervisor's exit status.
      await child.stderr.cancel();
      child.stdin.end();
      const code = await child.exited;
      expect(ids).toHaveLength(2);
      expect(Number(await readFile(reaped, "utf8"))).toBe(ids[0]);
      expect(code).toBe(143);
      expect(ids.filter(alive)).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      child.kill("SIGKILL");
      await child.exited;
      for (const pid of ids) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await fixture.cleanup();
    }
  }, 20000);

  test.each(["whole", "fragmented"])("reaps detached descendants when the bot parent is forcibly killed (%s READY frame)", async (frame) => {
    const fixture = await tempFixture("supervised-force-");
    const command = join(fixture.root, "command.cjs");
    const bot = join(fixture.root, "bot.ts");
    const descendantPid = join(fixture.root, "descendant.pid");
    const phases = join(fixture.root, "phases.jsonl");
    const phase = (name: string) => "require('fs').appendFileSync(" + JSON.stringify(phases) + ",JSON.stringify({phase:" + JSON.stringify(name) + ",at:Date.now(),pid:process.pid})+String.fromCharCode(10)); ";
    const ready = frame === "whole" ? "console.log('READY:'+process.pid);" :
      "const parts=['RE','AD','Y:',String(process.pid).slice(0,1),String(process.pid).slice(1),String.fromCharCode(10)]; let i=0; const send=()=>{process.stdout.write(parts[i++]); if(i<parts.length)setTimeout(send,30)}; send();";
    const announce = phase("descendant") + "require('fs').writeFileSync(" + JSON.stringify(descendantPid) + ",String(process.pid)); " + ready;
    // They must stay alive until the bot is killed, rather than exit during a slow Windows startup.
    await writeFile(command, `${phase("command")}const {spawn}=require('child_process'); spawn(process.execPath,['-e',${JSON.stringify(announce + " setInterval(()=>{},1000)")}],{detached:true,stdio:['ignore','inherit','inherit'],windowsHide:true}).unref(); setInterval(()=>{},1000);`);
    const module = fileURLToPath(new URL("../../src/core/process.ts", import.meta.url));
    // Startup measured 20.143 s before the command and another 3.132 s before READY on Windows.
    // Readiness has a 30 s budget; the post-kill reclamation assertion remains 3 s.
    await writeFile(bot, `import {runProcess} from ${JSON.stringify(module)}; import{appendFileSync}from'node:fs'; appendFileSync(${JSON.stringify(phases)},JSON.stringify({phase:'bot',at:Date.now(),pid:process.pid})+String.fromCharCode(10)); await runProcess({command:process.execPath,args:[${JSON.stringify(command)}],cwd:process.cwd(),timeoutMs:30000,onData:data=>process.stdout.write(data)});`);
    const parent = Bun.spawn([process.execPath, bot], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    let pid = 0;
    let killedAt = 0;
    const stderr = new Response(parent.stderr).text();
    const watchdog = setTimeout(() => parent.kill(), 32000);
    try {
      let output = "";
      for await (const data of parent.stdout) {
        output += Buffer.from(data).toString();
        const match = output.match(/READY:(\d+)\r?\n/);
        if (match) { pid = Number(match[1]); killedAt = Date.now(); parent.kill("SIGKILL"); break; }
      }
      await parent.exited;
      console.log(`forced kill ${frame} phases: ` + await readFile(phases, "utf8").catch(String));
      const diagnostic = pid === 0 ? "stderr: " + await stderr + "\nphases: " + await readFile(phases, "utf8").catch(String) : "";
      expect(pid, diagnostic).toBeGreaterThan(0);
      expect(pid).toBe(Number(await readFile(descendantPid, "utf8")));
      const deadline = killedAt + 3000;
      while (alive(pid) && Date.now() < deadline) await Bun.sleep(30);
      expect(alive(pid)).toBe(false);
      expect(Date.now() - killedAt).toBeLessThan(4000);
      await stderr;
    } finally { clearTimeout(watchdog); parent.kill(); await parent.exited; await fixture.cleanup(); }
  }, 42000);

  test.each(["exit", "cancel"])("reaps a detached child on parent %s", async (mode) => {
    const fixture = await tempFixture("supervised-process-");
    const childFile = join(fixture.root, "child.cjs");
    const parentFile = join(fixture.root, "parent.cjs");
    const pidFile = join(fixture.root, "child.pid");
    const phases = join(fixture.root, "phases.jsonl");
    const phase = (name: string) => "require('fs').appendFileSync(" + JSON.stringify(phases) + ",JSON.stringify({phase:" + JSON.stringify(name) + ",at:Date.now(),pid:process.pid})+String.fromCharCode(10)); ";
    // Stay alive through slow startup; the finite supervisor deadline owns failure cleanup.
    await writeFile(childFile, `${phase("child-ready")}require('fs').writeFileSync(process.argv[2],String(process.pid)); process.stdout.write('READY:'+process.pid+String.fromCharCode(10),()=>process.send?.('ready')); setInterval(()=>process.stdout.write('alive'+String.fromCharCode(10)),30);`);
    // Exit only after READY is flushed; observing the PID file races buffered stdout.
    await writeFile(parentFile, `${phase("command")}const {spawn}=require('child_process'); const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{detached:true,stdio:['ignore','inherit','inherit','ipc'],windowsHide:true}); child.on('message',message=>{if(message==='ready'&&process.argv[4]==='exit')process.exit(0)}); child.unref(); setInterval(()=>{},1000);`);
    const controller = new AbortController();
    let pid = 0;
    let readyAt = 0;
    let running: ReturnType<typeof runProcess> | undefined;
    try {
      let output = "";
      const result = running = runProcess({ command: process.execPath, args: [parentFile, childFile, pidFile, mode], cwd: fixture.root,
        // The recorded Windows readiness delay was 20.143 s; cleanup after READY still must take <4 s.
        timeoutMs: 30000, signal: controller.signal, observe: event => appendFileSync(phases, JSON.stringify({ ...event, at: Date.now() }) + "\n"), onData: (data) => {
          output += String(data);
          const match = output.match(/READY:(\d+)\r?\n/);
          if (match && pid === 0) {
            pid = Number(match[1]); readyAt = Date.now();
            appendFileSync(phases, JSON.stringify({ phase: "ready-observed", at: readyAt, pid }) + "\n");
            if (mode === "cancel") controller.abort(new DOMException("test stop", "AbortError"));
          }
        },
      });
      if (mode === "cancel") await expect(result).rejects.toThrow("test stop");
      else expect((await result).exitCode).toBe(0);
      expect(pid).toBeGreaterThan(0);
      expect(Date.now() - readyAt).toBeLessThan(4000);
      expect(alive(pid)).toBe(false);
    } finally {
      controller.abort(); await running?.catch(() => {});
      console.log(`parent ${mode} phases: ` + await readFile(phases, "utf8").catch(String));
      await fixture.cleanup();
    }
  }, 40000);
});
