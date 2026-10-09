import { expect, test } from "bun:test";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { holdDirectory } from "../../src/core/held-directory.ts";
import { tempFixture } from "../helpers/temp.ts";
import { type HandleEvent, WindowsHandles } from "../../src/core/windows-handles.ts";

test("removal is relative to the held parent when its pathname is replaced by a junction or link", async () => {
  const fixture = await tempFixture("held-parent-"), base = join(fixture.root, "parent"), moved = base + "-moved", foreign = join(fixture.root, "foreign");
  await mkdir(join(base, "owned"), { recursive: true }); await mkdir(join(foreign, "owned"), { recursive: true });
  await writeFile(join(base, "owned/marker"), "authorized"); await writeFile(join(foreign, "owned/unrelated.txt"), "keep");
  const held = await holdDirectory(fixture.root, ["parent"], false);
  let exchanged = false;
  try {
    const removed = await held.use(entries => entries.removeDirectories({
      select: name => name === "owned", requireRemoval: true,
      beforeRemove: async (_name, _time, child) => {
        expect(await child.read("marker")).toBe("authorized");
        try {
          await rename(base, moved); exchanged = true;
          await symlink(foreign, base, process.platform === "win32" ? "junction" : "dir");
        } catch (error) { if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error; }
        return true;
      },
    }));
    expect(exchanged).toBe(process.platform === "linux");
    expect(removed).toHaveLength(1); expect(removed[0]).toMatchObject({ name: "owned", status: process.platform === "linux" ? "deferred" : "removed" });
    if (process.platform === "linux") expect(await readFile(join(moved, "owned/marker"), "utf8")).toBe("authorized");
    expect(await readFile(join(foreign, "owned/unrelated.txt"), "utf8")).toBe("keep");
  } finally { await held.release(); if (exchanged) await rm(base); await fixture.cleanup(); }
});

async function exchange(request: { path: string; moved: string; replacement: string; outside: string }) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/linux-deletion-race.ts", import.meta.url)), JSON.stringify(request)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const errors = new Response(child.stderr).text(), reader = child.stdout.getReader(), watchdog = setTimeout(() => child.kill(), 15_000);
  try {
    let output = "";
    while (!output.includes("READY")) { const next = await reader.read(); if (next.done) throw new Error(await errors); output += Buffer.from(next.value).toString(); }
    child.stdin.write("GO\n"); await child.stdin.flush();
    expect(await child.exited).toBe(0); await errors;
  } finally { clearTimeout(watchdog); child.kill(); await child.exited; reader.releaseLock(); }
}

for (const level of ["top", "nested"]) for (const replacement of ["empty", "nonempty", "link"] as const) test.skipIf(process.platform !== "linux")(`shared cleanup defers before recursion: ${level} ${replacement} exchange`, async () => {
  const f = await tempFixture("held-deferred-race-");
  const base = join(f.root, "parent"), owned = join(base, "owned"), outside = join(f.root, "outside"), moved = join(f.root, "moved");
  await mkdir(join(owned, "nested"), { recursive: true }); await mkdir(outside); await writeFile(join(outside, "foreign"), "keep");
  await writeFile(join(owned, "nested/original"), "owned");
  const held = await holdDirectory(f.root, ["parent"], false);
  try {
    const results = await held.use(entries => entries.removeDirectories({ select: name => name === "owned", beforeRemove: async () => {
      await exchange({ path: level === "top" ? owned : join(owned, "nested"), moved, replacement, outside }); return true;
    } }));
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ name: "owned", status: "deferred", reason: "exclusive-writers-not-proven" });
    const target = level === "top" ? owned : join(owned, "nested");
    expect(await lstat(target)).toBeDefined();
    if (replacement === "empty") expect(await readdir(target)).toEqual([]);
    else expect(await readFile(join(target, "foreign"), "utf8")).toBe("keep");
    expect(await readFile(join(moved, level === "top" ? "nested/original" : "original"), "utf8")).toBe("owned");
    expect(await readFile(join(outside, "foreign"), "utf8")).toBe("keep");
  } finally { await held.release(); await f.cleanup(); }
}, 25_000);

test.skipIf(process.platform !== "linux")("legacy name-based rmdir deterministically removes a swapped empty directory after identity comparison", async () => {
  const f = await tempFixture("legacy-rmdir-window-"); const path = join(f.root, "target"), moved = join(f.root, "moved");
  await mkdir(path); const held = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const named = await lstat(path, { bigint: true }), entity = await held.stat({ bigint: true }); expect(named.ino).toBe(entity.ino);
    await exchange({ path, moved, replacement: "empty", outside: f.root });
    await rmdir(path); // The former production comparison+name deletion, executed only in our synthetic fixture.
    await expect(lstat(path)).rejects.toThrow("ENOENT"); expect((await held.stat()).nlink).not.toBe(0); expect(await lstat(moved)).toBeDefined();
  } finally { await held.close(); await f.cleanup(); }
}, 25_000);

