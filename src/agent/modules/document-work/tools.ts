import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AsyncSemaphore } from "../../../core/async-semaphore.ts";
import { application } from "../../../core/lifecycle.ts";
import { log } from "../../../core/log.ts";
import { runProcess } from "../../../core/process.ts";
import { isPathInside } from "../../paths.ts";
import { resolveToolPath } from "../../tool-path.ts";
import { ensureDocumentToolchain, venvPythonPath } from "../../python-toolchain.ts";
import type { DocumentOptions } from "../../document-extract.ts";
import { markdownToBlocks, type Block } from "./markdown.ts";

const pythonScript = fileURLToPath(new URL("./scripts/document_ops.py", import.meta.url));
const slidesScript = fileURLToPath(new URL("./scripts/compose_slides.ts", import.meta.url));
const slots = new AsyncSemaphore(2);
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
interface Inspection {
  digest: string; format: "docx" | "pptx"; warnings: string[]; truncated: boolean;
  paragraphs: unknown[]; blocks?: unknown[];
  slides?: { page: number; part: string; slideFile: number; hidden: boolean }[];
  size?: { width: number; height: number };
  outline?: unknown;
  build?: { generatedPages?: number[]; keptPages?: number[]; attention?: unknown[]; layouts?: unknown[]; titleStyle?: unknown; layout?: string; headings?: number; templated?: boolean };
}
interface Source { source: string; original: string; digest: string; }
interface Item { source?: string; digest?: string; slides?: number[]; start?: number; end?: number; content?: string; }
interface BuildRequest {
  format: "docx" | "pptx"; output: string; blocks: Block[]; assets: Record<string, string>;
  template?: string; title?: string; subtitle?: string; cover?: boolean; sequence?: (number | "content")[]; styleFrom?: number[];
}
interface Job {
  directory: string; scratch: string; signal: AbortSignal;
  snapshot(source: string, expected?: string, pdf?: boolean): Promise<Source>;
  assets(paths: string[]): Promise<Record<string, string>>;
  python<T>(operation: string, request: object): Promise<{ result: T; report: string }>;
  run(command: string, args: string[]): Promise<void>;
}

