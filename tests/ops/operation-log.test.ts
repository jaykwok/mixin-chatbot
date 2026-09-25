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

for (const entry of ["migration", ...(process.platform === "win32" ? ["powershell"] : []), ...(bash && existsSync(bash) ? ["bash"] : [])]) {
  for (const status of [0, 1]) test(`${entry} announces one operation log, repeating it only on failure (exit ${status})`, async () => {
    const f = await tempFixture("operation-log-chain-");
    try {
      const groups = join(f.root, "groups"), migration = join(project, "scripts/migrations/run.ts");
      await mkdir(join(f.root, "data/runtime/pi"), { recursive: true });
      await writeFile(join(f.root, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture" }));
      if (status === 0) await mkdir(groups);
      let args = [process.execPath, migration, "preview", "--decisions-only", "--project", f.root, "--groups", groups];
      if (entry === "powershell") {
        const header = `\ufeff$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n. ${quotePS(join(project, "scripts/lib/operation-log.ps1"))}\n`;
        const child = join(f.root, "child.ps1"), parent = join(f.root, "parent.ps1");
        await writeFile(child, header + `$context=Start-OperationLog $PSScriptRoot 'deploy'\n& ${args.map(quotePS).join(" ")}\n$code=$LASTEXITCODE\nStop-OperationLog $context $code\nexit $code\n`);
        await writeFile(parent, header + `$context=Start-OperationLog $PSScriptRoot 'upgrade'\n& (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File ${quotePS(child)}\n$code=$LASTEXITCODE\nStop-OperationLog $context $code\nexit $code\n`);
        args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parent];
      } else if (entry === "bash") {
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const header = `#!/usr/bin/env bash\nset -uo pipefail\nPROJECT_DIR=${quote(posix(f.root))}\n. ${quote(posix(join(project, "scripts/lib/operation-log.sh")))}\n`;
        const child = join(f.root, "child.sh"), parent = join(f.root, "parent.sh");
        const command = [posix(process.execPath), ...args.slice(1).map(arg => arg.replaceAll("\\", "/"))].map(quote).join(" ");
        await writeFile(child, header + `operation_start deploy\ncode=0\n${command} || code=$?\noperation_finish "$code"\nexit "$code"\n`);
        await writeFile(parent, header + `operation_start upgrade\ncode=0\nbash ${quote(posix(child))} || code=$?\noperation_finish "$code"\nexit "$code"\n`);
        args = [bash!, posix(parent)];
      }
      const result = await run(args, f.root, { BOT_OPERATION_LOG: "", BOT_MODEL_CACHE_RETENTION: "", PI_CACHE_RETENTION: "", MSYS_NO_PATHCONV: "1" });
      expect(result.code, result.text).toBe(status);
      const directory = join(f.root, "logs/operations"), logs = await readdir(directory);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toStartWith(entry === "migration" ? "migration-" : "upgrade-");
      expect(result.text.split(logs[0]!).length - 1, result.text).toBe(status === 0 ? 1 : 2);
      expect(result.text.match(/本次操作日志：/g), result.text).toHaveLength(status === 0 ? 1 : 2);
      const text = await readFile(join(directory, logs[0]!), "utf8");
      expect(text).toContain(`migration-finished: exit=${status}`);
      if (entry !== "migration") expect(text).toContain(`operation finished; exit=${status}`);
      if (status) expect(text).toContain("目录不存在");
      else expect(result.text).toContain('"decisions": []');
    } finally { await f.cleanup(); }
  }, 30000);
}

for (const writer of ["typescript", ...(process.platform === "win32" ? ["powershell"] : []), ...(bash && existsSync(bash) ? ["bash"] : [])]) {
  test(`${writer} diagnostics redact bare provider tokens without labels`, async () => {
    const f = await tempFixture("log-token-prefixes-");
    const message = ["sk-", "pk-", "ghp-", "ghp_", "github_pat_", "xoxb-", "hf-", "hf_"].map(prefix => prefix + "fixtureSecret123456").join(" ");
    try {
      if (writer === "typescript") openOperationLog(f.root, "startup", "").event("error", "fixture", message);
      else {
        const script = join(f.root, writer === "bash" ? "tokens.sh" : "tokens.ps1");
        await writeFile(script, writer === "bash"
          ? `PROJECT_DIR="$1"\nunset BOT_OPERATION_LOG\n. '${posix(join(project, "scripts/lib/operation-log.sh"))}'\noperation_start startup\noperation_event error '${message}'\n`
          : `\ufeff$ErrorActionPreference='Stop'\n$env:BOT_OPERATION_LOG=''\n. ${quotePS(join(project, "scripts/lib/operation-log.ps1"))}\nStart-OperationLog $PSScriptRoot 'startup' | Out-Null\nWrite-OperationEvent 'error' '${message}'\n`);
        const result = await run(writer === "bash" ? [bash!, posix(script), posix(f.root)] : ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
        expect(result.code, result.text).toBe(0);
      }
      const directory = join(f.root, "logs/operations"), files = await readdir(directory);
      expect(files).toHaveLength(1);
      const text = await readFile(join(directory, files[0]!), "utf8");
      expect(text).toContain("ghp_"); expect(text).toContain("github_pat_"); expect(text).toContain("hf_");
      expect(text).not.toContain("fixtureSecret123456");
    } finally { await f.cleanup(); }
  }, 15000);

  test(`${writer} startup rotation preserves upgrade, deploy and migration evidence`, async () => {
    const f = await tempFixture("log-families-");
    try {
      const directory = join(f.root, "logs/operations"); await mkdir(directory, { recursive: true });
      for (const kind of ["startup", "upgrade", "deploy", "migration"]) for (let i = 0; i < 23; i++) {
        const path = join(directory, `${kind}-20200101T000000Z-${i}.log`);
        await writeFile(path, "failure evidence"); await utimes(path, i, i);
      }
      if (writer === "typescript") openOperationLog(f.root, "startup", "");
      else {
        const script = join(f.root, writer === "bash" ? "rotate.sh" : "rotate.ps1");
        await writeFile(script, writer === "bash"
          ? `PROJECT_DIR="$1"\nunset BOT_OPERATION_LOG\n. '${posix(join(project, "scripts/lib/operation-log.sh"))}'\noperation_start startup\n`
          : `\ufeff$ErrorActionPreference='Stop'\n$env:BOT_OPERATION_LOG=''\n. ${quotePS(join(project, "scripts/lib/operation-log.ps1"))}\nStart-OperationLog $PSScriptRoot 'startup' | Out-Null\n`);
        const result = await run(writer === "bash" ? [bash!, posix(script), posix(f.root)] : ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
        expect(result.code, result.text).toBe(0);
      }
      const names = await readdir(directory);
      expect(names.filter(name => name.startsWith("startup-"))).toHaveLength(20);
      for (const kind of ["upgrade", "deploy", "migration"]) expect(names.filter(name => name.startsWith(kind + "-"))).toHaveLength(23);
    } finally { await f.cleanup(); }
  }, 15000);
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
