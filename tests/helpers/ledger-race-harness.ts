// Executed in a fresh process: the gated reader substitute must not leak into other tests.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const readerPath = import.meta.resolve("../../src/agent/session-reader.ts");
const reader = await import(readerPath);
const readSessionSlice = reader.readSessionSlice as typeof import("../../src/agent/session-reader.ts").readSessionSlice;
// The armed call finishes its real read, then waits: that connection now holds a stale view of the file.
let hold: { read: () => void; release: Promise<void> } | undefined;
mock.module(readerPath, () => ({ ...reader, async readSessionSlice(...args: Parameters<typeof readSessionSlice>) {
  const slice = await readSessionSlice(...args);
  const gate = hold;
  hold = undefined;
  if (gate) { gate.read(); await gate.release; }
  return slice;
} }));
const ledger = await import("../../src/agent/stats-ledger.ts");

const root = process.argv[2]!;
// 两个用例是不同会话，不能复用账本主键，否则后一个会覆写前一个的归档世代。
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id }) + "\n";
const ask = (text: string) => JSON.stringify({ type: "message", timestamp: "2026-09-18T01:00:00Z",
  message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

/** A reads and pauses; B ingests newer content and archives the file; A then tries to commit its stale read. */
async function race(user: string, prepare: (path: string) => Promise<void>) {
  const dir = join(root, "g", "users", user), path = join(dir, "session.jsonl"), archived = join(dir, "archived.jsonl");
  await mkdir(dir, { recursive: true });
  await prepare(path);
  let read!: () => void, release!: () => void;
  const readDone = new Promise<void>((resolve) => { read = resolve; });
  hold = { read, release: new Promise<void>((resolve) => { release = resolve; }) };
  const stale = ledger.ingestUserSession(root, "g", user);
  await readDone;
  await appendFile(path, ask("newer"));
  await ledger.ingestBeforeArchive(root, "g", user);
  await rename(path, archived);
  release();
  await stale;
  const db = ledger.openStatsLedger(root);
  try {
    const row = db.query("SELECT offset, archived_at FROM sources WHERE user_segment = ?").get(user) as { offset: number; archived_at: number | null };
    const asks = (db.query("SELECT SUM(a.asks) AS n FROM activity a JOIN sources s ON s.id = a.source WHERE s.user_segment = ?")
      .get(user) as { n: number }).n;
    return { asks, offset: row.offset, size: Bun.file(archived).size, archived: row.archived_at !== null };
  } finally { db.close(); }
}

// No ledger row yet: the stale reader takes the first-ingest branch.
const first = await race("first", path => writeFile(path, header("first") + ask("one")));
// Rewritten in place after an earlier ingest: same file identity, prefix digest mismatch, full-rebuild branch.
const rebuilt = await race("rebuilt", async (path) => {
  await writeFile(path, header("rebuilt") + ask("one"));
  await ledger.ingestUserSession(root, "g", "rebuilt");
  await writeFile(path, header("rebuilt") + ask("uno"));
});
for (const result of [first, rebuilt]) {
  assert.equal(result.asks, 2, JSON.stringify(result));
  assert.equal(result.offset, result.size, JSON.stringify(result));
  assert.equal(result.archived, true, JSON.stringify(result));
}
console.log("HARNESS_RESULT=" + JSON.stringify({ first, rebuilt }));
