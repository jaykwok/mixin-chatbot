import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opsCommand, PROJECT_DIR } from "../../scripts/ops/tui/platform.ts";
import { stream } from "../../scripts/ops/tui/exec.ts";
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

test("统计周期通过两个平台运维入口完整传递", () => {
  const args = ["stat", "support", "--period", "last-month"];
  const command = opsCommand("windows", args);
  expect(JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString("utf8"))).toEqual({ Command: "stat", Target: "support", Period: "last-month" });
  expect(opsCommand("linux", args).args.slice(1)).toEqual(["stat", "--period", "last-month", "--", "support"]);
});

// 从真实脚本提取函数和入口，只替换宿主机探测/写操作。
// 测试不运行真实的 repair、purge、directory-admin 或计划任务命令。
const BUILD = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TUI_TEST_OPS, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'ops.ps1 syntax error' }
$common = [Management.Automation.Language.Parser]::ParseFile($env:TUI_TEST_COMMON, [ref]$tokens, [ref]$errors)
$parts = @($ast.ParamBlock.Extent.Text, '$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)')
foreach ($name in @('Invoke-WithUtf8Output', 'Get-OpsCommandHint')) {
    $definition = $common.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    $parts += $definition.Extent.Text
}
foreach ($name in @('Show-Doctor', 'Step', 'Done', 'Warn', 'New-DoctorRow', 'Clear-SpaceHistory')) {
    $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $definition) { throw "missing function $name" }
    $parts += $definition.Extent.Text
}
$parts += @'
$Project = $PSScriptRoot
$Port = 1011
$TaskName = 'fixture'
$DeployedWorkspaceRoot = ''
$DataDir = Join-Path $PSScriptRoot 'data'
$ModelsFile = Join-Path $PSScriptRoot 'data\config\models.json'
function Test-ModelConfiguration($project) {
    & $env:TUI_TEST_BUN $env:TUI_TEST_VALIDATOR $PSScriptRoot
    return $LASTEXITCODE -eq 0
}
$AppBotFile = Join-Path $PSScriptRoot 'data\config\app-bot.json'
# Stands in for "bun run scripts\ops\directory-admin.ts doctor" (the service's Stream and directory rows: status, name, detail)
# and "bun run scripts\ops\version-info.ts" (name, value).
# The rows come from the environment: Bun's transpiler escapes non-ASCII text, which String.raw would keep as "\uXXXX".
function Get-BunPath { return {
    $global:LASTEXITCODE = 0
    if ($args -contains 'scripts\ops\version-info.ts') { $env:TUI_TEST_VERSION -split [char]10 } else { $env:TUI_TEST_STREAM -split [char]10 }
} }
function Resolve-ProjectPath($value) { return $value }
function Test-Local { if ($env:TUI_TEST_HEALTH -eq 'fail') { return 0 }; if ($env:TUI_TEST_HEALTH -eq 'verification') { return 503 }; return 200 }
function Get-BotPids { if ($env:TUI_TEST_HEALTH -ne 'fail') { return 42 } }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
    if ($env:TUI_TEST_HEALTH -ne 'fail') { return [pscustomobject]@{ OwningProcess = 42 } }
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) }
function Get-RelayDoctorRows { }
function Err($message) { [Console]::Error.WriteLine($message) }
function Start-Bot { Step $env:TUI_TEST_PROGRESS; [Console]::Error.WriteLine($env:TUI_TEST_DIAGNOSTIC); return $true }
function Stop-Bot { return $true }
function Wait-Local { return 200 }
function Write-Captured([string]$Script, [string[]]$CliArgs) {
    $payload = [pscustomobject]@{ script = $Script; argv = @($CliArgs) }
    Invoke-WithUtf8Output { [Console]::WriteLine(($payload | ConvertTo-Json -Compress)) }
}
function Invoke-RelayAdmin([string[]]$CliArgs) { Write-Captured 'relay' $CliArgs; return $true }
function Invoke-TmpAdmin([string[]]$CliArgs) { Write-Captured 'tmp' $CliArgs; return $true }
function Invoke-DataAdmin([string]$Script, [string[]]$CliArgs) { Write-Captured $Script $CliArgs; return $true }
# The system "open file" dialog: the path the test names, or nothing (cancelled).
function Select-LegacyStatsFile { if ($env:TUI_TEST_PICK) { return $env:TUI_TEST_PICK } }
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
  await writeFile(join(fixture.root, "data", "config", "app-bot.json"), '{"appId":"test-app","appSecret":"test-only-secret"}');
  const child = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", builder], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, TUI_TEST_OPS: join(PROJECT_DIR, "scripts", "ops", "ops.ps1"),
      TUI_TEST_COMMON: join(PROJECT_DIR, "scripts", "lib", "common.ps1"), TUI_TEST_WRAPPER: wrapper },
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) { await fixture.cleanup(); throw new Error(error); }
  return { ...fixture, async run(args: string[], health = "pass", env: Record<string, string> = {}) {
    const command = opsCommand("windows", args);
    command.args[4] = wrapper;
    const child = Bun.spawn([command.command, ...command.args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, ...command.env, TUI_TEST_HEALTH: health, TUI_TEST_BUN: process.execPath, TUI_TEST_VALIDATOR: join(PROJECT_DIR, "scripts/config/validate-models.ts"),
        TUI_TEST_PROGRESS: "正在启动机器人", TUI_TEST_DIAGNOSTIC: "测试诊断：Stream 信息",
        TUI_TEST_STREAM: "pass\t事件 Stream\t已连接 3 分钟\nwarn\t通讯录同步\t待确认撤销：12 个成员（第 7 轮）",
        TUI_TEST_VERSION: "应用机器人\tv1.0.0\n构建\tabc1234\n数据格式\t1", ...env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  } };
}

test("Windows 规范化参数保留群名中的空格和撤销轮次，Linux 保持原参数", () => {
  const decode = (args: string[]) => {
    const command = opsCommand("windows", args);
    expect(command.args[5]).toBe("-RequestBase64");
    return JSON.parse(Buffer.from(command.args[6]!, "base64").toString());
  };
  const tmp = ["tmp-ls", "--group", "技术 支持群"];
  expect(decode(tmp)).toEqual({ Command: "tmp-ls", Group: "技术 支持群" });
  expect(decode(["directory-confirm", "7"])).toEqual({ Command: "directory-confirm", Target: "7" });
  expect(opsCommand("linux", tmp).args.slice(1)).toEqual(["tmp-ls", "--group=技术 支持群"]);
  expect(opsCommand("linux", ["directory-confirm", "7"]).args.slice(1)).toEqual(["directory-confirm", "7"]);
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
          expect(health.fix).toContain("系统 → 服务部署 → 继续上次操作");
        }
        for (const check of payload.checks) expect(typeof check.fix).toBe("string");
        const names = payload.checks.map((check: { name: string }) => check.name);
        expect(names).toContain("data/config/app-bot.json");
        expect(names.includes("事件 Stream")).toBe(state === "pass");
        expect(Object.keys(payload).sort()).toEqual(["checks", "fail", "pass", "port", "warn"]);
        if (state === "pass") {
          expect(payload.checks.find((check: { name: string }) => check.name === "事件 Stream")).toMatchObject({ status: "pass", detail: "已连接 3 分钟", fix: "" });
          expect(payload.checks.find((check: { name: string }) => check.name === "通讯录同步")).toMatchObject({ status: "warn", detail: "待确认撤销：12 个成员（第 7 轮）" });
          expect(payload.warn).toBeGreaterThan(0);
          expect(payload.checks.find((check: { name: string }) => check.name === "应用机器人")).toMatchObject({ status: "pass", detail: "v1.0.0" });
          expect(payload.checks.find((check: { name: string }) => check.name === "数据格式")).toMatchObject({ status: "pass", detail: "1" });
        }
      }
    }
    // An unreadable deployment record fails the check and warns against deploying over it.
    const unknown = JSON.parse((await fixture.run(["doctor", "--json"], "pass", { TUI_TEST_VERSION: "应用机器人\t未知：部署记录没有程序版本（旧版数据）" })).stdout);
    expect(unknown.checks.find((check: { name: string }) => check.name === "应用机器人")).toMatchObject({ status: "fail", detail: "未知：部署记录没有程序版本（旧版数据）" });
    expect(unknown.checks.find((check: { name: string }) => check.name === "应用机器人").fix).toContain("不要在此目录覆盖部署");
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
      await writeFile(join(fixture.root, "scripts/deploy/deploy.ps1"), '\ufeffWrite-Output "DEPLOY_FIXTURE"\nWrite-Output "TUI=$env:MIXIN_OPS_TUI"\nexit ' + code + '\n');
      const result = await fixture.run(["deploy"]);
      expect(result.stdout).toContain("DEPLOY_FIXTURE"); expect(result.code, result.stderr).toBe(code);
      expect(result.stdout).toContain("TUI=1");
    }
  } finally { await fixture.cleanup(); }
}, 15000);

