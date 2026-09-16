import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AsyncSemaphore } from "../../../core/async-semaphore.ts";
import { application } from "../../../core/lifecycle.ts";
import { runProcess } from "../../../core/process.ts";
import { isPathInside } from "../../paths.ts";
import { resolveToolPath } from "../../tool-path.ts";
import { ensureDocumentToolchain, venvPythonPath } from "../../python-toolchain.ts";
import type { DocumentOptions } from "../../document-extract.ts";

const pythonScript = fileURLToPath(new URL("./scripts/document_ops.py", import.meta.url));
const slidesScript = fileURLToPath(new URL("./scripts/compose_slides.ts", import.meta.url));
const slots = new AsyncSemaphore(2);
const MAX_BYTES = 128 * 1024 * 1024;
interface Inspection {
  digest: string; format: "docx" | "pptx"; warnings: string[]; truncated: boolean;
  paragraphs: unknown[]; blocks?: unknown[];
  slides?: { page: number; part: string; slideFile: number; hidden: boolean }[];
  size?: { width: number; height: number };
}
interface Source { source: string; original: string; digest: string; }
interface Item { source: string; digest?: string; slides?: number[]; start?: number; end?: number; }
interface Job {
  directory: string; signal: AbortSignal;
  snapshot(source: string, expected?: string, pdf?: boolean): Promise<Source>;
  python<T>(operation: string, request: object): Promise<{ result: T; report: string }>;
  run(command: string, args: string[]): Promise<void>;
}

