import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { opsShellFunctions } from "../helpers/ops-shell.ts";
import { tempFixture } from "../helpers/temp.ts";

const root = resolve(import.meta.dir, "../.."), bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (s: string) => s.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d: string) => "/" + d.toLowerCase());
const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const cases = [
  { name: "success-running", action: 0, state: "running", ready: true, expected: 0, final: "running" },
  { name: "delayed-ready", action: 0, state: "running", ready: true, readyAfter: 3, expected: 0, final: "running" },
  { name: "success-stopped", action: 0, state: "stopped", ready: true, expected: 0, final: "stopped" },
  { name: "failed-restored", action: 1, state: "running", ready: true, expected: 1, final: "running" },
  { name: "failed-restored-delayed", action: 1, state: "running", ready: true, readyAfter: 3, expected: 1, final: "running" },
  { name: "not-ready", action: 0, state: "running", ready: false, expected: 1, final: "start-requested" },
  { name: "pending", action: 0, state: "stopped", ready: true, pending: true, expected: 1, final: "stopped" },
  { name: "unknown", action: 0, state: "unknown", ready: true, expected: 1, final: "unknown" },
  { name: "result-unwritable", action: 0, state: "stopped", ready: true, unwritable: true, expected: 1, final: "stopped" },
];

for (const platform of ["linux", "windows"] as const) test.skipIf(platform === "windows" ? process.platform !== "win32" : !bash || !existsSync(bash))(
  `${platform} 生命周期结果同时要求成功退出、事务已收尾和就绪；报告失败不擅自启停`, async () => {
    const functions = platform === "linux" ? await opsShellFunctions("core_reported", "finish_lifecycle_result", "finish_update", "wait_for_local", "ops_result", "json_escape") : "";
    for (const scenario of cases) {
      const f = await tempFixture("lifecycle-result-" + scenario.name + "-");
      try {
        mkdirSync(join(f.root, "state"));
        if (scenario.pending) writeFileSync(join(f.root, "state/deploy-transaction"), "fixture");
        const output = join(f.root, scenario.unwritable ? "missing/result.json" : "result.json");
        let argv: string[];
        if (platform === "linux") {
          const script = join(f.root, "run.sh");
          writeFileSync(script, ["set -uo pipefail", functions, 'STATE_DIR="$FIXTURE_ROOT/state"; OPS_COMMAND=resume; UPDATE_WAS_RUNNING=1',
            'ER() { printf "%s\\n" "$1" >&2; }', 'final_run_state() { printf "%s\\n" "$FIXTURE_STATE"; }',
            'load_saved_settings() { PORT=2022; }', 'probe_count=0; sleep() { :; }',
            'bot_local_ready() { probe_count=$((probe_count + 1)); printf "%s" "$probe_count" > "$FIXTURE_ROOT/probes"; [ "$1" = 2022 ] && [ "$FIXTURE_READY_AFTER" -gt 0 ] && [ "$probe_count" -ge "$FIXTURE_READY_AFTER" ]; }',
            'remove_upgrade_stage() { :; }', 'operation_finish() { printf "finished=%s\\n" "$1"; }',
            'trap finish_update EXIT', 'exit "$FIXTURE_ACTION"',
          ].join("\n"));
          argv = [bash!, posix(script)];
        } else {
          const script = join(f.root, "run.ps1");
          writeFileSync(script, "\uFEFF" + [
            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
            "$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(" + ps(join(root, "scripts/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
            "if($errors){throw 'syntax'}; foreach($name in @('Invoke-LifecycleOperation','Wait-Local','Write-OpsResult')) { $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); . ([scriptblock]::Create($fn.Extent.Text)) }",
            "$Command='resume'; function Err($s) { Write-Host $s }; function Get-FinalRunState { return $env:FIXTURE_STATE }",
            "$script:probeCount=0; function Start-Sleep {}",
            "function Read-StateText { '2022' }; function Test-Local { $script:probeCount++; [IO.File]::WriteAllText((Join-Path $env:FIXTURE_ROOT 'probes'), [string]$script:probeCount); if($Port -ne '2022'){throw 'stale port'}; if([int]$env:FIXTURE_READY_AFTER -gt 0 -and $script:probeCount -ge [int]$env:FIXTURE_READY_AFTER){200}else{0} }",
            "function Test-PendingTransaction { Test-Path -LiteralPath (Join-Path $env:FIXTURE_ROOT 'state/deploy-transaction') }",
            "$result=Invoke-LifecycleOperation { return ($env:FIXTURE_ACTION -eq '0') }; if($result -isnot [bool]){throw 'polluted return'}; if($result){exit 0}else{exit 1}",
          ].join("\r\n"));
          argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
        }
        const child = Bun.spawn(argv, { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
          env: { ...process.env, FIXTURE_ROOT: platform === "linux" ? posix(f.root) : f.root, FIXTURE_STATE: scenario.state,
            FIXTURE_ACTION: String(scenario.action), FIXTURE_READY_AFTER: String(scenario.ready ? scenario.readyAfter ?? 1 : 0), MIXIN_OPS_RESULT_FILE: platform === "linux" ? posix(output) : output } });
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, scenario.name + out + err).toBe(scenario.expected);
        if (scenario.state === "running") expect(Number(readFileSync(join(f.root, "probes"), "utf8")), scenario.name).toBe(scenario.ready ? scenario.readyAfter ?? 1 : 10);
        else expect(existsSync(join(f.root, "probes")), scenario.name).toBe(false);
        if (scenario.unwritable) expect(existsSync(output)).toBe(false);
        else expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ protocol: "mixin-ops", version: 1, command: "resume",
          outcome: code === 0 ? "success" : "failed", exitCode: code, finalState: scenario.final });
      } finally { await f.cleanup(); }
    }
  }, 120_000);

test.skipIf(!bash || !existsSync(bash))("运维核心写入结果后包装层不覆盖也不再探测，退出码原样返回", async () => {
  const f = await tempFixture("lifecycle-core-reported-");
  try {
    const output = join(f.root, "result.json"), reported = '{"command":"update","outcome":"refused","exitCode":9}\n', script = join(f.root, "run.sh");
    writeFileSync(output, reported);
    writeFileSync(script, ["set -uo pipefail", await opsShellFunctions("core_reported", "finish_lifecycle_result", "finish_update"),
      'final_run_state() { echo "the wrapper probed" >&2; exit 98; }', 'remove_upgrade_stage() { :; }', 'operation_finish() { printf "finished=%s\\n" "$1"; }',
      'trap finish_update EXIT', "exit 9"].join("\n"));
    const child = Bun.spawn([bash!, posix(script)], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, MIXIN_OPS_RESULT_FILE: posix(output) } });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(9); expect(out).toContain("finished=9"); expect(readFileSync(output, "utf8")).toBe(reported);
  } finally { await f.cleanup(); }
}, 30_000);
