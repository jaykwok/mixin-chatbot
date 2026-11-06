import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

const repo = resolve(import.meta.dir, "../..");
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";

test.skipIf(process.platform !== "linux")("真实 Shell 服务入口只转交核心 argv，未知参数不被吞掉并保留退出码", async () => {
  const f = await tempFixture("core-shell-entry-");
  try {
    const runtime = join(f.root, "bun fixture");
    await writeFile(runtime, "#!/bin/bash\nif [ \"${1:-}\" = --version ]; then printf '1.4.4\\n'; exit 0; fi\nprintf '%s\\n' \"$@\"\nexit 17\n", { mode: 0o700 });
    for (const [input, target] of [[ ["stop", "--unknown=中文 空格"], ["service", "stop", "--unknown=中文 空格"] ],
      [["history-compact", "--direct", "+123456789"], ["maintenance", "history-compact", "--direct", "+123456789"]],
      [["stat-import", "/some/中文 snapshot.sqlite", "--expect", "a".repeat(64)], ["maintenance", "stat-import", "/some/中文 snapshot.sqlite", "--expect", "a".repeat(64)]],
      [["tmp-reclaim", "--plan", "explicit", "--digest", "a".repeat(64)], ["maintenance", "tmp-reclaim", "--plan", "explicit", "--digest", "a".repeat(64)]],
      [["configuration-apply", "config-" + "a".repeat(32), "--digest", "b".repeat(64)], ["maintenance", "configuration-apply", "config-" + "a".repeat(32), "--digest", "b".repeat(64)]],
      [["configuration-restore", "config-" + "a".repeat(32), "--expect", "b".repeat(64)], ["maintenance", "configuration-restore", "config-" + "a".repeat(32), "--expect", "b".repeat(64)]],
      [["runtime-configure", ".runtime-draft-11111111-1111-1111-1111-111111111111.json", "--unknown"], ["maintenance", "runtime-configure", ".runtime-draft-11111111-1111-1111-1111-111111111111.json", "--unknown"]],
      [["backup-scan", "--unknown"], ["maintenance", "backup-scan", "--unknown"]],
      [["relay-purge", "--keyword", "--all"], ["maintenance", "relay-purge", "--keyword", "--all"]],
      [["relay-ls", "--unknown"], ["maintenance", "relay-ls", "--unknown"]],
      [["relay-test"], ["maintenance", "relay-test"]],
      [["backup-clean", "20261031T000000Z-abcdef", "--confirm", "0123456789abcdef"], ["maintenance", "backup-clean", "20261031T000000Z-abcdef", "--confirm", "0123456789abcdef"]],
      [["maintenance-recover"], ["maintenance-recover"]]]) {
    const child = Bun.spawn(["bash", join(repo, "scripts/ops.sh"), ...input!], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, MIXIN_OPS_BUN: runtime, MIXIN_OPS_PROJECT: f.root, MIXIN_OPS_CONSOLE: "", MIXIN_OPS_TASK_ID: "" } });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(17);
    expect(out.trim().split("\n")).toEqual(["--no-env-file", join(repo, "ops/core/cli.ts"), "--project", f.root, ...target!]);
    }
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "win32")("真实 PowerShell 服务函数和分派保留核心退出码，空格与中文原样传递，额外参数拒绝", async () => {
  const f = await tempFixture("core-windows-entry-");
  try {
    const root = join(f.root, "中文 project"), driver = join(f.root, "entry.ps1");
    await mkdir(join(root, "ops/core"), { recursive: true });
    await writeFile(join(root, "snapshot.sqlite"), "synthetic");
    await writeFile(join(root, "ops/core/cli.ts"), "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode=Number(process.env.FIXTURE_EXIT);\n");
    await writeFile(driver, "\ufeff" + [
      "param([string]$Action,[switch]$Extra)", "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      `. ${ps(join(repo, "scripts/lib/common.ps1"))}`,
      `$Project=${ps(root)}; $OpsSource=$Project; $Command=$Action; $script:OpsInputNames=@('Command'); if($Extra){$script:OpsInputNames+='Group'}`,
      `function Get-BunPath { ${ps(process.execPath)} }; function Err($text) { [Console]::Error.WriteLine($text) }`,
      `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${ps(join(repo, "scripts/ops.ps1"))},[ref]$tokens,[ref]$errors); if($errors){throw 'syntax'}`,
      "function Test-PendingTransaction { return $false }",
      "foreach($name in @('Invoke-ServiceCommand','Invoke-CoreMaintenance','Clear-SpaceHistory','Invoke-TmpAdmin','Invoke-ConfigurationChange','Invoke-RuntimeConfiguration','Invoke-RelayAdmin')) {",
      "$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)",
      ". ([scriptblock]::Create($definition.Extent.Text)) }",
      "if($Action -eq 'history-clear'){$Direct=$true; $script:OpsInputNames+='Direct'}",
      "if($Action -eq 'stat-import'){$Target=Join-Path $Project 'snapshot.sqlite'; $script:OpsInputNames+='Target'}",
      "if($Action -eq 'tmp-purge'){$All=$true; $script:OpsInputNames+='All'}",
      "if($Action -eq 'configuration-apply'){$Target='config-'+('a'*32);$Digest='b'*64;$script:OpsInputNames+=@('Target','Digest')}",
      "if($Action -eq 'configuration-restore'){$Target='config-'+('a'*32);$Expect='b'*64;$script:OpsInputNames+=@('Target','Expect')}",
      "if($Action -eq 'runtime-configure'){$Target='.runtime-draft-11111111-1111-1111-1111-111111111111.json';$script:OpsInputNames+='Target'}",
      "if($Action -eq 'backup-clean'){$Target='20261031T000000Z-abcdef';$ConfirmCode='0123456789abcdef';$script:OpsInputNames+=@('Target','ConfirmCode')}",
      "if($Action -eq 'relay-purge'){$Target='--all';$script:OpsInputNames+='Target'}",
      "if($Action -eq 'doctor'){$Repair=$true;$script:OpsInputNames+='Repair'}; function Show-Doctor { [Console]::Error.WriteLine('doctor'); return $true }",
      "$dispatch=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.SwitchStatementAst] -and $_.Condition.Extent.Text -eq '$Command' })",
      "if($dispatch.Count -ne 1){throw 'dispatch'}; . ([scriptblock]::Create($dispatch[0].Extent.Text))",
    ].join("\r\n"));
    const run = async (args: string[], code: number) => {
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver, ...args], {
        cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, MIXIN_OPS_BUN: "", FIXTURE_EXIT: String(code) } });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exit, out, err };
    };
    for (const [action, code] of [["start", 0], ["stop", 17], ["restart", 130], ["repair", 9]] as const) {
      const value = await run([action], code); expect(value.exit, value.err).toBe(code);
      expect(JSON.parse(value.out)).toEqual(["service", action, "--project", root]);
    }
    // doctor -Repair: diagnose, hand the repair to the core, diagnose again; a failed repair fails the command.
    for (const code of [0, 9]) {
      const value = await run(["doctor"], code); expect(value.exit, value.err).toBe(code ? 1 : 0);
      expect(JSON.parse(value.out)).toEqual(["service", "repair", "--project", root]);
      expect(value.err.match(/doctor/g)).toHaveLength(2);
    }
    for (const [action, target] of [["history-clear", ["maintenance", "history-clear", "--direct"]], ["maintenance-recover", ["maintenance-recover"]],
      ["stat-import", ["maintenance", "stat-import", join(root, "snapshot.sqlite")]], ["tmp-purge", ["maintenance", "tmp-purge", "--all"]],
      ["configuration-apply", ["maintenance", "configuration-apply", "config-" + "a".repeat(32), "--digest", "b".repeat(64)]],
      ["configuration-restore", ["maintenance", "configuration-restore", "config-" + "a".repeat(32), "--expect", "b".repeat(64)]],
      ["runtime-configure", ["maintenance", "runtime-configure", ".runtime-draft-11111111-1111-1111-1111-111111111111.json"]],
      ["backup-scan", ["maintenance", "backup-scan"]],
      ["relay-ls", ["maintenance", "relay-ls"]], ["relay-test", ["maintenance", "relay-test"]],
      ["relay-purge", ["maintenance", "relay-purge", "--keyword", "--all"]],
      ["backup-clean", ["maintenance", "backup-clean", "20261031T000000Z-abcdef", "--confirm", "0123456789abcdef"]]] as const) {
      const value = await run([action], 17); expect(value.exit, value.err).toBe(17);
      expect(JSON.parse(value.out)).toEqual([...target, "--project", root]);
    }
    const extra = await run(["stop", "-Extra"], 0);
    expect(extra.exit).toBe(1); expect(extra.out).toBe(""); expect(extra.err).toContain("不适用的参数");
    for (const action of ["backup-scan", "backup-clean", "relay-ls", "relay-test", "relay-purge"]) {
      const value = await run([action, "-Extra"], 0);
      expect(value.exit).toBe(1); expect(value.out).toBe(""); expect(value.err).toContain("不适用的参数");
    }
    const bytes = await readFile(join(repo, "scripts/ops.ps1")); expect([...bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
    expect(bytes.toString("utf8").replaceAll("\r\n", "")).not.toContain("\n");
  } finally { await f.cleanup(); }
}, 30_000);
