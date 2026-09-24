// Separate processes verify retry checkpoints survive a restart; mocked permissions are portable to Windows.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const { appendFile, mkdir, open, readdir, writeFile } = fs;
const root = process.argv[2]!, phase = process.argv[3]!;
const entries = [["a", "a-ok"], ["a", "b-denied"], ["a", "z-ok"], ["b-denied", "u"], ["c", "u"]];
const paths = entries.map(([group, user]) => join(root, group!, "users", user!, "session.jsonl"));
const deniedFile = paths[1]!, deniedDirectory = join(root, "b-denied", "users");
let denyFile = true, denyDirectory = true;
const opens = new Map<string, number>();
mock.module("node:fs/promises", () => ({ ...fs,
  async open(...args: Parameters<typeof open>) {
    const path = String(args[0]);
    if (paths.includes(path)) opens.set(path, (opens.get(path) ?? 0) + 1);
    if (denyFile && path === deniedFile) throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    return open(...args);
  },
  async readdir(...args: Parameters<typeof readdir>) {
    if (denyDirectory && String(args[0]) === deniedDirectory) throw Object.assign(new Error("fixture directory denied"), { code: "EACCES" });
    return readdir(...args);
  },
}));
const ledger = await import("../../src/agent/stats-ledger.ts");
const now = new Date(2026, 8, 24, 12).getTime();
const ask = JSON.stringify({ type: "message", timestamp: new Date(now).toISOString(),
  message: { role: "user", content: [{ type: "text", text: "synthetic question" }] } }) + "\n";
const errors: { path: string; code?: string }[] = [];
const sweep = (extra = {}) => ledger.sweepSessionStats(root, { now, ...extra,
  onError: (path: string, error: unknown) => errors.push({ path, code: (error as NodeJS.ErrnoException).code }) });
const marked = () => {
  const db = ledger.openStatsLedger(root);
  try { return db.query("SELECT value FROM meta WHERE key = 'last_sweep_day'").get() as { value: string } | null; }
  finally { db.close(); }
};
const unreadSuccesses = () => [paths[0]!, paths[2]!, paths[4]!].every(path => !opens.has(path));

if (phase === "seed") {
  for (const [index, path] of paths.entries()) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ type: "session", version: 3, id: "source-" + index }) + "\n" + ask);
  }
  const first = await sweep();
  assert.deepEqual(first, { files: 3, records: 6, failed: 2, skippedFiles: 0, skippedDay: false });
  assert.equal(marked(), null);
  assert.deepEqual(errors, [{ path: deniedFile, code: "EACCES" }, { path: deniedDirectory, code: "EACCES" }]);
  opens.clear(); errors.length = 0;
  assert.deepEqual(await sweep(), { files: 0, records: 0, failed: 2, skippedFiles: 3, skippedDay: false });
  assert.ok(unreadSuccesses(), "Successful files must not be reopened to hash their prefixes");
  assert.equal(opens.get(deniedFile), 1);
  assert.equal(errors.length, 2);
  assert.equal(marked(), null);
} else {
  // New process, same incomplete day: successful files still need no content reads.
  assert.deepEqual(await sweep(), { files: 0, records: 0, failed: 2, skippedFiles: 3, skippedDay: false });
  assert.ok(unreadSuccesses());
  denyFile = false; denyDirectory = false;
  await appendFile(paths[0]!, ask);
  const recovered = await sweep();
  assert.deepEqual(recovered, { files: 3, records: 5, failed: 0, skippedFiles: 2, skippedDay: false });
  assert.equal(marked()?.value, ledger.dayKey(now));
  const db = ledger.openStatsLedger(root);
  try { assert.equal((db.query("SELECT SUM(asks) AS n FROM activity").get() as { n: number }).n, 6); }
  finally { db.close(); }
  opens.clear();
  assert.equal((await sweep()).skippedDay, true);
  assert.equal(opens.size, 0);

  // A failed forced scan must invalidate an existing completion marker and remain retryable.
  denyFile = true;
  assert.deepEqual(await sweep({ force: true }), { files: 4, records: 0, failed: 1, skippedFiles: 0, skippedDay: false });
  assert.equal(marked(), null);
  opens.clear();
  assert.deepEqual(await sweep(), { files: 0, records: 0, failed: 1, skippedFiles: 4, skippedDay: false });
  assert.deepEqual([...opens], [[deniedFile, 1]]);
  denyFile = false;
  assert.deepEqual(await sweep(), { files: 1, records: 0, failed: 0, skippedFiles: 4, skippedDay: false });
  opens.clear();
  assert.deepEqual(await sweep({ now: now + 86400000 }), { files: 5, records: 0, failed: 0, skippedFiles: 0, skippedDay: false });
  assert.equal(opens.size, 5, "A new day must revisit every file");
}
console.log("HARNESS_RESULT=" + phase);
