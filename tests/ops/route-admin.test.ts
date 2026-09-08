import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CALLBACK_ROUTES } from "../../src/core/config.ts";
import { openState } from "../../src/core/state.ts";
import { tempFixture } from "../helpers/temp.ts";

test("route CLI clears quarantine, rejects ambiguous changes and releases full capacity", async () => {
  const fixture = await tempFixture("route-admin-");
  const database = openState(join(fixture.root, "data/state/agent.sqlite"));
  const script = fileURLToPath(new URL("../../scripts/ops/route-admin.ts", import.meta.url));
  const fingerprint = createHash("sha256").update("test-only-private-callback-key").digest("hex");
  database.exec("CREATE TABLE callback_routes (hash TEXT PRIMARY KEY, group_id TEXT NOT NULL, conflict TEXT, seen INTEGER NOT NULL)");
  database.query("INSERT INTO callback_routes VALUES (?, ?, ?, ?)").run(fingerprint, "original", "conflicting", Date.now());
  async function run(entry: string, args: string[] = []) {
    const child = Bun.spawn([process.execPath, entry, ...args], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err };
    } finally { clearTimeout(timer); child.kill(); await child.exited; }
  }
  try {
    const listed = await run(script, ["list"]);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain(fingerprint);
    expect(listed.out).toContain('"status":"conflict"');
    expect(listed.out).not.toContain("test-only-private-callback-key");
    const reset = await run(script, ["reset", fingerprint.slice(0, 12), "--group", "资料群 A"]);
    expect(reset.code, reset.err).toBe(0);
    expect(database.query("SELECT group_id, conflict FROM callback_routes WHERE hash = ?").get(fingerprint))
      .toEqual({ group_id: "资料群 A", conflict: null });

    const probe = join(fixture.root, "probe.ts");
    const module = fileURLToPath(new URL("../../src/integrations/callback-route.ts", import.meta.url));
    await writeFile(probe, `import {observeCallbackRoute} from ${JSON.stringify(module)};
      console.log(JSON.stringify(observeCallbackRoute('https://im.zdxlz.com/im-external/v1/webhook/send?key=capacity-probe','new-group')));`);
    const insert = database.query("INSERT INTO callback_routes VALUES (?, ?, ?, ?)");
    database.transaction(() => {
      for (let i = 0; i < MAX_CALLBACK_ROUTES - 1; i++) insert.run(i.toString(16).padStart(64, "0"), "retired", "old-conflict", Date.now());
    })();
    const full = await run(probe);
    expect(full.code, full.err).toBe(0);
    expect(JSON.parse(full.out).reason).toBe("capacity");
    const ambiguous = await run(script, ["forget", "000000000000"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("匹配多条");
    expect(database.query("SELECT COUNT(*) AS n FROM callback_routes").get()).toEqual({ n: MAX_CALLBACK_ROUTES });
    const removed = await run(script, ["forget", fingerprint]);
    expect(removed.code, removed.err).toBe(0);
    expect(database.query("SELECT * FROM callback_routes WHERE hash = ?").get(fingerprint)).toBeNull();
    const recovered = await run(probe);
    expect(recovered.code, recovered.err).toBe(0);
    expect(JSON.parse(recovered.out)).toMatchObject({ safe: true, reason: "ok", groups: ["new-group"] });
  } finally { database.close(); await fixture.cleanup(); }
}, 30000);
