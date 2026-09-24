import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOperationLog, operationError } from "../../scripts/lib/operation-log.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, text: out + err };
}

test("bootstrap diagnostics redact errors and causes, cap log size and retain only operation logs", async () => {
  const f = await tempFixture("operation-log-");
  try {
    const directory = join(f.root, "logs/operations"); await mkdir(directory, { recursive: true });
    for (let i = 0; i < 23; i++) {
      const path = join(directory, `upgrade-20200101T000000Z-${i}.log`);
      await writeFile(path, "old"); await utimes(path, i, i);
    }
    await writeFile(join(directory, "keep.txt"), "unrelated");
    const log = openOperationLog(f.root, "upgrade", "../../invalid.log");
    expect(log.path).toStartWith(directory);
    const error = new Error("failed api_key=private-api-value", { cause: new Error("Bearer private-bearer-value token=private-token-value") });
    log.event("error", "snapshot", operationError(error));
    log.event("info", "native", "https://user:private-password@fixture.invalid/?key=private-query /webhook/" + "a".repeat(64));
    const text = await readFile(log.path!, "utf8");
    expect(text).toContain("snapshot"); expect(text).toContain("Caused by:");
    for (const value of ["private-api-value", "private-bearer-value", "private-token-value", "private-password", "private-query", "a".repeat(64)]) expect(text).not.toContain(value);
    expect((await readdir(directory)).filter(file => file.endsWith(".log"))).toHaveLength(20);
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("unrelated");
    const inherited = openOperationLog(f.root, "migration", log.name);
    expect(inherited.path).toBe(log.path);
    inherited.event("info", "apply", "same operation");
    await writeFile(log.path!, "x".repeat(1024 * 1024));
    inherited.event("output", "build", "discarded native output");
    inherited.event("error", "rollback", "diagnostics still recorded");
    const limited = await readFile(log.path!, "utf8");
    expect(limited).toContain("Command output limit reached");
    expect(limited).not.toContain("discarded native output");
    expect(limited).toContain("diagnostics still recorded");
    await writeFile(log.path!, "x".repeat(2 * 1024 * 1024));
    inherited.event("info", "after-limit", "ignored");
    expect((await stat(log.path!)).size).toBe(2 * 1024 * 1024);
  } finally { await f.cleanup(); }
});

test("migration preflight records failures without loading project configuration or losing its exit code", async () => {
  const f = await tempFixture("migration-log-failure-");
  try {
    await mkdir(join(f.root, "data/config"), { recursive: true });
    await writeFile(join(f.root, "data/config/runtime.json"), "invalid-json");
    const result = await run([process.execPath, join(project, "scripts/migrations/run.ts"), "preview", "--project", f.root, "--groups", join(f.root, "missing")], f.root);
    expect(result.code, result.text).toBe(1);
    const logs = await readdir(join(f.root, "logs/operations")); expect(logs).toHaveLength(1);
    const text = await readFile(join(f.root, "logs/operations", logs[0]!), "utf8");
    expect(text).toContain("目录不存在"); expect(text).toContain("migration-finished: exit=1");
    expect(result.text).toContain(logs[0]!);
    expect(existsSync(join(f.root, "data/state/migration.json"))).toBe(false);
  } finally { await f.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("PowerShell 5.1 diagnostics retain native failures and restore the caller environment", async () => {
  const f = await tempFixture("ps-operation-log-");
  try {
    const native = join(f.root, "native.ps1"), script = join(f.root, "operation.ps1");
    await writeFile(native, '\ufeff[Console]::Error.WriteLine("api_key=private-native-value"); Write-Output "native-detail"; exit 23');
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/operation-log.ps1"))}
if($PSVersionTable.PSVersion.Major -ne 5){throw 'test requires Windows PowerShell 5.1'}
$before=$env:BOT_OPERATION_LOG
$context=Start-OperationLog $PSScriptRoot 'upgrade'
$nested=Start-OperationLog $PSScriptRoot 'migration'
if($nested.Path -ne $context.Path){throw 'nested operation split logs'}
Stop-OperationLog $nested 0
Set-OperationStage 'install-dependencies'
$success=Invoke-OperationNative (Join-Path $PSHOME 'powershell.exe') @('-NoProfile','-Command','exit 0')
if($success -ne 0){throw 'successful native command reported failure'}
$code=Invoke-OperationNative (Join-Path $PSHOME 'powershell.exe') @('-NoProfile','-File',${quotePS(native)})
try { throw 'snapshot failure token=private-exception-value' } catch { Write-OperationFailure $_ }
Stop-OperationLog $context $code
if($env:BOT_OPERATION_LOG -ne $before){throw 'environment leaked'}
exit $code
`);
    const result = await run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
    expect(result.code, result.text).toBe(23);
    const logs = await readdir(join(f.root, "logs/operations")); expect(logs).toHaveLength(1);
    const text = await readFile(join(f.root, "logs/operations", logs[0]!), "utf8");
    expect(text).toContain("install-dependencies"); expect(text).toContain("native-detail");
    expect(text).toContain("snapshot failure"); expect(text).toContain("exit=23");
    expect(text).not.toContain("private-native-value"); expect(text).not.toContain("private-exception-value");
    expect(result.text).toContain(logs[0]!);
  } finally { await f.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("native Bash diagnostics retain failing command output and its original status", async () => {
  const f = await tempFixture("bash-operation-log-");
  try {
    const script = join(f.root, "operation.sh");
    await writeFile(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_DIR="$1"
. '${posix(join(project, "scripts/lib/operation-log.sh"))}'
operation_start upgrade
operation_stage build-image
native_failure(){ echo 'build-detail'; echo 'token=private-build-value' >&2; return 17; }
code=0
operation_capture native_failure || code=$?
operation_finish "$code"
exit "$code"
`);
    const result = await run([bash!, posix(script), posix(f.root)], f.root, { MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.text).toBe(17);
    const logs = await readdir(join(f.root, "logs/operations")); expect(logs).toHaveLength(1);
    const text = await readFile(join(f.root, "logs/operations", logs[0]!), "utf8");
    expect(text).toContain("build-image"); expect(text).toContain("build-detail"); expect(text).toContain("exit=17");
    expect(text).not.toContain("private-build-value"); expect(result.text).toContain(logs[0]!);
  } finally { await f.cleanup(); }
}, 30000);
