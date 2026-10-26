import { writeTestData as writeFile } from "../helpers/stats-fixture.ts";
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { collectAll, collectComparisons, parseDate } from "../../scripts/ops/stats-admin.ts";
import { change, comparisons, comparisonWindows, describeStatsWindow, engagement, periodWindow, summarize, trend } from "../../scripts/ops/stats-summary.ts";
import { writeReport } from "../../scripts/ops/tui/report.ts";
import { executeProcess } from "../../scripts/lib/process.ts";
import { fileURLToPath } from "node:url";
import { loadRecentStats } from "../../scripts/ops/tui/data.ts";

const at = (date: string) => parseDate(date, false);
const range = (from: string, to: string) => ({ since: at(from), until: parseDate(to, true) });

test("日周月范围按本地自然日，周一开周，跨年与月末不溢出", () => {
  const now = at("2026-01-01");
  expect(describeStatsWindow(periodWindow("today", now))).toBe("2026-01-01 ~ 2026-01-01");
  expect(describeStatsWindow(periodWindow("yesterday", now))).toBe("2025-12-31 ~ 2025-12-31");
  expect(describeStatsWindow(periodWindow("week", now))).toBe("2025-12-29 ~ 2026-01-01");
  expect(describeStatsWindow(periodWindow("last-week", now))).toBe("2025-12-22 ~ 2025-12-28");
  expect(describeStatsWindow(periodWindow("last-month", now))).toBe("2025-12-01 ~ 2025-12-31");
  expect(describeStatsWindow(periodWindow("7d", now))).toBe("2025-12-26 ~ 2026-01-01");
  expect(describeStatsWindow(periodWindow("30d", now))).toBe("2025-12-03 ~ 2026-01-01");
  expect(periodWindow("all", now)).toEqual({});
  expect(() => periodWindow("invalid")).toThrow("未知统计范围");
});

test("本周本月比较已到达的日数，上月比较完整月，闰日同比截到月末", () => {
  const month = comparisonWindows(periodWindow("month", at("2026-03-31")))!;
  expect(describeStatsWindow(month.previous)).toBe("2026-02-01 ~ 2026-02-28");
  expect(describeStatsWindow(month.yearAgo)).toBe("2025-03-01 ~ 2025-03-31");
  const week = comparisonWindows(periodWindow("week", at("2026-10-08")))!;
  expect(describeStatsWindow(week.previous)).toBe("2026-09-28 ~ 2026-10-01");
  const leap = comparisonWindows(periodWindow("last-month", at("2024-03-10")))!;
  expect(describeStatsWindow(leap.previous)).toBe("2024-01-01 ~ 2024-01-31");
  expect(describeStatsWindow(leap.yearAgo)).toBe("2023-02-01 ~ 2023-02-28");
  expect(describeStatsWindow(comparisonWindows(range("2024-02-29", "2024-02-29"))!.yearAgo)).toBe("2023-02-28 ~ 2023-02-28");
  expect(describeStatsWindow(comparisonWindows(range("2026-10-02", "2026-10-04"))!.previous)).toBe("2026-09-29 ~ 2026-10-01");
  expect(comparisonWindows({})).toBeNull();
  expect(comparisonWindows({ until: at("2026-10-01") })).toBeNull();
});

test("零基数不显示无限增长，下降与持平给出准确比例", () => {
  expect(change(3, 0)).toBe("新增（基期无记录）");
  expect(change(0, 0)).toBe("—（两期均无记录）");
  expect(change(0, 5)).toBe("-100.0%");
  expect(change(3, 2)).toBe("+50.0%");
  expect(change(2, 2)).toBe("0.0%");
});

