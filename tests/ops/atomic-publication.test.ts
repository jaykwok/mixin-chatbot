import { expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publish } from "../../scripts/lib/atomic-file.ts";
import { tempFixture } from "../helpers/temp.ts";

test("排他发布只让一个完整事务指针获胜，其他竞争者不覆盖或残留临时文件", async () => {
  const f = await tempFixture("atomic-publication-");
  try {
    const path = join(f.root, "pointer"), values = Array.from({ length: 12 }, (_, index) => `${index}:` + "完整记录".repeat(400));
    const result = await Promise.allSettled(values.map(value => publish(path, value, { createOnly: true })));
    const winners = result.flatMap((item, index) => item.status === "fulfilled" ? [index] : []);
    expect(winners).toHaveLength(1); expect(await readFile(path, "utf8")).toBe(values[winners[0]!]);
    expect(await readdir(f.root)).toEqual(["pointer"]);
    await expect(publish(path, "replacement", { createOnly: true })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(values[winners[0]!]);
    await publish(path, "ordinary replace"); expect(await readFile(path, "utf8")).toBe("ordinary replace");
  } finally { await f.cleanup(); }
});

test("写出中断不留下部分指针，也不覆盖已有记录", async () => {
  const f = await tempFixture("atomic-publication-failure-");
  try {
    const path = join(f.root, "pointer"); await writeFile(path, "original");
    async function* broken() { yield Buffer.from("partial"); throw new Error("synthetic input failed"); }
    for (const createOnly of [false, true]) {
      await expect(publish(path, broken(), { createOnly })).rejects.toThrow("synthetic input failed");
      expect(await readFile(path, "utf8")).toBe("original"); expect(await readdir(f.root)).toEqual(["pointer"]);
    }
  } finally { await f.cleanup(); }
});
