// 这些数字会被抄进汇报材料，所以口径必须钉死：指令不算提问、干预算提问、区间按自然日
// 闭区间、半行 JSON 不能让整份统计失败。测试用真实的 session.jsonl 记录形状。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAll, collectGroup } from "../../scripts/ops/stats-admin.ts";

function userMsg(at: string, text: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: at,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistantMsg(at: string, tools: string[]): string {
  return JSON.stringify({
    type: "message",
    timestamp: at,
    message: {
      role: "assistant",
      content: tools.map((name) => ({ type: "toolCall", id: "x", name, arguments: {} })),
      usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 },
    },
  });
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-stats-"));
  const write = async (group: string, user: string, lines: string[]) => {
    await mkdir(join(root, group, "users", user), { recursive: true });
    await writeFile(join(root, group, "users", user, "session.jsonl"), lines.join("\n") + "\n");
  };

  await write("group-a", "13800000000", [
    JSON.stringify({ type: "session", version: 3, timestamp: "2026-08-10T01:00:00.000Z" }),
    JSON.stringify({ type: "model_change", timestamp: "2026-08-10T01:00:00.100Z" }),
    userMsg("2026-08-10T01:00:01.000Z", "发一份安全大脑的介绍材料"),
    assistantMsg("2026-08-10T01:00:05.000Z", ["bash", "send_file"]),
    // 干活途中的插话：对提问的人来说这就是又问了一次。
    userMsg("2026-08-10T01:00:09.000Z", "顺便把报价也发一下"),
    assistantMsg("2026-08-10T01:00:12.000Z", ["send_file"]),
    // 指令不进模型，早期版本残留在历史里的也要排除。
    userMsg("2026-08-10T01:00:20.000Z", "/stop"),
    userMsg("2026-08-10T01:00:25.000Z", "@机器人ﾠ/clear"),
    // 跨月，用来验证按月分组。
    userMsg("2026-09-02T02:00:00.000Z", "这个月的价格有变化吗"),
    assistantMsg("2026-09-02T02:00:04.000Z", ["bash", "read"]),
  ]);

  await write("group-a", "13900000000", [
    userMsg("2026-08-11T03:00:00.000Z", "量子网关有哪些型号"),
    assistantMsg("2026-08-11T03:00:03.000Z", ["bash"]),
  ]);

  // 只说过一句话就再没来过的成员，仍然算「使用过」。
  await write("group-b", "13700000000", [userMsg("2026-08-12T05:00:00.000Z", "在吗")]);

  return root;
}

describe("usage stats", () => {
  test("counts a message as one ask and leaves slash commands out", async () => {
    const root = await makeRoot();
    try {
      const stats = await collectGroup("group-a", root);
      // 4 条普通消息（含一条干预），/stop 与 @机器人 /clear 都不计入。
      expect(stats.asks).toBe(4);
      expect(stats.users).toHaveLength(2);
      expect(stats.users[0]!.user).toBe("13800000000");
      expect(stats.users[0]!.asks).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports what the group actually got out of it", async () => {
    const root = await makeRoot();
    try {
      const stats = await collectGroup("group-a", root);
      expect(stats.tools.get("send_file")).toBe(2);
      expect(stats.tools.get("bash")).toBe(3);
      expect(stats.users[0]!.files).toBe(2);
      expect(stats.replies).toBe(4);
      expect(stats.tokens.input).toBe(400);
      expect(stats.tokens.cacheRead).toBe(3600);
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

  test("groups by calendar month and counts distinct people per month", async () => {
    const root = await makeRoot();
    try {
      const stats = await collectGroup("group-a", root);
      expect(stats.months.get("2026-08")?.asks).toBe(3);
      expect(stats.months.get("2026-08")?.users.size).toBe(2);
      expect(stats.months.get("2026-09")?.asks).toBe(1);
      expect(stats.days.size).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 机器人边跑边追写，最后一行可能只写了一半。少一条记录可以接受，整份统计失败不行。
  test("survives a half-written trailing line", async () => {
    const root = await makeRoot();
    try {
      const path = join(root, "group-b", "users", "13700000000", "session.jsonl");
      await writeFile(path, (await Bun.file(path).text()) + '{"type":"message","times');
      const stats = await collectGroup("group-b", root);
      expect(stats.asks).toBe(1);
      expect(stats.skipped).toBe(1);
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
