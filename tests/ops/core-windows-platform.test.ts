import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runNative, nativePayload, type NativeResult } from "../../scripts/ops/core/native-process.ts";
import { tempFixture } from "../helpers/temp.ts";

const source = resolve(import.meta.dir, "../..");
const windows = process.platform === "win32";

// Only native Task Scheduler/CIM effects are substituted. The real platform script and Stop-ProjectBot are loaded.
const harness = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$global:fixture=Get-Content -LiteralPath $env:FIXTURE_FACTS -Raw -Encoding UTF8 | ConvertFrom-Json
$global:effects=[Collections.Generic.List[string]]::new()
function Get-ScheduledTask {
    param($TaskName, $ErrorAction)
    if ($global:fixture.inventoryError) { throw '任务清单无法读取' }
    if ($global:fixture.duplicate) { $global:fixture.task }
    $global:fixture.task
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($global:fixture.processError) { throw '进程清单无法读取' }
    if ($global:fixture.foreground) { [pscustomobject]@{ ProcessId=54321; CommandLine=('bun.exe "'+(Join-Path $env:FIXTURE_ROOT 'src/server/index.ts')+'"') } }
    if ($global:fixture.recorded) {
        [pscustomobject]@{ ProcessId=$global:fixture.recorded.pid; CommandLine='bun.exe app.ts'
            CreationDate=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$global:fixture.recorded.created).LocalDateTime }
    }
}
function Disable-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('disable'); $global:fixture.task.State='Disabled' }
function Enable-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('enable'); $global:fixture.task.State='Ready' }
function Stop-ScheduledTask {
    param($TaskName,$ErrorAction)
    $global:effects.Add('stop')
    if ($global:fixture.stopError) { throw '合成停止失败中文' }
    $global:fixture.task.State='Disabled'
}
function Start-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('start'); $global:fixture.task.State='Running' }
$global:LASTEXITCODE=0
& $env:FIXTURE_PLATFORM -RequestBase64 $env:FIXTURE_REQUEST
$code=$LASTEXITCODE
[IO.File]::WriteAllText($env:FIXTURE_EFFECTS,(ConvertTo-Json -InputObject @($global:effects) -Compress),[Text.UTF8Encoding]::new($false))
exit $code
`;

async function fixture() {
  const f = await tempFixture("native-windows-");
  const root = join(f.root, "中文 project"), script = join(f.root, "invoke.ps1");
  const facts = join(f.root, "facts.json"), effects = join(f.root, "effects.json");
  await writeFile(script, "\ufeff" + harness.replace(/\r?\n/g, "\r\n"));
  const task = { TaskName: "mixin-chatbot", TaskPath: "\\", State: "Ready",
    Principal: { UserId: "test-user", GroupId: null, LogonType: "S4U", RunLevel: "Highest" },
    Actions: [{ Execute: "powershell.exe", Arguments: "-File fixture.ps1", WorkingDirectory: root }] };
  const call = async (action: string, fields: Record<string, unknown> = {}, expected?: string) => {
    await writeFile(facts, JSON.stringify({ task, ...fields }));
    let stderr = "";
    const result = await runNative({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      cwd: f.root, protocol: true, env: { ...process.env, FIXTURE_FACTS: facts, FIXTURE_EFFECTS: effects, FIXTURE_ROOT: root,
        FIXTURE_PLATFORM: join(source, "scripts/ops/core/windows-platform.ps1"),
        FIXTURE_REQUEST: Buffer.from(JSON.stringify({ action, project: root, task: "mixin-chatbot", ...(expected ? { expected } : {}) })).toString("base64") },
    }, (text, stream) => { expect(stream).toBe("stderr"); stderr += text; });
    return { ...result, stderr, effects: JSON.parse(await readFile(effects, "utf8")) as string[] };
  };
  return { ...f, root, task, call };
}
const service = (result: NativeResult) => nativePayload(result, "inspect") as { identity: string; owned: boolean; state: string };

test.skipIf(!windows)("真实 Windows 平台脚本保留单一 JSON；启停只在相同身份上执行，状态不影响部署身份", async () => {
  const f = await fixture();
  try {
    const before = service(await f.call("inspect"));
    expect(before).toMatchObject({ owned: true, state: "stopped" });
    expect(before.identity).toMatch(/^[a-f0-9]{64}$/);
    const running = { ...f.task, State: "Running" };
    expect(service(await f.call("inspect", { task: running })).identity).toBe(before.identity);
    const stop = await f.call("stop", { task: running }, before.identity);
    expect(nativePayload(stop, "stop")).toBeNull();
    expect(stop.effects).toEqual(["disable", "stop", "enable"]);
    expect(stop.stderr).toBe("");
    const start = await f.call("start", { task: { ...f.task, State: "Disabled" } }, before.identity);
    expect(nativePayload(start, "start")).toBeNull(); expect(start.effects).toEqual(["enable", "start"]);
    const changed = await f.call("start", { task: { ...f.task, Principal: { ...f.task.Principal, UserId: "another" } } }, before.identity);
    expect(changed.code).toBe(1); expect(changed.effects).toEqual([]);
    const failed = await f.call("stop", { task: running, stopError: true }, before.identity);
    expect(failed.code).toBe(1); expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("合成停止失败中文"); expect(failed.effects).toEqual(["disable", "stop", "enable"]);
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(!windows)("真实 Windows 状态读取拒绝清单错误、前台进程、陌生任务和未识别任务状态", async () => {
  const f = await fixture();
  try {
    const identity = service(await f.call("inspect")).identity;
    for (const fields of [{ inventoryError: true }, { duplicate: true }, { processError: true }]) {
      const failed = await f.call("inspect", fields);
      expect(failed.code).toBe(1); expect(failed.stdout).toBe(""); expect(failed.effects).toEqual([]);
    }
    for (const fields of [{ foreground: true }, { task: { ...f.task, State: "Queued" } }]) {
      expect(service(await f.call("inspect", fields)).state).toBe("unsupported");
      const failed = await f.call("start", fields, identity);
      expect(failed.code).toBe(1); expect(failed.effects).toEqual([]);
    }
    expect(service(await f.call("inspect", { task: null })).state).toBe("absent");
    expect(service(await f.call("inspect", { task: { ...f.task, Actions: [{ ...f.task.Actions[0], WorkingDirectory: join(f.root, "another") }] } })).owned).toBe(false);
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await writeFile(join(f.root, "data/state/instance.json"), '{"token":"fixture-token-never-print", broken');
    const malformed = await f.call("inspect");
    expect(malformed.code).toBe(1); expect(malformed.stdout).toBe(""); expect(malformed.stderr).not.toContain("fixture-token-never-print");
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(!windows)("真实 Windows 状态读取接受带小数的 startedAt（1.0.1 及更早的服务这样写），按记录识别前台进程", async () => {
  const f = await fixture();
  try {
    const created = Date.now() - 60_000;
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ pid: 4242, port: 12011, token: "fixture-token", host: "127.0.0.1",
      cwd: f.root, instanceId: "630fe401-1f9e-40f1-b4c4-deb9fb196d74", startedAt: created + 812.2942 }));
    const running = await f.call("inspect", { task: { ...f.task, State: "Running" }, recorded: { pid: 4242, created } });
    expect(running.code).toBe(0); expect(service(running).state).toBe("running");
    expect(service(await f.call("inspect", { recorded: { pid: 4242, created } })).state).toBe("unsupported");
    expect(service(await f.call("inspect", { recorded: { pid: 4242, created: created - 3_600_000 } })).state).toBe("stopped");
  } finally { await f.cleanup(); }
}, 30_000);
