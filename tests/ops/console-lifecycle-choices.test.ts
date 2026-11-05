import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { deploymentEnvironment } from "../../scripts/ops/console/deployment-options.ts";

const repo = resolve(import.meta.dir, "../.."), quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
test("真实平台选择检查：关闭 stdin 仍拒绝缺失选择，明确允许切分支才能执行，中文输出不污染返回值", async () => {
  const f = await tempFixture("lifecycle-choices-");
  try {
    for (const path of ["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json", "data/config/directory.json"]) {
      mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), "{}");
    }
    const windows = process.platform === "win32", script = join(f.root, windows ? "run.ps1" : "run.sh");
    writeFileSync(script, windows ? "\uFEFF" + [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      ". " + quote(join(repo, "scripts/lib/console-plan.ps1")),
      "try { $value=Assert-ConsoleLifecycle 'update' $env:FIXTURE_PROJECT $env:FIXTURE_BRANCH; if($null -ne $value){throw 'stdout pollution'}; Write-Host '已通过选择检查' } catch { Write-Host $_.Exception.Message; exit 3 }",
    ].join("\r\n") : ["set -euo pipefail", 'PROJECT_DIR="$FIXTURE_PROJECT"', `source '${join(repo, "scripts/lib/console-plan.sh")}'`,
      'value="$(assert_console_lifecycle update "$FIXTURE_BRANCH")" || exit 3', '[ -z "$value" ] || exit 4', "echo '已通过选择检查'"].join("\n"));
    const good = { ...deploymentEnvironment("update", { target: "a".repeat(40), switchMain: false, cleanup: "apply", directory: "saved" }, f.root),
      MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "synthetic", FIXTURE_BRANCH: "main", FIXTURE_PROJECT: f.root };
    const scenarios: [Record<string, string>, boolean, string][] = [
      [{}, true, "已通过"], [{ BOT_REVISION_CLEANUP: "" }, false, "明确选择整理"], [{ BOT_REVISION_CLEANUP: "no-backup" }, false, "明确选择整理"],
      [{ MIXIN_OPS_TASK_ID: "" }, false, "任务记录"], [{ MIXIN_OPS_DIRECTORY: "all", BOT_DIRECTORY_SCOPE: "all" }, false, "首次通讯录"],
      [{ FIXTURE_BRANCH: "feature" }, false, "未允许"], [{ FIXTURE_BRANCH: "feature", MIXIN_OPS_SWITCH_MAIN: "1" }, true, "已通过"],
      [{ MIXIN_OPS_CONSOLE: "", BOT_REVISION_CLEANUP: "", FIXTURE_BRANCH: "feature" }, true, "已通过"],
      [{ MIXIN_OPS_DIRECTORY: "selected", MIXIN_OPS_DIRECTORY_INPUT: "{}", MIXIN_OPS_DIRECTORY_APP: "a".repeat(64) }, false, "部门选择"],
    ];
    for (const [override, okay, message] of scenarios) {
      const child = Bun.spawn(windows ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["bash", script], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...good, ...override },
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(okay ? 0 : 3); expect(out + err).toContain(message);
    }
    unlinkSync(join(f.root, "data/config/directory.json"));
    for (const input of ["", '{"format":1,"departments":["d2"]}']) {
      const child = Bun.spawn(windows ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["bash", script], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...good, MIXIN_OPS_DIRECTORY: "selected", MIXIN_OPS_DIRECTORY_INPUT: input, MIXIN_OPS_DIRECTORY_APP: "a".repeat(64) },
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(input ? 0 : 3);
    }
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 网页整理预览失败在停机前拒绝；CLI 保留原行为；网页不接受 Read-YesNo 默认值", async () => {
  const f = await tempFixture("lifecycle-preview-");
  try {
    mkdirSync(join(f.root, "data/conversations"), { recursive: true });
    const script = join(f.root, "run.ps1");
    writeFileSync(script, "\uFEFF" + [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      ". " + quote(join(repo, "scripts/lib/common.ps1")),
      "function Invoke-MaintenanceTool { return @{ Outcome='failed'; Result=$null } }",
      "function Test-MaintenanceSuccess { return $false }",
      "$env:BOT_REVISION_CLEANUP='skip'; $env:MIXIN_OPS_CONSOLE='1'",
      "try { $value=Select-RevisionCleanup 'fixture' 'fixture' $env:FIXTURE_PROJECT; throw 'unexpected success' } catch { if($_.Exception.Message -notlike '*停机前无法预览*'){throw}; Write-Host $_.Exception.Message }",
      "try { Read-YesNo '不得询问' $true; throw 'unexpected default' } catch { if($_.Exception.Message -notlike '*未提供的交互选择*'){throw}; Write-Host $_.Exception.Message }",
      "$env:MIXIN_OPS_CONSOLE=''; $value=Select-RevisionCleanup 'fixture' 'fixture' $env:FIXTURE_PROJECT; if($value -cne 'skip'){throw 'CLI choice changed'}; Write-Host 'CLI 原选择保留'",
    ].join("\r\n"));
    const child = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, FIXTURE_PROJECT: f.root },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("服务尚未停止"); expect(out).toContain("CLI 原选择保留");
  } finally { await f.cleanup(); }
});
