import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfficeProfile } from "../../src/agent/office-profiles.ts";
import { tempFixture } from "../helpers/temp.ts";

const linux = process.platform === "linux";
const markerName = ".mixin-office-owner.json";

for (const mode of ["close", "recover"] as const) test.skipIf(!linux)(`${mode} rejects a no-writer FIFO marker, releases handles and preserves its receipt`, async () => {
  const fixture = await tempFixture("office-fifo-"), child = Bun.spawn([
    process.execPath, fileURLToPath(new URL("../helpers/office-fifo-child.ts", import.meta.url)), fixture.root, mode,
  ], { stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  let profilePath: string | undefined, watchdog: ReturnType<typeof setTimeout> | undefined, killed = false;
  try {
    const startupEnd = Date.now() + 15_000;
    for (;;) {
      const ready = await fs.readFile(join(fixture.root, "ready.json"), "utf8").then(text => JSON.parse(text) as { path: string; isFIFO: boolean }, error => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (ready) { profilePath = ready.path; expect(ready.isFIFO).toBe(true); break; }
      if (child.exitCode !== null) throw new Error(`FIFO child exited before ready: ${await stderr}`);
      if (Date.now() > startupEnd) throw new Error("FIFO child setup timed out");
      await Bun.sleep(10);
    }
    // Supervise only the test child; a blocked production open must fail, never receive a writer.
    watchdog = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 2_000);
    const exit = await child.exited;
    clearTimeout(watchdog);
    expect(killed, "cleanup blocked with no FIFO writer").toBe(false);
    expect(exit, await stderr).toBe(0);
    const result = JSON.parse(await fs.readFile(join(fixture.root, "result.json"), "utf8"));
    console.log(JSON.stringify({ mode, ...result }));
    expect(result.errors).toHaveLength(3);
    for (const error of result.errors) expect(error).toContain("not a small regular file");
    expect(result.elapsedMs).toBeLessThan(2_000);
    expect(result.afterFds).toBe(result.beforeFds);
    expect(result.receiptPreserved).toBe(true);
    expect(result.stillFIFO).toBe(true);
    expect(result.profileGone).toBe(false);
    expect(result.remainingReceipts.filter((name: string) => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(1);
    if (mode === "recover") expect(result.restoredResult).toBe(0);
  } finally {
    clearTimeout(watchdog); child.kill("SIGKILL"); await child.exited; await stderr;
    // This path was just created by our child, including when the watchdog killed a blocked open.
    if (profilePath) await fs.rm(profilePath, { recursive: true, force: true });
    await fixture.cleanup();
  }
}, 30_000);

test("missing markers allow empty profiles, retain nonempty profiles and permit cleanup after restoration", async () => {
  const fixture = await tempFixture("office-missing-"), profile = await createOfficeProfile(fixture.root);
  const marker = join(profile.path, markerName), proof = await fs.readFile(marker, "utf8"), journal = join(fixture.root, ".office-jobs");
  try {
    await fs.rm(marker); await fs.writeFile(join(profile.path, "work"), "owned");
    await expect(profile.close()).rejects.toThrow();
    expect(await fs.readdir(journal)).toHaveLength(1);
    expect(await fs.readFile(join(profile.path, "work"), "utf8")).toBe("owned");
    await fs.writeFile(marker, proof); await profile.close();
    const empty = await createOfficeProfile(fixture.root);
    await fs.rm(join(empty.path, markerName)); await empty.close();
    expect((await fs.readdir(journal)).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(linux ? 2 : 0);
  } finally { await fs.rm(profile.path, { recursive: true, force: true }); await fixture.cleanup(); }
});

test("a directory marker is refused with its receipt and contents retained", async () => {
  const fixture = await tempFixture("office-directory-marker-"), profile = await createOfficeProfile(fixture.root);
  const marker = join(profile.path, markerName), proof = await fs.readFile(marker, "utf8"), journal = join(fixture.root, ".office-jobs");
  try {
    await fs.rm(marker); await fs.mkdir(marker); await fs.writeFile(join(marker, "keep"), "keep");
    await expect(profile.close()).rejects.toThrow();
    expect(await fs.readdir(journal)).toHaveLength(1);
    expect(await fs.readFile(join(marker, "keep"), "utf8")).toBe("keep");
    await fs.rm(marker, { recursive: true }); await fs.writeFile(marker, proof); await profile.close();
    expect((await fs.readdir(journal)).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(linux ? 1 : 0);
  } finally { await fs.rm(profile.path, { recursive: true, force: true }); await fixture.cleanup(); }
});

test.skipIf(!linux)("a symlink marker is refused without reading or removing its target", async () => {
  const fixture = await tempFixture("office-symlink-marker-"), profile = await createOfficeProfile(fixture.root);
  const marker = join(profile.path, markerName), proof = await fs.readFile(marker, "utf8"), target = join(fixture.root, "outside-marker");
  try {
    await fs.writeFile(target, proof); await fs.rm(marker); await fs.symlink(target, marker);
    await expect(profile.close()).rejects.toThrow("ELOOP");
    expect(await fs.readdir(join(fixture.root, ".office-jobs"))).toHaveLength(1);
    expect(await fs.readFile(target, "utf8")).toBe(proof);
    await fs.rm(marker); await fs.writeFile(marker, proof); await profile.close();
    expect(await fs.readFile(target, "utf8")).toBe(proof);
  } finally { await fs.rm(profile.path, { recursive: true, force: true }); await fixture.cleanup(); }
});

test.skipIf(!linux)("marker replacement after open keeps authorization bound to the opened regular file", async () => {
  const fixture = await tempFixture("office-marker-exchange-"), profile = await createOfficeProfile(fixture.root);
  const open = fs.open;
  let exchanged = false;
  // A test-only boundary injection; all handles, replacement and deletion remain real.
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    try {
      if (String(args[0]).endsWith("/" + markerName)) {
        await fs.rename(join(profile.path, markerName), join(profile.path, "opened-marker"));
        const mkfifo = Bun.spawn(["mkfifo", join(profile.path, markerName)], { stdout: "ignore", stderr: "pipe" });
        if (await mkfifo.exited !== 0) throw new Error(await new Response(mkfifo.stderr).text());
        exchanged = true;
      }
      return file;
    } catch (error) { await file.close(); throw error; }
  });
  try {
    await profile.close();
    expect(exchanged).toBe(true);
    expect((await fs.readdir(join(fixture.root, ".office-jobs"))).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(1);
    expect(await fs.readFile(join(profile.path, "opened-marker"), "utf8")).toContain('"version":1');
    expect((await fs.lstat(join(profile.path, markerName))).isFIFO()).toBe(true);
  } finally { spy.mockRestore(); await fs.rm(profile.path, { recursive: true, force: true }); await fixture.cleanup(); }
});
