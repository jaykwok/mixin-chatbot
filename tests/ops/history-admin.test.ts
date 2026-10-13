import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
// 这条命令删的是长期资产，所以测试的重点不是「删掉了」，而是「只删掉了该删的」：
// workspace、用户 tmp、资料索引和 venv 就在 session.jsonl 的隔壁，一个写歪的路径代价太大。
import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSession } from "@earendil-works/pi-durable";
import { clearAllGroups, clearGroup, collect } from "../../scripts/ops/history-admin.ts";
import { lastActivity } from "../../scripts/lib/history-scan.ts";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { groupSegment } from "../../src/agent/paths.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { ControlsDoc } from "../../src/durable/inbox.ts";
import { DurableService, type Outbound } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, openGroupHarness, TEST_PROGRESS } from "../helpers/durable.ts";

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-history-"));
  for (const [group, users] of [
    ["group-a", ["13800000000", "13900000000"]],
    ["group-b", ["13700000000"]],
  ] as const) {
    await mkdir(join(root, group, "workspace", "产品资料"), { recursive: true });
    await mkdir(join(root, group, "index"), { recursive: true });
    await mkdir(join(root, group, "venv"), { recursive: true });
    await writeFile(join(root, group, "workspace", "产品资料", "手册.pptx"), "材料");
    await writeFile(join(root, group, "index", "materials.md"), "产品资料/手册.pptx");
    await writeFile(join(root, group, "venv", ".mixin-doc-toolchain"), "pypdf");
    for (const user of users) {
      await mkdir(join(root, group, "users", user, "tmp"), { recursive: true });
      await writeFile(join(root, group, "users", user, "session.jsonl"), `{"u":"${user}"}\n`);
      await writeFile(join(root, group, "users", user, "tmp", "draft.txt"), "草稿");
    }
  }
  return root;
}

