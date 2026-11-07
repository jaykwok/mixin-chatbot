import { expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Auth } from "../../console/server/auth.ts";
import type { Bundle } from "../../console/server/bundle.ts";
import { guardConfig } from "../../console/server/guard.ts";
import { startServer } from "../../console/server/server.ts";
import { liveInstance, prepareConsoleDir, readInstance, readSavedPort, removeInstance, savePort, writeInstance } from "../../ops/core/console-state.ts";
import { tempFixture } from "../helpers/temp.ts";

const bundle: Bundle = { index: { path: "/", type: "text/html", body: new Uint8Array() }, assets: new Map() };

test(".console 只保存端口和实例记录，保存值无效时报错而不是改用默认值", async () => {
  const fixture = await tempFixture("console-state-");
  const dir = join(fixture.root, ".console");
  try {
    prepareConsoleDir(dir);
    prepareConsoleDir(dir);
    expect(readSavedPort(dir)).toBeNull();
    savePort(dir, 12345);
    expect(await readFile(join(dir, "port"), "utf8")).toBe("12345\n");
    expect(readSavedPort(dir)).toBe(12345);
    await writeFile(join(dir, "port"), "70000");
    expect(() => readSavedPort(dir)).toThrow(/端口无效.*--port/);

    const record = { format: 1 as const, instanceId: "a", pid: 1, port: 1, startedAt: 1, version: "1.0.0" };
    writeInstance(dir, record);
    expect(readInstance(dir)).toEqual(record);
    // A newer console replaced the record: the older one must not delete it on exit.
    removeInstance(dir, "b");
    expect(readInstance(dir)).toEqual(record);
    removeInstance(dir, "a");
    expect(readInstance(dir)).toBeNull();
    await writeFile(join(dir, "instance.json"), "{broken");
    expect(readInstance(dir)).toBeNull();
  } finally { await fixture.cleanup(); }
});

test.skipIf(process.platform === "win32")("POSIX 上 .console 为 700（macOS 为 711），组/其他用户可读写时拒绝且不自动改权限", async () => {
  const fixture = await tempFixture("console-mode-");
  const dir = join(fixture.root, ".console");
  try {
    prepareConsoleDir(dir);
    // macOS lets the service account pass through to the frozen code (0711); an existing 0700 is opened up the same way.
    const mode = process.platform === "darwin" ? 0o711 : 0o700;
    expect(statSync(dir).mode & 0o777).toBe(mode);
    if (process.platform === "darwin") { chmodSync(dir, 0o700); prepareConsoleDir(dir); expect(statSync(dir).mode & 0o777).toBe(0o711); }
    savePort(dir, 10001);
    expect(statSync(join(dir, "port")).mode & 0o777).toBe(0o600);
    chmodSync(dir, 0o750);
    expect(() => prepareConsoleDir(dir)).toThrow("组或其他用户可以访问");
    expect(statSync(dir).mode & 0o777).toBe(0o750);
  } finally { chmodSync(dir, 0o700); await fixture.cleanup(); }
});

/** A port that was free a moment ago; the guard needs the real port before binding. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

test("重复启动只认仍在应答且实例编号相同的控制台，陈旧记录不算", async () => {
  const fixture = await tempFixture("console-live-");
  const dir = join(fixture.root, ".console"), port = freePort();
  const record = (instanceId: string) => ({ format: 1 as const, instanceId, pid: process.pid, port, startedAt: Date.now(), version: "1" });
  const server = startServer({ port, guard: guardConfig(port), bundle, auth: new Auth(), instanceId: "live-id", overview: async () => { throw new Error("unused"); } });
  try {
    prepareConsoleDir(dir);
    writeInstance(dir, record("live-id"));
    expect((await liveInstance(dir))?.instanceId).toBe("live-id");
    // Same port, different instance (PID reuse or another console): not ours.
    writeInstance(dir, record("old-id"));
    expect(await liveInstance(dir)).toBeNull();
    server.stop(true);
    writeInstance(dir, record("live-id"));
    expect(await liveInstance(dir)).toBeNull();
  } finally { server.stop(true); await fixture.cleanup(); }
});
