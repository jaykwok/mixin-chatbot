import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createOfficeProfile, recoverOfficeProfiles } from "../../src/agent/office-profiles.ts";
import { tempFixture } from "../helpers/temp.ts";
import { HeldDirectory, type Entries } from "../../src/core/held-directory.ts";

async function until<T>(probe: () => Promise<T | undefined>) {
  const end = Date.now() + 30_000;
  for (;;) { const value = await probe(); if (value !== undefined) return value; if (Date.now() > end) throw new Error("Office cleanup wait timed out"); await Bun.sleep(25); }
}
test("a live registered profile is retained; normal close removes only its own profile and receipt", async () => {
  const fixture = await tempFixture("office-live-"), profile = await createOfficeProfile(fixture.root);
  try {
    await writeFile(join(profile.path, "work"), "owned");
    expect(await recoverOfficeProfiles(fixture.root)).toBe(0); expect(await readFile(join(profile.path, "work"), "utf8")).toBe("owned");
    const outcome = await profile.close(); expect(outcome.status).toBe(process.platform === "linux" ? "deferred" : "removed");
    expect((await readdir(join(fixture.root, ".office-jobs"))).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(process.platform === "linux" ? 1 : 0);
    if (process.platform === "linux") expect(await readFile(join(profile.path, "work"), "utf8")).toBe("owned");
  } finally { await profile.close(); await fixture.cleanup(); }
});
test("SIGKILL leaves a receipt; supervision stops the descendant; cold recovery cleans only the recorded Office profile", async () => {
  const fixture = await tempFixture("office-kill-"), unowned = await mkdtemp(join(tmpdir(), "mixin-office-"));
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/office-profile-child.ts", import.meta.url)), fixture.root], { stdout: "ignore", stderr: "pipe" });
  try {
    await writeFile(join(unowned, "keep"), "not registered");
    const ready = await until(() => readFile(join(fixture.root, "descendant.json"), "utf8").then(text => JSON.parse(text) as { pid: number; path: string }, () => undefined));
    child.kill("SIGKILL"); await child.exited;
    await until(async () => { try { process.kill(ready.pid, 0); return undefined; } catch { return true; } });
    expect(await recoverOfficeProfiles(fixture.root)).toBe(process.platform === "linux" ? 0 : 1);
    expect(await recoverOfficeProfiles(fixture.root)).toBe(0);
    expect(await readFile(join(unowned, "keep"), "utf8")).toBe("not registered");
    expect((await readdir(join(fixture.root, ".office-jobs"))).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(process.platform === "linux" ? 1 : 0);
  } finally { child.kill("SIGKILL"); await child.exited; await rm(unowned, { recursive: true, force: true }); await fixture.cleanup(); }
}, 90_000);
test("a replaced or unmarked nonempty profile is refused, while a restored foreign-root receipt grants no deletion authority", async () => {
  const fixture = await tempFixture("office-proof-"), journal = join(fixture.root, ".office-jobs");
  await mkdir(journal); const id = "abcdefabcdefabcd", receipt = { version: 1, id, owner: "a".repeat(32), pid: 2147483647,
    tempRoot: fixture.root, systemRoot: tmpdir() }, path = join(tmpdir(), "mixin-office-" + id);
  await mkdir(path);
  try {
    await writeFile(join(path, "foreign"), "keep"); await writeFile(join(journal, id + ".json"), JSON.stringify(receipt));
    await expect(recoverOfficeProfiles(fixture.root)).rejects.toThrow(); expect(await readFile(join(path, "foreign"), "utf8")).toBe("keep");
    await writeFile(join(journal, id + ".json"), JSON.stringify({ ...receipt, tempRoot: "/old-root" }));
    expect(await recoverOfficeProfiles(fixture.root)).toBe(0);
  } finally { await rm(path, { recursive: true, force: true }); await fixture.cleanup(); }
});

test("cleanup keeps its authorized entity across a directory replacement after the ownership check", async () => {
  const fixture = await tempFixture("office-exchange-"), profile = await createOfficeProfile(fixture.root);
  const foreign = await mkdtemp(join(tmpdir(), "office-foreign-")), moved = foreign + "-owned";
  await writeFile(join(foreign, "unrelated.txt"), "keep");
  const use = HeldDirectory.prototype.use;
  let exchanged = false, checked = false;
  const spy = spyOn(HeldDirectory.prototype, "use").mockImplementation(function<T>(this: HeldDirectory, work: (entries: Entries) => Promise<T>): Promise<T> {
    return use.call(this, entries => work({ ...entries, removeDirectories: policy => entries.removeDirectories({
      ...policy, beforeRemove: async (...args) => {
        const allowed = await policy.beforeRemove(...args);
        checked = true;
        try { await rename(profile.path, moved); exchanged = true; await rename(foreign, profile.path); }
        catch (error) { if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error; }
        return allowed;
      },
    }) })) as Promise<T>;
  });
  try {
    const outcome = await profile.close(); expect(outcome.status).toBe(process.platform === "linux" ? "deferred" : "removed");
    expect(checked).toBe(true);
    expect(exchanged).toBe(process.platform === "linux");
    expect(await readFile(join(exchanged ? profile.path : foreign, "unrelated.txt"), "utf8")).toBe("keep");
    if (exchanged) expect((await readdir(join(fixture.root, ".office-jobs"))).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(1);
  } finally {
    spy.mockRestore();
    // The replacement is our synthetic directory; never ask profile.close to remove it.
    await rm(foreign, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true });
    if (exchanged) await rm(profile.path, { recursive: true, force: true });
    else await profile.close();
    await fixture.cleanup();
  }
});

test("a junction or an unmarked replacement is retained with its recovery receipt", async () => {
  const fixture = await tempFixture("office-junction-"), profile = await createOfficeProfile(fixture.root);
  const foreign = await mkdtemp(join(tmpdir(), "office-foreign-")), moved = foreign + "-owned";
  try {
    await writeFile(join(foreign, "unrelated.txt"), "keep"); await rename(profile.path, moved);
    await symlink(foreign, profile.path, process.platform === "win32" ? "junction" : "dir");
    await expect(profile.close()).rejects.toThrow();
    expect(await readdir(join(fixture.root, ".office-jobs"))).toHaveLength(1);
    expect(await readFile(join(foreign, "unrelated.txt"), "utf8")).toBe("keep");
    await rm(profile.path); await rename(moved, profile.path); await profile.close();
    expect((await readdir(join(fixture.root, ".office-jobs"))).filter(name => /^[a-f0-9]{16}\.json$/.test(name))).toHaveLength(process.platform === "linux" ? 1 : 0);
  } finally {
    await rm(profile.path, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true }); await fixture.cleanup();
  }
});
