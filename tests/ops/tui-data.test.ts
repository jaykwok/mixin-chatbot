import { expect, spyOn, test } from "bun:test";
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadDiskUsage, loadGit, loadHealth, loadHistory, loadRecentStats, loadStatsOverview, loadTmp, probeService, type Health } from "../../scripts/ops/tui/data.ts";
import type { Deployment } from "../../scripts/ops/tui/platform.ts";
import * as tuiExec from "../../scripts/ops/tui/exec.ts";
import { parseDate } from "../../scripts/ops/stats-admin.ts";
import { tempFixture } from "../helpers/temp.ts";

test("体检把取消信号和界面提示上下文传给子进程，并保留失败项", async () => {
  const deployment: Deployment = { platform: "windows", runtime: "scheduled-task", port: 1011,
    mode: "direct", domain: "", groupDataRoot: "unused", groupDataRootIsCustom: false };
  const health: Health = { pass: 0, warn: 0, fail: 1, checks: [
    { name: "本地机器人健康", status: "fail", detail: "实例不存在", fix: "系统 → 服务部署 → 部署 / 重部署" },
  ] };
  const controller = new AbortController();
  const capture = spyOn(tuiExec, "capture").mockResolvedValue({ code: 1, stdout: JSON.stringify(health), stderr: "", timedOut: false });
  try {
    expect(await loadHealth(deployment, controller.signal)).toEqual(health);
    expect(capture.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    expect(capture.mock.calls[0]?.[2]?.env?.MIXIN_OPS_TUI).toBe("1");
  } finally { capture.mockRestore(); }
});

test("Git 调用共享一次查询并顺序复用宿主，下一次刷新仍读取最新版本", async () => {
  let done!: (value: tuiExec.RunResult) => void;
  let sha = "123456789abcdef";
  const result = (stdout: string): tuiExec.RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const capture = spyOn(tuiExec, "capture").mockImplementation(async (_command, args) => {
    if (args[0] === "status") return new Promise(resolve => { done = resolve; });
    if (args[0] === "rev-parse") return result("main\n");
    if (args[0] === "rev-list") return result("2\t1\n");
    return result(args.includes("-1") ? `${sha}\nfixture subject\n` : "abcdef0 incoming subject\n");
  });
  try {
    const first = loadGit();
    expect(loadGit()).toBe(first);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(capture).toHaveBeenCalledTimes(3); // status 未结束前不会排队启动下一条命令。
    done(result(" M tracked.ts\n"));
    expect(await first).toEqual({ branch: "main", sha, subject: "fixture subject", dirty: true, ahead: 2, behind: 1,
      incoming: [{ sha: "abcdef0", subject: "incoming subject" }] });
    expect(capture).toHaveBeenCalledTimes(5);
    sha = "fedcba987654321";
    const second = loadGit();
    expect(second).not.toBe(first);
    await new Promise<void>(resolve => setImmediate(resolve));
    done(result(""));
    expect(await second).toMatchObject({ sha, dirty: false });
    capture.mockRejectedValue(new Error("git missing"));
    expect(await loadGit().catch(error => error)).toBeInstanceOf(Error);
  } finally { capture.mockRestore(); }
});

test("Git 超时与执行故障显示读取错误，仅明确的非仓库返回空状态", async () => {
  const capture = spyOn(tuiExec, "capture");
  try {
    capture.mockResolvedValue({ code: 124, stdout: "", stderr: "diagnostic", timedOut: true });
    expect(String(await loadGit().catch(error => error))).toContain("Git 查询超时");
    capture.mockResolvedValue({ code: 128, stdout: "", stderr: "permission denied", timedOut: false });
    expect(String(await loadGit().catch(error => error))).toContain("permission denied");
    capture.mockResolvedValue({ code: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false });
    expect(await loadGit()).toBeNull();
  } finally { capture.mockRestore(); }
});

test("并发磁盘扫描不重复计算重叠根目录，也不跟随目录链接", async () => {
  const fixture = await tempFixture("tui-disk-");
  const data = join(fixture.root, "data");
  const group = join(data, "groups", "g1");
  const outside = join(fixture.root, "outside");
  try {
    await mkdir(group, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "excluded"), "x".repeat(10000));
    for (let i = 1; i <= 40; i++) await writeFile(join(group, String(i)), "x".repeat(i));
    const link = join(data, "linked");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const expected = 820 + (await lstat(link)).size;
    expect(await loadDiskUsage([data, group, relative(process.cwd(), data), ...(process.platform === "win32" ? [data.toUpperCase()] : [])])).toBe(expected);
    expect(await loadDiskUsage([join(fixture.root, "missing")])).toBe(0);
  } finally { await fixture.cleanup(); }
});

test("并发扫描多个群和成员时统计、会话字节及深层临时文件总量一致", async () => {
  const fixture = await tempFixture("tui-parallel-scan-");
  const now = new Date(2026, 8, 12, 23).getTime();
  let historyBytes = 0;
  try {
    for (let member = 0; member < 12; member++) {
      const dir = join(fixture.root, `g${Math.floor(member / 4)}`, "users", `u${member}`);
      const tmp = join(dir, "tmp", "nested");
      await mkdir(tmp, { recursive: true });
      const content = Array.from({ length: member + 1 }, () => JSON.stringify({ type: "message",
        timestamp: new Date(now - 3600000).toISOString(), message: { role: "user", content: [{ type: "text", text: "并发统计" }] } })).join("\n") + "\n";
      historyBytes += Buffer.byteLength(content);
      await writeFile(join(dir, "session.jsonl"), content);
      await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(tmp, `${index}.txt`), "x".repeat(index + 1))));
    }
    const [stats, recent, history, tmp, disk] = await Promise.all([
      loadStatsOverview(fixture.root), loadRecentStats(fixture.root, 3, now), loadHistory(fixture.root),
      loadTmp(fixture.root), loadDiskUsage([fixture.root]),
    ]);
    expect(stats.map(group => group.group)).toEqual(["g2", "g1", "g0"]);
    expect(stats.reduce((sum, group) => sum + group.asks, 0)).toBe(78);
    expect(recent.today.asks).toBe(78);
    expect(recent.today.people).toBe(12);
    expect(history.reduce((sum, group) => sum + group.bytes, 0)).toBe(historyBytes);
    expect(history.flatMap(group => group.users)).toHaveLength(12);
    expect(tmp.reduce((sum, user) => sum + user.files, 0)).toBe(240);
    expect(tmp.reduce((sum, user) => sum + user.bytes, 0)).toBe(2520);
    expect(disk).toBe(historyBytes + 2520);
  } finally { await fixture.cleanup(); }
});

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
