import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
// 归档使用同挂载的原子移动，保护数据目录中与 tmp 并列的共享资料和会话库。
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { collect, purge } from "../../scripts/ops/tmp-admin.ts";
import { groupSegment, userSegment } from "../../src/core/layout.ts";

const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-tmp-admin-"));

const DAY = 24 * 60 * 60_000;
// u1 in group g1, u2 in the direct space.
const u1Tmp = join(root, "tmp", "groups", "g1", "u1");
const u2Tmp = join(root, "tmp", "direct", "u2");
const session = join(root, "conversations", "groups", "g1", "keep.txt");
const asset = join(root, "workspace", "keep.txt");

async function age(path: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * DAY);
  await utimes(path, when, when);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

describe("用户临时目录清理", () => {
  test("an unreadable Durable ledger fails closed and reports incomplete maintenance", async () => {
    const scoped = await mkdtemp(join(tmpdir(), "tmp-durable-protected-"));
    const temp = join(scoped, "tmp/groups/g1/u1");
    try {
      await mkdir(join(temp, "codemode/1-call"), { recursive: true });
      await writeFile(join(temp, "codemode/1-call/output.txt"), "persistent reference");
      await mkdir(join(scoped, "conversations/groups/g1"), { recursive: true });
      await writeFile(join(scoped, "conversations/groups/g1/durable.sqlite"), "database belongs to this group");
      await age(join(temp, "codemode/1-call/output.txt"), 30);
      expect(await purge(0, undefined, scoped)).toBe(1);
      expect(await exists(join(temp, "codemode/1-call/output.txt"))).toBe(true);
    } finally { await rm(scoped, { recursive: true, force: true }); }
  });
  test("同时限定群和成员，同一手机号在其他群和单聊的内容保留，摘要目录可直接选中；单聊空间用 direct 选择", async () => {
    const scoped = await mkdtemp(join(tmpdir(), "tmp-scope-"));
    try {
      const group = "带 空格的群";
      const user = "成员/标识";
      const groups = join(scoped, "tmp", "groups");
      const chosen = join(groups, groupSegment(group), userSegment(user));
      const otherGroup = join(groups, "other", userSegment(user));
      const otherUser = join(groups, groupSegment(group), "13812345678");
      const encodedGroup = join(groups, groupSegment(groupSegment(group)), userSegment(user));
      const encodedUser = join(groups, groupSegment(group), userSegment(userSegment(user)));
      const direct = join(scoped, "tmp", "direct", userSegment(user));
      for (const path of [chosen, otherGroup, otherUser, encodedGroup, encodedUser, direct]) {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "keep-unless-selected.txt"), "fixture");
      }
      expect((await collect(user, scoped, group)).map(item => item.dir)).toEqual([chosen]);
      expect((await collect(user, scoped, "direct")).map(item => [item.space, item.dir])).toEqual([["direct", direct]]);
      await expect(collect(userSegment(user), scoped, groupSegment(group))).rejects.toThrow("歧义");
      expect((await collect(userSegment(user), scoped, groupSegment(group), "segment")).map(item => item.dir)).toEqual([chosen]);
      expect(await purge(0, userSegment(user), scoped, groupSegment(group), "segment")).toBe(0);
      expect(await exists(join(chosen, "keep-unless-selected.txt"))).toBe(false);
      expect(await exists(join(otherGroup, "keep-unless-selected.txt"))).toBe(true);
      expect(await exists(join(otherUser, "keep-unless-selected.txt"))).toBe(true);
      expect(await exists(join(encodedGroup, "keep-unless-selected.txt"))).toBe(true);
      expect(await exists(join(encodedUser, "keep-unless-selected.txt"))).toBe(true);
      expect(await exists(join(direct, "keep-unless-selected.txt"))).toBe(true);
      expect(await exists(chosen)).toBe(true);
      expect(await collect("../../outside", scoped, "../outside")).toEqual([]);
    } finally { await rm(scoped); }
  });

  test("按子树最新改动时间清理群和单聊成员的 tmp，且不碰共享资料与会话目录", async () => {
    try {
      await mkdir(join(u1Tmp, "cache", "uv"), { recursive: true });
      await mkdir(u2Tmp, { recursive: true });
      await mkdir(join(root, "workspace"), { recursive: true });
      await mkdir(join(root, "conversations", "groups", "g1"), { recursive: true });

      await writeFile(join(u1Tmp, "old.log"), "old");
      await writeFile(join(u2Tmp, "pi-bash-abc.log"), "old");
      await writeFile(join(u1Tmp, "fresh.txt"), "fresh");
      // 关键用例：目录自身的 mtime 很旧，但深处有刚写的文件。目录 mtime 只反映直接子项
      // 的增删，照它判断会把一个正在被写的缓存当成陈旧目录删掉。
      await writeFile(join(u1Tmp, "cache", "uv", "entry.bin"), "warm");
      await writeFile(session, "history");
      await writeFile(asset, "asset");
      for (const path of [
        join(u1Tmp, "old.log"),
        join(u2Tmp, "pi-bash-abc.log"),
        join(u1Tmp, "cache", "uv"),
        join(u1Tmp, "cache"),
        session,
        asset,
      ]) {
        await age(path, 30);
      }

      const scanned = await collect(undefined, root);
      expect(scanned.map((entry) => [entry.space, entry.user]).sort()).toEqual([["direct", "u2"], ["groups/g1", "u1"]]);
      const cache = scanned
        .find((entry) => entry.user === "u1")!
        .entries.find((entry) => entry.name === "cache")!;
      expect(Date.now() - cache.newest).toBeLessThan(DAY);

      expect(await purge(7, undefined, root)).toBe(0);
      expect(await exists(join(u1Tmp, "old.log"))).toBe(false);
      expect(await exists(join(u2Tmp, "pi-bash-abc.log"))).toBe(false);
      expect(await exists(join(u1Tmp, "fresh.txt"))).toBe(true);
      expect(await exists(join(u1Tmp, "cache", "uv", "entry.bin"))).toBe(true);
      // tmp 本身要留着：正在跑的任务已经拿着这个路径，删掉目录会让它们直接失败。
      expect(await exists(u1Tmp)).toBe(true);
      expect(await exists(u2Tmp)).toBe(true);
      expect(await exists(session)).toBe(true);
      expect(await exists(asset)).toBe(true);

      // --user 只清一个人，别人的中间产物不受影响。
      await writeFile(join(u2Tmp, "other.txt"), "other");
      await age(join(u2Tmp, "other.txt"), 30);
      expect(await purge(0, "u1", root)).toBe(0);
      expect(await exists(join(u1Tmp, "fresh.txt"))).toBe(false);
      expect(await exists(join(u1Tmp, "cache"))).toBe(false);
      expect(await exists(join(u2Tmp, "other.txt"))).toBe(true);
      expect(await exists(session)).toBe(true);
      expect(await exists(asset)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
