import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opsCommand, PROJECT_DIR } from "../../scripts/ops/tui/platform.ts";
import { stream } from "../../scripts/ops/tui/exec.ts";
import { tempFixture } from "../helpers/temp.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

// 从真实脚本提取函数和入口，只替换宿主机探测/写操作。
// 测试不运行真实的 repair、purge、route-admin 或计划任务命令。
const BUILD = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TUI_TEST_OPS, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'ops.ps1 syntax error' }
$common = [Management.Automation.Language.Parser]::ParseFile($env:TUI_TEST_COMMON, [ref]$tokens, [ref]$errors)
$parts = @($ast.ParamBlock.Extent.Text, '$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)')
$utf8 = $common.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-WithUtf8Output'}, $true)
$parts += $utf8.Extent.Text
foreach ($name in @('Show-Doctor', 'Step', 'Done', 'New-DoctorRow', 'Get-DeployModeLabel')) {
    $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $definition) { throw "missing function $name" }
    $parts += $definition.Extent.Text
}
$parts += @'
$DeployMode = 'direct'
$Project = $PSScriptRoot
$Port = 1011
$Domain = ''
$TaskName = 'fixture'
$DeployedGroupDataRoot = $PSScriptRoot
$ModelsFile = Join-Path $PSScriptRoot 'data\config\models.json'
function Test-ModelConfiguration($project) {
    & $env:TUI_TEST_BUN $env:TUI_TEST_VALIDATOR $PSScriptRoot
    return $LASTEXITCODE -eq 0
}
$WebhookSecretFile = Join-Path $PSScriptRoot 'webhook-secret'
function Resolve-ProjectPath($value) { return $value }
function Test-Local { if ($env:TUI_TEST_HEALTH -eq 'fail') { return 0 }; return 200 }
function Get-BotPids { if ($env:TUI_TEST_HEALTH -ne 'fail') { return 42 } }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
    if ($env:TUI_TEST_HEALTH -ne 'fail') { return [pscustomobject]@{ OwningProcess = 42 } }
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) }
function Get-RelayDoctorRows { }
function Err($message) { [Console]::Error.WriteLine($message) }
function Start-Bot { Step $env:TUI_TEST_PROGRESS; [Console]::Error.WriteLine($env:TUI_TEST_DIAGNOSTIC); return $true }
function Wait-Local { return 200 }
function Write-Captured([string]$Script, [string[]]$CliArgs) {
    $payload = [pscustomobject]@{ script = $Script; argv = @($CliArgs) }
    Invoke-WithUtf8Output { [Console]::WriteLine(($payload | ConvertTo-Json -Compress)) }
}
function Invoke-RelayAdmin([string[]]$CliArgs) { Write-Captured 'relay' $CliArgs; return $true }
function Invoke-TmpAdmin([string[]]$CliArgs) { Write-Captured 'tmp' $CliArgs; return $true }
function Invoke-GroupDataAdmin([string]$Script, [string[]]$CliArgs) { Write-Captured $Script $CliArgs; return $true }
'@
$jsonEntry = @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($Json -and $Command -in') })
$parts += ($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($RequestBase64)') }).Extent.Text
$switchEntry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.SwitchStatementAst] -and $_.Condition.Extent.Text -eq '$Command' })
if ($jsonEntry.Count -ne 1 -or $switchEntry.Count -ne 1) { throw 'missing real dispatcher' }
$parts += $jsonEntry[0].Extent.Text
$parts += $switchEntry[0].Extent.Text
[IO.File]::WriteAllText($env:TUI_TEST_WRAPPER, ($parts -join [Environment]::NewLine), [Text.UTF8Encoding]::new($true))
`;

async function fixtureWrapper() {
  const fixture = await tempFixture("tui-windows-");
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
  await writeFile(join(fixture.root, "webhook-secret"), "a".repeat(64));
  const child = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", builder], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, TUI_TEST_OPS: join(PROJECT_DIR, "scripts", "ops", "ops.ps1"),
      TUI_TEST_COMMON: join(PROJECT_DIR, "scripts", "lib", "common.ps1"), TUI_TEST_WRAPPER: wrapper },
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) { await fixture.cleanup(); throw new Error(error); }
  return { ...fixture, async run(args: string[], health = "pass") {
    const command = opsCommand("windows", args);
    command.args[4] = wrapper;
    const child = Bun.spawn([command.command, ...command.args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, TUI_TEST_HEALTH: health, TUI_TEST_BUN: process.execPath, TUI_TEST_VALIDATOR: join(PROJECT_DIR, "scripts/config/validate-models.ts"),
        TUI_TEST_PROGRESS: "正在启动机器人", TUI_TEST_DIAGNOSTIC: "测试诊断：隧道信息" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  } };
}

test("Windows 规范化参数保留路径和群名中的空格，Linux 保持原参数", () => {
  const route = ["routes", "reset", "abcdef123456", "--group", "技术 支持群"];
  expect(opsCommand("windows", route).args[5]).toBe("-RequestBase64");
  expect(JSON.parse(Buffer.from(opsCommand("windows", route).args[6]!, "base64").toString())).toEqual({
    Command: "routes", Target: "reset", Fingerprint: "abcdef123456", Group: "技术 支持群",
  });
  expect(opsCommand("linux", route).args.slice(1)).toEqual(route);
});

windowsTest("Windows doctor/status -Json 只输出 JSON，真实失败返回非零，修复不会混入只读接口", async () => {
  const fixture = await fixtureWrapper();
  try {
    for (const command of ["doctor", "status"]) {
      for (const state of ["pass", "fail"]) {
        const result = await fixture.run([command, "--json"], state);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
        const payload = JSON.parse(result.stdout);
        expect(payload.checks.some((check: { name: string }) => check.name === "本地机器人健康")).toBe(true);
        expect(result.code).toBe(state === "pass" ? 0 : 1);
        expect(payload.fail > 0).toBe(state === "fail");
        for (const check of payload.checks) expect(typeof check.fix).toBe("string");
      }
    }
    const repair = await fixture.run(["doctor", "--json", "-Repair"]);
    expect(repair.code).toBe(2);
    expect(repair.stdout).toBe("");
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows TUI 部署入口调用部署脚本并保留失败退出码", async () => {
  const fixture = await fixtureWrapper();
  try {
    await mkdir(join(fixture.root, "scripts/deploy"), { recursive: true });
    for (const code of [0, 17]) {
      await writeFile(join(fixture.root, "scripts/deploy/deploy.ps1"), '\ufeffWrite-Output "DEPLOY_FIXTURE"\nexit ' + code + '\n');
      const result = await fixture.run(["deploy"]);
      expect(result.stdout).toContain("DEPLOY_FIXTURE"); expect(result.code, result.stderr).toBe(code);
    }
  } finally { await fixture.cleanup(); }
}, 15000);

windowsTest("Windows TUI 在中文代码页下通过 UTF-8 输出普通进度、诊断和错误", async () => {
  const fixture = await fixtureWrapper();
  try {
    const result = await fixture.run(["start"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("正在启动机器人");
    expect(result.stdout).toContain("机器人已启动");
    expect(result.stderr.trim()).toBe("测试诊断：隧道信息");
    const command = opsCommand("windows", ["start"]);
    command.args[4] = join(fixture.root, "ops-fixture.ps1");
    const lines: string[] = [];
    expect(await stream(command.command, command.args, line => lines.push(line), {
      env: { TUI_TEST_PROGRESS: "正在启动机器人", TUI_TEST_DIAGNOSTIC: "测试诊断：隧道信息" },
    }).done).toBe(0);
    expect(lines.join("\n")).toContain("正在启动机器人");
    expect(lines).toContain("测试诊断：隧道信息");
    expect(lines.join("\n")).not.toContain("�");
    const error = await fixture.run(["未知操作"]);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("无法识别的命令：未知操作");
  } finally { await fixture.cleanup(); }
}, 15000);

windowsTest("Windows 路由、外链全清和临时目录范围都到达正确 CLI", async () => {
  const fixture = await fixtureWrapper();
  try {
    const cases = [
      { input: ["routes", "list"], argv: ["list"], script: "scripts\\ops\\route-admin.ts" },
      { input: ["routes", "reset", "abcdef123456", "--group", "技术 支持群"], argv: ["reset", "abcdef123456", "--group", "技术 支持群"], script: "scripts\\ops\\route-admin.ts" },
      { input: ["routes", "forget", "abcdef123456"], argv: ["forget", "abcdef123456"], script: "scripts\\ops\\route-admin.ts" },
      { input: ["relay-purge", "--all"], argv: ["purge", "--all"], script: "relay" },
      ...["-All", "-all", "-A", "--all", "--group", "含 空格与'引号"].map(keyword => ({
        input: ["relay-purge", "--keyword", keyword], argv: ["purge", "--keyword", keyword], script: "relay",
      })),
      { input: ["tmp-purge", "--all", "--group", "g1", "--user", "13812345678"], argv: ["purge", "--all", "--user", "13812345678", "--group", "g1"], script: "tmp" },
      { input: ["tmp-ls", "--group", "g1"], argv: ["list", "--group", "g1"], script: "tmp" },
    ];
    for (const { input, argv, script } of cases) {
      const result = await fixture.run(input);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ script, argv });
    }
    expect((await fixture.run(["routes", "reset", "abcdef123456"])).code).toBe(2);
  } finally { await fixture.cleanup(); }
}, 30000);
