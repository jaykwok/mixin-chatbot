import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "bun:test";
import { application, waitFor } from "../../src/core/lifecycle.ts";

let next = 0, runs = 0, holding = false, release: (() => void) | undefined;
const records = new Map<string, { path: string; sealed: boolean; removed: boolean }>();
const backend = {
  async create(temp: string) {
    const id = String(++next), path = join(temp, ".isolated-work", id, "work");
    await mkdir(path, { recursive: true });
    const record = { path, sealed: false, removed: false }; records.set(id, record);
    return { id, path,
      async run(options: any, _readOnly: string[], inputs?: { paths: readonly string[] }) {
        assert.deepEqual(inputs?.paths ?? [], []); assert.equal(options.cwd, join(path, ".work"));
        runs++;
        if (holding) await waitFor(new Promise<void>(resolve => { release = resolve; }), options.signal);
        options.signal.throwIfAborted();
        const text = await readFile(options.args[1], "utf8"); await writeFile(options.args[3], text);
        await writeFile(options.args[5], JSON.stringify({ units: 1, characters: text.length, truncated: false }));
        return { exitCode: 0, output: "UserWarning: recoverable parser warning\n" };
      },
      async seal(options?: { discardScratch: boolean }) {
        record.sealed = true;
        if (options?.discardScratch) await rm(join(path, ".work"), { recursive: true });
      },
    };
  },
  async reclaim(id: string) { const record = records.get(id)!; assert.ok(record.sealed); await rm(record.path, { recursive: true }); record.removed = true; },
};
// The real end-of-task policy runs against the fake backend, so the assertions below cover what extractDocument asks for.
const { finishTask } = await import("../../src/core/task-backend.ts");
mock.module("../../src/core/task-backend.ts", () => ({ configuredRootlessTasks: () => backend, assertTaskPathAllowed: async () => {}, finishTask, ISOLATED_PYTHON: "/fixture/python" }));
const { extractDocument } = await import("../../src/agent/document-extract.ts");
const workspace = join(process.cwd(), "workspace"), temp = join(process.cwd(), "tmp");
await mkdir(workspace); await mkdir(join(workspace, "index")); await mkdir(temp);
const source = join(workspace, "source.docx"), options = { workspaceDir: workspace, tempDir: temp, indexPath: join(workspace, "index/materials.md"), venvDir: "unused" };
await writeFile(source, "source bytes");
const first = await extractDocument(options, source);
assert.equal(await readFile(first.path, "utf8"), "source bytes");
assert.deepEqual((await readdir(records.get("1")!.path)).sort(), ["metadata.json", "text.txt"]);
assert.ok(records.get("1")!.sealed);
assert.equal((await extractDocument(options, source)).cacheHit, true); assert.equal(runs, 1);
// A reclaimed pointer is disposable: a subsequent lookup creates another signed task.
await backend.reclaim("1");
const second = await extractDocument(options, source); assert.notEqual(second.path, first.path); assert.equal(runs, 2);
holding = true; await writeFile(source, "cancelled source");
const cancel = new AbortController(); const pending = extractDocument(options, source, undefined, cancel.signal).then(() => false, () => true);
while (runs !== 3) await Bun.sleep(5);
cancel.abort(); assert.ok(await pending); await application.drain(); assert.ok(records.get("3")!.removed);
holding = false; release?.();
assert.equal((await extractDocument(options, source)).cacheHit, false);
await application.drain();
console.log("ISOLATED_CACHE_PASSED");
