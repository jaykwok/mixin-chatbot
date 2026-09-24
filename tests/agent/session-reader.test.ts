import { expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSessionSlice } from "../../src/agent/session-reader.ts";
import { tempFixture } from "../helpers/temp.ts";

const row = (model: string) => JSON.stringify({ type: "message", timestamp: "2026-09-13T01:00:00Z", message: {
  role: "assistant", model, content: [{ type: "text", text: "private-answer" }, { type: "toolCall", name: "bash", arguments: { secret: "private-argument" } }],
  usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 5 } } });

test("增量读取处理追加、补全的半行、截断与原地改写", async () => {
  const fixture = await tempFixture("session-reader-"), path = join(fixture.root, "session.jsonl");
  try {
    // 首读：完整行入账，末尾没写完的那行留到下次。
    await writeFile(path, JSON.stringify({ type: "session", version: 3, id: "generation-1" }) + "\n" + row("first") + "\n" + row("tail"));
    const first = await readSessionSlice(path);
    expect(first.sessionId).toBe("generation-1");
    expect(first.records).toHaveLength(2);
    expect(first.pending).toBe(true);
    expect(first.reset).toBe(true);
    // 投影只留统计要用的字段：模型回答和工具参数都不会进统计流程。
    expect(JSON.stringify(first)).not.toContain("private-");

    // 同一份文件没有新增时不重复给记录。
    const idle = await readSessionSlice(path, first.cursor);
    expect(idle.records).toHaveLength(0);
    expect(idle.reset).toBe(false);

    // 半行补全后才算一条，后面又跟了一个新的半行。
    await appendFile(path, '\n{"type":"message"');
    const completed = await readSessionSlice(path, idle.cursor);
    expect(completed.records.map(record => record.message?.model)).toEqual(["tail"]);
    expect(completed.pending).toBe(true);
    await appendFile(path, ',"timestamp":"2026-09-13T02:00:00Z","message":{"role":"assistant","model":"late"}}\n');
    const late = await readSessionSlice(path, completed.cursor);
    expect(late.records.map(record => record.message?.model)).toEqual(["late"]);
    expect(late.pending).toBe(false);
    expect(late.reset).toBe(false);

    // 坏行只算一次，游标照常前进。
    await appendFile(path, "{not json}\n");
    const broken = await readSessionSlice(path, late.cursor);
    expect(broken.badLines).toBe(1);
    expect(broken.records).toHaveLength(0);

    // 截断：前缀短于游标，必须整份重读。
    await writeFile(path, row("replaced") + "\n");
    const truncated = await readSessionSlice(path, broken.cursor);
    expect(truncated.reset).toBe(true);
    expect(truncated.records.map(record => record.message?.model)).toEqual(["replaced"]);

    // 长度不变的原地改写：mtime 可能一样，但前缀摘要对不上，同样整份重读。
    const sameSize = await readSessionSlice(path, truncated.cursor);
    expect(sameSize.reset).toBe(false);
    await writeFile(path, row("replacea") + "\n");
    const rewritten = await readSessionSlice(path, truncated.cursor);
    expect(rewritten.reset).toBe(true);
    expect(rewritten.records.map(record => record.message?.model)).toEqual(["replacea"]);

    // 中段改写后又追加：旧前缀不匹配，不能被当成纯追加。
    const prefix = row("a".repeat(1000)) + "\n";
    await writeFile(path, prefix + row("old") + "\n");
    const beforeMiddle = await readSessionSlice(path);
    await writeFile(path, prefix + row("new") + "\n" + row("appended") + "\n");
    const middle = await readSessionSlice(path, beforeMiddle.cursor);
    expect(middle.reset).toBe(true);
    expect(middle.records.map(record => record.message?.model)).toEqual(["a".repeat(1000), "new", "appended"]);
  } finally { await fixture.cleanup(); }
});
