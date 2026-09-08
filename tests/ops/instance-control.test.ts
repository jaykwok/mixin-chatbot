import { expect, test } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test.skipIf(process.platform !== "win32")("Windows ops gracefully stop an owned Bun instance launched with a relative path", async () => {
  const fixture = await tempFixture("instance-control-");
  const childFile = join(fixture.root, "bot.ts");
  await writeFile(childFile, `import {mkdirSync,writeFileSync} from 'node:fs';
    const token='a'.repeat(64); const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
      if(req.headers.get('authorization')!=='Bearer '+token)return new Response('denied',{status:404});
      writeFileSync('graceful.txt','received'); setTimeout(()=>process.exit(0),50); return Response.json({status:'stopping'});
    }}); mkdirSync('data/state',{recursive:true}); writeFileSync('data/state/instance.json',JSON.stringify({pid:process.pid,port:server.port,token,cwd:process.cwd(),startedAt:Date.now()-process.uptime()*1000}));
    console.log('READY'); setTimeout(()=>process.exit(2),15000);`);
  const child = Bun.spawn([process.execPath, "bot.ts"], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const library = fileURLToPath(new URL("../../scripts/lib/lifecycle.ps1", import.meta.url));
  const stopFile = join(fixture.root, "stop.ps1");
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  await writeFile(stopFile, `\ufeff$ErrorActionPreference='Stop'\n. ${quote(library)}\nif (Stop-ProjectBot ${quote(fixture.root)} 'audit-no-scheduled-task') { exit 0 } else { exit 1 }`);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("READY");
    const control = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stopFile], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([control.exited, new Response(control.stdout).text(), new Response(control.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(await readFile(join(fixture.root, "graceful.txt"), "utf8")).toBe("received");
  } finally { child.kill(); await child.exited; await fixture.cleanup(); }
}, 40000);
