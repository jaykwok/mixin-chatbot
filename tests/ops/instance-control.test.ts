import { expect, test } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const library = fileURLToPath(new URL("../../scripts/lib/lifecycle.ps1", import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

// startedAt is recorded once the Bun runtime is up; a start under load put it more than 5 s after the process
// creation, so the instance was not recognised and Stop-ProjectBot reported success while the bot kept running.
test.skipIf(process.platform !== "win32")("Windows instance identity accepts a slow runtime start and rejects a process created later", async () => {
  const fixture = await tempFixture("instance-identity-");
  const script = join(fixture.root, "identity.ps1");
  // The test runner's own bun.exe stands in for the bot; only the recorded start time varies.
  await writeFile(script, "\ufeff" + [
    "$ErrorActionPreference='Stop'",
    ". " + quote(library),
    "New-Item -ItemType Directory -Force -Path (Join-Path " + quote(fixture.root) + " 'data\\state') | Out-Null",
    "$created=([DateTimeOffset](Get-CimInstance Win32_Process -Filter 'ProcessId=" + process.pid + "').CreationDate).ToUnixTimeMilliseconds()",
    "foreach ($lag in @(0, 8000, 120000, -8000, 400000)) {",
    "  @{pid=" + process.pid + "; port=1; token=('a'*64); cwd=" + quote(fixture.root) + "; startedAt=$created+$lag} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path " + quote(fixture.root) + " 'data\\state\\instance.json')",
    "  Write-Output ('' + $lag + '=' + [bool](Get-ProjectBotInstance " + quote(fixture.root) + "))",
    "}",
  ].join("\n"));
  try {
    const control = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([control.exited, new Response(control.stdout).text(), new Response(control.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim().split(/\r?\n/)).toEqual(["0=True", "8000=True", "120000=True", "-8000=False", "400000=False"]);
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows ops gracefully stop an owned Bun instance launched with a relative path", async () => {
  const fixture = await tempFixture("instance-control-");
  const childFile = join(fixture.root, "bot.ts");
  // The child and the stop script log timestamped events, so a failure shows whether the request arrived, how
  // the stop script decided, and why the child exited (no exit line means it was terminated forcibly).
  await writeFile(childFile, `import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
    const note=(text)=>appendFileSync('child.log',Date.now()+' child '+text+'\\n');
    let reason='unexpected'; process.on('exit',code=>note('exit '+code+' '+reason)); note('start pid '+process.pid);
    const token='a'.repeat(64); const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
      const authorized=req.headers.get('authorization')==='Bearer '+token;
      note('request '+req.method+' '+new URL(req.url).pathname+' authorized '+authorized);
      if(!authorized)return new Response('denied',{status:404});
      writeFileSync('graceful.txt','received'); reason='shutdown request'; setTimeout(()=>process.exit(0),50); return Response.json({status:'stopping'});
    }}); mkdirSync('data/state',{recursive:true}); writeFileSync('data/state/instance.json',JSON.stringify({pid:process.pid,port:server.port,token,cwd:process.cwd(),startedAt:Date.now()-process.uptime()*1000}));
    note('ready port '+server.port); console.log('READY');
    // Longer than the test budget: the child never leaves on its own while the stop is still deciding.
    setTimeout(()=>{reason='self-timeout';process.exit(2)},120000);`);
  const events = [`${Date.now()} test spawn child`];
  const child = Bun.spawn([process.execPath, "bot.ts"], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const stopFile = join(fixture.root, "stop.ps1");
  await writeFile(stopFile, "\ufeff" + [
    "$ErrorActionPreference='Stop'",
    ". " + quote(library),
    "function Note($text){ Add-Content -LiteralPath 'control.log' -Value ('{0} control {1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),$text) }",
    // Time the slow system queries Stop-ProjectBot makes; the wrappers pass every argument to the real cmdlets.
    "function Get-ScheduledTask { $watch=[Diagnostics.Stopwatch]::StartNew(); $result=ScheduledTasks\\Get-ScheduledTask @args; Note ('Get-ScheduledTask took ' + $watch.ElapsedMilliseconds + 'ms'); $result }",
    "function Get-CimInstance { $watch=[Diagnostics.Stopwatch]::StartNew(); $result=CimCmdlets\\Get-CimInstance @args; Note ('Get-CimInstance ' + ($args -join ' ') + ' found ' + @($result).Count + ' in ' + $watch.ElapsedMilliseconds + 'ms'); $result }",
    "Note 'start'",
    "$recorded=Get-Content -LiteralPath 'data\\state\\instance.json' -Raw | ConvertFrom-Json; $process=CimCmdlets\\Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$recorded.pid)",
    "Note ('recorded startedAt minus process creation ' + ([double]$recorded.startedAt - ([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds()) + 'ms')",
    "Note ('identity ' + $(if (Get-ProjectBotInstance " + quote(fixture.root) + ") {'recognised'} else {'not recognised'}))",
    "$stopped = Stop-ProjectBot " + quote(fixture.root) + " 'audit-no-scheduled-task'",
    "Note ('Stop-ProjectBot returned ' + $stopped)",
    "if ($stopped) { exit 0 } else { exit 1 }",
  ].join("\n"));
  const timeline = async () => {
    const logs = await Promise.all(["child.log", "control.log"].map(name => readFile(join(fixture.root, name), "utf8").catch(() => "")));
    const lines = [...events, ...logs.join("").split(/\r?\n/)].filter(Boolean).sort((a, b) => Number(a.split(" ")[0]) - Number(b.split(" ")[0]));
    const start = Number(lines[0]!.split(" ")[0]);
    return "\n" + lines.map(line => `+${Number(line.split(" ")[0]) - start}ms ${line.slice(line.indexOf(" ") + 1)}`).join("\n");
  };
  // Deadlines inside the test budget, so a slow or stuck stop still reports its timeline instead of a bare timeout.
  const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, Bun.sleep(ms).then(() => null)]);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("READY");
    events.push(`${Date.now()} test start stop script`);
    const control = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stopFile], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const output = Promise.all([new Response(control.stdout).text(), new Response(control.stderr).text()]);
    let code = await within(control.exited, 40_000);
    if (code === null) {
      events.push(`${Date.now()} test stop script still running after 40 s, killed`);
      control.kill(); code = await control.exited;
    } else events.push(`${Date.now()} test stop script exited ${code}`);
    const [stdout, stderr] = await output;
    let exited = await within(child.exited, 5_000);
    if (exited === null) {
      events.push(`${Date.now()} test child still running 5 s after the stop script, killed`);
      child.kill(); exited = await child.exited;
    } else events.push(`${Date.now()} test child exited ${exited}`);
    const diagnostics = await timeline() + "\n" + stdout + "\n" + stderr + "\n" + await new Response(child.stderr).text();
    expect(code, diagnostics).toBe(0);
    expect(exited, diagnostics).toBe(0);
    expect(diagnostics).toContain("child request POST /_admin/shutdown authorized true");
    expect(diagnostics).toContain("child exit 0 shutdown request");
    expect(await readFile(join(fixture.root, "graceful.txt"), "utf8")).toBe("received");
  } finally { child.kill(); await child.exited; await fixture.cleanup(); }
}, 60000);