describe("history admin", () => {
  test("rejects ambiguous IDs and clears the explicitly selected storage segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-ambiguous-"));
    const first = groupSegment("审计群A");
    const second = groupSegment(first);
    for (const group of [first, second]) {
      await mkdir(join(root, group, "users/u"), { recursive: true });
      await writeFile(join(root, group, "users/u/session.jsonl"), "keep\n");
    }
    try {
      await expect(clearGroup(first, root)).rejects.toThrow("歧义");
      expect(await collect(root)).toHaveLength(2);
      expect(await clearGroup(first, root, "segment")).toBe(0);
      expect((await collect(root)).map(group => group.group)).toEqual([second]);
      expect(await clearGroup(first, root, "id")).toBe(0);
      expect(await collect(root)).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test.each(["root", "group", "users", "user"])("does not traverse a linked %s directory", async (part) => {
    const root = await mkdtemp(join(tmpdir(), "history-links-"));
    const scanned = join(root, "groups");
    const outside = join(root, "outside");
    const path = { root: scanned, group: join(scanned, "g"), users: join(scanned, "g/users"), user: join(scanned, "g/users/u") }[part]!;
    const tail = { root: "g/users/u", group: "users/u", users: "u", user: "." }[part]!;
    await mkdir(join(outside, tail), { recursive: true });
    await writeFile(join(outside, tail, "session.jsonl"), "keep");
    await mkdir(join(path, ".."), { recursive: true });
    await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(await collect(scanned)).toEqual([]);
      await clearGroup("g", scanned);
      expect(await readFile(join(outside, tail, "session.jsonl"), "utf8")).toBe("keep");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("lists every group that has history", async () => {
    const root = await makeRoot();
    try {
      const groups = await collect(root);
      expect(groups.map((g) => g.group).sort()).toEqual(["group-a", "group-b"]);
      expect(groups.find((g) => g.group === "group-a")!.users).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clears every member of one group and leaves everything else alone", async () => {
    const root = await makeRoot();
    try {
      const code = await clearGroup("group-a", root);
      expect(code).toBe(0);

      // 目标群的历史全部消失。
      const remaining = await collect(root);
      expect(remaining.map((g) => g.group)).toEqual(["group-b"]);

      // 隔壁的长期资产一个都不能少。
      for (const user of ["13800000000", "13900000000"]) {
        expect(
          await readFile(join(root, "group-a", "users", user, "tmp", "draft.txt"), "utf8")
        ).toBe("草稿");
      }
      expect(
        await readFile(join(root, "group-a", "workspace", "产品资料", "手册.pptx"), "utf8")
      ).toBe("材料");
      expect(await readFile(join(root, "group-a", "index", "materials.md"), "utf8")).toContain(
        "手册.pptx"
      );
      expect(
        await readFile(join(root, "group-a", "venv", ".mixin-doc-toolchain"), "utf8")
      ).toBe("pypdf");

      // 另一个群完全没被碰过。
      expect(
        await readFile(join(root, "group-b", "users", "13700000000", "session.jsonl"), "utf8")
      ).toContain("13700000000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses an unknown group instead of doing nothing quietly", async () => {
    const root = await makeRoot();
    try {
      expect(await clearGroup("group-zzz", root)).toBe(1);
      expect(await collect(root)).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cannot be walked out of the group data root", async () => {
    const root = await makeRoot();
    const outside = join(root, "..", "escape-target");
    await mkdir(join(outside, "users", "13800000000"), { recursive: true });
    await writeFile(join(outside, "users", "13800000000", "session.jsonl"), "outside");

    try {
      // 群号里的 .. 会先被 groupSegment 换成 sha256（目录不存在），再走目录名兜底，
      // 而兜底必须重新校验边界，否则这一条就能清掉群数据根之外的文件。
      expect(await clearGroup("../escape-target", root)).toBe(1);
      expect(
        await readFile(join(outside, "users", "13800000000", "session.jsonl"), "utf8")
      ).toBe("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a group database: list shows it, clear queues a /clear per member for the next start and archives the old files", async () => {
    const root = await makeRoot();
    const { models, model } = fauxModels();
    const database = join(root, "group-a", "durable.sqlite");
    const group = await openGroupHarness(database, models, { group: "group-a", door: false });
    try {
      for (const phone of ["13800000000", "13900000000"]) await memberConversation(group.harness, "group-a", phone, { model }, context);
    } finally { await group.close(); }
    try {
      const listed = (await collect(root)).find((entry) => entry.group === "group-a")!;
      expect(listed.database!.bytes).toBeGreaterThan(0);
      expect(listed.bytes).toBe(listed.database!.bytes + listed.users.reduce((total, user) => total + user.bytes, 0));
      expect(lastActivity(listed)).toBeGreaterThanOrEqual(listed.database!.modified);
      expect(await clearGroup("group-a", root)).toBe(0);
      // The database stays (the old context is kept there); the old session files are archived.
      const after = (await collect(root)).find((entry) => entry.group === "group-a")!;
      expect(after.users).toEqual([]);
      expect(after.database).toBeDefined();
      const session = createSession(await openGroupStorage(database));
      try {
        const pending = (await session.snapshot(ControlsDoc, context))!.pending;
        expect(pending.map((control) => [control.phone, control.command])).toEqual([["13800000000", "/clear"], ["13900000000", "/clear"]]);
      } finally { await session.close(context); }
      // The other group is untouched.
      expect(await readFile(join(root, "group-b", "users", "13700000000", "session.jsonl"), "utf8")).toContain("13700000000");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a group database that records another group", async () => {
    const root = await makeRoot();
    const { models } = fauxModels();
    const group = await openGroupHarness(join(root, "group-b", "durable.sqlite"), models, { group: "group-a", door: false });
    await group.close();
    try {
      expect(await clearGroup("group-b", root)).toBe(1);
      // Nothing changed: the old session file stays too.
      expect(await readFile(join(root, "group-b", "users", "13700000000", "session.jsonl"), "utf8")).toContain("13700000000");
      const session = createSession(await openGroupStorage(join(root, "group-b", "durable.sqlite")));
      try {
        expect((await session.snapshot(ControlsDoc, context))?.pending ?? []).toEqual([]);
      } finally { await session.close(context); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a group that exists but has no history", async () => {
    const root = await makeRoot();
    await rm(join(root, "group-b", "users", "13700000000", "session.jsonl"));
    try {
      expect(await clearGroup("group-b", root)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clear --all clears every group; a refused group is reported and the others are still cleared", async () => {
    const root = await makeRoot();
    const { models, model } = fauxModels();
    const group = await openGroupHarness(join(root, "group-a", "durable.sqlite"), models, { group: "group-a", door: false });
    try {
      for (const phone of ["13800000000", "13900000000"]) await memberConversation(group.harness, "group-a", phone, { model }, context);
    } finally { await group.close(); }
    // group-c's database records another group: it is refused and left exactly as it was. Its large old session file
    // makes it the largest group, so it is processed first and the others must still be cleared after it.
    const kept = "keep\n".repeat(200_000);
    await mkdir(join(root, "group-c", "users", "13600000000"), { recursive: true });
    await writeFile(join(root, "group-c", "users", "13600000000", "session.jsonl"), kept);
    await (await openGroupHarness(join(root, "group-c", "durable.sqlite"), models, { group: "group-a", door: false })).close();
    const pending = async (name: string) => {
      const session = createSession(await openGroupStorage(join(root, name, "durable.sqlite")));
      try { return ((await session.snapshot(ControlsDoc, context))?.pending ?? []).map((control) => [control.phone, control.command]); }
      finally { await session.close(context); }
    };
    const run = async () => {
      const output: string[] = [];
      const capture = (...args: unknown[]) => { output.push(args.join(" ")); };
      const log = spyOn(console, "log").mockImplementation(capture), error = spyOn(console, "error").mockImplementation(capture);
      try { return { code: await clearAllGroups(root), text: output.join("\n") }; }
      finally { log.mockRestore(); error.mockRestore(); }
    };
    try {
      const first = await run();
      expect(first.code).toBe(1);
      expect(first.text).toContain("即将清空 3 个群");
      expect(first.text).toContain("2/3 个群已清空；未完成：group-c");
      // The notes every group shares are printed once.
      expect(first.text.split("每位成员的下一条消息").length - 1).toBe(1);
      expect(first.text.split("旧上下文留在群库里").length - 1).toBe(1);
      const after = await collect(root);
      expect(after.map((entry) => entry.group).sort()).toEqual(["group-a", "group-c"]);
      expect(after.find((entry) => entry.group === "group-a")!.users).toEqual([]);
      expect(await pending("group-a")).toEqual([["13800000000", "/clear"], ["13900000000", "/clear"]]);
      expect(await pending("group-c")).toEqual([]);
      expect((await collect(root)).map((entry) => entry.group)[0]).toBe("group-c");
      expect(await readFile(join(root, "group-c", "users", "13600000000", "session.jsonl"), "utf8")).toBe(kept);
      for (const name of ["group-a", "group-b"]) {
        expect(await readFile(join(root, name, "workspace", "产品资料", "手册.pptx"), "utf8")).toBe("材料");
        expect(await readFile(join(root, name, "users", name === "group-a" ? "13800000000" : "13700000000", "tmp", "draft.txt"), "utf8")).toBe("草稿");
      }
      // Running it again queues nothing twice.
      expect((await run()).code).toBe(1);
      expect(await pending("group-a")).toEqual([["13800000000", "/clear"], ["13900000000", "/clear"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["clear --all", "clear <群号>"])("%s keeps the statistics: counted usage stays, uncounted old files are counted first, new turns add on", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "history-stats-"));
    const { faux, models, model } = fauxModels();
    const stateDb = new Database(":memory:"), deliveries = new DeliveryStore(stateDb);
    let replies = 0;
    const outbound: Outbound = {
      sendText: async () => true, sendReply: async () => { replies++; return true; },
      rate: () => ({ used: 0, limit: 20 }), refresh: async (item) => item.text,
    };
    const open = () => new DurableService({
      root, modules: [], relay: null, materials: false, outbound, deliveries, stateDb,
      selection: {
        runtime: models as never, settings: undefined as never, ref: model, thinkingLevel: "off", notices: [],
        model: { ...models.getModel(model.provider, model.modelId)!, contextWindow: 128000 } as never,
        harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
      },
      limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
    });
    const until = async (probe: () => boolean, label: string) => {
      for (const deadline = Date.now() + 15_000; !probe();) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await Bun.sleep(10);
      }
    };
    // Every row of the ledger the stat command and the TUI read; first/last times included.
    const ledger = (group?: string) => {
      const db = openStatsLedger(root);
      try { const { activity, tools, usage } = readLedger(db, {}, group); return { activity, tools, usage }; } finally { db.close(); }
    };
    const url = "https://example.invalid/callback?key=synthetic";
    try {
      faux.setResponses([fauxAssistantMessage("Alice 的回答"), fauxAssistantMessage("Bob 的回答")]);
      let service = open();
      try {
        await service.admit("13800000001", "group-a", "Alice 提问", url);
        await until(() => replies === 1, "Alice's reply");
        await service.admit("13800000002", "group-a", "Bob 提问", url);
        await until(() => replies === 2, "Bob's reply");
      } finally { await service.close(); }
      // group-b only has an old session file the daily scan has not counted yet.
      await mkdir(join(root, "group-b", "users", "13700000000"), { recursive: true });
      await writeFile(join(root, "group-b", "users", "13700000000", "session.jsonl"), [
        { type: "session", version: 3, id: "legacy-1" },
        { type: "message", timestamp: "2026-09-18T01:00:00Z", message: { role: "user", content: [{ type: "text", text: "在吗" }] } },
        { type: "message", timestamp: "2026-09-18T01:00:05Z", message: { role: "assistant", provider: "zai", model: "plan",
          content: [{ type: "text", text: "在" }], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n");
      const before = ledger("group-a");
      expect(before.activity.reduce((sum, row) => sum + row.asks, 0)).toBe(2);
      expect(before.usage.reduce((sum, row) => sum + row.requests, 0)).toBe(2);
      expect(ledger("group-b").activity).toEqual([]);

      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        if (mode === "clear --all") expect(await clearAllGroups(root)).toBe(0);
        else for (const group of ["group-a", "group-b"]) expect(await clearGroup(group, root)).toBe(0);
      } finally { log.mockRestore(); }
      // The queued clears have not run yet; the old file was counted before it moved to backup/rm.
      expect(ledger("group-a")).toEqual(before);
      const legacy = ledger("group-b");
      expect(legacy.activity.map((row) => [row.asks, row.replies])).toEqual([[1, 1]]);
      expect(legacy.usage.map((row) => [row.requests, row.input, row.output, row.cost])).toEqual([[1, 100, 10, 0.25]]);

      // The service runs the queued clears at start, before any message; each member's next turn adds on top.
      const seen: string[] = [];
      faux.setResponses([1, 2].map(() => (transcript: { messages: unknown[] }) => {
        seen.push(JSON.stringify(transcript.messages));
        return fauxAssistantMessage("清空之后的回答");
      }));
      service = open();
      try {
        expect(await service.start()).toEqual(["group-a"]);
        await service.admit("13800000001", "group-a", "Alice 清空之后", url);
        await service.admit("13800000002", "group-a", "Bob 清空之后", url);
        await until(() => replies === 4, "the replies after the clear");
      } finally { await service.close(); }
      const session = createSession(await openGroupStorage(groupDatabasePath(root, "group-a")));
      try { expect((await session.snapshot(ControlsDoc, context))?.pending).toEqual([]); } finally { await session.close(context); }
      for (const old of ["Alice 提问", "Bob 提问"]) expect(seen.join("\n")).not.toContain(old);
      const after = ledger("group-a");
      for (const member of ["13800000001", "13800000002"]) {
        const asks = (rows: typeof after.activity) => rows.filter((row) => row.user === member).reduce((sum, row) => sum + row.asks, 0);
        expect([asks(before.activity), asks(after.activity)]).toEqual([1, 2]);
      }
      expect(after.usage.reduce((sum, row) => sum + row.requests, 0)).toBe(4);
      expect(ledger("group-b")).toEqual(legacy);
    } finally {
      stateDb.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  test("clear --all on a root without history succeeds without changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-all-empty-"));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await clearAllGroups(root)).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("无需清理");
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a group whose members cannot be listed fails alone: clear --all and clearing another group still work", async () => {
    const root = await makeRoot();
    const unreadable = join(root, "group-b", "users");
    const original = fs.readdir;
    let injected = 0;
    const readdir = spyOn(fs, "readdir").mockImplementation(((path: unknown, options: unknown) => {
      if (String(path) !== unreadable) return (original as any)(path, options);
      injected++;
      return Promise.reject(Object.assign(new Error("synthetic EACCES"), { code: "EACCES" }));
    }) as typeof fs.readdir);
    const output: string[] = [];
    const capture = (...args: unknown[]) => { output.push(args.join(" ")); };
    const log = spyOn(console, "log").mockImplementation(capture), error = spyOn(console, "error").mockImplementation(capture);
    const session = (group: string, user: string) => readFile(join(root, group, "users", user, "session.jsonl"), "utf8").then(() => true, () => false);
    try {
      // Clearing one group scans only that group.
      expect(await clearGroup("group-a", root)).toBe(0);
      expect(await session("group-a", "13800000000")).toBe(false);
      expect(injected).toBe(0);
      expect(await clearGroup("group-b", root)).toBe(1);
      expect(output.join("\n")).toContain("群 group-b 的会话历史无法读取，本群未做任何改动");
      // Restore group-a's history: clear --all must clear it although group-b fails first.
      await writeFile(join(root, "group-a", "users", "13900000000", "session.jsonl"), "{}\n");
      output.length = 0;
      expect(await clearAllGroups(root)).toBe(1);
      const text = output.join("\n");
      expect(text).toContain("群 group-b 的会话历史无法读取，跳过");
      expect(text).toContain("即将清空 1 个群的会话历史（另有 1 个群无法读取，未处理）");
      expect(text).toContain("1/2 个群已清空；未完成：group-b");
      expect(await session("group-a", "13900000000")).toBe(false);
      expect(injected).toBe(2);
      expect(await session("group-b", "13700000000")).toBe(true);
    } finally {
      readdir.mockRestore(); log.mockRestore(); error.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the CLI clears all groups only with an explicit --all", async () => {
    const work = await mkdtemp(join(tmpdir(), "history-all-cli-"));
    const root = join(work, "groups");
    for (const name of ["group-a", "group-b"]) {
      await mkdir(join(root, name, "users", "13800000000"), { recursive: true });
      await writeFile(join(root, name, "users", "13800000000", "session.jsonl"), "keep\n");
    }
    const script = fileURLToPath(new URL("../../scripts/ops/history-admin.ts", import.meta.url));
    const cli = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, script, ...args], {
        cwd: work, env: { ...process.env, GROUP_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    try {
      for (const args of [["clear"], ["clear", "--all", "group-a"], ["clear", "group-a", "--all"]]) {
        const refused = await cli(...args);
        expect(refused.code, refused.stdout).toBe(1);
        expect(refused.stderr).toContain("--all");
      }
      expect(await collect(root)).toHaveLength(2);
      const cleared = await cli("clear", "--all");
      expect(cleared.code, cleared.stderr).toBe(0);
      expect(cleared.stdout).toContain("2 个群已全部清空");
      expect(await collect(root)).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 60000);
});
