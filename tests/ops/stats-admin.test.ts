import { writeTestData as writeFile } from "../helpers/stats-fixture.ts";
import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
// 这些数字会被抄进汇报材料，所以口径必须钉死：指令不算提问、干预算提问、区间按自然日
// 闭区间、token 按模型与工具分开、不出现金额。测试用记录形状的夹具入账（tests/helpers/stats-fixture.ts）。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAll, collectGroup } from "../../scripts/ops/stats-admin.ts";
import { cacheReadRate, formatCacheRate } from "../../scripts/lib/usage.ts";
import { emptyTokens } from "../../src/agent/stats-ledger.ts";
import { tempFixture } from "../helpers/temp.ts";

/** 统计只读账本，所以每个用例都要先把写好的记录入账。 */

test("账本按固定顺序折算：成员入账次序不影响模型、工具与每日统计", async () => {
  const fixture = await tempFixture("stats-fold-order-");
  try {
    const users = ["a", "b", "c"];
    const build = async (label: string, order: string[]) => {
      const root = join(fixture.root, label);
      for (const user of order) {
        const index = users.indexOf(user);
        await mkdir(join(root, "group", "users", user), { recursive: true });
        await writeFile(join(root, "group", "users", user, "stats.records"), [
          { type: "message", timestamp: `2026-09-0${index + 1}T12:00:00Z`, message: { role: "user", content: [{ type: "text", text: "问" }] } },
          { type: "message", timestamp: `2026-09-0${index + 1}T12:00:01Z`,
            message: { role: "assistant", provider: "fixture", model: user, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
          { type: "message", timestamp: `2026-09-0${index + 1}T12:00:02Z`, message: { role: "toolResult", toolName: user, usage: { input: 2, output: 0 } } },
        ].map(value => JSON.stringify(value)).join("\n") + "\n");
      }
      return root;
    };
    const forward = await collectGroup("group", await build("forward", users));
    const reverse = await collectGroup("group", await build("reverse", [...users].reverse()));
    const serialize = (value: unknown) => JSON.stringify(value, (_key, part) =>
      part instanceof Map ? [...part] : part instanceof Set ? [...part] : part);
    expect([...reverse.tools.keys()]).toEqual(users);
    expect([...reverse.models.keys()]).toEqual(users.map(user => `fixture/${user}`));
    expect(serialize(reverse)).toBe(serialize(forward));
  } finally { await fixture.cleanup(); }
});

function userMsg(at: string, text: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: at,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistantMsg(at: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: at,
    message: { role: "assistant", provider: "zai", model: "plan", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 } },
  });
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-stats-"));
  const write = async (group: string, user: string, lines: string[]) => {
    await mkdir(join(root, group, "users", user), { recursive: true });
    await writeFile(join(root, group, "users", user, "stats.records"), lines.join("\n") + "\n");
  };

  await write("group-a", "13800000000", [
    userMsg("2026-08-10T01:00:01.000Z", "发一份安全大脑的介绍材料"),
    assistantMsg("2026-08-10T01:00:05.000Z"),
    // 干活途中的插话：对提问的人来说这就是又问了一次。
    userMsg("2026-08-10T01:00:09.000Z", "顺便把报价也发一下"),
    assistantMsg("2026-08-10T01:00:12.000Z"),
    // 指令不进模型，也不算提问。
    userMsg("2026-08-10T01:00:20.000Z", "/stop"),
    // 跨月，用来验证按月分组。
    userMsg("2026-09-02T02:00:00.000Z", "这个月的价格有变化吗"),
    assistantMsg("2026-09-02T02:00:04.000Z"),
    JSON.stringify({ type: "message", timestamp: "2026-09-02T02:00:05.000Z",
      message: { role: "toolResult", toolName: "image", usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 } } }),
  ]);

  await write("group-a", "13900000000", [
    userMsg("2026-08-11T03:00:00.000Z", "量子网关有哪些型号"),
    assistantMsg("2026-08-11T03:00:03.000Z"),
  ]);

  // 只说过一句话就再没来过的成员，仍然算「使用过」。
  await write("group-b", "13700000000", [userMsg("2026-08-12T05:00:00.000Z", "在吗")]);

  return root;
}