async function withJob<T>(options: DocumentOptions, signal: AbortSignal | undefined, task: (job: Job) => Promise<T>): Promise<T> {
  const budget = AbortSignal.any([application.signal, AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
  const release = await slots.acquire(budget);
  let directory: string | undefined, succeeded = false;
  try {
    const workspace = await realpath(options.workspaceDir), temp = await realpath(options.tempDir);
    const output = directory = await mkdtemp(join(temp, "document-work-"));
    const scratch = join(output, ".work");
    await mkdir(scratch);
    const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", XDG_CACHE_HOME: join(scratch, ".cache") };
    let ready = false, totalBytes = 0;
    const run = async (command: string, args: string[]) => {
      const result = await runProcess({ command, args, cwd: scratch, env, signal: budget, timeoutMs: 240000 });
      if (result.exitCode !== 0) throw new Error("文档操作失败：" + result.output.slice(-2000));
    };
    const locate = async (value: string): Promise<string> => {
      const original = await realpath(resolveToolPath(value, workspace));
      if (![workspace, temp].some(root => isPathInside(original, root))) throw new Error("只能读取本群 workspace 或当前用户 tmp 中的文件");
      return original;
    };
    const job: Job = {
      directory: output, scratch, signal: budget, run,
      async snapshot(value, expected, pdf = false) {
        budget.throwIfAborted();
        const original = await locate(value);
        const extension = extname(original).toLowerCase();
        if (!(pdf ? [".docx", ".pptx", ".pdf"] : [".docx", ".pptx"]).includes(extension)) throw new Error("仅支持 DOCX/PPTX，渲染另支持 PDF");
        const info = await stat(original);
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error("文档必须是不超过 128 MiB 的普通文件");
        const source = join(scratch, randomUUID() + extension);
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
      async assets(paths) {
        // Images referenced by Markdown are copied beside the job so Python never reads outside it.
        const copied: Record<string, string> = {};
        for (const value of paths) {
          budget.throwIfAborted();
          let original: string;
          try { original = await locate(value); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          const info = await stat(original);
          if (!info.isFile() || !/\.(png|jpe?g|gif|bmp|tiff?)$/i.test(original)) continue;
          if (info.size > MAX_IMAGE_BYTES) throw new Error("图片超过 32 MiB：" + value);
          totalBytes += info.size;
          if (totalBytes > MAX_BYTES * 2) throw new Error("本次来源总量超过 256 MiB");
          const target = join(scratch, "asset-" + randomUUID() + extname(original).toLowerCase());
          await pipeline(createReadStream(original), createWriteStream(target, { flags: "wx" }), { signal: budget });
          copied[value] = target;
        }
        return copied;
      },
      async python<T>(operation: string, request: object) {
        if (!ready) {
          if (!await ensureDocumentToolchain(options.venvDir, budget)) throw new Error("文档环境不可用，请检查固定依赖环境");
          ready = true;
        }
        const id = randomUUID(), input = join(scratch, id + ".request.json"), report = join(output, id + ".json");
        await writeFile(input, JSON.stringify({ ...request, workdir: scratch }), { flag: "wx" });
        await run(venvPythonPath(options.venvDir), [pythonScript, operation, input, report]);
        return { result: JSON.parse(await readFile(report, "utf8")) as T, report };
      },
    };
    const result = await task(job);
    succeeded = true;
    return result;
  } finally {
    try {
      // Only directories created by this invocation are removed. Successful jobs
      // retain their outputs/reports; failed or cancelled jobs have no deliverable.
      if (directory) await rm(succeeded ? join(directory, ".work") : directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) { log.warn("文档工作目录清理失败：" + String(error)); }
    finally { release(); }
  }
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
    blocks: result.blocks?.length, slides: result.slides?.length, truncated: result.truncated, warnings: result.warnings,
    ...(result.outline ? { outline: result.outline } : {}), ...(result.build ? { build: result.build } : {}) };
}

async function provenance(job: Job, operation: string, sources: Source[], output: string, selection?: unknown) {
  const path = join(job.directory, "provenance.json");
  await writeFile(path, JSON.stringify({ operation, output, sources: sources.map(({ original, digest }) => ({ source: original, digest })), selection }, null, 2));
  return path;
}

async function prepareContent(job: Job, content: string) {
  const parsed = markdownToBlocks(content);
  return { blocks: parsed.blocks, assets: await job.assets(parsed.images), warnings: parsed.warnings };
}

/** Provenance keeps the intent of inline content without duplicating long Markdown. */
function selectionRecord(items: Item[]) {
  return items.map(item => item.content !== undefined
    ? { content: item.content.length > 2000 ? item.content.slice(0, 2000) + "…" : item.content } : item);
}

const MARKDOWN_HINT = "Markdown：#/## 标题（PPT 中起新页）、段落、**粗体**、列表、表格、图片 ![说明](路径 \"width=8cm\")、> 引用、代码块、--- 分页、<!-- notes: 讲稿 -->。PPT 自动图示：页内 2–6 个 ### 短段→多栏卡片（都以“层”结尾→分层架构图），“第一阶段：…”式列表→时间轴，“A → B → C”段落→流程图，纯数字标签列表→数字指标；打算做成某种图示时务必写 <!-- cards | timeline | flow | layers | pyramid | cycle | stats | plain --> 注释，自动识别只是没写注释时的兜底。标签开头的表情符号或 ### 内的一张图片作为图标。```mermaid 代码块（flowchart TB，A --> B{判断?}，B -- 是 --> C）生成带分支、汇合、回退的流程图。";

export function buildDocumentWorkTools(options: DocumentOptions): ToolDefinition[] {
  const inspect = defineTool({
    name: "document_inspect", label: "检查文档结构",
    description: "检查 DOCX/PPTX 内部引用，返回内容清单路径、摘要和数量。清单包含可定位的段落、Word 正文块、PPT 实际页序。outline=true 时直接返回大纲：PPT 每页标题、文字量、图片/表格数与版式，Word 标题层级与可用样式，用于选页、选章节或选模板；完整段落仍在清单文件中，用 read 按需读取。",
    parameters: Type.Object({ source: Type.String(), outline: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source);
        const { result, report } = await job.python<Inspection>("inspect", { ...source, outline: !!params.outline });
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
    description: "按 items 顺序组装同一格式的资料，可混合复用与新增：{source, slides} 选 PPT 实际页码（1 起始，保留来源母版）；{source, start, end} 选 Word 正文块闭区间（省略为全文）；{content} 用 Markdown 在第一份来源的母版/样式上生成新页或新章节。第一项必须是文件，提供页眉页脚、母版及主样式。" + MARKDOWN_HINT,
    parameters: Type.Object({ filename: Type.Optional(Type.String()), items: Type.Array(Type.Object({
      source: Type.Optional(Type.String()), digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      slides: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 200 })),
      start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 200000 })),
    }), { minItems: 1, maxItems: 20 }) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const sources: Source[] = [], prepared: (Item & { slideFiles?: number[] })[] = [];
        let kind: "docx" | "pptx" | undefined, size: string | undefined, slides = 0;
        const contentWarnings: string[] = [];
        if (params.items[0]?.source === undefined) throw new Error("第一项必须是文件来源，作为母版与样式的依据");
        for (const [index, item] of params.items.entries()) {
          if (item.content !== undefined) {
            if (item.source !== undefined || item.slides || item.start !== undefined || item.end !== undefined) throw new Error("content 项不能同时指定 source/slides/start/end");
            const content = await prepareContent(job, item.content);
            contentWarnings.push(...content.warnings);
            const generated = join(job.scratch, "generated-" + index + "." + kind);
            const request: BuildRequest = { format: kind!, output: generated, blocks: content.blocks, assets: content.assets,
              template: sources[0]!.source, cover: false, sequence: [] };
            const { result: built } = await job.python<Inspection>("build", request);
            contentWarnings.push(...built.warnings.filter(warning => !warning.startsWith("包含 ")));
            if (kind === "pptx") {
              const pages = built.slides!.map(s => s.page);
              slides += pages.length;
              if (slides > 200) throw new Error("输出 PPT 须为 1–200 页");
              prepared.push({ source: generated, slides: pages, slideFiles: built.slides!.map(s => s.slideFile) });
            } else prepared.push({ source: generated });
            continue;
          }
          const source = await job.snapshot(item.source!, item.digest);
          const { result } = await job.python<Inspection>("inspect", source);
          if (kind && kind !== result.format) throw new Error("组装来源必须为相同格式；可用 content 项按第一份来源生成补充内容");
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
          const input = join(job.scratch, "compose.json");
          const assembled = join(job.scratch, randomUUID() + ".pptx");
          await writeFile(input, JSON.stringify({ ...request, output: assembled }));
          await job.run(process.execPath, [slidesScript, input]);
          const { result: finalized } = await job.python<Inspection>("finalize_slides", { source: assembled, output });
          processingWarnings = finalized.warnings;
        } else {
          await job.python<Inspection>("compose_word", request);
        }
        const { result, report } = await job.python<Inspection>("inspect", { source: output });
        result.warnings = [...new Set([...result.warnings, ...processingWarnings, ...contentWarnings])];
        const record = await provenance(job, "compose", sources, output, selectionRecord(params.items));
        return response({ ...summary(result), output, inspection: report, provenance: record, visuallyReviewed: false });
      });
    },
  });
  const build = defineTool({
    name: "document_build", label: "按模板生成文档",
    description: "用 Markdown 内容在本群模板（任意同格式 DOCX/PPTX）的母版、版式与样式上生成可编辑的新 Word 或 PPT。Word 继承页面设置、页眉页脚和样式；PPT 继承母版，从模板样例页推断标题样式与内容区域，#/## 起新页，文字超出自动续页并在 build.attention 中提示；build.layouts 列出本次新生成页中实际排成图示的页，描述新页版式时以它为准，新页未列出即普通版式；keepSlides 保留的模板页不在其中，其版式看大纲或渲染图。keepSlides 保留模板指定页（封面、封底等），sequence 决定保留页与新页顺序。无模板时使用默认中文版式。生成后仍需 document_render 检查。" + MARKDOWN_HINT,
    parameters: Type.Object({
      format: Type.Union([Type.Literal("docx"), Type.Literal("pptx")]),
      content: Type.String({ minLength: 1, maxLength: 200000 }),
      template: Type.Optional(Type.String({ description: "本群 workspace 或本用户 tmp 中同格式的模板或样例文件" })),
      title: Type.Optional(Type.String({ maxLength: 200 })), subtitle: Type.Optional(Type.String({ maxLength: 300 })),
      filename: Type.Optional(Type.String()),
      keepSlides: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50, description: "PPT：保留模板中的这些页（实际页码）" })),
      sequence: Type.Optional(Type.Array(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("content")]), { maxItems: 60,
        description: "PPT：输出顺序，元素为保留页页码或 \"content\"（新页插入位置）；默认保留页在前、新页在后" })),
      styleFrom: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 50, description: "PPT：仅从这些模板页推断标题样式与内容版式" })),
      cover: Type.Optional(Type.Boolean({ description: "PPT：有 title 时是否生成封面页，默认 true" })),
    }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const extension = "." + params.format;
        const sources: Source[] = [];
        let template: string | undefined;
        if (params.template) {
          const source = await job.snapshot(params.template);
          if (extname(source.source) !== extension) throw new Error("模板格式必须与 format 一致");
          template = source.source;
          sources.push(source);
        }
        const content = await prepareContent(job, params.content);
        const output = outputPath(job.directory, params.filename, extension);
        const keep = params.keepSlides ?? [];
        if (!template && (keep.length || params.sequence?.some(value => typeof value === "number"))) throw new Error("keepSlides/sequence 需要指定模板");
        const sequence: (number | "content")[] = params.sequence ?? [...keep, "content"];
        for (const item of sequence) if (typeof item === "number" && !keep.includes(item)) throw new Error("sequence 中的页码必须先列入 keepSlides：" + item);
        const request: BuildRequest = { format: params.format, output, blocks: content.blocks, assets: content.assets, template,
          title: params.title, subtitle: params.subtitle, cover: params.cover ?? true, sequence, styleFrom: params.styleFrom };
        const { result, report } = await job.python<Inspection>("build", request);
        result.warnings = [...new Set([...result.warnings, ...content.warnings])];
        const record = await provenance(job, "build", sources, output, { template: params.template, keepSlides: keep, sequence, images: Object.keys(content.assets) });
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
  const images = defineTool({
    name: "document_images", label: "提取图片素材",
    description: "从 PDF、PPTX、DOCX 中提取内嵌的位图图片到本用户 tmp，作为 document_build / document_compose 中 Markdown 图片的素材。PDF 与 PPT 按页提取，返回每张图的页码、像素尺寸和在页面中的位置（box 为页面比例，左上角为原点）；重复出现的图（背景、logo）只保留一次并列出出现页码，fullPage 标记整页大图。矢量图（EMF/WMF/SVG）无法提取，可用 crops 按页面比例截取渲染区域（PDF 直接可用，Office 需要 LibreOffice）。PDF 默认处理前 20 页、PPT 前 50 页，pages 每次最多 50 页；单次最多返回 60 张。",
    parameters: Type.Object({
      source: Type.String({ description: "本群 workspace 或本用户 tmp 中的 PDF/PPTX/DOCX" }),
      pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50, description: "PDF 页码或 PPT 页码；Word 忽略" })),
      minSize: Type.Optional(Type.Integer({ minimum: 16, maximum: 2000, description: "跳过短边小于该像素的图（默认 96，用于滤掉图标）" })),
      crops: Type.Optional(Type.Array(Type.Object({
        page: Type.Integer({ minimum: 1 }),
        box: Type.Array(Type.Number({ minimum: 0, maximum: 1 }), { minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1]，页面宽高比例，左上角为原点" }),
      }), { minItems: 1, maxItems: 20, description: "按渲染页面截取区域，适合矢量图或组合图示" })),
    }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source, undefined, true);
        const { result, report } = await job.python<{ images: unknown[]; crops: unknown[]; warnings: string[] }>("images",
          { ...source, directory: job.directory, pages: params.pages, minSize: params.minSize, crops: params.crops });
        return response({ ...result, report, source: source.original, digest: source.digest });
      });
    },
  });
  return [inspect, patch, compose, build, render, images];
}
