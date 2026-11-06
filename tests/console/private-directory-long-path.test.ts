import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareConsoleDir } from "../../ops/core/console-state.ts";
import { tempFixture } from "../helpers/temp.ts";

test.skipIf(process.platform !== "win32")("Windows 权限检查遍历超过 260 字符的运行包路径，仍拒绝外来 ACL", async () => {
  const f = await tempFixture("console-long-path-");
  try {
    const root = join(f.root, ".console"); prepareConsoleDir(root);
    const deep = join(root, "runtime", "source-" + "a".repeat(64), "nested-".repeat(14), "references-".repeat(9));
    await mkdir(deep, { recursive: true }); const file = join(deep, "中文-runtime.txt"); await writeFile(file, "synthetic code");
    expect(file.length).toBeGreaterThan(300); expect(() => prepareConsoleDir(root)).not.toThrow();
    const owner = await readFile(join(root, "owner.json"));
    await writeFile(join(root, "owner.json"), JSON.stringify({ version: 1, sid: "S-1-5-21-123456789" }));
    expect(() => prepareConsoleDir(root)).toThrow("运维身份");
    await writeFile(join(root, "owner.json"), owner);
    const added = Bun.spawnSync(["icacls", "\\\\?\\" + file, "/grant", "*S-1-5-32-545:R"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(added.exitCode, new TextDecoder().decode(added.stderr)).toBe(0);
    expect(() => prepareConsoleDir(root)).toThrow("其他主体");
    expect(() => prepareConsoleDir(root)).toThrow("其他主体");
  } finally { await f.cleanup(); }
}, 20_000);
