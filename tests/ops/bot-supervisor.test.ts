import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

const supervisor = new URL("../../scripts/lib/bot-supervisor.ps1", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
test.skipIf(process.platform !== "win32")("Windows supervisor retries a fresh process, stops on zero and respects its retry bound", async () => {
  const f = await tempFixture("bot-supervisor-");
  try {
    const entry = join(f.root, "entry.ts"), events = join(f.root, "events.jsonl"), script = join(f.root, "run.ps1");
    await writeFile(entry, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const path = ${JSON.stringify(events)};
const count = existsSync(path) && readFileSync(path, "utf8").trim() ? readFileSync(path, "utf8").trim().split("\\n").length : 0;
appendFileSync(path, JSON.stringify({pid: process.pid, count})+"\\n");
process.exit(count < Number(process.env.FAILURES) ? 1 : 0);`);
    const run = async (failures: number, limit: number) => {
      await writeFile(events, "");
      await writeFile(script, "\ufeff. " + quote(decodeURIComponent(supervisor)) + "\n$env:FAILURES='" + failures + "'\nexit (Invoke-BotSupervision -BunPath " + quote(process.execPath) + " -Entry " + quote(entry) + " -RestartDelaySeconds 0 -RestartLimit " + limit + ")\n");
      const child = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const timer = setTimeout(() => child.kill(), 25000);
      try {
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { code, output: out + err, rows: (await readFile(events, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
      } finally { clearTimeout(timer); child.kill(); await child.exited; }
    };
    const recovered = await run(1, 2);
    expect(recovered.code, recovered.output).toBe(0); expect(recovered.rows).toHaveLength(2);
    expect(new Set(recovered.rows.map(row => row.pid)).size).toBe(2);
    const normal = await run(0, 2); expect(normal.code, normal.output).toBe(0); expect(normal.rows).toHaveLength(1);
    const bounded = await run(9, 1); expect(bounded.code, bounded.output).toBe(1); expect(bounded.rows).toHaveLength(2);
    await writeFile(events, "");
    await writeFile(script, "\ufeff. " + quote(decodeURIComponent(supervisor)) + "\n$env:FAILURES='9'\nexit (Invoke-BotSupervision -BunPath " + quote(process.execPath) + " -Entry " + quote(entry) + " -RestartDelaySeconds 3 -RestartLimit 1)\n");
    const stopped = Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    try {
      const deadline = Date.now() + 10000;
      while (!(await readFile(events, "utf8")).trim() && Date.now() < deadline) await Bun.sleep(10);
      expect((await readFile(events, "utf8")).trim()).not.toBe("");
      await Bun.sleep(100); stopped.kill(); await stopped.exited; await Bun.sleep(3500);
      expect((await readFile(events, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally { stopped.kill(); await stopped.exited; }
  } finally { await f.cleanup(); }
}, 70000);
