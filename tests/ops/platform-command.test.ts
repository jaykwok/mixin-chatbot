import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opsCommand, PROJECT_DIR } from "../../ops/core/platform.ts";
import { QueryPool } from "../../console/server/exec-client.ts";
import { tempFixture } from "../helpers/temp.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

test("manual compaction selects the same member on both ops platforms", () => {
  const args = ["history-compact", "synthetic", "member", "--storage-segment"];
  const windows = opsCommand("windows", args);
  const request = JSON.parse(Buffer.from(windows.args.at(-1)!, "base64").toString("utf8"));
  expect(request).toEqual({ Command: "history-compact", Target: "synthetic", User: "member", StorageSegment: true });
  expect(opsCommand("linux", args).args.slice(1)).toEqual(args);
});

test("清空所有群在两个运维平台都只以 --all / -All 传递，不带群号", () => {
  const args = ["history-clear", "--all"];
  const request = JSON.parse(Buffer.from(opsCommand("windows", args).args.at(-1)!, "base64").toString("utf8"));
  expect(request).toEqual({ Command: "history-clear", All: true });
  expect(opsCommand("linux", args).args.slice(1)).toEqual(args);
});

test("导入旧统计把所选文件作为路径交给两个平台的运维入口", () => {
  const file = "D:\\old deployment\\data\\groups\\stats.sqlite";
  const request = JSON.parse(Buffer.from(opsCommand("windows", ["stat-import", file]).args.at(-1)!, "base64").toString("utf8"));
  expect(request).toEqual({ Command: "stat-import", Target: file });
  expect(opsCommand("linux", ["stat-import", "/srv/old/data/groups/stats.sqlite"]).args.slice(1)).toEqual(["stat-import", "/srv/old/data/groups/stats.sqlite"]);
});

