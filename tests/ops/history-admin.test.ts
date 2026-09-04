// 这条命令删的是长期资产，所以测试的重点不是「删掉了」，而是「只删掉了该删的」：
// workspace、用户 tmp、资料索引和 venv 就在 session.jsonl 的隔壁，一个写歪的路径代价太大。
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGroup, collect } from "../../scripts/ops/history-admin.ts";

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
      const code = await clearGroup("group-a", { skipRunningCheck: true }, root);
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
      expect(await clearGroup("group-zzz", { skipRunningCheck: true }, root)).toBe(1);
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
      expect(await clearGroup("../escape-target", { skipRunningCheck: true }, root)).toBe(1);
      expect(
        await readFile(join(outside, "users", "13800000000", "session.jsonl"), "utf8")
      ).toBe("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("reports a group that exists but has no history", async () => {
    const root = await makeRoot();
    await rm(join(root, "group-b", "users", "13700000000", "session.jsonl"));
    try {
      expect(await clearGroup("group-b", { skipRunningCheck: true }, root)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
