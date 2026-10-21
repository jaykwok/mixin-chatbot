import { lstat, open, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { materialsRecords, loadIgnorePrefixes, isIgnored } from "./materials-index.ts";
import { createDocumentTextLookup, type DocumentOptions } from "./document-extract.ts";
import { isPathInside } from "../contracts/paths.ts";
import { assertTaskPathAllowed } from "../core/task-backend.ts";
import { commandScope } from "../core/process.ts";
import { log } from "../core/log.ts";

const plain = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".log", ".yaml", ".yml", ".ini", ".rst"]);
const binary = new Set([".docx", ".pptx", ".xlsx", ".pdf"]);
const keywords = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 10 });
function matches(value: string, terms: string[], mode = "any") {
  const text = value.toLocaleLowerCase(), hits = terms.map(term => text.includes(term.toLocaleLowerCase()));
  return mode === "all" ? hits.every(Boolean) : hits.some(Boolean);
}
const safeName = (name: string) => !name.split(/[\\/]/).some(x => x === ".." || x.startsWith(".") || ["node_modules", "__pycache__", "$recycle.bin"].includes(x.toLowerCase()));
function searchTiming(started: number, files: number, hits: number) {
  const elapsed = performance.now() - started, scope = commandScope.getStore();
  if (scope) void Promise.resolve().then(scope.describe).then(label => log.info(`检索耗时 - ${label}, 工具: ${scope.tool}#${scope.toolTask}, 文件: ${files}, 命中: ${hits}, 总: ${(elapsed / 1000).toFixed(2)}秒`)).catch(() => {});
}
async function boundedText(path: string, signal: AbortSignal): Promise<string> {
  const file = await open(path, "r"), chunks: Buffer[] = []; let total = 0;
  try {
    if (!(await file.stat()).isFile()) throw new Error("不是普通文本文件");
    for (;;) {
      signal.throwIfAborted();
      const chunk = Buffer.allocUnsafe(64 * 1024), { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead; if (total > 8 * 1024 * 1024) throw new Error("文本超过读取上限");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await file.close(); }
}

/** All work stays in this process. Cache misses are returned, never silently turned into parser jobs. */
export function buildMaterialsTools(options: DocumentOptions & { ignorePath: string }): ToolDefinition[] {
  const findParams = Type.Object({ keywords: Type.Optional(keywords), mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) });
  const grepParams = Type.Object({ keywords, mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])),
    paths: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })) });
  async function index() {
    const indexed = await materialsRecords(options), ignored = await loadIgnorePrefixes(options.ignorePath);
    return { ...indexed, entries: indexed.entries.filter(x => safeName(x.path) && !isIgnored(x.path, ignored)) };
  }
  const find: ToolDefinition<typeof findParams> = {
    name: "materials_find", label: "查找资料文件", parameters: findParams,
    description: "在本群资料索引内按文件名/路径的字面关键词查找（不启动进程）。返回相对路径、字节数、修改时间及索引完整性；any 任一关键词、all 全部关键词。索引可能滞后，未命中不代表不存在。",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, signal) {
      const started = performance.now();
      signal?.throwIfAborted();
      const data = await index(), all = data.entries.filter(x => !params.keywords?.length || matches(x.path, params.keywords, params.mode));
      const value = { files: all.slice(0, params.limit ?? 50), totalMatched: all.length, generatedAt: data.summary.generatedAt,
        stale: data.stale, truncated: data.summary.truncated || all.length > (params.limit ?? 50) };
      searchTiming(started, data.entries.length, value.files.length);
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  };
  const grep: ToolDefinition<typeof grepParams> = {
    name: "materials_grep", label: "检索资料正文", parameters: grepParams,
    description: "在本群纯文本及有效的 document_extract 缓存中检索字面关键词，any 任一命中、all 同一行全部命中；返回文件、行号、前后文。不会启动解析或其他进程。缓存缺失/失效返回 notIndexed，请先单独 document_extract，再检索。最多 15 秒、16 KiB 结果，每文件最多 5 个命中。",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, callerSignal) {
      const started = performance.now();
      const budget = AbortSignal.timeout(15_000), signal = AbortSignal.any([budget, ...(callerSignal ? [callerSignal] : [])]);
      const data = await index(), root = await realpath(options.workspaceDir);
      const wanted = params.paths?.map(x => resolve(root, x));
      if (wanted?.some(x => !isPathInside(x, root))) throw new Error("只能检索本群资料索引中的路径");
      const entries = data.entries.filter(x => !wanted || wanted.includes(resolve(root, x.path)));
      const cachedText = createDocumentTextLookup(options, signal);
      const hits: { path: string; line: number; snippet: string; extracted: boolean; truncated: boolean }[] = [];
      const notIndexed: { path: string; reason: string }[] = [];
      let scanned = 0, bytes = 0, incomplete = data.summary.truncated, missingCount = 0;
      try {
        for (const entry of entries) {
          signal.throwIfAborted();
          if (hits.length >= (params.limit ?? 20) || bytes >= 12_000) { incomplete = true; break; }
          const miss = (reason: string) => { missingCount++; incomplete = true; const v = { path: entry.path, reason }, size = Buffer.byteLength(JSON.stringify(v));
            if (notIndexed.length < 20 && bytes + size < 12_000) { notIndexed.push(v); bytes += size; } };
          try {
            const requested = resolve(root, entry.path), link = await lstat(requested);
            if (link.isSymbolicLink() || !link.isFile()) { miss("不是普通资料文件"); continue; }
            const source = await realpath(requested);
            if (!isPathInside(source, root) || source !== requested) { miss("资料路径含链接或已变化"); continue; }
            await assertTaskPathAllowed(source);
            const extension = extname(source).toLowerCase();
            let path: string, extracted = false, truncated = false;
            if (plain.has(extension)) {
              if (link.size > 8 * 1024 * 1024) { miss("纯文本超过 8 MiB"); continue; }
              path = source;
            } else if (binary.has(extension)) {
              const cached = await cachedText(source);
              if ("reason" in cached) { miss(cached.reason); continue; }
              path = cached.path; extracted = true; truncated = cached.truncated;
              if (truncated) incomplete = true;
            } else { miss("未支持此文件格式的正文检索"); continue; }
            const content = await boundedText(path, signal);
            if (Buffer.byteLength(content) > 8 * 1024 * 1024) { miss("文件读取期间超过上限"); continue; }
            const current = await stat(source);
            if (current.size !== link.size || current.mtimeMs !== link.mtimeMs || current.ctimeMs !== link.ctimeMs) { miss("读取期间原件变化"); continue; }
            const lines = content.split(/\r?\n/); let perFile = 0;
            for (let n = 0; n < lines.length; n++) {
              if (n > 0 && n % 1000 === 0) { await Bun.sleep(0); signal.throwIfAborted(); }
              if (!matches(lines[n]!, params.keywords, params.mode)) continue;
              if (perFile >= 5 || hits.length >= (params.limit ?? 20) || bytes >= 12_000) { incomplete = true; break; }
              const line = lines[n]!, lower = line.toLocaleLowerCase(), at = Math.max(0, Math.min(...params.keywords.map(x => lower.indexOf(x.toLocaleLowerCase())).filter(x => x >= 0)) - 60);
              const snippet = (at ? "…" : (lines[n - 1]?.slice(-40) ?? "") + "\n") + line.slice(at, at + 160) + "\n" + (lines[n + 1]?.slice(0, 40) ?? "");
              const hit = { path: entry.path, line: n + 1, snippet: snippet.slice(0, 200), extracted, truncated };
              const size = Buffer.byteLength(JSON.stringify(hit));
              if (bytes + size > 12_000) { incomplete = true; break; }
              hits.push(hit); bytes += size; perFile++;
            }
          } catch (error) { if (signal.aborted) throw error; miss("读取或缓存校验失败"); }
          finally { scanned++; }
        }
      } catch (error) { callerSignal?.throwIfAborted(); if (!budget.aborted) throw error; incomplete = true; }
      const value = { hits, notIndexed, notIndexedCount: missingCount, scanned, unscanned: Math.max(0, entries.length - scanned), incomplete,
        stale: data.stale, generatedAt: data.summary.generatedAt };
      searchTiming(started, scanned, hits.length);
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  };
  return [find, grep];
}
