import { expect, test } from "bun:test";
import { appendFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { readSessionStats } from "../../scripts/lib/session-stats-cache.ts";
import { tempFixture } from "../helpers/temp.ts";

const row = (model: string) => JSON.stringify({ type: "message", timestamp: "2026-09-13T01:00:00Z", message: {
  role: "assistant", model, content: [{ type: "text", text: "private-answer" }, { type: "toolCall", name: "bash", arguments: { secret: "private-argument" } }],
  usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 5 } } });

test("stats cache handles append, completed partial rows, truncate and middle rewrite", async () => {
  const fixture = await tempFixture("stats-cache-"), path = join(fixture.root, "session.jsonl");
  try {
    await writeFile(path, row("first") + "\n" + row("tail"));
    const first = await readSessionStats(path);
    expect(first.records).toHaveLength(2);
    expect((await readSessionStats(path)).records).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain("private-");
    await appendFile(path, '\n{"type":"message"');
    const partial = await readSessionStats(path);
    expect(partial.records).toHaveLength(2); expect(partial.skipped).toBe(1);
    await appendFile(path, ',"message":{"role":"assistant","model":"completed"}}\n');
    const completed = await readSessionStats(path);
    expect(completed.records).toHaveLength(3); expect(completed.skipped).toBe(0);
    await writeFile(path, row("replaced") + "\n");
    expect((await readSessionStats(path)).records.map(r => r.message?.model)).toEqual(["replaced"]);
    const prefix = row("a".repeat(1000)) + "\n";
    await writeFile(path, prefix + row("old") + "\n" + prefix);
    await readSessionStats(path);
    await writeFile(path, prefix + row("new") + "\n" + prefix + row("appended") + "\n");
    const rewritten = await readSessionStats(path);
    expect(rewritten.records[1]!.message?.model).toBe("new");
    expect(rewritten.records).toHaveLength(4);
    await writeFile(path, row("same-size-a"));
    await utimes(path, new Date(0), new Date(0)); await readSessionStats(path);
    await writeFile(path, row("same-size-b")); await utimes(path, new Date(0), new Date(0));
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => readSessionStats(path)));
    expect(concurrent.every(result => result.records[0]!.message?.model === "same-size-b")).toBe(true);
  } finally { await fixture.cleanup(); }
});
