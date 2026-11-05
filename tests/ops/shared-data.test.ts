// Shared host readers used by the console (the terminal UI is retired).
import { writeTestData as writeFile } from "../helpers/stats-fixture.ts";
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadTmp, probeService } from "../../scripts/ops/shared/data.ts";
import * as settingsData from "../../scripts/ops/shared/data.ts";
import { serviceView } from "../../scripts/ops/console/status.ts";
import { collectAll, parseDate } from "../../scripts/ops/stats-admin.ts";
import { trend } from "../../scripts/ops/stats-summary.ts";
import { createApp } from "../../src/server/http-app.ts";
import { tempFixture } from "../helpers/temp.ts";

test("并发扫描多个群和成员时统计与深层临时文件总量一致", async () => {
  const fixture = await tempFixture("shared-parallel-scan-");
  const now = new Date(2026, 8, 12, 23).getTime();
  try {
    for (let member = 0; member < 12; member++) {
      const dir = join(fixture.root, `g${Math.floor(member / 4)}`, "users", `u${member}`);
      const tmp = join(fixture.root, "tmp", "groups", `g${Math.floor(member / 4)}`, `u${member}`, "nested");
      await mkdir(tmp, { recursive: true });
      const content = Array.from({ length: member + 1 }, () => JSON.stringify({ type: "message",
        timestamp: new Date(now - 3600000).toISOString(), message: { role: "user", content: [{ type: "text", text: "并发统计" }] } })).join("\n") + "\n";
      await writeFile(join(dir, "stats.records"), content);
      await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(tmp, `${index}.txt`), "x".repeat(index + 1))));
    }
    const [stats, tmp] = await Promise.all([collectAll(fixture.root), loadTmp(fixture.root)]);
    expect(stats.map(group => group.group)).toEqual(["g2", "g1", "g0"]);
    expect(stats.reduce((sum, group) => sum + group.asks, 0)).toBe(78);
    expect(tmp.reduce((sum, user) => sum + user.files, 0)).toBe(240);
    expect(tmp.reduce((sum, user) => sum + user.bytes, 0)).toBe(2520);
  } finally { await fixture.cleanup(); }
  // About 0.2–0.8 s normally, but it writes 252 files and opens the stats ledger; a stalled Windows CI runner
  // once took over 20 s here (the next small test took 8 s), so it gets more room than the default.
}, 60000);

