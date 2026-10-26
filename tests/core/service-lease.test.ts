import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, utimesSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLease } from "../../src/core/maintenance.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("service-lease-");
afterAll(() => fixture.cleanup());
let counter = 0;
const newLease = () => join(fixture.root, `root-${++counter}`, "state", "service");
const fast = { stale: 2000, update: 1000 };

// Another process holding the same lease path.
const holder = join(fixture.root, "holder.ts");
await writeFile(holder, `
import { acquireLease } from ${JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts"))};
const [path, mode] = process.argv.slice(2);
try {
  await acquireLease("other", path, { stale: 2000, update: 1000, retries: 0 });
} catch (error) { console.log(String(error)); process.exit(3); }
console.log("held");
if (mode !== "hold") process.exit(0);
setInterval(() => {}, 1000);
`);
function spawnHolder(path: string, mode: "try" | "hold") {
  return Bun.spawn([process.execPath, holder, path, mode], { stdout: "pipe", stderr: "pipe", windowsHide: true });
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

describe("service lease", () => {
  test("excludes a second owner in this process and in another process", async () => {
    const path = newLease();
    const release = await acquireLease("service", path, { ...fast, retries: 0 });
    try {
      expect(existsSync(path + ".lock")).toBe(true);
      await expect(acquireLease("maintenance", path, { ...fast, retries: 0 })).rejects.toThrow("无法取得 maintenance 互斥锁");
      const other = spawnHolder(path, "try");
      expect(await firstLine(other)).toContain("无法取得 other 互斥锁");
      expect(await other.exited).toBe(3);
    } finally { await release(); }
    expect(existsSync(path + ".lock")).toBe(false);
    const after = spawnHolder(path, "try");
    expect(await firstLine(after)).toBe("held");
    expect(await after.exited).toBe(0);
  }, 30000);

  test("the lease of a force-killed owner is taken over once it is stale", async () => {
    const path = newLease();
    const owner = spawnHolder(path, "hold");
    expect(await firstLine(owner)).toBe("held");
    owner.kill("SIGKILL");
    await owner.exited;
    expect(existsSync(path + ".lock")).toBe(true);
    const started = Date.now();
    const release = await acquireLease("service", path, fast);
    await release();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30000);

  test("a lost lease is reported once, and releasing it afterwards leaves the next owner's lease alone", async () => {
    for (const lose of [
      (path: string) => rmSync(path, { recursive: true }),
      (path: string) => utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)),
    ]) {
      const path = newLease();
      const lost: Error[] = [];
      const release = await acquireLease("service", path, { ...fast, retries: 0, onLost: (error) => lost.push(error) });
      lose(path + ".lock");
      const deadline = Date.now() + 5000;
      while (!lost.length && Date.now() < deadline) await Bun.sleep(50);
      expect(lost).toHaveLength(1);
      expect((lost[0] as NodeJS.ErrnoException).code).toBe("ECOMPROMISED");
      const next = await acquireLease("service", path, fast);
      await release();
      expect(existsSync(path + ".lock")).toBe(true);
      await next();
      await Bun.sleep(1500);
      expect(lost).toHaveLength(1);
    }
  }, 30000);
});
