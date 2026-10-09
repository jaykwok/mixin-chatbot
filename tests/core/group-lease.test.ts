import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { dataDirectoryNames } from "../../scripts/lib/group-data.ts";
import { GROUP_ROOT_LEASE } from "../../src/core/data-version.ts";
import { acquireGroupRootLease, withMaintenance } from "../../src/core/maintenance.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("group-lease-");
afterAll(() => fixture.cleanup());
let counter = 0;
const newRoot = () => {
  const root = join(fixture.root, `root-${++counter}`);
  mkdirSync(root, { recursive: true });
  return root;
};
const fast = { stale: 2000, update: 1000 };

// Another checkout: its own working directory, the same group root.
const holder = join(fixture.root, "holder.ts");
await writeFile(holder, `
import { acquireGroupRootLease } from ${JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts"))};
const [root, mode, timing] = process.argv.slice(2);
try {
  await acquireGroupRootLease("other checkout", root, { ...(timing === "fast" ? { stale: 2000, update: 1000 } : {}), retries: 0 });
} catch (error) { console.log(String(error)); process.exit(3); }
console.log("held");
if (mode !== "hold") process.exit(0);
setInterval(() => {}, 1000);
`);
// A holder with a shorter `stale` than the owner would take over a live lease: both sides use the same timing.
function spawnHolder(root: string, mode: "try" | "hold", cwd: string, timing: "fast" | "default" = "default") {
  return Bun.spawn([process.execPath, holder, root, mode, timing], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
}
async function firstLine(child: ReturnType<typeof spawnHolder>): Promise<string> {
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.trim();
}
const checkout = (name: string) => { const path = join(fixture.root, name); mkdirSync(path, { recursive: true }); return path; };

describe("group root lease", () => {
  test("excludes a second owner in this process, under another name of the root, and from another checkout", async () => {
    const root = newRoot();
    const release = await acquireGroupRootLease("service", root, { retries: 0 });
    try {
      expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(true);
      await expect(acquireGroupRootLease("service", relative(process.cwd(), root), { retries: 0 })).rejects.toThrow("同一群数据根");
      const alias = join(fixture.root, `alias-${counter}`);
      symlinkSync(root, alias, "junction");
      await expect(acquireGroupRootLease("service", alias, { retries: 0 })).rejects.toThrow("同一群数据根");
      const other = spawnHolder(root, "try", checkout("checkout-b"));
      expect(await firstLine(other)).toContain("同一群数据根");
      expect(await other.exited).toBe(3);
    } finally { await release(); }
    expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(false);
    const other = spawnHolder(root, "try", checkout("checkout-b"));
    expect(await firstLine(other)).toBe("held");
    expect(await other.exited).toBe(0);
    // Its normal exit released the lease.
    expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(false);
  }, 30000);

  test("a missing root is refused and not created", async () => {
    const root = join(fixture.root, "missing-root");
    await expect(acquireGroupRootLease("service", root, { retries: 0 })).rejects.toThrow("群数据根不可用");
    expect(existsSync(root)).toBe(false);
  });

  test("the lease of a force-killed owner is taken over once it is stale", async () => {
    const root = newRoot();
    const owner = spawnHolder(root, "hold", checkout("checkout-killed"), "fast");
    expect(await firstLine(owner)).toBe("held");
    owner.kill("SIGKILL");
    await owner.exited;
    expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(true);
    const started = Date.now();
    const release = await acquireGroupRootLease("service", root, fast);
    await release();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30000);

  test("a lost lease is reported once, and releasing it afterwards leaves the next owner's lease alone", async () => {
    for (const lose of [
      (path: string) => rmSync(path, { recursive: true }),
      (path: string) => utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)),
    ]) {
      const root = newRoot();
      const lost: Error[] = [];
      const release = await acquireGroupRootLease("service", root, { ...fast, retries: 0, onLost: (error) => lost.push(error) });
      lose(join(root, GROUP_ROOT_LEASE));
      const deadline = Date.now() + 5000;
      while (!lost.length && Date.now() < deadline) await Bun.sleep(50);
      expect(lost).toHaveLength(1);
      expect((lost[0] as NodeJS.ErrnoException).code).toBe("ECOMPROMISED");
      const next = await acquireGroupRootLease("service", root, fast);
      await release();
      expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(true);
      await next();
      await Bun.sleep(1500);
      expect(lost).toHaveLength(1);
    }
  }, 30000);

  test("maintenance that names the group root holds it for the whole task; other maintenance leaves it alone", async () => {
    const root = newRoot();
    await withMaintenance(async () => {
      await expect(acquireGroupRootLease("service", root, { retries: 0 })).rejects.toThrow("同一群数据根");
    }, root);
    expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(false);
    await withMaintenance(async () => {
      expect(existsSync(join(root, GROUP_ROOT_LEASE))).toBe(false);
      await (await acquireGroupRootLease("service", root, { retries: 0 }))();
    });
  });

  test("group listings skip the lease directory", async () => {
    const root = newRoot();
    mkdirSync(join(root, "group-a"));
    const release = await acquireGroupRootLease("service", root, { retries: 0 });
    try { expect(await dataDirectoryNames(root, root)).toEqual(["group-a"]); } finally { await release(); }
  });
});
