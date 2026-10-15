import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const name = process.argv[2], started = performance.now();
// Write checkpoints synchronously so a watchdog kill cannot discard buffered progress.
function progress(stage: string) { writeSync(2, `[${name} +${Math.round(performance.now() - started)}ms] ${stage}\n`); }
progress("ENTRY");
progress("IMPORT START");
// Dynamic imports let the parent distinguish dependency loading from a stuck path case.
const { createEditToolDefinition, createWriteToolDefinition } = await import("@earendil-works/pi-coding-agent");
const { resolveToolPath } = await import("../../src/agent/tool-path.ts");
progress("IMPORT DONE");

assert.equal(homedir(), process.cwd());
const cwd = resolve("workspace with spaces"), absolute = join(cwd, "notes.md");
const shellPath = absolute.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
const cases = ["notes.md", "@notes.md", "@@notes.md", "sub/../notes.md", " leading space.md",
  "notes\u00a0file.md", "notes\u202ffile.md", "notes\u3000file.md", "~", "~/notes.md", pathToFileURL(absolute).href, absolute,
  ...(process.platform === "win32" ? [shellPath, `/mnt${shellPath}`, `/cygdrive${shellPath}`, "~\\notes.md"] : [])];
for (const [index, path] of cases.entries()) {
  const label = `case ${index + 1}/${cases.length}`;
  progress(`${label} START path=${JSON.stringify(path)}`);
  let actual: string | undefined;
  const operations = {
    mkdir: async () => {}, access: async () => {}, readFile: async () => Buffer.from("before"),
    writeFile: async (target: string) => { actual = target; },
  };
  const tool = name === "write" ? createWriteToolDefinition(cwd, { operations }) : createEditToolDefinition(cwd, { operations });
  await tool.execute("path-probe", { path, content: "after", edits: [{ oldText: "before", newText: "after" }] } as never,
    undefined, undefined, { cwd } as never);
  assert.equal(actual, resolveToolPath(path, cwd));
  progress(`${label} DONE`);
}
console.log("PATHS_PASSED");