test("每日提问按消息当天计数，9 次和 1 次不会被平均成 5 次", async () => {
  const fixture = await tempFixture("shared-daily-");
  try {
    const dir = join(fixture.root, "g1", "users", "13812345678");
    await mkdir(dir, { recursive: true });
    const message = (day: number, text: string) => JSON.stringify({
      type: "message", timestamp: new Date(2026, 8, day, 12).toISOString(),
      message: { role: "user", content: [{ type: "text", text }] },
    });
    const answer = (day: number, hour: number, input: number) => JSON.stringify({
      type: "message", timestamp: new Date(2026, 8, day, hour, 1).toISOString(),
      message: { role: "assistant", provider: "p", model: "m", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    await writeFile(join(dir, "stats.records"), [
      ...Array.from({ length: 9 }, () => message(11, "统计")),
      message(12, "资料"), message(12, "/help"), answer(12, 12, 300),
    ].join("\n") + "\n");
    const window = { since: parseDate("2026-09-10", false), until: parseDate("2026-09-12", true) };
    const daily = async () => trend(await collectAll(fixture.root, window), window)
      .map(row => [row.date, row.asks, row.askers.size, row.tokens.totalTokens]);
    // 成员和 token 也按天留档：统计页的环比要用前一天的值，只攒提问数的话算不出来。
    expect(await daily()).toEqual([["2026-09-10", 0, 0, 0], ["2026-09-11", 9, 1, 0], ["2026-09-12", 1, 1, 300]]);
    // token 计入入账当天，即使当天没有新提问。
    await writeFile(join(dir, "stats.records"), [message(11, "昨日的任务"), answer(12, 0, 50)].join("\n") + "\n");
    // 原地改写：夹具整份替换这位成员的行，旧的 9 次提问不会留在里面。
    expect(await daily()).toEqual([["2026-09-10", 0, 0, 0], ["2026-09-11", 1, 1, 0], ["2026-09-12", 0, 0, 50]]);
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
  const fixture = await tempFixture("shared-health-");
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
    body = { ...identity, status: "ready", verificationOnly: true };
    expect(await probeService(port, file)).toMatchObject({ state: "verifying", pid: 42 });
    body = { ...identity, status: "ready" };
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

test("同步范围是选定部门时，探针经控制接口读取部门路径，控制台按路径显示范围；整个通讯录时不读", async () => {
  const fixture = await tempFixture("shared-health-paths-");
  const token = "test-admin-token", instanceId = crypto.randomUUID(), startedAt = Date.now() - 60_000;
  const chosen = { kind: "departments", departments: ["100", "300"] }, whole = { kind: "all" };
  let directory: Record<string, unknown> = { mappings: 3, scope: chosen, state: "applying", effective: { scope: { kind: "departments", departments: ["100"] }, since: startedAt } };
  let asked = 0;
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt, health: () => ({ directory }),
    scopePaths: () => { asked++; return { "100": "集团/总部" }; } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const service = await probeService(server.port!, file);
    expect(service.scopePaths).toEqual({ "100": "集团/总部" });
    expect(serviceView(service).directory).toMatchObject({ scope: "2 个部门及其子部门：集团/总部；部门 300",
      stateText: "正在应用，完成前之前的范围（1 个部门及其子部门：集团/总部）仍然生效" });
    directory = { mappings: 3, scope: whole, state: "effective", effective: { scope: whole, since: startedAt } };
    const again = await probeService(server.port!, file);
    expect(again.scopePaths).toBeUndefined();
    expect(serviceView(again).directory?.scope).toBe("整个通讯录");
    expect(asked).toBe(1);
  } finally { await server.stop(true); await fixture.cleanup(); }
});


test("设置摘要读取模型选择、辅助模型和 MCP 文件；缺失表示未启用，MCP 摘要不含凭据字段", async () => {
  const fixture = await tempFixture("shared-settings-summary-");
  try {
    const project = fixture.root;
    expect(await settingsData.loadModelSummary(project)).toBeNull();
    expect(await settingsData.loadAuxiliarySummary(project)).toEqual({ enabled: false });
    expect(await settingsData.loadMcpSummary(project)).toBeNull();
    await mkdir(join(project, "data", "runtime", "pi"), { recursive: true });
    await mkdir(join(project, "data", "config"), { recursive: true });
    const settings = join(project, "data", "runtime", "pi", "settings.json");
    await Bun.write(settings, String.fromCharCode(0xfeff) + JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat" }));
    expect(await settingsData.loadModelSummary(project)).toEqual({ provider: "deepseek", model: "deepseek-chat", thinking: null });
    // Same order as the service: the selected model's own level, then the global default; other models' levels do not count.
    await Bun.write(settings, JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "high",
      modelThinkingLevels: { "deepseek/other": "minimal" } }));
    expect((await settingsData.loadModelSummary(project))?.thinking).toEqual({ level: "high", source: "default" });
    await Bun.write(settings, JSON.stringify({ defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "high",
      modelThinkingLevels: { "deepseek/deepseek-chat": "low" } }));
    expect((await settingsData.loadModelSummary(project))?.thinking).toEqual({ level: "low", source: "model" });
    await Bun.write(join(project, "data", "config", "auxiliary.json"), JSON.stringify({ format: 1, image: { provider: "openai", modelId: "gpt-image-1" } }));
    expect(await settingsData.loadAuxiliarySummary(project)).toEqual({ enabled: true, classifier: null, image: "openai/gpt-image-1", maxConcurrent: 2, classifierRetries: 1 });
    await Bun.write(join(project, "data", "config", "mcp.json"), JSON.stringify({ format: 1, servers: [{
      name: "documents", transport: "http", url: "https://mcp.example/mcp", tools: ["search"], headersEnv: { Authorization: "DOCS_SECRET_HEADER" },
    }] }));
    const servers = await settingsData.loadMcpSummary(project);
    expect(servers).toEqual([{ name: "documents", transport: "http", tools: 1, oauth: false }]);
    expect(JSON.stringify(servers)).not.toContain("DOCS_SECRET_HEADER");
    await Bun.write(join(project, "data", "config", "auxiliary.json"), JSON.stringify({ format: 2 }));
    await expect(settingsData.loadAuxiliarySummary(project)).rejects.toThrow("格式无效");
  } finally { await fixture.cleanup(); }
});

test("外链摘要直接读取配置文件：未配置、有效、无效均不带出凭据或文件原文", async () => {
  const fixture = await tempFixture("shared-relay-summary-");
  const path = join(fixture.root, "data", "config", "relay.json");
  try {
    expect(await settingsData.loadRelaySummary(fixture.root)).toEqual({ enabled: false });
    await mkdir(join(fixture.root, "data", "config"), { recursive: true });
    await writeFile(path, JSON.stringify({ provider: "s3", endpoint: "https://cos.ap-chengdu.myqcloud.com", region: "ap-chengdu",
      bucket: "bot-1250000000", accessKeyId: "fixture-private-ak", secretAccessKey: "fixture-private-sk", sessionToken: "fixture-private-token" }));
    const summary = await settingsData.loadRelaySummary(fixture.root);
    expect(summary).toEqual({ enabled: true, endpoint: "https://cos.ap-chengdu.myqcloud.com", region: "ap-chengdu", bucket: "bot-1250000000",
      prefix: "", pathStyle: false, maxBytes: 2 * 1024 ** 3, expireHours: 2, cleanupGraceMinutes: 30, sessionToken: true });
    expect(JSON.stringify(summary)).not.toContain("fixture-private");
    await writeFile(path, '{"secretAccessKey": fixture-private-sk');
    const invalid = await settingsData.loadRelaySummary(fixture.root).then(() => "", (error: Error) => error.message);
    expect(invalid).toBe("relay.json 不是有效 JSON，请重新运行外链配置");
    await writeFile(path, JSON.stringify({ provider: "s3", endpoint: "https://bot-1250000000.cos.ap-chengdu.myqcloud.com", region: "ap-chengdu",
      bucket: "bot-1250000000", accessKeyId: "fixture-private-ak", secretAccessKey: "fixture-private-sk" }));
    const rejected = await settingsData.loadRelaySummary(fixture.root).then(() => "", (error: Error) => error.message);
    expect(rejected).toContain("endpoint 已包含桶名");
    expect(rejected).not.toContain("fixture-private");
  } finally { await fixture.cleanup(); }
});
