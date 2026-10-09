import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform, addAbortSignal } from "node:stream";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { application, waitFor } from "../core/lifecycle.ts";
import { AsyncSemaphore } from "../core/async-semaphore.ts";
import { runProcess } from "../core/process.ts";
import { assertTaskPathAllowed, configuredRootlessTasks, ISOLATED_PYTHON, type IsolatedTask } from "../core/rootless-tasks.ts";
import { log } from "../core/log.ts";
import { hashFile } from "../core/file-hash.ts";
import { ensureDocumentToolchain, venvPythonPath } from "./python-toolchain.ts";
import { isPathInside } from "./paths.ts";
import { resolveToolPath } from "./tool-path.ts";
import { structuredResult } from "./structured-result.ts";

const script = fileURLToPath(new URL("../../scripts/runtime/extract_document.py", import.meta.url));
const lock = fileURLToPath(new URL("../../uv.lock", import.meta.url));
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const parserSlots = new AsyncSemaphore(2);
interface Extracted { path: string; digest: string; units: number; truncated: boolean; characters: number; cacheHit: boolean; }
type Format = "pdf" | "docx" | "pptx" | "xlsx";
interface Flight { promise: Promise<Extracted>; controller: AbortController; consumers: number; done: boolean; }
const flights = new Map<string, Flight>();
export interface DocumentOptions { workspaceDir: string; tempDir: string; indexPath: string; venvDir: string; }

async function validCache(dir: string, digest: string, signal?: AbortSignal): Promise<Extracted | null> {
  try {
    const metadata = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8"));
    const path = join(dir, "text.txt");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || metadata.digest !== digest ||
        !Number.isInteger(metadata.units) || metadata.units < 0 || typeof metadata.truncated !== "boolean" ||
        !Number.isInteger(metadata.characters) || metadata.characters < 0 || metadata.characters > 2000000 ||
        metadata.textHash !== await hashFile(path, signal)) return null;
    await utimes(dir, new Date(), new Date());
    return { path, digest, units: metadata.units, truncated: metadata.truncated, characters: metadata.characters, cacheHit: true };
  } catch { signal?.throwIfAborted(); return null; }
}

async function sourceDigest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of addAbortSignal(signal, createReadStream(path))) {
    size += chunk.length;
    if (size > MAX_SOURCE_BYTES) throw new Error("文档在读取时增长超过上限");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function pruneCache(root: string, keep: string): Promise<void> {
  // Legacy cache ownership does not prove a protected parent or absence of shared-identity writers.
  if (process.platform === "linux") return;
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{64}$/.test(entry.name))
    .map(async entry => ({ path: join(root, entry.name), at: (await stat(join(root, entry.name))).mtimeMs })));
  candidates.sort((a, b) => b.at - a.at);
  for (const entry of candidates.slice(128)) {
    if (entry.path !== keep && !flights.has(entry.path) && isPathInside(resolve(entry.path), resolve(root))) await rm(entry.path, { recursive: true, force: true });
  }
}

