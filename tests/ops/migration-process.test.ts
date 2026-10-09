import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { executeProcess, ProcessFailure, type ProcessEvent } from "../../scripts/lib/process.ts";
import { validateMigration } from "../../scripts/migrations/lib/validation.ts";
import { tempFixture } from "../helpers/temp.ts";

const helper = fileURLToPath(new URL("../helpers/migration-validator.ts", import.meta.url));
test.each(["normal", "invalid"])("synthetic validator %s preserves exit and all lifecycle stages", async mode => {
  const f = await tempFixture("migration-stages-"); const phases: string[] = [];
  try {
    const context = { project: f.root, groups: f.root, decisions: {}, report: (stage: string) => phases.push(stage) };
    const run = validateMigration(context, undefined, { command: process.execPath, args: [helper, mode], timeoutMs: 30_000 });
    if (mode === "invalid") await expect(run).rejects.toThrow("exit=1"); else await run;
    for (const phase of ["spawn-request", "spawned", "entry-ready", "imports-ready", "config", "result", "exit", "stdio-close", "reaped"]) expect(phases).toContain("validation-" + phase);
  } finally { await f.cleanup(); }
}, 40_000);

test.each(["entry-delay", "block"])("validator timeout during %s is classified and reaped", async mode => {
  const f = await tempFixture("migration-timeout-"); const phases: ProcessEvent[] = [];
  try {
    const failure = await executeProcess({ command: process.execPath, args: [helper, mode], cwd: f.root, timeoutMs: 12_000, observe: phase => phases.push(phase) }).then(() => undefined, error => error as ProcessFailure);
    expect(failure).toBeInstanceOf(ProcessFailure); expect(failure!.kind).toBe("timeout");
    expect(failure!.result.supervisorExitCode).not.toBe(0); expect(phases.map(x => x.phase)).toContain("reaped");
    if (mode === "block") expect(failure!.result.stderr).toContain('"phase":"config","state":"start"');
    else expect(failure!.result.stderr).not.toContain('"phase":"entry-ready"');
  } finally { await f.cleanup(); }
}, 25_000);

test("startup failure, cancellation and signal exit remain distinct", async () => {
  const f = await tempFixture("migration-failures-");
  try {
    const missing = await executeProcess({ command: join(f.root, "missing-command"), args: [], cwd: f.root, timeoutMs: 30_000 }).catch(error => error as ProcessFailure);
    expect(missing).toBeInstanceOf(ProcessFailure); expect((missing as ProcessFailure).kind).toBe("startup");
    const controller = new AbortController(); let output = "";
    const cancelled = await executeProcess({ command: process.execPath, args: [helper, "block"], cwd: f.root, signal: controller.signal, timeoutMs: 30_000,
      onData: data => { output += data; if (output.includes('"phase":"config"')) controller.abort(new Error("synthetic cancellation")); },
    }).catch(error => error as ProcessFailure);
    expect(cancelled).toBeInstanceOf(ProcessFailure); expect((cancelled as ProcessFailure).kind).toBe("cancelled");
    const signal = await executeProcess({ command: process.execPath, args: [helper, "signal"], cwd: f.root, timeoutMs: 30_000 });
    // Bun on this Windows runtime reports self-SIGTERM as code 1/null; preserve that native result.
    expect(signal.exitCode).toBe(process.platform === "win32" ? 1 : 143);
    expect(signal.commandSignal).toBe(process.platform === "win32" ? null : "SIGTERM");
    const exit143 = await executeProcess({ command: process.execPath, args: [helper, "exit143"], cwd: f.root, timeoutMs: 30_000 });
    expect(exit143.exitCode).toBe(143); expect(exit143.commandExitCode).toBe(143); expect(exit143.commandSignal).toBeNull();
  } finally { await f.cleanup(); }
}, 100_000);

test("successful validator exits with inherited pipes still held; detached writer is reaped", async () => {
  const f = await tempFixture("migration-pipe-"); let output = "";
  try {
    const result = await executeProcess({ command: process.execPath, args: [helper, "pipe"], cwd: f.root, timeoutMs: 30_000, onData: data => { output += data; } });
    expect(result.exitCode).toBe(0);
    const pid = Number(output.match(/DESCENDANT:(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(); expect(result.commandExitCode).toBe(0);
  } finally { await f.cleanup(); }
}, 40_000);

test("real thin entry reports config failure before databases, without leaking fixture secrets", async () => {
  const f = await tempFixture("migration-invalid-json-"); const logs: string[] = [];
  try {
    await import("node:fs/promises").then(fs => fs.mkdir(join(f.root, "data/config"), { recursive: true }));
    await writeFile(join(f.root, "data/config/runtime.json"), "invalid-json");
    await expect(validateMigration({ project: f.root, groups: f.root, decisions: {}, report: (stage, detail) => logs.push(stage + ":" + detail) })).rejects.toThrow("exit=1");
    const text = logs.join("\n"); expect(text).toContain("validation-entry-ready"); expect(text).toContain("validation-imports-ready");
    expect(text).toContain("validation-config"); expect(text).toContain("state=failed"); expect(text).not.toContain("validation-stats:"); expect(text).not.toContain("fixture-key");
  } finally { await f.cleanup(); }
}, 40_000);

test.each(["exit", "stdio-close"])("throwing %s observer rejects inside the supervised lifecycle", async phase => {
  const f = await tempFixture("migration-observer-");
  try {
    const failure = await executeProcess({ command: process.execPath, args: [helper, "normal"], cwd: f.root, timeoutMs: 30_000,
      observe: event => { if (event.phase === phase) throw new Error("synthetic observer failure"); },
    }).catch(error => error as ProcessFailure);
    expect(failure).toBeInstanceOf(ProcessFailure);
    expect((failure as ProcessFailure).kind).toBe("supervisor");
    expect((failure as ProcessFailure).result.commandExitCode).toBe(0);
    expect((failure as ProcessFailure).result.lastPhase).toBe("reaped");
  } finally { await f.cleanup(); }
}, 40_000);
