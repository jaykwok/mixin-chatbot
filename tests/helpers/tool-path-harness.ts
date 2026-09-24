import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveToolPath } from "../../src/agent/tool-path.ts";

assert.equal(homedir(), process.cwd());
const cwd = resolve("workspace with spaces"), absolute = join(cwd, "notes.md");
const shellPath = absolute.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
const cases = ["notes.md", "@notes.md", "@@notes.md", "sub/../notes.md", " leading space.md",
  "notes\u00a0file.md", "notes\u202ffile.md", "notes\u3000file.md", "~", "~/notes.md", pathToFileURL(absolute).href, absolute,
  ...(process.platform === "win32" ? [shellPath, `/mnt${shellPath}`, `/cygdrive${shellPath}`, "~\\notes.md"] : [])];
for (const path of cases) {
  let actual: string | undefined;
  const operations = {
    mkdir: async () => {}, access: async () => {}, readFile: async () => Buffer.from("before"),
    writeFile: async (target: string) => { actual = target; },
  };
  const tool = process.argv[2] === "write" ? createWriteToolDefinition(cwd, { operations }) : createEditToolDefinition(cwd, { operations });
  await tool.execute("path-probe", { path, content: "after", edits: [{ oldText: "before", newText: "after" }] } as never,
    undefined, undefined, { cwd } as never);
  assert.equal(actual, resolveToolPath(path, cwd));
}
console.log("PATHS_PASSED");