export async function extractDocument(options: DocumentOptions, source: string, maxChars = 250000, signal?: AbortSignal):
    Promise<Extracted & { source: string; format: Format }> {
  signal = AbortSignal.any([application.signal, AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
  signal?.throwIfAborted();
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 2000000) throw new Error("maxChars 必须为 1000–2000000");
  const workspace = await realpath(options.workspaceDir), temp = await realpath(options.tempDir);
  const path = await realpath(resolveToolPath(source, workspace));
  await assertTaskPathAllowed(path);
  if (![workspace, temp].some(root => isPathInside(path, root))) throw new Error("只能解析本群 workspace 或当前用户 tmp 中的文档");
  const extension = extname(path).toLowerCase();
  if (![".pdf", ".docx", ".pptx", ".xlsx"].includes(extension)) throw new Error("仅支持 PDF、DOCX、PPTX、XLSX；扫描件需要 OCR");
  const located = { source: path, format: extension.slice(1) as Format };
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error("文档必须为不超过 128 MiB 的普通文件");
  const digest = await sourceDigest(path, signal);
  const parserIdentity = createHash("sha256").update(await readFile(script)).update(await readFile(lock)).digest("hex");
  const key = createHash("sha256").update(JSON.stringify([digest, extension, parserIdentity, maxChars])).digest("hex");
  // Only shared source material has a group cache. Private generated documents stay in the user's tmp.
  const parent = isPathInside(path, workspace) ? await realpath(dirname(options.indexPath)) : temp;
  const root = join(parent, isPathInside(path, workspace) ? "parsed" : ".document-cache");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || !isPathInside(await realpath(root), parent)) throw new Error("解析缓存目录越界");
  const dir = join(root, key);
  try { if ((await lstat(dir)).isSymbolicLink()) throw new Error("解析缓存目录不能是链接"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const cached = await validCache(dir, digest, signal);
  if (cached) return { ...cached, ...located };
  let flight = flights.get(dir);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    const budget = AbortSignal.any([application.signal, controller.signal, AbortSignal.timeout(180000)]);
    flight = { controller, consumers: 0, done: false, promise: Promise.resolve(null as unknown as Extracted) };
    const owner = flight;
    owner.promise = application.track((async () => {
      const release = await parserSlots.acquire(budget);
      const backend = configuredRootlessTasks();
      let isolated: IsolatedTask | undefined;
      let snapshot: string | undefined, output: string | undefined;
      try {
        const existing = await validCache(dir, digest, budget);
        if (existing) return existing;
        if (!backend && !await ensureDocumentToolchain(options.venvDir, budget)) throw new Error("文档解析环境不可用");
        isolated = await backend?.create(temp);
        snapshot = join(isolated?.path ?? temp, ".document-" + randomUUID());
        output = join(isolated?.path ?? temp, ".extracted-" + randomUUID());
        let bytes = 0;
        await pipeline(createReadStream(path), new Transform({ transform(chunk: Buffer, _encoding, next) {
          bytes += chunk.length;
          next(bytes > MAX_SOURCE_BYTES ? new Error("文档在读取时增长超过上限") : null, chunk);
        } }), createWriteStream(snapshot, { flags: "wx", mode: 0o600 }), { signal: budget });
        if (await hashFile(snapshot, budget) !== digest) throw new Error("文档在同步过程中发生变化，请重新调用解析工具");
        const scratch = isolated?.path ?? temp;
        const execution = { command: isolated ? ISOLATED_PYTHON : venvPythonPath(options.venvDir), args: [script, snapshot, extension, output, String(maxChars)],
          cwd: scratch, timeoutMs: 120000, signal: budget,
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", TMP: scratch, TEMP: scratch, TMPDIR: scratch } };
        const result = isolated ? await isolated.run(execution, [dirname(script)]) : await runProcess(execution);
        if (result.exitCode !== 0) throw new Error("文档解析失败：" + result.output.slice(-1200));
        const metadata = JSON.parse(result.output.trim());
        await mkdir(dir, { recursive: true });
        if ((await lstat(dir)).isSymbolicLink() || !isPathInside(await realpath(dir), root)) throw new Error("解析缓存目录已改变");
        const textHash = await hashFile(output, budget);
        await rename(output, join(dir, "text.txt"));
        const manifest = join(dir, ".metadata-" + randomUUID());
        await writeFile(manifest, JSON.stringify({ ...metadata, digest, textHash, parserIdentity }), { mode: 0o600 });
        await rename(manifest, join(dir, "metadata.json"));
        await pruneCache(root, dir).catch(error => log.warn("解析缓存清理延后: " + String(error)));
        return { path: join(dir, "text.txt"), digest, ...metadata, cacheHit: false } as Extracted;
      } finally {
        try {
          if (isolated) { await isolated.seal(); await backend!.reclaim(isolated.id); }
          else if (process.platform !== "linux") await Promise.allSettled([snapshot && rm(snapshot, { force: true }), output && rm(output, { force: true })]);
          else if (snapshot) log.warn("共享解析临时文件保留待物理回收：" + snapshot + " / " + output);
        } finally { release(); }
      }
    })()).finally(() => { owner.done = true; if (flights.get(dir) === owner) flights.delete(dir); });
    flights.set(dir, owner);
  }
  flight.consumers++;
  try { return { ...await waitFor(flight.promise, signal), ...located }; }
  finally {
    flight.consumers--;
    if (!flight.consumers && !flight.done) flight.controller.abort(new Error("文档解析调用已全部取消"));
  }
}

const extractOutput = Type.Object({
  source: Type.String({ description: "原件的实际路径" }),
  format: Type.Union([Type.Literal("pdf"), Type.Literal("docx"), Type.Literal("pptx"), Type.Literal("xlsx")]),
  path: Type.String({ description: "提取出的文本文件，用 read/bash 按需读取" }),
  digest: Type.String({ description: "原件内容的 SHA-256 摘要" }),
  units: Type.Integer({ minimum: 0, description: "已提取的页（PDF）、正文块（DOCX）、幻灯片（PPTX）或工作表（XLSX）数" }),
  characters: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean({ description: "为 true 时文本不完整" }),
  cacheHit: Type.Boolean(),
  warnings: Type.Array(Type.String()),
}, { additionalProperties: false });

export function buildDocumentEnvironmentTool(venvDir: string): ToolDefinition {
  return {
    name: "document_environment", label: "文档解析环境", description: "查询并按需准备本群固定版本的文档解析环境；成功后返回解释器位置。失败时说明能力不可用，不自行安装或修改共享环境。",
    parameters: Type.Object({}),
    // 按需建立本群固定版本的环境（会下载依赖），环境已就绪时重复调用不再改动。
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async execute(_id, _params, toolSignal) {
      const backend = configuredRootlessTasks();
      if (backend) {
        const temp = resolve("data/runtime/tmp/document-toolchain"); await mkdir(temp, { recursive: true });
        const task = await backend.create(temp);
        try {
          const result = await task.run({ command: ISOLATED_PYTHON, args: ["-c", "import pptx,docx,openpyxl,pypdf,pandas,numpy,dateutil,xlsxwriter,PIL,docxcompose,pypdfium2,lxml"],
            cwd: task.path, timeoutMs: 30_000, signal: toolSignal });
          if (result.exitCode !== 0) throw new Error("镜像中的文档环境不可用：" + result.output.slice(-1200));
          return { content: [{ type: "text" as const, text: "解析环境已验证，PI_PYTHON=" + ISOLATED_PYTHON }], details: {} };
        } finally { await task.seal(); await backend.reclaim(task.id); }
      }
      const ready = await ensureDocumentToolchain(venvDir, toolSignal);
      if (!ready) throw new Error("文档解析环境不可用，请联系管理员检查 uv、网络或部署依赖");
      return { content: [{ type: "text", text: "解析环境已验证，PI_PYTHON=" + venvPythonPath(venvDir) }], details: {} };
    },
  };
}

export function buildDocumentTool(options: DocumentOptions): ToolDefinition {
  const parameters = Type.Object({ source: Type.String(), maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 2000000 })) });
  const tool: ToolDefinition<typeof parameters> = { name: "document_extract", label: "提取文档", description: "提取本群 PDF/DOCX/PPTX/XLSX 文本，按当前文件内容校验并复用缓存；保留页码、幻灯片或 sheet/行号。返回文本文件路径，再用 read/bash 按需检索。",
    parameters, outputSchema: extractOutput,
    // 解析缓存是内部实现，对资料和用户文件只读。
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, signal) {
      const { source, format, path, digest, units, characters, truncated, cacheHit } = await extractDocument(options, params.source, params.maxChars, signal);
      return structuredResult({ source, format, path, digest, units, characters, truncated, cacheHit,
        warnings: truncated ? ["提取已截断；需要更多内容时提高 maxChars 或定向解析原件"] : [] });
    },
  };
  return tool;
}
