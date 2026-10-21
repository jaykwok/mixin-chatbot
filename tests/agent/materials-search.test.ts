import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as streams from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMaterialsTools } from "../../src/agent/materials-search.ts";
import { extractDocument } from "../../src/agent/document-extract.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("materials-search-"); afterAll(() => fixture.cleanup());
let seq = 0;
async function setup() {
  const root = join(fixture.root, String(++seq));
  const options = { workspaceDir: join(root, "workspace"), tempDir: join(root, "tmp"), indexPath: join(root, "index/materials.md"),
    ignorePath: join(root, "index/ignore.txt"), venvDir: join(root, "absent-venv") };
  await Promise.all([options.workspaceDir, options.tempDir, join(root, "index")].map(dir => mkdir(dir, { recursive: true })));
  const tools = buildMaterialsTools(options);
  async function call(name: string, args: object) {
    return (await tools.find(t => t.name === name)!.execute("test", args, undefined, undefined, {} as never)).details as any;
  }
  return { options, root, call };
}
test("filename/body searches respect ignore, hidden paths and group boundaries; binary misses never spawn parsers", async () => {
  const f = await setup();
  await Promise.all(["public.txt", "hidden.txt", ".private.txt", "manual.docx"].map(x => writeFile(join(f.options.workspaceDir, x), "before\n安全网关 策略\nafter")));
  await writeFile(f.options.ignorePath, "hidden.txt\n");
  const found = await f.call("materials_find", {});
  expect(found.files.map((x: any) => x.path)).toEqual(["manual.docx", "public.txt"]);
  const grep = await f.call("materials_grep", { keywords: ["安全网关", "策略"], mode: "all" });
  expect(grep.hits).toHaveLength(1); expect(grep.hits[0].line).toBe(2); expect(grep.hits[0].snippet).toContain("before");
  expect(grep.notIndexed[0].path).toBe("manual.docx"); expect(grep.incomplete).toBe(true);
  expect(await stat(f.options.venvDir).then(() => true, () => false)).toBe(false);
  await expect(f.call("materials_grep", { keywords: ["策略"], paths: ["../other/secret.txt"] })).rejects.toThrow("本群");
});

test("old caches require explicit extraction once; a cache hit registers a pointer without parsing and source edits invalidate it", async () => {
  const f = await setup(), source = join(f.options.workspaceDir, "manual.docx");
  const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
  const parser = createHash("sha256").update(await readFile(fileURLToPath(new URL("../../scripts/runtime/extract_document.py", import.meta.url))))
    .update(await readFile(fileURLToPath(new URL("../../uv.lock", import.meta.url)))).digest("hex");
  const key = digest(JSON.stringify([digest("original"), ".docx", parser, 250000])), cache = join(f.root, "index/parsed", key);
  await writeFile(source, "original"); await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "text.txt"), "[段落 17]\n安全网关功能\n");
  await writeFile(join(cache, "metadata.json"), JSON.stringify({ digest: digest("original"), textHash: digest(await readFile(join(cache, "text.txt"))), units: 1, characters: 20, truncated: false }));
  const old = await f.call("materials_grep", { keywords: ["安全网关"] });
  expect(old.hits).toEqual([]); expect(old.notIndexed[0].reason).toContain("旧缓存缺少来源记录");
  expect(old.notIndexed[0].reason).toContain("document_extract");
  const extracted = await extractDocument(f.options, source);
  expect(extracted.cacheHit).toBe(true); expect(await stat(f.options.venvDir).then(() => true, () => false)).toBe(false);
  expect((await f.call("materials_grep", { keywords: ["安全网关"] })).hits).toHaveLength(1);
  await writeFile(source, "modified");
  const result = await f.call("materials_grep", { keywords: ["安全网关"] });
  expect(result.hits).toEqual([]); expect(result.notIndexed).toHaveLength(1);
});

