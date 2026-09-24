import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRuntimeConfig } from "../../src/core/runtime-schema.ts";
import { saveRuntimeSettings } from "../../scripts/config/runtime-settings.ts";
import { tempFixture } from "../helpers/temp.ts";

test("runtime settings retain previous values and validate explicit overrides", async () => {
  const fixture = await tempFixture("runtime-settings-");
  const path = join(fixture.root, "runtime.json");
  try {
    await writeFile(path, JSON.stringify({ BOT_BASH_TIMEOUT: 123, BOT_INDEX_MAX_DEPTH: 4 }));
    await saveRuntimeSettings(path, { BOT_BASH_TIMEOUT: "456", BOT_DEBUG: "1", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "240", BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: "540", API_KEY: "must-not-copy" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ BOT_BASH_TIMEOUT: "456", BOT_INDEX_MAX_DEPTH: "4", BOT_DEBUG: "1", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "240", BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: "540" });
    await saveRuntimeSettings(path, { BOT_DEBUG: "0" });
    await saveRuntimeSettings(path, { BOT_DOCUMENT_WORK_ENABLED: "0" });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("BOT_DOCUMENT_WORK_ENABLED", "0");
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("BOT_MODEL_IDLE_TIMEOUT_SECONDS", "240");
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("BOT_MODEL_RESPONSE_TIMEOUT_SECONDS", "540");
    for (const value of [{ BOT_DEBUG: "yes" }, { BOT_SHUTDOWN_TIMEOUT_SECONDS: 999 }, { BOT_HOST: "https://host" }, { UNUSED: "1" }]) {
      expect(() => validateRuntimeConfig(value)).toThrow();
    }
    for (const value of [0, 1, "0", "1"]) expect(validateRuntimeConfig({ BOT_DOCUMENT_WORK_ENABLED: value })).toHaveProperty("BOT_DOCUMENT_WORK_ENABLED", String(value));
    for (const value of ["yes", "false", true, 2, -1]) expect(() => validateRuntimeConfig({ BOT_DOCUMENT_WORK_ENABLED: value })).toThrow();
    for (const key of ["BOT_MODEL_IDLE_TIMEOUT_SECONDS", "BOT_MODEL_RESPONSE_TIMEOUT_SECONDS"] as const) {
      for (const value of [0, 9, 7201, 10.5, "abc"]) expect(() => validateRuntimeConfig({ [key]: value })).toThrow();
      for (const value of [10, 180, 600, 7200]) expect(validateRuntimeConfig({ [key]: value })).toHaveProperty(key, String(value));
    }
    for (const policy of ["short", "long"]) expect(validateRuntimeConfig({ PI_CACHE_RETENTION: policy })).toHaveProperty("PI_CACHE_RETENTION", policy);
    for (const policy of ["", "auto", "none", "24h", "LONG", false]) expect(() => validateRuntimeConfig({ PI_CACHE_RETENTION: policy })).toThrow();
    expect(() => validateRuntimeConfig({ BOT_MODEL_CACHE_RETENTION: "auto" })).toThrow();
    await expect(saveRuntimeSettings(path, { BOT_MODEL_CACHE_RETENTION: "none" })).rejects.toThrow(/已移除/);
    for (const value of [1, 2, 8]) expect(validateRuntimeConfig({ BOT_ATTACHMENT_CONCURRENCY: value })).toHaveProperty("BOT_ATTACHMENT_CONCURRENCY", String(value));
    for (const value of [0, 9, 1.5]) expect(() => validateRuntimeConfig({ BOT_ATTACHMENT_CONCURRENCY: value })).toThrow();
    await expect(saveRuntimeSettings(path, { BOT_INDEX_MAX_DEPTH: "0" })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("BOT_INDEX_MAX_DEPTH", "4");
  } finally { await fixture.cleanup(); }
});

async function withWindowsReadLock(path: string, task: (release: () => Promise<void>) => Promise<void>): Promise<void> {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$heldFile = [System.IO.File]::Open($env:TEST_CONFIG_LOCK_PATH, 'Open', 'Read', 'Read')
try {
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally { $heldFile.Dispose() }
`], { env: { ...process.env, TEST_CONFIG_LOCK_PATH: path }, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 10000);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    child.stdin.write("\n");
    child.stdin.end();
    expect(await child.exited).toBe(0);
  };
  const reader = child.stdout.getReader();
  try {
    let output = "";
    while (!output.includes("locked")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Could not hold Windows configuration lock: " + await new Response(child.stderr).text());
      output += new TextDecoder().decode(chunk.value);
    }
    await task(release);
  } finally {
    reader.releaseLock();
    try { await release(); } finally { clearTimeout(timeout); }
  }
}

test.skipIf(process.platform !== "win32")("runtime settings tolerate brief Windows locks and preserve the old file on persistent failure", async () => {
  const fixture = await tempFixture("runtime-lock-");
  const path = join(fixture.root, "runtime.json");
  try {
    await writeFile(path, JSON.stringify({ BOT_BASH_TIMEOUT: "123" }));
    await withWindowsReadLock(path, async (release) => {
      const saving = saveRuntimeSettings(path, { BOT_BASH_TIMEOUT: "456" }).then(() => null, error => error);
      await Bun.sleep(150);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ BOT_BASH_TIMEOUT: "123" });
      await release();
      expect(await saving).toBeNull();
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ BOT_BASH_TIMEOUT: "456" });
    await withWindowsReadLock(path, async () => {
      await expect(saveRuntimeSettings(path, { BOT_BASH_TIMEOUT: "789" })).rejects.toHaveProperty("code", "EPERM");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ BOT_BASH_TIMEOUT: "456" });
    });
  } finally { await fixture.cleanup(); }
}, 15000);