// 从真实脚本提取函数和入口，只替换宿主机探测/写操作。
// 测试不运行真实的 repair、purge、directory-admin 或计划任务命令。
const BUILD = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:OPS_TEST_OPS, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'ops.ps1 syntax error' }
$common = [Management.Automation.Language.Parser]::ParseFile($env:OPS_TEST_COMMON, [ref]$tokens, [ref]$errors)
$parts = @($ast.ParamBlock.Extent.Text, '$script:OpsInputNames = @($PSBoundParameters.Keys)', '$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)')
foreach ($name in @('Invoke-WithUtf8Output', 'Get-OpsCommandHint')) {
    $definition = $common.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    $parts += $definition.Extent.Text
}
foreach ($name in @('Show-Doctor', 'Step', 'Done', 'Warn', 'New-DoctorRow', 'Clear-SpaceHistory', 'Invoke-CoreMaintenance', 'Invoke-TmpAdmin', 'Invoke-RelayAdmin',
    'Invoke-ServiceCommand')) {
    $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $definition) { throw "missing function $name" }
    $parts += $definition.Extent.Text
}
$parts += @'
$Project = $PSScriptRoot
$OpsSource = $PSScriptRoot
$Port = 1011
$TaskName = 'fixture'
$DeployedWorkspaceRoot = ''
$DataDir = Join-Path $PSScriptRoot 'data'
$StateDir = Join-Path $PSScriptRoot 'data\state'
$ModelsFile = Join-Path $PSScriptRoot 'data\config\models.json'
function Test-ModelConfiguration($project) {
    & $env:OPS_TEST_BUN $env:OPS_TEST_VALIDATOR $PSScriptRoot
    return $LASTEXITCODE -eq 0
}
$AppBotFile = Join-Path $PSScriptRoot 'data\config\app-bot.json'
# Stands in for "bun run ops\tools\directory-admin.ts doctor" (the service's Stream and directory rows: status, name, detail)
# and "bun run ops\tools\version-info.ts" (name, value).
# The rows come from the environment: Bun's transpiler escapes non-ASCII text, which String.raw would keep as "\uXXXX".
function Get-BunPath { return {
    $global:LASTEXITCODE = 0
    if ($args -contains 'ops\tools\version-info.ts') { $env:OPS_TEST_VERSION -split [char]10 } else { $env:OPS_TEST_STREAM -split [char]10 }
} }
function Test-Local { if ($env:OPS_TEST_HEALTH -eq 'fail') { return 0 }; if ($env:OPS_TEST_HEALTH -eq 'verification') { return 503 }; return 200 }
function Get-BotPids { if ($env:OPS_TEST_HEALTH -ne 'fail') { return 42 } }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
    if ($env:OPS_TEST_HEALTH -ne 'fail') { return [pscustomobject]@{ OwningProcess = 42 } }
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) }
function Get-RelayDoctorRows { }
function Err($message) { [Console]::Error.WriteLine($message) }
function Invoke-ConsoleProcess([string]$FilePath, [string[]]$Arguments) {
    if ($Arguments[2] -ceq 'maintenance') { Write-Captured 'ops-core' @($Arguments[3..($Arguments.Length-3)]); return 0 }
    if ($Arguments[0] -cne '--no-env-file' -or $Arguments[1] -notlike '*ops*core*cli.ts' -or $Arguments[2] -cne 'service') { throw 'wrong core entry' }
    Step $env:OPS_TEST_PROGRESS
    [Console]::Error.WriteLine($env:OPS_TEST_DIAGNOSTIC)
    [Console]::Out.WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from("机器人运行中（实例身份与就绪检查通过）").toString("base64")}')))
    return 0
}
function Write-Captured([string]$Script, [string[]]$CliArgs) {
    $payload = [pscustomobject]@{ script = $Script; argv = @($CliArgs) }
    Invoke-WithUtf8Output { [Console]::WriteLine(($payload | ConvertTo-Json -Compress)) }
}
function Invoke-DataAdmin([string]$Script, [string[]]$CliArgs) { Write-Captured $Script $CliArgs; return $true }
# The system "open file" dialog: the path the test names, or nothing (cancelled).
function Select-StatsFile { if ($env:OPS_TEST_PICK) { return $env:OPS_TEST_PICK } }
'@
$jsonEntry = @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($Json -and $Command -in') })
$parts += ($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($RequestBase64)') }).Extent.Text
$switchEntry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.SwitchStatementAst] -and $_.Condition.Extent.Text -eq '$Command' })
if ($jsonEntry.Count -ne 1 -or $switchEntry.Count -ne 1) { throw 'missing real dispatcher' }
$parts += $jsonEntry[0].Extent.Text
$parts += $switchEntry[0].Extent.Text
[IO.File]::WriteAllText($env:OPS_TEST_WRAPPER, ($parts -join [Environment]::NewLine), [Text.UTF8Encoding]::new($true))
`;

async function fixtureWrapper() {
  const fixture = await tempFixture("platform-command-");
  const wrapper = join(fixture.root, "ops-fixture.ps1");
  const builder = join(fixture.root, "build.ps1");
  await writeFile(builder, "\ufeff" + BUILD);
  // doctor 的模型检查走真实的离线校验，所以 fixture 要摆出一份 Pi 真能解析的配置：
  // models.json 只带凭证，选型在项目私有 agent 目录的 settings.json 里。
  await mkdir(join(fixture.root, "data", "config"), { recursive: true });
  await mkdir(join(fixture.root, "data", "runtime", "pi"), { recursive: true });
  await writeFile(join(fixture.root, "data", "config", "models.json"),
    '{"providers":{"zai-coding-cn":{"apiKey":"test-only"}}}');
  await writeFile(join(fixture.root, "data", "runtime", "pi", "settings.json"),
    '{"defaultProvider":"zai-coding-cn","defaultModel":"glm-5.3-flash"}');
  await writeFile(join(fixture.root, "data", "config", "app-bot.json"), '{"appId":"test-app","appSecret":"test-only-secret"}');
  const child = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", builder], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, OPS_TEST_OPS: join(PROJECT_DIR, "scripts", "ops.ps1"),
      OPS_TEST_COMMON: join(PROJECT_DIR, "scripts", "lib", "common.ps1"), OPS_TEST_WRAPPER: wrapper },
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) { await fixture.cleanup(); throw new Error(error); }
  const spawn = async (argv: string[], health: string, env: Record<string, string>) => {
    const child = Bun.spawn(argv, {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, OPS_TEST_HEALTH: health, OPS_TEST_BUN: process.execPath, OPS_TEST_VALIDATOR: join(PROJECT_DIR, "ops/config/validate-models.ts"),
        OPS_TEST_PROGRESS: "正在启动机器人", OPS_TEST_DIAGNOSTIC: "测试诊断：Stream 信息",
        OPS_TEST_STREAM: "pass\t事件 Stream\t已连接 3 分钟\nwarn\t通讯录同步\t范围状态：正在应用，完成前之前的范围（整个通讯录）仍然生效",
        OPS_TEST_VERSION: "应用机器人\tv1.0.0\n构建\tabc1234\n数据格式\t1", ...env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return { ...fixture,
    /** The console's call: the request opsCommand encodes, decoded by the real entry. */
    run(args: string[], health = "pass", env: Record<string, string> = {}) {
      const command = opsCommand("windows", args);
      command.args[4] = wrapper;
      return spawn([command.command, ...command.args], health, { ...command.env, ...env });
    },
    /** A command-line call with the entry's own parameters. */
    native(args: string[], health = "pass", env: Record<string, string> = {}) {
      return spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...args], health, env);
    } };
}

test("Windows 规范化参数保留群名中的空格，Linux 把取值并入参数；控制台不发的参数一律拒绝", () => {
  const decode = (args: string[]) => {
    const command = opsCommand("windows", args);
    expect(command.args[5]).toBe("-RequestBase64");
    return JSON.parse(Buffer.from(command.args[6]!, "base64").toString());
  };
  const preview = ["tmp-preview", "--plan", "a-plan", "--all", "--user", "13812345678", "--group", "技术 支持群", "--storage-segment"];
  expect(decode(preview)).toEqual({ Command: "tmp-preview", Plan: "a-plan", All: true, User: "13812345678", Group: "技术 支持群", StorageSegment: true });
  expect(opsCommand("linux", preview).args.slice(1)).toEqual(["tmp-preview", "--plan=a-plan", "--all", "--user=13812345678", "--group=技术 支持群", "--storage-segment"]);
  for (const args of [["stat", "support"], ["directory-scope", "all"], ["doctor", "--repair"], ["tmp-preview", "--group-id"], ["history-clear", "g", "--period", "last-month"]]) {
    expect(() => opsCommand("windows", args), args.join(" ")).toThrow();
  }
});

windowsTest("Windows doctor/status -Json 只输出 JSON，真实失败返回非零，修复不会混入只读接口", async () => {
  const fixture = await fixtureWrapper();
  try {
    for (const command of ["doctor", "status"]) {
      for (const state of ["pass", "fail", "verification"]) {
        const result = await fixture.run([command, "--json"], state);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
        const payload = JSON.parse(result.stdout);
        expect(payload.checks.some((check: { name: string }) => check.name === "本地机器人健康")).toBe(true);
        expect(result.code).toBe(state === "pass" ? 0 : 1);
        expect(payload.fail > 0).toBe(state !== "pass");
        if (state === "verification") {
          const health = payload.checks.find((check: { name: string }) => check.name === "本地机器人健康");
          expect(health.detail).toContain("只验证");
          expect(health.fix).toContain("scripts\\ops.ps1 resume");
        }
        for (const check of payload.checks) expect(typeof check.fix).toBe("string");
        const names = payload.checks.map((check: { name: string }) => check.name);
        expect(names).toContain("data/config/app-bot.json");
        expect(names.includes("事件 Stream")).toBe(state === "pass");
        expect(Object.keys(payload).sort()).toEqual(["checks", "fail", "pass", "port", "warn"]);
        if (state === "pass") {
          expect(payload.checks.find((check: { name: string }) => check.name === "事件 Stream")).toMatchObject({ status: "pass", detail: "已连接 3 分钟", fix: "" });
          expect(payload.checks.find((check: { name: string }) => check.name === "通讯录同步")).toMatchObject({ status: "warn", detail: "范围状态：正在应用，完成前之前的范围（整个通讯录）仍然生效" });
          expect(payload.warn).toBeGreaterThan(0);
          expect(payload.checks.find((check: { name: string }) => check.name === "应用机器人")).toMatchObject({ status: "pass", detail: "v1.0.0" });
          expect(payload.checks.find((check: { name: string }) => check.name === "数据格式")).toMatchObject({ status: "pass", detail: "1" });
        }
      }
    }
    // An unreadable deployment record fails the check and warns against deploying over it.
    const unknown = JSON.parse((await fixture.run(["doctor", "--json"], "pass", { OPS_TEST_VERSION: "应用机器人\t未知：部署记录没有程序版本" })).stdout);
    expect(unknown.checks.find((check: { name: string }) => check.name === "应用机器人")).toMatchObject({ status: "fail", detail: "未知：部署记录没有程序版本" });
    expect(unknown.checks.find((check: { name: string }) => check.name === "应用机器人").fix).toContain("不要在此目录覆盖部署");
    const repair = await fixture.native(["doctor", "-Json", "-Repair"]);
    expect(repair.code).toBe(2);
    expect(repair.stdout).toBe("");
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows 管理入口调用部署脚本并保留失败退出码", async () => {
  const fixture = await fixtureWrapper();
  try {
    await mkdir(join(fixture.root, "scripts"), { recursive: true });
    for (const code of [0, 17]) {
      await writeFile(join(fixture.root, "scripts/deploy.ps1"), '\ufeffWrite-Output "DEPLOY_FIXTURE"\nWrite-Output "UI=$env:MIXIN_OPS_UI"\nexit ' + code + '\n');
      const result = await fixture.run(["deploy"]);
      expect(result.stdout).toContain("DEPLOY_FIXTURE"); expect(result.code, result.stderr).toBe(code);
      expect(result.stdout).toContain("UI=cli");
    }
  } finally { await fixture.cleanup(); }
}, 15000);

windowsTest("控制台体检与修复输出使用控制台页面，直接调用仍给命令行建议", async () => {
  const fixture = await fixtureWrapper();
  try {
    // Missing credentials point at the app-bot wizard; a paused revocation points at the directory page.
    await Bun.file(join(fixture.root, "data", "config", "app-bot.json")).delete();
    for (const ui of ["console", "cli"]) {
      const web = ui === "console", env = { MIXIN_OPS_UI: ui };
      const passing = JSON.parse((await fixture.run(["doctor", "--json"], "pass", env)).stdout);
      expect(passing.checks.find((check: { name: string }) => check.name === "通讯录同步").fix)
        .toContain(web ? "「通讯录」" : "scripts\\ops.ps1 directory");
      const result = await fixture.run(["doctor", "--json"], "fail", env);
      expect(result.code, result.stderr).toBe(1);
      const health = JSON.parse(result.stdout);
      const fixes = health.checks.map((check: { fix: string }) => check.fix).join("\n");
      expect(fixes).toContain(web ? "设置 → 应用机器人凭据" : "scripts\\ops.ps1 configure-app-bot");
      expect(fixes).toContain(web ? "维护 → 重新部署" : "scripts\\ops.ps1 deploy");
      expect(fixes).toContain(web ? "「日志」" : "scripts\\ops.ps1 logs");
      if (web) expect(fixes).not.toMatch(/ops\.ps1|scripts[\\/]|bun run/);
      const printed = await fixture.run(["doctor"], "fail", env);
      expect(printed.stdout).toContain(web ? "维护 → 修复部署" : "scripts\\ops.ps1 doctor -Repair");
      if (web) expect(printed.stdout).not.toMatch(/ops\.ps1|scripts[\\/]|bun run/);
    }
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows 管理入口在中文代码页下通过 UTF-8 输出普通进度、诊断和错误", async () => {
  const fixture = await fixtureWrapper();
  try {
    const result = await fixture.run(["start"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("正在启动机器人");
    expect(result.stdout).toContain("机器人运行中");
    expect(result.stderr.trim()).toBe("测试诊断：Stream 信息");
    const command = opsCommand("windows", ["start"]);
    command.args[4] = join(fixture.root, "ops-fixture.ps1");
    const queries = new QueryPool();
    try {
      const captured = await queries.capture(command.command, command.args, {
        env: { OPS_TEST_PROGRESS: "正在启动机器人", OPS_TEST_DIAGNOSTIC: "测试诊断：Stream 信息" },
      });
      expect(captured.code, captured.stderr).toBe(0);
      expect(captured.stdout).toContain("正在启动机器人");
      expect(captured.stderr.trim()).toBe("测试诊断：Stream 信息");
      expect(captured.stdout + captured.stderr).not.toContain("\uFFFD");
    } finally { await queries.stop(); }
    const error = await fixture.run(["未知操作"]);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("无法识别的命令：未知操作");
  } finally { await fixture.cleanup(); }
}, 15000);

windowsTest("Windows 通讯录、外链全清和临时目录范围都到达正确 CLI", async () => {
  const fixture = await fixtureWrapper();
  try {
    const cases = [
      { input: ["directory"], argv: ["status"], script: "ops\\tools\\directory-admin.ts" },
      { input: ["relay-test"], argv: ["test"], script: "relay" },
      { input: ["relay-purge", "--all"], argv: ["purge", "--all"], script: "relay" },
      ...["-All", "-all", "-A", "--all", "--group", "含 空格与'引号"].map(keyword => ({
        input: ["relay-purge", "--keyword", keyword], argv: ["purge", "--keyword", keyword], script: "relay",
      })),
      { input: ["tmp-purge", "--all", "--group", "g1", "--user", "13812345678"], argv: ["purge", "--all", "--user=13812345678", "--group=g1"], script: "tmp" },
      { input: ["tmp-preview", "--plan", "a-plan", "--all", "--group", "-Repair", "--storage-segment"], argv: ["preview", "--all", "--plan", "a-plan", "--group=-Repair", "--storage-segment"], script: "tmp" },
      { input: ["tmp-preview", "--days", "30", "--plan", "a-plan"], argv: ["preview", "--days", "30", "--plan", "a-plan"], script: "tmp" },
      { input: ["tmp-purge", "--plan", "a-plan", "--digest", "a-digest"], argv: ["purge", "--plan", "a-plan", "--digest", "a-digest"], script: "tmp" },
      { input: ["tmp-reclaim", "--plan", "a-plan", "--digest", "a-digest"], argv: ["reclaim", "--plan", "a-plan", "--digest", "a-digest"], script: "tmp" },
      { input: ["tmp-discard", "--plan", "a-plan"], argv: ["discard", "--plan", "a-plan"], script: "tmp" },
      { input: ["tmp-discard", "--plan", "a-plan", "--digest", "a-digest"], argv: ["discard", "--plan", "a-plan", "--digest", "a-digest"], script: "tmp" },
    ];
    for (const { input, argv, script } of cases) {
      // A successful health probe without a scheduled task represents a foreground bot. Purge now correctly
      // refuses it; this argv fixture uses a stopped bot, while maintenance-window tests cover foreground refusal.
      const result = await fixture.run(input, input[0] === "relay-purge" ? "fail" : "pass");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["tmp", "relay"].includes(script) ? { script: "ops-core", argv: [input[0], ...argv.slice(1)] } : { script, argv });
    }
    // Command-line calls with the entry's own parameters, which the console does not send.
    for (const { input, argv, script } of [
      { input: ["directory-scope", "all"], argv: ["scope", "all"], script: "ops\\tools\\directory-admin.ts" },
      { input: ["tmp-ls", "-Group", "support team", "-GroupId"], argv: ["tmp-ls", "--group=support team", "--group-id"], script: "ops-core" },
      { input: ["stat", "support", "-GroupId"], argv: ["--group-id", "--", "support"], script: "ops\\tools\\stats-admin.ts" },
      { input: ["stat", "support", "-Period", "last-month"], argv: ["--period", "last-month", "--", "support"], script: "ops\\tools\\stats-admin.ts" },
    ]) {
      const result = await fixture.native(input);
      expect(result.stderr).toBe("");
      expect(result.code, input.join(" ")).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ script, argv });
    }
    // The confirmation of paused revocations and the department listing (only the picker shows departments) are gone.
    for (const command of ["directory-confirm", "directory-departments"]) {
      const removed = await fixture.run([command]);
      expect(removed.code).toBe(1);
      expect(removed.stdout + removed.stderr).toContain(`无法识别的命令：${command}`);
    }
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows 清空所有群经 -All 交给共享维护核心，同时指定群时拒绝", async () => {
  const fixture = await fixtureWrapper();
  try {
    // 停止和启动是桩；"fail" 让 Get-BotPids 报告未运行，输出只剩进度行和捕获的参数。
    const all = await fixture.run(["history-clear", "--all"], "fail");
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({ script: "ops-core", argv: ["history-clear", "--all"] });
    for (const input of [["history-clear", "support", "--all"], ["history-clear", "--all", "--storage-segment"]]) {
      const refused = await fixture.run(input, "fail");
      expect(refused.code).toBe(2);
      expect(refused.stdout).not.toContain("ops-core");
    }
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows stat-import 给了路径直接导入，不给路径时用文件选择框所选文件，取消或文件不存在时不导入", async () => {
  const fixture = await fixtureWrapper();
  try {
    const ledger = join(fixture.root, "old deployment", "stats.sqlite");
    await mkdir(join(fixture.root, "old deployment"), { recursive: true });
    await writeFile(ledger, "synthetic");
    const captured = (stdout: string) => JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
    const given = await fixture.run(["stat-import", ledger], "fail");
    expect(given.code, given.stderr).toBe(0);
    expect(captured(given.stdout)).toEqual({ script: "ops-core", argv: ["stat-import", ledger] });
    const picked = await fixture.run(["stat-import"], "fail", { OPS_TEST_PICK: ledger });
    expect(picked.code, picked.stderr).toBe(0);
    expect(captured(picked.stdout)).toEqual({ script: "ops-core", argv: ["stat-import", ledger] });
    const cancelled = await fixture.run(["stat-import"], "fail");
    expect(cancelled.code).toBe(2);
    expect(cancelled.stdout).not.toContain("ops-core");
    const missing = await fixture.run(["stat-import", join(fixture.root, "absent.sqlite")], "fail");
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("ops-core");
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows 备份清理入口把报告名和确认码原样交给清理工具", async () => {
  const fixture = await fixtureWrapper();
  try {
    // 命令行入口，不经控制台：直接用 ops.ps1 的原生参数调用。
    const report = "20260928T000000Z-abcdef";
    for (const [args, argv] of [[["backup-scan"], ["scan"]], [["backup-clean", report], ["apply", report]],
      [["backup-clean", report, "-ConfirmCode", "0123456789abcdef"], ["apply", report, "--confirm", "0123456789abcdef"]]]) {
      const result = await fixture.native(args!);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ script: "ops-core", argv: [args![0], ...argv!.slice(1)] });
    }
    // 缺少报告名时不调用工具（错误信息按包装脚本模拟的 GBK 控制台输出，这里不比对文字）。
    const missing = await fixture.native(["backup-clean"]);
    expect(missing.code).toBe(2); expect(missing.stdout).toBe("");
  } finally { await fixture.cleanup(); }
}, 30000);