test.each([false, true])("300 large unpointed documents read the cache catalogue once without hashing originals (legacy=%s)", async legacy => {
  const f = await setup(), cache = join(f.root, "index/parsed"), block = Buffer.alloc(64);
  await mkdir(cache);
  // Sparse 4 MiB originals make accidental source reads visible without 1.2 GiB of fixture writes.
  for (let n = 0; n < 300; n++) {
    block.writeUInt32LE(n); const source = join(f.options.workspaceDir, `doc-${n}.docx`);
    await writeFile(source, block); await fs.truncate(source, 4 * 1024 * 1024);
  }
  for (let n = 0; n < 128; n++) {
    const directory = join(cache, createHash("sha256").update(String(n)).digest("hex")); await mkdir(directory);
    await writeFile(join(directory, "metadata.json"), JSON.stringify({ digest: "no match", textHash: "none", truncated: false,
      ...(!legacy ? { sourcePath: join(f.options.workspaceDir, `missing-${n}.docx`), sourceStamp: "different" } : {}) }));
  }
  await writeFile(join(f.options.workspaceDir, "notes.txt"), "search target"); await f.call("materials_find", {});
  const listing = spyOn(fs, "readdir"), reading = spyOn(fs, "readFile"), hashing = spyOn(streams, "createReadStream");
  try {
    for (const round of [1, 2]) {
      listing.mockClear(); reading.mockClear(); hashing.mockClear();
      const started = performance.now(), result = await f.call("materials_grep", { keywords: ["search target"] });
      expect(result.scanned).toBe(301); expect(result.unscanned).toBe(0); expect(result.hits).toHaveLength(1); expect(result.notIndexedCount).toBe(300);
      expect(listing.mock.calls.filter(args => String(args[0]) === cache)).toHaveLength(1);
      expect(reading.mock.calls.filter(args => String(args[0]).endsWith("metadata.json"))).toHaveLength(128);
      expect(hashing).not.toHaveBeenCalled();
      expect(performance.now() - started).toBeLessThan(15000);
      console.log(JSON.stringify({ unpointedLargeFiles: 300, cacheDirs: 128, legacy, round, ms: performance.now() - started }));
    }
  } finally { listing.mockRestore(); reading.mockRestore(); hashing.mockRestore(); }
});

test("current source metadata without a pointer uses stat identity, and a later source edit is not reused", async () => {
  const f = await setup(), source = resolve(f.options.workspaceDir, "manual.docx"), cache = join(f.root, "index/parsed", "b".repeat(64));
  await writeFile(source, "large original"); await mkdir(cache, { recursive: true });
  const data = "keyword in cache", s = await stat(source); await writeFile(join(cache, "text.txt"), data);
  await writeFile(join(cache, "metadata.json"), JSON.stringify({ sourcePath: source,
    sourceStamp: JSON.stringify([s.size, s.mtimeMs, s.ctimeMs, s.ino, s.birthtimeMs]), truncated: false,
    textHash: createHash("sha256").update(data).digest("hex") }));
  expect((await f.call("materials_grep", { keywords: ["keyword"] })).hits).toHaveLength(1);
  await writeFile(source, "changed"); expect((await f.call("materials_grep", { keywords: ["keyword"] })).hits).toEqual([]);
});

test("new cache stat hints are verified against text bytes and never cross into another user's tmp", async () => {
  const f = await setup(), source = join(f.options.workspaceDir, "manual.docx"), index = join(f.root, "index");
  await writeFile(source, "source"); await mkdir(join(index, "parsed-sources"));
  const foreign = join(f.root, "foreign.txt"); await writeFile(foreign, "secret keyword");
  const s = await stat(source), stamp = JSON.stringify([s.size, s.mtimeMs, s.ctimeMs, s.ino, s.birthtimeMs]);
  await writeFile(join(index, "parsed-sources", createHash("sha256").update(resolve(source)).digest("hex") + ".json"),
    JSON.stringify({ source: resolve(source), stamp, path: foreign, textHash: createHash("sha256").update("secret keyword").digest("hex"), truncated: false }));
  expect((await f.call("materials_grep", { keywords: ["secret"] })).hits).toEqual([]);
});