async function withJob<T>(options: DocumentOptions, signal: AbortSignal | undefined, task: (job: Job) => Promise<T>): Promise<T> {
  const budget = AbortSignal.any([application.signal, AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
  const release = await slots.acquire(budget);
  try {
    const workspace = await realpath(options.workspaceDir), temp = await realpath(options.tempDir);
    const directory = await mkdtemp(join(temp, "document-work-"));
    const env = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
      PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", XDG_CACHE_HOME: join(directory, ".cache") };
    let ready = false, totalBytes = 0;
    const run = async (command: string, args: string[]) => {
      const result = await runProcess({ command, args, cwd: directory, env, signal: budget, timeoutMs: 240000 });
      if (result.exitCode !== 0) throw new Error("文档操作失败：" + result.output.slice(-2000));
    };
    const job: Job = {
      directory, signal: budget, run,
      async snapshot(value, expected, pdf = false) {
        budget.throwIfAborted();
        const original = await realpath(resolveToolPath(value, workspace));
        if (![workspace, temp].some(root => isPathInside(original, root))) throw new Error("只能读取本群 workspace 或当前用户 tmp 中的文件");
        const extension = extname(original).toLowerCase();
        if (!(pdf ? [".docx", ".pptx", ".pdf"] : [".docx", ".pptx"]).includes(extension)) throw new Error("仅支持 DOCX/PPTX，渲染另支持 PDF");
        const info = await stat(original);
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error("文档必须是不超过 128 MiB 的普通文件");
        const source = join(directory, randomUUID() + extension);
        const hash = createHash("sha256");
        let bytes = 0;
        await pipeline(createReadStream(original), new Transform({ transform(chunk: Buffer, _encoding, next) {
          bytes += chunk.length; totalBytes += chunk.length;
          if (bytes > MAX_BYTES || totalBytes > MAX_BYTES * 2) { next(new Error("单文件超过 128 MiB 或本次来源总量超过 256 MiB")); return; }
          hash.update(chunk); next(null, chunk);
        } }), createWriteStream(source, { flags: "wx" }), { signal: budget });
        const digest = hash.digest("hex");
        if (expected && expected !== digest) throw new Error("原文件已变化，请重新 document_inspect");
        return { source, original, digest };
      },
      async python<T>(operation: string, request: object) {
        if (!ready) {
          if (!await ensureDocumentToolchain(options.venvDir, budget)) throw new Error("文档环境不可用，请检查固定依赖环境");
          ready = true;
        }
        const id = randomUUID(), input = join(directory, id + ".request.json"), report = join(directory, id + ".json");
        await writeFile(input, JSON.stringify(request), { flag: "wx" });
        await run(venvPythonPath(options.venvDir), [pythonScript, operation, input, report]);
        return { result: JSON.parse(await readFile(report, "utf8")) as T, report };
      },
    };
    return await task(job);
  } finally { release(); }
}

function outputPath(directory: string, filename: string | undefined, extension: string): string {
  const name = filename ?? "result" + extension;
  if (name !== basename(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\./i.test(name) ||
      extname(name).toLowerCase() !== extension || name.length > 150) {
    throw new Error("filename 只能是对应格式的文件名，不含目录或特殊路径字符");
  }
  return join(directory, name);
}

function response(details: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function summary(result: Inspection) {
  return { digest: result.digest, format: result.format, paragraphs: result.paragraphs.length,
    blocks: result.blocks?.length, slides: result.slides?.length, truncated: result.truncated, warnings: result.warnings };
}

async function provenance(job: Job, operation: string, sources: Source[], output: string, selection?: unknown) {
  const path = join(job.directory, "provenance.json");
  await writeFile(path, JSON.stringify({ operation, output, sources: sources.map(({ original, digest }) => ({ source: original, digest })), selection }, null, 2));
  return path;
}

export function buildDocumentWorkTools(options: DocumentOptions): ToolDefinition[] {
  const inspect = defineTool({
    name: "document_inspect", label: "检查文档结构",
    description: "检查 DOCX/PPTX 内部引用，返回内容清单路径、摘要和数量。清单包含可定位的段落、Word 正文块、PPT 实际页序；再用 read 按需读取。",
    parameters: Type.Object({ source: Type.String() }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source);
        const { result, report } = await job.python<Inspection>("inspect", source);
        return response({ ...summary(result), inspection: report, source: source.original });
      });
    },
  });
  const patch = defineTool({
    name: "document_patch", label: "局部修改文档",
    description: "在新副本中替换 DOCX/PPTX 指定段落文字，保留未修改的文件部件。digest 和位置来自 document_inspect；before 在目标段落须唯一，支持跨文字片段匹配。输出仍需检查实际版式。",
    parameters: Type.Object({ source: Type.String(), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      filename: Type.Optional(Type.String()), edits: Type.Array(Type.Object({ part: Type.String(),
        paragraph: Type.Integer({ minimum: 1 }), before: Type.String({ minLength: 1, maxLength: 10000 }), after: Type.String({ maxLength: 10000 }) }), { minItems: 1, maxItems: 200 }) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source, params.digest);
        const output = outputPath(job.directory, params.filename, extname(source.source));
        const { result, report } = await job.python<Inspection>("patch", { ...source, output, edits: params.edits });
        const record = await provenance(job, "patch", [source], output, params.edits);
        return response({ ...summary(result), output, inspection: report, provenance: record, visuallyReviewed: false });
      });
    },
  });
  const compose = defineTool({
    name: "document_compose", label: "组装文档",
    description: "按 items 顺序组装同一格式的资料。PPT slides 为实际页码（1 起始），保留来源母版；Word start/end 为正文块闭区间，省略为全文，第一份提供页眉页脚及主样式。可先生成补充文件再组装。",
    parameters: Type.Object({ filename: Type.Optional(Type.String()), items: Type.Array(Type.Object({
      source: Type.String(), digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      slides: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 200 })),
      start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
    }), { minItems: 1, maxItems: 20 }) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const sources: Source[] = [], prepared: (Item & { slideFiles?: number[] })[] = [];
        let kind: string | undefined, size: string | undefined, slides = 0;
        for (const item of params.items) {
          const source = await job.snapshot(item.source, item.digest);
          const { result } = await job.python<Inspection>("inspect", source);
          if (kind && kind !== result.format) throw new Error("组装来源必须为相同格式；可先根据资料生成目标格式的补充文件");
          kind = result.format;
          if (kind === "pptx") {
            if (item.start !== undefined || item.end !== undefined) throw new Error("PPT 使用 slides 页码选择");
            if (size && size !== JSON.stringify(result.size)) throw new Error("PPT 画布尺寸不同，请先按目标尺寸重排需要的页面");
            size = JSON.stringify(result.size);
            const pages = item.slides ?? result.slides!.map(s => s.page);
            const slideFiles = pages.map(page => {
              const found = result.slides!.find(s => s.page === page);
              if (!found) throw new Error("PPT 页码不存在：" + page);
              return found.slideFile;
            });
            slides += slideFiles.length;
            if (!slideFiles.length || slides > 200) throw new Error("输出 PPT 须为 1–200 页");
            prepared.push({ ...item, source: source.source, slideFiles });
          } else {
            if (item.slides !== undefined) throw new Error("Word 使用 start/end 正文块选择");
            prepared.push({ ...item, source: source.source });
          }
          sources.push(source);
        }
        const output = outputPath(job.directory, params.filename, "." + kind);
        const request = { output, items: prepared };
        let processingWarnings: string[] = [];
        if (kind === "pptx") {
          const input = join(job.directory, "compose.json");
          const assembled = join(job.directory, randomUUID() + ".pptx");
          await writeFile(input, JSON.stringify({ ...request, output: assembled }));
          await job.run(process.execPath, [slidesScript, input]);
          const { result: finalized } = await job.python<Inspection>("finalize_slides", { source: assembled, output });
          processingWarnings = finalized.warnings;
        } else {
          await job.python<Inspection>("compose_word", request);
        }
        const { result, report } = await job.python<Inspection>("inspect", { source: output });
        result.warnings = [...new Set([...result.warnings, ...processingWarnings])];
        const record = await provenance(job, "compose", sources, output, params.items);
        return response({ ...summary(result), output, inspection: report, provenance: record, visuallyReviewed: false });
      });
    },
  });
  const render = defineTool({
    name: "document_render", label: "渲染文档预览",
    description: "将 DOCX/PPTX/PDF 渲染为单页 PNG 和联系表，返回图片路径供 read 查看。Office 需要 LibreOffice。默认前 20 页，pages 可指定至多 50 页；明确返回未渲染页。渲染成功不代表已视觉检查。",
    parameters: Type.Object({ source: Type.String(), pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50 })) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source, undefined, true);
        const { result, report } = await job.python<object>("render", { ...source, directory: job.directory, pages: params.pages });
        return response({ ...result, report, source: source.original, digest: source.digest });
      });
    },
  });
  return [inspect, patch, compose, render];
}
