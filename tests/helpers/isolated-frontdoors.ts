// Which end each isolated tool entry asks for, against a fake backend: bash output stays for the receipt sweep,
// the environment probe and a failed document job are reclaimed at once. Run in a fresh process (mock.module).
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "bun:test";

let next = 0, exitCode = 0;
const records = new Map<string, { path: string; seals: string[]; reclaimed: boolean }>();
const backend = {
  async create(temp: string) {
    const id = String(++next), path = join(temp, ".isolated-work", id, "work");
    await mkdir(path, { recursive: true });
    const record = { path, seals: [] as string[], reclaimed: false }; records.set(id, record);
    return { id, path,
      async run() { return { exitCode, output: exitCode ? "synthetic failure" : "" }; },
      async seal(options?: { discardScratch: boolean }) { record.seals.push(options?.discardScratch ? "discard-scratch" : "keep-scratch"); },
    };
  },
  async reclaim(id: string) { const record = records.get(id)!; assert.equal(record.seals.length, 1); record.reclaimed = true; },
};
const { finishTask } = await import("../../src/core/task-backend.ts");
mock.module("../../src/core/task-backend.ts", () => ({ configuredRootlessTasks: () => backend, assertTaskPathAllowed: async () => {}, finishTask, ISOLATED_PYTHON: "/fixture/python" }));
const { buildLocalTools } = await import("../../src/agent/local-tools.ts");
const { buildDocumentEnvironmentTool } = await import("../../src/agent/document-extract.ts");
const { buildDocumentWorkTools } = await import("../../src/agent/modules/document-work/tools.ts");

const root = process.cwd(), workspace = join(root, "workspace"), temp = join(root, "tmp"), index = join(root, "index");
await Promise.all([workspace, temp, index].map(path => mkdir(path)));
await writeFile(join(index, "materials.md"), "synthetic index");
await writeFile(join(workspace, "source.docx"), "synthetic docx");
const ctx = {} as never;

// bash: kept, whatever the command's exit code.
const tools = await buildLocalTools({ workspaceDir: workspace, tempDir: temp, phone: "synthetic", groupId: "synthetic", venvDir: join(root, "absent-venv"), materialsIndexPath: join(index, "materials.md") });
const bash = tools.find(tool => tool.name === "bash")!;
await bash.execute("bash", { command: "true" }, undefined, undefined, ctx);
exitCode = 3; await bash.execute("bash", { command: "false" }, undefined, undefined, ctx).catch(() => {}); exitCode = 0;
for (const id of ["1", "2"]) {
  assert.deepEqual(records.get(id)!.seals, ["keep-scratch"]); assert.equal(records.get(id)!.reclaimed, false);
  await access(records.get(id)!.path);
}

// document_environment: a probe delivers nothing, so it is reclaimed whether it passes or fails.
const environment = buildDocumentEnvironmentTool(join(root, "absent-venv"));
await environment.execute("environment", {} as never, undefined, undefined, ctx);
exitCode = 1; await assert.rejects(environment.execute("environment", {} as never, undefined, undefined, ctx), /文档环境不可用/); exitCode = 0;
for (const id of ["3", "4"]) { assert.deepEqual(records.get(id)!.seals, ["keep-scratch"]); assert.equal(records.get(id)!.reclaimed, true); }

// A failed document job has no deliverable and is reclaimed.
const inspect = buildDocumentWorkTools({ workspaceDir: workspace, tempDir: temp, indexPath: join(index, "materials.md"), venvDir: join(root, "absent-venv") })
  .find(tool => tool.name === "document_inspect")!;
exitCode = 1; await assert.rejects(inspect.execute("inspect", { source: "source.docx" } as never, undefined, undefined, ctx), /文档操作失败/); exitCode = 0;
assert.deepEqual(records.get("5")!.seals, ["keep-scratch"]); assert.equal(records.get("5")!.reclaimed, true);
assert.equal(records.size, 5);
console.log("ISOLATED_FRONTDOORS_PASSED");