describe("usage stats", () => {
  test("the real CLI displays a group whose only usage is history compaction, in tokens and without any amount", async () => {
    const fixture = await tempFixture("stats-compaction-cli-");
    const user = join(fixture.root, "data/g/users/u"); await mkdir(user, { recursive: true });
    await writeFile(join(user, "stats.records"), JSON.stringify({ type: "compaction", timestamp: "2026-09-11T12:01:00Z",
      usage: { input: 321, output: 20, cacheRead: 0, cacheWrite: 9, cost: { total: 0.5 } } }) + "\n");
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../scripts/ops/stats-admin.ts", import.meta.url)), "g", "--group-id"],
      { cwd: fixture.root, env: process.env, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(0); expect(out).not.toContain("没有使用记录");
      expect(out).toContain("unknown/unknown"); expect(out).toContain("321"); expect(out).toContain("合计 350");
      // 只有 token：旧记录里的金额不显示，也没有任何货币数字（说明文字只写明「不含费用」）。
      expect(out).not.toContain("0.5"); expect(out).not.toMatch(/金额|\$|¥|USD/);
    } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
  }, 20000);

  test("counts model, compaction and branch usage per model, tool usage per tool, and the cache read rate", async () => {
    const fixture = await tempFixture("usage-breakdown-");
    const user = join(fixture.root, "g", "users", "u");
    await mkdir(user, { recursive: true });
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite, cost: { total: 1 } });
    await writeFile(join(user, "stats.records"), [
      { type: "model_change", provider: "zai", modelId: "plan", timestamp: "2026-09-10T12:00:00Z" },
      { type: "message", timestamp: "2026-09-11T12:00:00Z", message: { role: "assistant", provider: "zai", model: "plan", usage: usage(100, 10, 900, 500) } },
      { type: "compaction", timestamp: "2026-09-11T12:01:00Z", usage: usage(200, 20, 0, 0) },
      { type: "model_change", provider: "next", modelId: "model", timestamp: "2026-09-12T12:00:00Z" },
      { type: "branch_summary", timestamp: "2026-09-12T12:01:00Z", usage: usage(50, 5, 100, 10) },
      { type: "message", timestamp: "2026-09-12T12:02:00Z", message: { role: "toolResult", toolName: "classify", usage: usage(7, 1, 0, 0) } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    try {
      const result = await collectGroup("g", fixture.root);
      expect(result.tokens).toEqual({ input: 357, output: 36, cacheRead: 1000, cacheWrite: 510, totalTokens: 1903 });
      expect(cacheReadRate(result.tokens)).toBeCloseTo(1000 / 1867, 10);
      expect([...result.models]).toEqual([
        ["zai/plan", { input: 300, output: 30, cacheRead: 900, cacheWrite: 500, totalTokens: 1730 }],
        ["next/model", { input: 50, output: 5, cacheRead: 100, cacheWrite: 10, totalTokens: 165 }],
      ]);
      expect([...result.tools]).toEqual([["classify", { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8 }]]);
      expect(result.tokenDays.get("2026-09-12")?.totalTokens).toBe(173);
      expect(result.users).toEqual([]);
      // 账本是日粒度的：比一天更细的区间会被扩到整天，那天的两条用量都算进来。
      const oneDay = await collectAll(fixture.root, { since: Date.parse("2026-09-11T12:00:30Z"), until: Date.parse("2026-09-11T12:01:30Z") });
      expect(oneDay).toHaveLength(1);
      expect(oneDay[0]!.tokens.input).toBe(300);
      expect([...oneDay[0]!.models.keys()]).toEqual(["zai/plan"]);
      expect(formatCacheRate(emptyTokens())).toBe("无样本");
    } finally { await fixture.cleanup(); }
  });

  test("counts a message as one ask and leaves slash commands out", async () => {
    const root = await makeRoot();
    try {
      const stats = await collectGroup("group-a", root);
      // 4 条普通消息（含一条干预），/stop 不计入。
      expect(stats.asks).toBe(4);
      expect(stats.users).toHaveLength(2);
      expect(stats.users[0]!.user).toBe("13800000000");
      expect(stats.users[0]!.asks).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports the tokens the group used, per model and per tool", async () => {
    const root = await makeRoot();
    try {
      const stats = await collectGroup("group-a", root);
      expect(stats.tokens.input).toBe(430);
      expect(stats.tokens.cacheRead).toBe(3600);
      expect(stats.models.get("zai/plan")?.totalTokens).toBe(4080);
      expect(stats.tools.get("image")?.totalTokens).toBe(35);
      expect(stats.tokens.totalTokens).toBe(4115);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 汇报材料按自然月写，边界少算一天就会对不上账。
  test("treats --since/--until as an inclusive day range", async () => {
    const root = await makeRoot();
    try {
      const september = await collectGroup("group-a", root, {
        since: new Date(2026, 8, 1).getTime(),
      });
      expect(september.asks).toBe(1);
      expect(september.users).toHaveLength(1);
      expect(september.tokens.totalTokens).toBe(1055);

      // 8-10 当天的提问必须落在 --until 2026-08-10 之内。
      const throughTenth = await collectGroup("group-a", root, {
        until: new Date(2026, 7, 10, 23, 59, 59, 999).getTime(),
      });
      expect(throughTenth.asks).toBe(2);
      expect([...throughTenth.months.keys()]).toEqual(["2026-08"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("groups by calendar month and counts distinct people per month and day", async () => {
    const root = await makeRoot();
    try {
      const stats = await collectGroup("group-a", root);
      expect(stats.months.get("2026-08")?.asks).toBe(3);
      expect(stats.months.get("2026-08")?.users.size).toBe(2);
      expect(stats.months.get("2026-09")?.asks).toBe(1);
      expect(stats.days.size).toBe(3);
      expect(stats.daily.get("2026-08-10")).toEqual({ asks: 2, askers: new Set(["13800000000"]) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ranks groups by usage and skips groups nobody has used", async () => {
    const root = await makeRoot();
    try {
      await mkdir(join(root, "group-empty", "users"), { recursive: true });
      const groups = await collectAll(root);
      expect(groups.map((group) => group.group)).toEqual(["group-a", "group-b"]);
      expect(groups[0]!.asks).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
