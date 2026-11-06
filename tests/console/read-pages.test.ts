import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../../console/server/audit.ts";
import { readPage } from "../../console/server/read-pages.ts";
import { readRoutes } from "../../console/server/read-routes.ts";
import { tempFixture } from "../helpers/temp.ts";
import type { ReadPage } from "../../console/ui/src/contract.ts";

test("只读页：无数据/无配置，日志筛选脱敏，设置错误不泄漏配置片段", async () => {
  const fixture = await tempFixture("console-read-pages-");
  try {
    mkdirSync(join(fixture.root, "logs"));
    mkdirSync(join(fixture.root, "data/config"), { recursive: true });
    writeFileSync(join(fixture.root, "logs/mixin-bot.log"), "2026 - INFO - job-123 13800138000 token=very-secret\n2026 - ERROR - job-456 failed\n");
    expect((await readPage(fixture.root, "logs", { task: "job-123", level: "info" })).rows).toEqual([["info", "2026 - INFO - job-123 138****8000 token=***"]]);
    expect((await readPage(fixture.root, "logs", { keyword: "nothing" })).rows).toEqual([]);
    expect((await readPage(fixture.root, "storage")).rows).toEqual([]);
    expect((await readPage(fixture.root, "relay")).rows).toEqual([]);
    writeFileSync(join(fixture.root, "data/config/app-bot.json"), '{"appSecret":"do-not-print",bad');
    const settings = await readPage(fixture.root, "settings");
    expect(JSON.stringify(settings)).not.toContain("do-not-print");
    expect(settings.rows.find(row => row[0] === "应用机器人")?.[1]).toContain("无法读取");
  } finally { await fixture.cleanup(); }
});

test("设置页按字段写中文名和可读值，不出现 JSON、摘要或环境变量名", async () => {
  const fixture = await tempFixture("console-read-settings-");
  try {
    mkdirSync(join(fixture.root, "data/config"), { recursive: true }); mkdirSync(join(fixture.root, "data/runtime/pi"), { recursive: true });
    writeFileSync(join(fixture.root, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "m1", defaultThinkingLevel: "high" }));
    writeFileSync(join(fixture.root, "data/config/runtime.json"), JSON.stringify({ BOT_PORT: "12011", BOT_HOST: "127.0.0.1", BOT_RUN_TIMEOUT_SECONDS: "1500", PI_CACHE_RETENTION: "long" }));
    const rows = Object.fromEntries((await readPage(fixture.root, "settings")).rows);
    expect(rows).toMatchObject({ "模型": "fixture/m1", "模型 · 推理级别": "high（全局默认）", "辅助模型": "未启用", "应用机器人": "未配置", "外链": "未启用",
      "运行参数 · 本机端口": "12011", "运行参数 · 监听地址": "127.0.0.1", "运行参数 · 整轮处理时限": "1500 秒", "运行参数 · 模型缓存保留": "长期" });
    expect([...Object.keys(rows), ...Object.values(rows)].join("\n")).not.toMatch(/[{}]|hash|values|BOT_|PI_CACHE/);
    writeFileSync(join(fixture.root, "data/config/runtime.json"), "{}");
    expect(Object.fromEntries((await readPage(fixture.root, "settings")).rows)["运行参数"]).toBe("全部使用默认值");
  } finally { await fixture.cleanup(); }
});

test("只读路由：拒绝任意参数，超时/断线传给受监督查询，日志查看及导出记审计", async () => {
  const fixture = await tempFixture("console-read-routes-");
  try {
    const controller = new AbortController();
    let timeout = false, code = 0;
    const audit = new AuditLog(join(fixture.root, "audit"));
    const routes = readRoutes(fixture.root, audit, async (_command, args, options) => {
      expect(options?.signal).toBe(controller.signal);
      expect(args).toContain(fixture.root);
      return { code, timedOut: timeout, stdout: JSON.stringify({ rows: [], columns: [], note: "", checkedAt: 1 }), stderr: "" };
    });
    const context = { session: { label: "fixture", createdAt: 1, idleExpiresAt: 2, expiresAt: 3 }, body: {}, signal: controller.signal };
    await routes["POST /api/read/logs"]!.run(context);
    await routes["POST /api/read/logs"]!.run({ ...context, body: { export: true, task: "fixture-task" } });
    const records = readdirSync(audit.dir).map(name => readFileSync(join(audit.dir, name), "utf8")).join("");
    expect(records).toContain('"action":"log-view"'); expect(records).toContain('"action":"log-export"');
    expect(records).not.toContain("fixture-task");
    await expect(routes["POST /api/read/logs"]!.run({ ...context, body: { path: "outside" } })).rejects.toThrow("参数");
    timeout = true;
    await expect(routes["POST /api/read/logs"]!.run(context)).rejects.toThrow("超时");
    timeout = false; code = 1;
    await expect(routes["POST /api/read/logs"]!.run(context)).rejects.toThrow("读取失败");
  } finally { await fixture.cleanup(); }
});

test("体检故障退出仍显示完整诊断和脱敏修复建议，运行失败或不完整协议不能伪装为报告", async () => {
  const fixture = await tempFixture("console-health-report-");
  try {
    const context = { session: { label: "fixture", createdAt: 1, idleExpiresAt: 2, expiresAt: 3 }, body: {}, signal: new AbortController().signal };
    const report = { pass: 1, warn: 1, fail: 1, checks: [
      { name: "运行环境", status: "pass", detail: "可用", fix: "" },
      { name: "通讯录", status: "warn", detail: "13800138000 待同步", fix: "在「通讯录」查看；token=secret" },
      { name: "机器人", status: "fail", detail: "未就绪", fix: "在「维护 → 修复部署」处理" },
    ] };
    let code = 1, value: unknown = report, timedOut = false;
    const routes = readRoutes(fixture.root, new AuditLog(join(fixture.root, "audit")), async () => ({ code, timedOut, stdout: JSON.stringify(value), stderr: "private diagnostics" }));
    const route = routes["POST /api/read/health"]!;
    const response = await route.run(context) as ReadPage;
    expect(response.columns).toEqual(["检查", "结果", "说明", "处理建议"]);
    expect(response.rows).toEqual([
      ["运行环境", "通过", "可用", ""],
      ["通讯录", "警告", "138****8000 待同步", "在「通讯录」查看；token=***"],
      ["机器人", "失败", "未就绪", "在「维护 → 修复部署」处理"],
    ]);
    expect(response.note).toContain("1 项通过，1 项警告，1 项失败");
    expect(JSON.stringify(response)).not.toContain("private diagnostics");
    code = 2;
    await expect(route.run(context)).rejects.toThrow("读取失败");
    code = 0;
    await expect(route.run(context)).rejects.toThrow("体检结果不完整");
    value = { ...report, fail: 0, checks: report.checks.slice(0, 2) };
    expect((await route.run(context) as ReadPage).rows).toHaveLength(2);
    code = 1;
    await expect(route.run(context)).rejects.toThrow("体检结果不完整");
    for (const malformed of [null, {}, { ...report, fail: 2 }, { ...report, checks: [null] }, { ...report, checks: [{ name: "x", status: "pass", detail: 2, fix: "" }] }]) {
      value = malformed;
      await expect(route.run(context)).rejects.toThrow("体检结果不完整");
    }
    value = report; timedOut = true;
    await expect(route.run(context)).rejects.toThrow("超时");
  } finally { await fixture.cleanup(); }
});