test("bounded hits, literal matching and a changed ignore file cannot expose excluded data", async () => {
  const f = await setup(); await writeFile(join(f.options.workspaceDir, "data.txt"), ("literal [x] keyword\n").repeat(10000));
  const output = await f.call("materials_grep", { keywords: ["[x]"], limit: 50 });
  expect(output.hits).toHaveLength(5); expect(output.incomplete).toBe(true); expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(16 * 1024);
  await writeFile(f.options.ignorePath, "data.txt\n");
  expect((await f.call("materials_grep", { keywords: ["keyword"] })).hits).toEqual([]);
});

test("an exhausted search budget returns partial progress, while caller cancellation is not swallowed", async () => {
  const f = await setup(); await writeFile(join(f.options.workspaceDir, "data.txt"), "keyword\n");
  await f.call("materials_find", {});
  const controller = new AbortController(), timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    const pending = f.call("materials_grep", { keywords: ["keyword"] });
    controller.abort(new DOMException("search budget exhausted", "TimeoutError"));
    const result = await pending;
    expect(timeout).toHaveBeenCalledWith(15000);
    expect(result.incomplete).toBe(true); expect(result.unscanned).toBe(1); expect(result.hits).toEqual([]);
  } finally { timeout.mockRestore(); }
  const caller = new AbortController(); caller.abort(new Error("caller stopped"));
  const grep = buildMaterialsTools(f.options).find(t => t.name === "materials_grep")!;
  await expect(grep.execute("cancel", { keywords: ["keyword"] }, caller.signal, undefined, {} as never)).rejects.toThrow("caller stopped");
});

test.skipIf(process.platform === "win32")("directory symlinks cannot escape into another group's files", async () => {
  const f = await setup(), other = join(f.root, "other"); await mkdir(other); await writeFile(join(other, "secret.txt"), "secret");
  await symlink(other, join(f.options.workspaceDir, "linked"), "dir");
  expect((await f.call("materials_find", {})).files).toEqual([]);
});

test.each([false, true])("2000 indexed files stay in process and yield to the event loop (extracted cache=%s)", async extracted => {
  const f = await setup();
  const cache = join(f.root, "index/parsed-sources"), text = join(f.root, "index/text.txt"), textData = "normal material\n";
  if (extracted) { await mkdir(cache); await writeFile(text, textData); }
  for (let start = 0; start < 2000; start += 50) await Promise.all(Array.from({ length: 50 }, async (_, n) => {
    const source = resolve(f.options.workspaceDir, `manual-${start + n}.${extracted ? "docx" : "txt"}`); await writeFile(source, textData);
    if (extracted) {
      const s = await stat(source);
      await writeFile(join(cache, createHash("sha256").update(source).digest("hex") + ".json"), JSON.stringify({ source,
        stamp: JSON.stringify([s.size, s.mtimeMs, s.ctimeMs, s.ino, s.birthtimeMs]), path: text, truncated: false,
        textHash: createHash("sha256").update(textData).digest("hex") }));
    }
  }));
  await f.call("materials_find", {}); // Index scan is separately measured by existing timing logs.
  let beats = 0; const timer = setInterval(() => beats++, 10);
  try {
    const start = performance.now(); const find = await f.call("materials_find", { keywords: ["manual"] }); const findMs = performance.now() - start;
    const grepStart = performance.now(); const result = await f.call("materials_grep", { keywords: ["absent phrase"] }); const grepMs = performance.now() - grepStart;
    expect(find.totalMatched).toBe(2000); expect(result.scanned).toBe(2000); expect(result.unscanned).toBe(0); expect(beats).toBeGreaterThan(0);
    console.log(JSON.stringify({ materialsFindMs: findMs, materialsGrepMs: grepMs, files: result.scanned, extracted }));
  } finally { clearInterval(timer); }
});