windowsTest("TUI 体检与修复输出使用菜单路径，直接调用仍给命令行建议", async () => {
  const fixture = await fixtureWrapper();
  try {
    // Missing credentials point at the app-bot wizard; a paused revocation points at the directory page.
    await Bun.file(join(fixture.root, "data", "config", "app-bot.json")).delete();
    for (const tui of ["1", ""]) {
      const env = { MIXIN_OPS_TUI: tui };
      const passing = JSON.parse((await fixture.run(["doctor", "--json"], "pass", env)).stdout);
      expect(passing.checks.find((check: { name: string }) => check.name === "通讯录同步").fix)
        .toContain(tui ? "系统 → 通讯录 → 确认暂停的撤销" : "scripts\\ops\\ops.ps1 directory-confirm");
      const result = await fixture.run(["doctor", "--json"], "fail", env);
      expect(result.code, result.stderr).toBe(1);
      const health = JSON.parse(result.stdout);
      const fixes = health.checks.map((check: { fix: string }) => check.fix).join("\n");
      expect(fixes).toContain(tui ? "系统 → 设置 → 应用机器人" : "scripts\\ops\\ops.ps1 configure-app-bot");
      expect(fixes).toContain(tui ? "系统 → 服务部署 → 重新部署" : "scripts\\ops\\ops.ps1 deploy");
      expect(fixes).toContain(tui ? "监控 → 日志" : "scripts\\ops\\ops.ps1 logs");
      if (tui) expect(fixes).not.toMatch(/ops\.ps1|scripts[\\/]|bun run/);
      const printed = await fixture.run(["doctor"], "fail", env);
      expect(printed.stdout).toContain(tui ? "系统 → 服务部署 → 修复部署" : "scripts\\ops\\ops.ps1 doctor -Repair");
      if (tui) expect(printed.stdout).not.toMatch(/ops\.ps1|scripts[\\/]|bun run/);
    }
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows TUI 在中文代码页下通过 UTF-8 输出普通进度、诊断和错误", async () => {
  const fixture = await fixtureWrapper();
  try {
    const result = await fixture.run(["start"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("正在启动机器人");
    expect(result.stdout).toContain("机器人已启动");
    expect(result.stderr.trim()).toBe("测试诊断：Stream 信息");
    const command = opsCommand("windows", ["start"]);
    command.args[4] = join(fixture.root, "ops-fixture.ps1");
    const lines: string[] = [];
    expect(await stream(command.command, command.args, line => lines.push(line), {
      env: { TUI_TEST_PROGRESS: "正在启动机器人", TUI_TEST_DIAGNOSTIC: "测试诊断：Stream 信息" },
    }).done).toBe(0);
    expect(lines.join("\n")).toContain("正在启动机器人");
    expect(lines).toContain("测试诊断：Stream 信息");
    expect(lines.join("\n")).not.toContain("�");
    const error = await fixture.run(["未知操作"]);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("无法识别的命令：未知操作");
  } finally { await fixture.cleanup(); }
}, 15000);

windowsTest("Windows 通讯录、外链全清和临时目录范围都到达正确 CLI", async () => {
  const fixture = await fixtureWrapper();
  try {
    const cases = [
      { input: ["directory"], argv: ["status"], script: "scripts\\ops\\directory-admin.ts" },
      { input: ["directory-confirm", "7"], argv: ["confirm", "7"], script: "scripts\\ops\\directory-admin.ts" },
      { input: ["directory-departments", "1001"], argv: ["departments", "1001"], script: "scripts\\ops\\directory-admin.ts" },
      { input: ["directory-scope", "1001,1002"], argv: ["scope", "1001,1002"], script: "scripts\\ops\\directory-admin.ts" },
      { input: ["relay-test"], argv: ["test"], script: "relay" },
      { input: ["relay-purge", "--all"], argv: ["purge", "--all"], script: "relay" },
      ...["-All", "-all", "-A", "--all", "--group", "含 空格与'引号"].map(keyword => ({
        input: ["relay-purge", "--keyword", keyword], argv: ["purge", "--keyword", keyword], script: "relay",
      })),
      { input: ["tmp-purge", "--all", "--group", "g1", "--user", "13812345678"], argv: ["purge", "--all", "--user=13812345678", "--group=g1"], script: "tmp" },
      { input: ["tmp-ls", "--group", "-Repair", "--group-id"], argv: ["list", "--group=-Repair", "--group-id"], script: "tmp" },
      { input: ["tmp-preview", "--days", "30", "--plan", "a-plan"], argv: ["preview", "--days", "30", "--plan", "a-plan"], script: "tmp" },
      { input: ["tmp-purge", "--plan", "a-plan", "--digest", "a-digest"], argv: ["purge", "--plan", "a-plan", "--digest", "a-digest"], script: "tmp" },
      { input: ["tmp-reclaim", "--plan", "a-plan", "--digest", "a-digest"], argv: ["reclaim", "--plan", "a-plan", "--digest", "a-digest"], script: "tmp" },
      { input: ["tmp-discard", "--plan", "a-plan"], argv: ["discard", "--plan", "a-plan"], script: "tmp" },
      { input: ["tmp-discard", "--plan", "a-plan", "--digest", "a-digest"], argv: ["discard", "--plan", "a-plan", "--digest", "a-digest"], script: "tmp" },
      { input: ["stat", "-Repair", "--group-id"], argv: ["--group-id", "--", "-Repair"], script: "scripts\\ops\\stats-admin.ts" },
      { input: ["stat", "support", "--period", "last-month"], argv: ["--period", "last-month", "--", "support"], script: "scripts\\ops\\stats-admin.ts" },
    ];
    for (const { input, argv, script } of cases) {
      const result = await fixture.run(input);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ script, argv });
    }
    for (const round of [[], ["0"], ["7;x"]]) expect((await fixture.run(["directory-confirm", ...round])).code).toBe(2);
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows 清空所有群经 -All 交给 history-admin clear --all，同时指定群时拒绝", async () => {
  const fixture = await fixtureWrapper();
  try {
    // 停止和启动是桩；"fail" 让 Get-BotPids 报告未运行，输出只剩进度行和捕获的参数。
    const all = await fixture.run(["history-clear", "--all"], "fail");
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({ script: "scripts\\ops\\history-admin.ts", argv: ["clear", "--all"] });
    for (const input of [["history-clear", "support", "--all"], ["history-clear", "--all", "--storage-segment"]]) {
      const refused = await fixture.run(input, "fail");
      expect(refused.code).toBe(2);
      expect(refused.stdout).not.toContain("history-admin");
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
    expect(captured(given.stdout)).toEqual({ script: "scripts\\ops\\stats-import.ts", argv: [ledger] });
    const picked = await fixture.run(["stat-import"], "fail", { TUI_TEST_PICK: ledger });
    expect(picked.code, picked.stderr).toBe(0);
    expect(captured(picked.stdout)).toEqual({ script: "scripts\\ops\\stats-import.ts", argv: [ledger] });
    const cancelled = await fixture.run(["stat-import"], "fail");
    expect(cancelled.code).toBe(2);
    expect(cancelled.stdout).not.toContain("stats-import.ts");
    const missing = await fixture.run(["stat-import", join(fixture.root, "absent.sqlite")], "fail");
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("stats-import.ts");
  } finally { await fixture.cleanup(); }
}, 30000);

windowsTest("Windows 备份清理入口把报告名和确认码原样交给清理工具", async () => {
  const fixture = await fixtureWrapper();
  try {
    // 命令行入口，不经运维界面：直接用 ops.ps1 的原生参数调用。
    const run = async (...args: string[]) => {
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(fixture.root, "ops-fixture.ps1"), ...args], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    };
    const report = "20260928T000000Z-abcdef";
    for (const [args, argv] of [[["backup-scan"], ["scan"]], [["backup-clean", report], ["apply", report]],
      [["backup-clean", report, "-ConfirmCode", "0123456789abcdef"], ["apply", report, "--confirm", "0123456789abcdef"]]]) {
      const result = await run(...args!);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ script: "scripts\\ops\\backup-cleanup.ts", argv });
    }
    // 缺少报告名时不调用工具（错误信息按包装脚本模拟的 GBK 控制台输出，这里不比对文字）。
    const missing = await run("backup-clean");
    expect(missing.code).toBe(2); expect(missing.stdout).toBe("");
  } finally { await fixture.cleanup(); }
}, 30000);
