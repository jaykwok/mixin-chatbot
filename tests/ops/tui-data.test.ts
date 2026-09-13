import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRecentStats, probeService } from "../../scripts/ops/tui/data.ts";
import { parseDate } from "../../scripts/ops/stats-admin.ts";
import { tempFixture } from "../helpers/temp.ts";

test("每日提问按消息当天计数，9 次和 1 次不会被平均成 5 次", async () => {
  const fixture = await tempFixture("tui-daily-");
  try {
    const dir = join(fixture.root, "g1", "users", "13812345678");
    await mkdir(dir, { recursive: true });
    const message = (day: number, text: string) => JSON.stringify({
      type: "message", timestamp: new Date(2026, 8, day, 12).toISOString(),
      message: { role: "user", content: [{ type: "text", text }] },
    });
    await writeFile(join(dir, "session.jsonl"), [
      ...Array.from({ length: 9 }, () => message(11, "统计")),
      message(12, "资料"), message(12, "/help"), message(12, "@机器人ﾠ/clear"),
      JSON.stringify({ type: "message", timestamp: new Date(2026, 8, 12, 12, 1).toISOString(),
        message: { role: "toolResult", toolName: "send_file", isError: false, details: { fileId: "fixture" } } }),
    ].join("\n") + "\n");
    const recent = await loadRecentStats(fixture.root, 3, new Date(2026, 8, 12, 23).getTime());
    // 成员和附件也按天留档：总览的指标块要用昨天的值算环比，只攒提问数的话算不出来。
    expect(recent.trend).toEqual([
      { day: "2026-09-10", asks: 0, people: 0, files: 0 },
      { day: "2026-09-11", asks: 9, people: 1, files: 0 },
      { day: "2026-09-12", asks: 1, people: 1, files: 1 },
    ]);
    expect(recent.today).toEqual({ asks: 1, people: 1, files: 1, images: 0, groups: 1 });
    // 跨午夜才送达的附件仍计入送达当天，即使当天没有新提问。
    await writeFile(join(dir, "session.jsonl"), [message(11, "昨日的任务"), JSON.stringify({
      type: "message", timestamp: new Date(2026, 8, 12, 0, 1).toISOString(),
      message: { role: "toolResult", toolName: "send_file", isError: false, details: { fileId: "after-midnight" } },
    })].join("\n") + "\n");
    expect((await loadRecentStats(fixture.root, 3, new Date(2026, 8, 12, 23).getTime())).today.files).toBe(1);
  } finally { await fixture.cleanup(); }
});

test("日期拒绝不存在的自然日，闰年和当天末尾边界有效", () => {
  expect(() => parseDate("2026-02-30", false)).toThrow();
  expect(() => parseDate("2026-02-29", false)).toThrow();
  expect(() => parseDate("2026-13-01", false)).toThrow();
  expect(new Date(parseDate("2024-02-29", true)).getHours()).toBe(23);
  expect(new Date(parseDate("2024-02-29", true)).getMilliseconds()).toBe(999);
});

test("健康探针拒绝 503、未知状态和无 PID，运行时长只来自匹配的实例记录", async () => {
  const fixture = await tempFixture("tui-health-");
  let status = 200;
  const startedAt = Date.now() - 3_600_000;
  const identity = { service: "mixin-chatbot", version: 1, instanceId: crypto.randomUUID(), startedAt, pid: 42 };
  let body: unknown = { ...identity, status: "ready" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body, { status }) });
  const port = server.port!;
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ ...identity, port }));
    expect(await probeService(port, file)).toMatchObject({ state: "ready", pid: 42, startedAt });
    status = 503;
    expect((await probeService(port, file)).state).toBe("unreachable");
    status = 200;
    for (const invalid of [{}, { status: "ok", pid: 42 }, { status: "ready" }, { status: "ready", pid: 0 }]) {
      body = invalid;
      expect((await probeService(port, file)).state).toBe("unreachable");
    }
    body = { ...identity, status: "stopping" };
    expect((await probeService(port, file)).state).toBe("stopping");
    body = { ...identity, status: "ready", instanceId: crypto.randomUUID() };
    expect((await probeService(port, file)).state).toBe("unreachable");
    body = { ...identity, status: "ready", pid: 43 };
    expect((await probeService(port, file)).state).toBe("unreachable");
    expect((await probeService(port, file)).startedAt).toBeUndefined();
    await writeFile(file, JSON.stringify({ pid: 43, port: port + 1, startedAt }));
    expect((await probeService(port, file)).startedAt).toBeUndefined();
  } finally { await server.stop(true); await fixture.cleanup(); }
});
