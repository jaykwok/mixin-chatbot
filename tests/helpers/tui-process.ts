import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "./temp.ts";

export async function waitFor(check: () => Promise<boolean> | boolean, description: string, timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("等待超时: " + description);
    await Bun.sleep(20);
  }
}
export async function alive(pid: number): Promise<boolean> {
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ")) return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
export async function treeFixture() {
  const fixture = await tempFixture("tui-query-tree-");
  const script = join(fixture.root, "tree.ts");
  await writeFile(script, `
import { join } from "node:path";
const [root, mode] = process.argv.slice(2);
if (mode === "grandchild") {
  await Bun.write(join(root, "grandchild"), String(process.pid));
  await Bun.sleep(60000);
} else {
  await Bun.write(join(root, "parent"), JSON.stringify({ parent: process.pid, host: process.ppid }));
  Bun.spawn([process.execPath, "--no-env-file", import.meta.path, root, "grandchild"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, windowsHide: true,
  });
  while (!await Bun.file(join(root, "grandchild")).exists()) await Bun.sleep(10);
  if (mode === "leave-descendant") { console.log("finished"); process.exit(0); }
  await Bun.sleep(60000);
}
`);
  return { ...fixture, script, async pids() {
    await waitFor(() => Bun.file(join(fixture.root, "grandchild")).exists(), "孙进程启动");
    const { parent, host } = await Bun.file(join(fixture.root, "parent")).json() as { parent: number; host: number };
    const grandchild = Number(await Bun.file(join(fixture.root, "grandchild")).text());
    return { parent, host, grandchild };
  }, async assertStopped() {
    const { parent, grandchild } = await this.pids();
    await waitFor(async () => !await alive(parent) && !await alive(grandchild), "整棵查询进程树退出", 5000);
    expect(await alive(parent)).toBe(false);
    expect(await alive(grandchild)).toBe(false);
  }, async stopLeftovers() {
    if (await Bun.file(join(fixture.root, "parent")).exists()) {
      const { host, parent } = await Bun.file(join(fixture.root, "parent")).json() as { host: number; parent: number };
      const grandchild = Number(await Bun.file(join(fixture.root, "grandchild")).text().catch(() => "0"));
      if (await alive(parent) || grandchild > 0 && await alive(grandchild)) {
        try { process.kill(host, "SIGTERM"); } catch {}
      }
    }
  } };
}
