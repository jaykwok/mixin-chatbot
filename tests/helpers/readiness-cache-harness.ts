import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mock, spyOn } from "bun:test";
import { application, waitFor } from "../../src/core/lifecycle.ts";
import { DOCUMENT_TOOLCHAIN_PACKAGES } from "../../src/core/config.ts";
import { documentMarker, DOCUMENT_TOOLCHAIN_MARKER } from "../../scripts/runtime/document-manifest.ts";
let runs = 0, success = true, release: (() => void) | undefined, hold = false;
const prepared: string[] = [];
spyOn(Bun, "which").mockReturnValue("fixture-uv");
mock.module("../../src/core/process.ts", () => ({ runProcess: async (options: any) => {
  if (options.args[0] === "-c") {
    assert.ok(options.args[1].includes("docxcompose"));
    return { exitCode: 0, output: "" };
  }
  if (!options.args.includes("--check")) {
    assert.equal(options.args[0], "sync");
    assert.ok(options.args.includes("--locked"));
    assert.equal(options.args.at(-1), "3.14");
    const target = options.env.UV_PROJECT_ENVIRONMENT;
    assert.equal(options.env.VIRTUAL_ENV, target);
    assert.equal(options.env.UV_LINK_MODE, "copy", "group packages must not be hard-linked to the shared download cache");
    prepared.push(target);
    const interpreter = venvPythonPath(target);
    await mkdir(dirname(interpreter), { recursive: true });
    await writeFile(interpreter, "provisioned fixture interpreter");
    return { exitCode: 0, output: "" };
  }
  runs++;
  assert.ok(options.args.includes("--check"));
  assert.ok(options.args.includes("--locked"));
  assert.ok(options.args.includes("--offline"));
  assert.equal(options.args.at(-1), "3.14");
  if (hold) await waitFor(new Promise<void>(resolve => { release = resolve; }), options.signal);
  options.signal.throwIfAborted();
  return { exitCode: success ? 0 : 1, output: "" };
} }));
const { documentToolchainReady, ensureDocumentToolchain, venvPythonPath } = await import("../../src/agent/python-toolchain.ts");
const venv = join(process.cwd(), "venv"), python = venvPythonPath(venv), marker = join(venv, DOCUMENT_TOOLCHAIN_MARKER);
await mkdir(dirname(python), { recursive: true }); await writeFile(python, "fixture-interpreter");
const expected = documentMarker(DOCUMENT_TOOLCHAIN_PACKAGES, await readFile(new URL("../../uv.lock", import.meta.url), "utf8"));
await writeFile(marker, expected);
assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => documentToolchainReady(venv))), Array(8).fill(true));
assert.equal(runs, 1); assert.equal(await documentToolchainReady(venv), true); assert.equal(runs, 1);
await writeFile(python, "changed-interpreter");
assert.equal(await documentToolchainReady(venv), true); assert.equal(runs, 2);
await writeFile(marker, "old-marker"); assert.equal(await documentToolchainReady(venv), false); assert.equal(runs, 2);
await writeFile(marker, expected);
success = false; assert.equal(await documentToolchainReady(venv), false); assert.equal(runs, 3);
success = true; assert.equal(await documentToolchainReady(venv), true); assert.equal(runs, 4);
const realNow = Date.now;
Date.now = () => realNow() + 301000;
try { assert.equal(await documentToolchainReady(venv), true); assert.equal(runs, 5); }
finally { Date.now = realNow; }
await writeFile(python, "concurrent-check");
hold = true;
const abort = new AbortController();
const p1 = documentToolchainReady(venv, abort.signal).then(() => false, () => true);
const p2 = documentToolchainReady(venv);
while (runs < 6) await Bun.sleep(5);
await Bun.sleep(30); abort.abort(); assert.equal(await p1, true);
hold = false; release!(); assert.equal(await p2, true); assert.equal(runs, 6);
const groupA = join(process.cwd(), "groups/group a/venv"), groupB = join(process.cwd(), "groups/group b/venv");
assert.deepEqual(await Promise.all([
  ensureDocumentToolchain(groupA), ensureDocumentToolchain(groupA), ensureDocumentToolchain(groupB),
]), [true, true, true]);
assert.deepEqual(prepared.sort(), [groupA, groupB].sort(), "each group syncs exactly once into its own environment");
assert.equal(await readFile(join(groupA, DOCUMENT_TOOLCHAIN_MARKER), "utf8"), expected);
assert.equal(await readFile(join(groupB, DOCUMENT_TOOLCHAIN_MARKER), "utf8"), expected);
await application.drain();
console.log("READINESS_CACHE_PASSED");