for (const scenario of ["release", "initialization", "created-file-check", "file-close", "file-read", "index", "nested-file", "nested-directory", "removed-root"]) {
  test.skipIf(process.platform !== "win32")(`native close failure is visible and other owners close: ${scenario}`, async () => {
    const fixture = await tempFixture("held-native-close-");
    const events: HandleEvent[] = [], active = new Map<string, HandleEvent>();
    const actual = new WindowsHandles({ observe: () => {} }).native;
    const suffix = ({ release: "/owned", initialization: "/owned", "created-file-check": "/x", "file-close": "/x",
      "file-read": "/read.txt", index: "/index.txt", "nested-file": "/nested/file", "nested-directory": "/nested", "removed-root": "/remove" } as Record<string, string>)[scenario]!;
    let injectedError: number | undefined, badClose = false;
    const matches = (value: unknown) => active.get(String(value))?.path.replaceAll("\\", "/").endsWith(suffix);
    const resources = new WindowsHandles({
      observe: event => { events.push(event); if (event.phase === "owned") active.set(event.handle!, event); },
      native: { ...actual,
        GetLastError: () => { if (injectedError !== undefined) { const error = injectedError; injectedError = undefined; return error; } return actual.GetLastError(); },
        GetFileInformationByHandle: (...args: Parameters<typeof actual.GetFileInformationByHandle>) => {
          if (["initialization", "created-file-check"].includes(scenario) && matches(args[0])) { injectedError = 5; return 0; }
          return actual.GetFileInformationByHandle(...args);
        },
        CloseHandle: (value: bigint | number) => {
          const result = actual.CloseHandle(value);
          if (!result) throw new Error(`real close unexpectedly failed: ${actual.GetLastError()}`);
          if (!badClose && matches(value)) { badClose = true; injectedError = 6; return 0; }
          return result;
        },
      },
    });
    let failure: unknown, held: Awaited<ReturnType<typeof holdDirectory>> | undefined;
    try {
      try {
        held = await holdDirectory(fixture.root, ["owned"], true, resources);
        if (["created-file-check", "file-close"].includes(scenario)) await held.use(async entries => { const file = await entries.create("x"); await file.close(); });
        if (scenario === "file-read") { await writeFile(join(fixture.root, "owned/read.txt"), "read"); await held.use(entries => entries.read("read.txt")); }
        if (["index", "nested-file", "nested-directory", "removed-root"].includes(scenario)) {
          await mkdir(join(fixture.root, "owned/remove/nested"), { recursive: true });
          await writeFile(join(fixture.root, "owned/remove/index.txt"), "index");
          await writeFile(join(fixture.root, "owned/remove/nested/file"), "nested");
          await held.use(entries => entries.removeDirectories({ select: name => name === "remove", beforeRemove: async () => true }));
        }
        await held.release();
      } catch (error) { failure = error; }
      try { await held?.release(); } catch (error) { failure ??= error; }
      expect(badClose).toBe(true);
      expect(failure).toBeInstanceOf(AggregateError);
      const flattened = (error: unknown): any[] => error instanceof AggregateError ? error.errors.flatMap(flattened) : [error];
      expect(flattened(failure).some(error => error.win32 === 6 && error.code === "EBADF")).toBe(true);
      if (["initialization", "created-file-check"].includes(scenario)) expect((failure as Error).cause).toMatchObject({ win32: 5 });
      const opened = events.filter(event => event.phase === "owned");
      expect(events.filter(event => event.phase === "close-result")).toHaveLength(opened.length);
      for (const event of opened) expect(events.filter(item => item.phase === "close-attempt" && item.openSequence === event.openSequence)).toHaveLength(1);
      expect(events.filter(event => event.phase === "close-result" && !event.success)).toHaveLength(1);
      await rename(join(fixture.root, "owned"), join(fixture.root, "released"));
    } finally { await fixture.cleanup(); }
  });
}

test.skipIf(process.platform !== "win32")("a deliberately leaked native handle is detected by the physical rename assertion", async () => {
  const fixture = await tempFixture("held-leak-proof-");
  const events: HandleEvent[] = [], actual = new WindowsHandles({ observe: () => {} }).native;
  let leaked: bigint | undefined;
  const resources = new WindowsHandles({ observe: event => events.push(event), native: { ...actual,
    CloseHandle: (value: bigint | number) => { if (leaked === undefined) { leaked = BigInt(value); return 1; } return actual.CloseHandle(value); },
  } });
  try {
    await mkdir(join(fixture.root, "owned"));
    const held = await holdDirectory(fixture.root, ["owned"], false, resources);
    await held.release();
    // The defective binding claims a successful close. The physical assertion still detects its leak.
    await expect(rename(join(fixture.root, "owned"), join(fixture.root, "moved"))).rejects.toMatchObject({ code: "EBUSY" });
    expect(actual.CloseHandle(leaked!)).not.toBe(0); leaked = undefined;
    await rename(join(fixture.root, "owned"), join(fixture.root, "moved"));
    expect(events.filter(event => event.phase === "owned")).toHaveLength(2);
  } finally {
    if (leaked !== undefined && !actual.CloseHandle(leaked)) throw new Error(`leaked test handle cleanup failed: ${actual.GetLastError()}`);
    await fixture.cleanup();
  }
});

test.skipIf(process.platform !== "win32")("an independent process holding a directory prevents every rename until it releases", async () => {
  const fixture = await tempFixture("held-independent-");
  const path = join(fixture.root, "owned"); await mkdir(path);
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/held-directory-holder.ts", import.meta.url)), path],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    let ready = "";
    while (!ready.includes("READY")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`holder ended before READY: ${await stderr}`);
      ready += new TextDecoder().decode(value);
    }
    for (let attempt = 0; attempt < 3; attempt++) await expect(rename(path, path + "-moved")).rejects.toMatchObject({ code: "EBUSY" });
    child.stdin.end();
    expect(await child.exited, await stderr).toBe(0);
    await rename(path, path + "-moved");
  } finally {
    clearTimeout(timer); child.kill(); await child.exited; await reader.cancel(); await stderr; await fixture.cleanup();
  }
}, 20_000);