test("每日补零、周月去重、跨群排行、空本期比较与报表脱敏一致", async () => {
  const f = await tempFixture("stats-summary-");
  const data = join(f.root, "data");
  try {
    const put = async (group: string, user: string, entries: [string, number, string?][]) => {
      const dir = join(data, group, "users", user); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "stats.records"), entries.flatMap(([date, count, role = "user"]) => Array.from({ length: count }, () => JSON.stringify({
        type: "message", timestamp: new Date(at(date) + 12 * 3600000).toISOString(),
        message: { role, content: [{ type: "text", text: "fixture question" }], usage: { input: 40, output: 2 } },
      }))).join("\n") + "\n");
    };
    await put("a", "13812345678", [["2026-10-01", 2], ["2026-10-03", 1], ["2026-09-28", 1], ["2025-10-01", 1]]);
    await put("b", "13812345678", [["2026-10-01", 1], ["2026-10-03", 1]]);
    await put("b", "13912345678", [["2026-10-03", 2]]);
    await put("a", "13712345678", [["2026-10-02", 1, "assistant"]]);
    await put("prior-only", "13612345678", [["2026-09-29", 2]]);
    const window = range("2026-10-01", "2026-10-03"), groups = await collectAll(data, window);
    const summary = summarize(groups);
    expect(summary.asks).toBe(7); expect(summary.people).toBe(2); expect(summary.average).toBe(3.5);
    const recent = await loadRecentStats(data, 3, at("2026-10-03") + 23 * 3600000);
    expect(recent.today.people).toBe(2);
    expect(recent.trend.map(day => day.people)).toEqual([1, 0, 2]);
    expect(summary.ranking.map(user => [user.user, user.asks, user.days.size, user.groups.size])).toEqual([
      ["13812345678", 5, 2, 2], ["13912345678", 2, 1, 1],
    ]);
    expect(trend(groups, window).map(row => [row.date, row.asks, row.askers.size, row.tokens.totalTokens])).toEqual([
      ["2026-10-01", 3, 1, 0], ["2026-10-02", 0, 0, 42], ["2026-10-03", 4, 2, 0],
    ]);
    expect(trend(groups, window, "week").map(row => [row.date, row.asks, row.askers.size])).toEqual([["2026-09-28", 7, 2]]);
    expect(trend(groups, window, "month")[0]!.askers.size).toBe(2);
    const activity = engagement(groups, window);
    expect(activity.dailyAverage).toBeCloseTo(7 / 3); expect(activity.activeRate).toBeCloseTo(2 / 3);
    expect(activity.peak?.date).toBe("2026-10-03"); expect(activity.topFiveShare).toBe(1);
    const comparison = await collectComparisons(data, window);
    expect(comparisons(comparison).map(row => [row.asks, row.people])).toEqual([[3, 2], [1, 1]]);
    expect(comparisons(comparison, new Set(["a"])).map(row => row.asks)).toEqual([1, 1]);
    const emptyWindow = range("2026-10-04", "2026-10-06");
    expect(await collectAll(data, emptyWindow)).toEqual([]);
    expect(trend([], emptyWindow).map(row => row.asks)).toEqual([0, 0, 0]);
    expect(comparisons(await collectComparisons(data, emptyWindow))[0]!.asks).toBe(7);
    const path = await writeReport({ groups, detail: groups[0]!, window, comparisons: comparison,
      unmasked: false, dir: data, deployment: { platform: "linux", runtime: "docker", port: 1011, dataRoot: data, workspaceRoot: "" } });
    const html = await Bun.file(path).text();
    for (const text of ["每日明细", "每周（周一为起点）明细", "每月明细", "2026-10-02", "+133.3%", "覆盖提问人数", "提问高峰日", "前五名提问占比", "138****5678", "模型用量", "模型与工具用量"]) expect(html).toContain(text);
    expect(html).not.toMatch(/金额|\$\d|¥/);
    expect(html).not.toContain("13812345678");
    expect(html).not.toContain("13612345678");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    const unmaskedPath = await writeReport({ groups, detail: groups.find(group => group.group === "a")!, window, comparisons: comparison,
      unmasked: true, dir: data, deployment: { platform: "linux", runtime: "docker", port: 1011, dataRoot: data, workspaceRoot: "" } });
    const unmaskedHtml = await Bun.file(unmaskedPath).text();
    expect(unmaskedHtml).toContain("13812345678");
    expect(unmaskedHtml).not.toContain("13912345678");
    expect(unmaskedHtml).toContain("unknown/unknown");
    expect(unmaskedHtml.split("群 a · 概况")[0]).not.toContain("13812345678");
    const script = fileURLToPath(new URL("../../scripts/ops/stats-admin.ts", import.meta.url));
    const cli = await executeProcess({ command: process.execPath, args: [script, "--since", "2026-10-01", "--until", "2026-10-03"], cwd: f.root, env: process.env, timeoutMs: 30000 });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("总提问数 7 次 · 覆盖提问人数 2 人");
    expect(cli.stdout).toContain("2026-10-02  0 次  0 人  42");
    expect(cli.stdout).toContain("基期 3 次 / 2 人");
    expect(cli.stdout).toContain("138****5678");
    expect(cli.stdout).not.toContain("13812345678");
    expect(cli.stdout).not.toContain("13912345678");
    const invalid = await executeProcess({ command: process.execPath, args: [script, "--period", "month", "--since", "2026-10-01"], cwd: f.root, env: process.env, timeoutMs: 30000 });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("不能同时使用");
  } finally { await f.cleanup(); }
}, 60000);
