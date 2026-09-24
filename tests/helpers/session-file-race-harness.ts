// Run in a child process so the paused filesystem calls cannot affect other tests.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const { lstat, open, mkdir, rename, writeFile, appendFile } = fs;
type Gate = { path: string; point: "lstat" | "fstat"; calls: number; read: () => void; release: Promise<void> };
let gate: Gate | undefined;
async function pause(active: Gate) {
  gate = undefined;
  active.read();
  await active.release;
}
mock.module("node:fs/promises", () => ({ ...fs,
  async lstat(...args: Parameters<typeof lstat>) {
    const info = await lstat(...args);
    const active = gate;
    // The first lstat belongs to the ledger; the second belongs to the reader.
    if (active?.point === "lstat" && String(args[0]) === active.path && ++active.calls === 2) await pause(active);
    return info;
  },
  async open(...args: Parameters<typeof open>) {
    const handle = await open(...args);
    const active = gate;
    if (active?.point === "fstat" && String(args[0]) === active.path) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...statArgs: Parameters<typeof stat>) => {
        const info = await stat(...statArgs);
        if (gate === active) await pause(active);
        return info;
      }) as typeof handle.stat;
    }
    return handle;
  },
}));
const ledger = await import("../../src/agent/stats-ledger.ts");
const root = process.argv[2]!;
const ask = (text: string) => JSON.stringify({ type: "message", timestamp: "2026-09-23T01:00:00Z",
  message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
const content = (id: string, asks: number) => JSON.stringify({ type: "session", version: 3, id }) + "\n"
  + Array.from({ length: asks }, (_, i) => ask(id + i)).join("");

async function race(point: Gate["point"], archived: boolean, append = false) {
  const user = `${point}-${archived ? "archived" : "active"}-${append ? "append" : "replace"}`;
  const dir = join(root, "g/users", user), path = join(dir, "session.jsonl");
  const oldId = user + "-old", newId = user + "-new";
  await mkdir(dir, { recursive: true });
  await writeFile(path, content(oldId, 3));
  if (archived) await ledger.ingestBeforeArchive(root, "g", user);
  else await ledger.ingestUserSession(root, "g", user);
  const db = ledger.openStatsLedger(root);
  const source = () => db.query("SELECT * FROM sources WHERE id = ?").get(oldId);
  const before = source();
  let release!: () => void, read!: () => void;
  const readDone = new Promise<void>(r => { read = r; });
  gate = { path, point, calls: 0, read, release: new Promise<void>(r => { release = r; }) };
  const scan = ledger.ingestUserSession(root, "g", user);
  try {
    await readDone;
    if (append) await appendFile(path, ask("appended-during-read"));
    else {
      await rename(path, join(dir, "archived.jsonl"));
      await writeFile(path, content(newId, 1));
    }
    release();
    await scan;
    if (!append) {
      // A subsequent task in the new generation must not conceal loss of the old one.
      await ledger.ingestUserSession(root, "g", user);
      const after = source() as Record<string, unknown>;
      assert.deepEqual(archived ? after : { ...after, seen_at: (before as Record<string, unknown>).seen_at }, before,
        "Scanning a replaced file must preserve the old source (including the archive marker)");
    }
    const rows = db.query(`SELECT s.id, SUM(a.asks) AS asks FROM sources s JOIN activity a ON a.source = s.id
      WHERE s.user_segment = ? GROUP BY s.id ORDER BY s.id`).all(user);
    assert.deepEqual(rows, append ? [{ id: oldId, asks: 4 }] : [{ id: newId, asks: 1 }, { id: oldId, asks: 3 }], user);
    if (archived) assert.equal((source() as { archived_at: number }).archived_at, (before as { archived_at: number }).archived_at);
    return user;
  } finally { release(); await scan.catch(() => {}); db.close(); }
}

const results = [];
for (const point of ["lstat", "fstat"] as const) {
  results.push(await race(point, true));
  results.push(await race(point, false));
}
results.push(await race("fstat", false, true));
// A failed archive move can leave the original path in service; later appends must still be counted.
results.push(await race("fstat", true, true));
console.log("HARNESS_RESULT=" + JSON.stringify(results));
