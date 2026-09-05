import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveToolPath } from "../../src/agent/tool-path.ts";

const cwd = resolve("workspace with spaces");
const absolute = join(cwd, "notes.md");
const shellPath = absolute.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
const cases = [
  "notes.md", "@notes.md", "@@notes.md", "sub/../notes.md", " leading space.md",
  "notes\u00a0file.md", "notes\u202ffile.md", "notes\u3000file.md", "~", "~/notes.md",
  pathToFileURL(absolute).href, absolute,
  ...(process.platform === "win32" ? [shellPath, `/mnt${shellPath}`, `/cygdrive${shellPath}`, "~\\notes.md"] : []),
];

test.each(["write", "edit"])("%s path keys match the installed Pi resolver", async (name) => {
  for (const path of cases) {
    let actual: string | undefined;
    const operations = {
      mkdir: async () => {}, access: async () => {}, readFile: async () => Buffer.from("before"),
      writeFile: async (target: string) => { actual = target; },
    };
    // 用公开工厂的 operations 接口观察官方最终路径，不导入内部模块，也不写用户目录。
    const tool = name === "write" ? createWriteToolDefinition(cwd, { operations }) : createEditToolDefinition(cwd, { operations });
    await tool.execute("path-probe", {
      path, content: "after", edits: [{ oldText: "before", newText: "after" }],
    } as never, undefined, undefined, { cwd } as never);
    expect(actual).toBe(resolveToolPath(path, cwd));
  }
});
