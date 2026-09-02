// 这个命令会递归删除文件，而它要删的目录就紧挨着 workspace 和 session.jsonl，
// 所以边界必须有测试盯着：删对了什么、更重要的是没碰什么。
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, purge } from "../../scripts/ops/tmp-admin.ts";

const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-tmp-admin-"));

const DAY = 24 * 60 * 60_000;
const u1Tmp = join(root, "g1", "users", "u1", "tmp");
const u2Tmp = join(root, "g2", "users", "u2", "tmp");
const session = join(root, "g1", "users", "u1", "session.jsonl");
const asset = join(root, "g1", "workspace", "keep.txt");

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
  test("按子树最新改动时间清理，且不碰 workspace 与会话历史", async () => {
    try {
      await mkdir(join(u1Tmp, "cache", "uv"), { recursive: true });
      await mkdir(u2Tmp, { recursive: true });
      await mkdir(join(root, "g1", "workspace"), { recursive: true });

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
      expect(scanned.map((entry) => entry.user).sort()).toEqual(["u1", "u2"]);
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
