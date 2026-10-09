/** Test-only rendezvous: both real Office requests arrive before either launches LibreOffice. */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function launchOfficeAtBarrier() {
  const root = process.env.MIXIN_OFFICE_GATE_ROOT!, command = process.env.MIXIN_OFFICE_GATE_COMMAND!;
  assert(root && command, "the Office test gate requires its owned directory and real executable");
  await writeFile(join(root, `${process.pid}.ready`), JSON.stringify({ pid: process.pid, command, args: process.argv.slice(2) }), { flag: "wx" });
  const start = join(root, "start.json"), deadline = Date.now() + 90_000;
  let startAt = 0;
  while (!startAt) {
    assert(Date.now() < deadline, "both Office requests did not reach the launch barrier");
    if ((await readdir(root)).filter(name => name.endsWith(".ready")).length === 2) {
      await writeFile(start, JSON.stringify(Date.now() + 500), { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    }
    try { startAt = JSON.parse(await readFile(start, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!startAt) await Bun.sleep(25);
  }
  await Bun.sleep(Math.max(0, startAt - Date.now()));
  // This wrapper and its real child remain inside the document supervisor's Windows Job Object.
  const child = Bun.spawn([command, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
  const code = await child.exited;
  await writeFile(join(root, `${process.pid}.exit`), JSON.stringify({ pid: child.pid, code }));
  process.exitCode = code;
}
if (import.meta.main) await launchOfficeAtBarrier();
