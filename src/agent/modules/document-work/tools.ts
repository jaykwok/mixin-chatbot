import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolAnnotations, type ToolDefinition, type ToolExposure, type ToolNamespace } from "@earendil-works/pi-coding-agent";
import { AsyncSemaphore } from "../../../core/async-semaphore.ts";
import { application } from "../../../core/lifecycle.ts";
import { log } from "../../../core/log.ts";
import { runProcess } from "../../../core/process.ts";
import { assertTaskPathAllowed, configuredRootlessTasks, ISOLATED_PYTHON, type IsolatedTask } from "../../../core/rootless-tasks.ts";
import { holdDirectory } from "../../../core/held-directory.ts";
import { isPathInside } from "../../paths.ts";
import { resolveToolPath } from "../../tool-path.ts";
import { ensureDocumentToolchain, venvPythonPath } from "../../python-toolchain.ts";
import type { DocumentOptions } from "../../document-extract.ts";
import { structuredResult } from "../../structured-result.ts";
import { createOfficeProfile, recoverOfficeProfiles } from "../../office-profiles.ts";
import { markdownToBlocks, type Block } from "./markdown.ts";

const pythonScript = fileURLToPath(new URL("./scripts/document_ops.py", import.meta.url));
const flowchartScripts = fileURLToPath(new URL("./skills/document-work/scripts", import.meta.url));
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
  build?: BuildResult;
}
interface BuildResult {
  generatedPages?: number[]; keptPages?: number[]; attention?: { page: number; reason: string }[];
  layouts?: { page: number; mode: string; segments: number }[]; titleStyle?: unknown; layout?: string; headings?: number; templated?: boolean;
}
interface Rendered { pages: number; images: { page: number; path: string }[]; contacts: string[]; unrenderedPages: number[]; }
interface ImageExtraction {
  pages: number; selectedPages: number[]; images: unknown[]; crops: unknown[]; unsupported: unknown[]; warnings: string[]; directory: string;
  skipped: { small: number; repeated: number; unsupported: number; limit: number };
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
  officeProfile(): Promise<string>;
}

async function withJob<T>(options: DocumentOptions, signal: AbortSignal | undefined, task: (job: Job) => Promise<T>): Promise<T> {
  const budget = AbortSignal.any([application.signal, AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
  const release = await slots.acquire(budget);
  let directory: string | undefined, isolated: IsolatedTask | undefined, profile: Awaited<ReturnType<typeof createOfficeProfile>> | undefined, succeeded = false, failure: unknown;
  const backend = configuredRootlessTasks();
  try {
    const workspace = await realpath(options.workspaceDir), temp = await realpath(options.tempDir);
    await recoverOfficeProfiles(temp, pending => log.warn(`Office 物理回收延后：${pending}`));
    isolated = await backend?.create(temp);
    const output = directory = isolated?.path ?? await mkdtemp(join(temp, "document-work-"));
    const scratch = join(output, ".work");
    await mkdir(scratch);
    const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", XDG_CACHE_HOME: join(scratch, ".cache") };
    let ready = false, totalBytes = 0;
    const run = async (command: string, args: string[]) => {
      const execution = { command, args, cwd: scratch, env, signal: budget, timeoutMs: 240000 };
      const result = isolated
        ? await isolated.run(execution, [dirname(pythonScript), flowchartScripts, ...(command === process.execPath ? [fileURLToPath(new URL("../../../../node_modules", import.meta.url)), process.execPath] : [])])
        : await runProcess(execution);
      if (result.exitCode !== 0) throw new Error("文档操作失败：" + result.output.slice(-2000));
    };
    const locate = async (value: string): Promise<string> => {
      const original = await realpath(resolveToolPath(value, workspace));
      await assertTaskPathAllowed(original);
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
          if (!isolated && !await ensureDocumentToolchain(options.venvDir, budget)) throw new Error("文档环境不可用，请检查固定依赖环境");
          ready = true;
        }
        const id = randomUUID(), input = join(scratch, id + ".request.json"), report = join(output, id + ".json");
        await writeFile(input, JSON.stringify({ ...request, workdir: scratch }), { flag: "wx" });
        const office = (request as Record<string, unknown>).office;
        const args = isolated && typeof office === "string" ? ["-c",
          "import os,runpy,sys; os.mkdir(sys.argv[1]); sys.argv=sys.argv[2:]; runpy.run_path(sys.argv[0],run_name='__main__')", office, pythonScript, operation, input, report]
          : [pythonScript, operation, input, report];
        await run(isolated ? ISOLATED_PYTHON : venvPythonPath(options.venvDir), args);
        return { result: JSON.parse(await readFile(report, "utf8")) as T, report };
      },
      // LibreOffice's user profile gets an empty directory of its own under the system temp instead of the job
      // directory. On one Windows machine, LibreOffice 26.2 exited 0 without writing a PDF once the profile directory
      // reached 149 characters (148 worked), and jobs under the project's data root with a group directory named by its
      // hash were deeper than that. Which step inside LibreOffice fails is not known. Source, TEMP and output stay in the job.
      async officeProfile() {
        if (isolated) return "/tmp/mixin-office-" + isolated.id;
        profile ??= await createOfficeProfile(temp);
        return profile.path;
      },
    };
    const result = await task(job);
    succeeded = true;
    return result;
  } catch (error) { failure = error; throw error; } finally {
    const remove = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(error => log.warn("文档工作目录清理失败：" + String(error)));
    try {
      // Only directories created by this invocation are removed. Successful jobs
      // retain their outputs/reports; failed or cancelled jobs have no deliverable.
      if (isolated) {
        await isolated.seal({ discardScratch: succeeded });
        if (!succeeded) await backend!.reclaim(isolated.id);
      } else if (directory && process.platform === "linux") {
        const held = await holdDirectory(directory, [], false);
        try { await held.use(async entries => {
          const receipt = await entries.create(".reclamation.json");
          try { await receipt.handle.writeFile(JSON.stringify({ version: 1, status: "deferred", reason: "shared-parent-writers-not-isolated", succeeded, at: Date.now() })); await receipt.handle.sync(); }
          finally { await receipt.close(); }
        }); } finally { await held.release(); }
        log.warn("文档工作目录保留待物理回收：" + directory);
      } else if (directory) await remove(succeeded ? join(directory, ".work") : directory);
      if (profile) await profile.close().catch(error => log.warn("Office 配置目录清理失败，记录保留供重启重试：" + String(error)));
    } catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], "文档任务回收失败，保留回执", { cause: failure }); }
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

// 结果协议。顶层字段由下面的函数显式组装，schema 不允许多余字段；outline、build 是 Python 侧的结构，
// 列出 skill 引用的字段，其余字段原样保留。outline 只有 document_inspect(outline=true) 返回；build 只有
// document_build 和含 content 项的 PPT document_compose 返回，后者只含新生成页的三项。各自只写进对应工具的
// schema：共用时模型曾到 document_compose 的结果里找 outline。成功之外一律抛错。
const pages = Type.Array(Type.Integer({ minimum: 1 }));
const outlineSchema = Type.Union([
  Type.Object({ slides: Type.Array(Type.Object({ page: Type.Integer(), layout: Type.String(), title: Type.String(), chars: Type.Integer(),
    pictures: Type.Integer(), tables: Type.Integer(), charts: Type.Integer(), hidden: Type.Boolean() })), layouts: Type.Array(Type.Unknown()) },
    { description: "PPT 大纲：每页推断标题、文字量、图片/表格/图表数与版式" }),
  Type.Object({ headings: Type.Array(Type.Object({ block: Type.Integer(), level: Type.Integer(), text: Type.String() })), styles: Type.Array(Type.String()) },
    { description: "Word 大纲：标题层级与正文块位置、可用样式" }),
]);
const layoutEntries = Type.Array(Type.Object({ page: Type.Integer(), mode: Type.String(), segments: Type.Integer() }),
  { description: "本次新生成页中实际排成图示的页；未列出的新页是普通版式" });
const attentionEntries = Type.Array(Type.Object({ page: Type.Integer(), reason: Type.String() }), { description: "需要重点看图的页及原因" });
const buildSchema = Type.Object({
  generatedPages: Type.Optional(pages), keptPages: Type.Optional(pages),
  layouts: Type.Optional(layoutEntries), attention: Type.Optional(attentionEntries),
});
const composedSchema = Type.Object({ generatedPages: pages, layouts: layoutEntries, attention: attentionEntries },
  { additionalProperties: false, description: "PPT 含 content 项时返回：content 新生成的页，页码为输出文件的页码；复用的来源页不在其中" });
const summaryFields = {
  digest: Type.String({ description: "该文件内容的 SHA-256 摘要，document_patch 等用它确认文件未变" }),
  format: Type.Union([Type.Literal("docx"), Type.Literal("pptx")]),
  paragraphs: Type.Integer({ minimum: 0, description: "清单中可定位的段落数" }),
  blocks: Type.Optional(Type.Integer({ minimum: 0, description: "Word 正文块数" })),
  slides: Type.Optional(Type.Integer({ minimum: 0, description: "PPT 页数" })),
  truncated: Type.Boolean({ description: "为 true 时内容清单不完整" }),
  warnings: Type.Array(Type.String()),
};
const inspectionField = { inspection: Type.String({ description: "完整内容清单（JSON）的路径，用 read 按需读取" }) };
const producedFields = {
  output: Type.String({ description: "生成的新文件" }),
  provenance: Type.String({ description: "来源记录（JSON）的路径" }),
  visuallyReviewed: Type.Literal(false, { description: "工具不看图；用 document_render 看过之后才能说版式已检查" }),
};
const inspectOutput = Type.Object({ source: Type.String({ description: "原件的实际路径" }), ...summaryFields,
  outline: Type.Optional(outlineSchema), ...inspectionField }, { additionalProperties: false });
const producedOutput = Type.Object({ ...summaryFields, ...inspectionField, ...producedFields }, { additionalProperties: false });
const buildOutput = Type.Object({ ...summaryFields, build: buildSchema, ...inspectionField, ...producedFields }, { additionalProperties: false });
const composeOutput = Type.Object({ ...summaryFields, build: Type.Optional(composedSchema), ...inspectionField, ...producedFields },
  { additionalProperties: false });
const renderOutput = Type.Object({
  source: Type.String(), digest: Type.String(),
  pages: Type.Integer({ minimum: 0, description: "文档总页数" }),
  images: Type.Array(Type.Object({ page: Type.Integer(), path: Type.String() }), { description: "逐页 PNG" }),
  contacts: Type.Array(Type.String(), { description: "联系表图片，每张最多 12 页" }),
  unrenderedPages: Type.Array(Type.Integer(), { description: "本次没有渲染的页" }),
  visuallyReviewed: Type.Literal(false),
  warnings: Type.Array(Type.String()),
  report: Type.String(),
}, { additionalProperties: false });
const imagesOutput = Type.Object({
  source: Type.String(), digest: Type.String(),
  pages: Type.Integer({ minimum: 0, description: "PDF/PPT 总页数；Word 为 0" }),
  selectedPages: Type.Array(Type.Integer(), { description: "本次处理的页" }),
  images: Type.Array(Type.Object({ page: Type.Integer({ description: "所在页；Word 为图片在正文中的序号" }), pages: pages, path: Type.String(),
    width: Type.Integer(), height: Type.Integer(), box: Type.Union([Type.Array(Type.Number()), Type.Null()]), fullPage: Type.Boolean() })),
  crops: Type.Array(Type.Object({ page: Type.Integer(), box: Type.Array(Type.Number()), path: Type.String(), width: Type.Integer(), height: Type.Integer() })),
  skipped: Type.Object({ small: Type.Integer(), repeated: Type.Integer(), unsupported: Type.Integer(), limit: Type.Integer() },
    { description: "跳过的图片数：太小、重复、格式不支持（EMF/WMF/SVG 等）、超过单次 60 张上限" }),
  unsupported: Type.Array(Type.Unknown()),
  truncated: Type.Boolean({ description: "为 true 时有图片因数量上限没有提取" }),
  warnings: Type.Array(Type.String()),
  directory: Type.String(),
  report: Type.String(),
}, { additionalProperties: false });

function summary(result: Inspection, inspection: string) {
  return { digest: result.digest, format: result.format, paragraphs: result.paragraphs.length,
    ...(result.blocks ? { blocks: result.blocks.length } : {}), ...(result.slides ? { slides: result.slides.length } : {}),
    truncated: result.truncated, warnings: result.warnings,
    ...(result.outline ? { outline: result.outline } : {}), ...(result.build ? { build: result.build } : {}), inspection };
}

function produced(result: Inspection, report: string, output: string, provenance: string) {
  return structuredResult({ ...summary(result, report), output, provenance, visuallyReviewed: false as const });
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

/**
 * PPT compose 的输出按 items 顺序拼接各项的页。content 项生成文件里的页码换算成输出页码；来源页（包括重复选中的页）
 * 只占位置，不算新生成。拼接页数与组装结果不符时换算不可靠，报错而不是给出错页码。
 */
function composedBuild(parts: { pages: number[]; build?: BuildResult }[], outputPages: number) {
  const composed = { generatedPages: [] as number[], layouts: [] as NonNullable<BuildResult["layouts"]>, attention: [] as NonNullable<BuildResult["attention"]> };
  let offset = 0;
  for (const { pages, build } of parts) {
    const at = (page: number) => {
      const index = pages.indexOf(page);
      if (index < 0) throw new Error("生成页 " + page + " 不在组装的页中");
      return offset + index + 1;
    };
    if (build) {
      composed.generatedPages.push(...(build.generatedPages ?? []).map(at));
      composed.layouts.push(...(build.layouts ?? []).map(entry => ({ ...entry, page: at(entry.page) })));
      composed.attention.push(...(build.attention ?? []).map(entry => ({ ...entry, page: at(entry.page) })));
    }
    offset += pages.length;
  }
  if (offset !== outputPages) throw new Error(`组装结果 ${outputPages} 页，与选择的 ${offset} 页不符`);
  return composed;
}

/** Provenance keeps the intent of inline content without duplicating long Markdown. */
function selectionRecord(items: Item[]) {
  return items.map(item => item.content !== undefined
    ? { content: item.content.length > 2000 ? item.content.slice(0, 2000) + "…" : item.content } : item);
}

const MARKDOWN_HINT = "Markdown：#/## 标题（PPT 中起新页）、段落、**粗体**、列表、表格、图片 ![说明](路径 \"width=8cm\")、> 引用、代码块、--- 分页、<!-- notes: 讲稿 -->。PPT 自动图示：页内 2–6 个 ### 短段→多栏卡片（都以“层”结尾→分层架构图），“第一阶段：…”式列表→时间轴，“A → B → C”段落→流程图，纯数字标签列表→数字指标；打算做成某种图示时务必写 <!-- cards | timeline | flow | layers | pyramid | cycle | stats | plain --> 注释，自动识别只是没写注释时的兜底。标签开头的表情符号或 ### 内的一张图片作为图标。```mermaid 代码块（flowchart TB，A --> B{判断?}，B -- 是 --> C）生成带分支、汇合、回退的流程图。";

/**
 * 工具描述只写用途和调用时必须知道的约束；用法细节放在命名空间说明（codemode 脚本用 describeNamespace 读取）
 * 和 document-work skill 里。
 */
const NAMESPACE: ToolNamespace = {
  name: "document_work",
  description: "Word/PPT 文档加工：检查结构、局部修改、选编组装、按模板生成、渲染预览、提取图片素材。",
  instructions: [
    "先读 document-work skill（SKILL.md 和 references/），按任务选主路径：局改 document_inspect → document_patch；选编 document_inspect(outline) → document_compose；新写内容用 document_build 或 document_compose 的 content 项；成品用 document_render 看图。",
    "这些工具只在 codemode 脚本里调用（await tools.document_inspect({...})）。互不依赖的读取用 Promise.all 放进同一个脚本，工具自己限制同时处理的文档数；修改、组装与渲染有先后依赖，逐个 await，前一步失败就停下。看图用脚本外的 read，发送用脚本外的 send_file。",
    "关键限制：document_patch 的 digest、part、paragraph 来自最近一次 document_inspect，before 在目标段落中须恰好出现一次；document_compose 第一项必须是文件，各来源格式相同、PPT 画布尺寸相同，输出 1–200 页；keepSlides、sequence 需要模板，sequence 中的页码须先列入 keepSlides；所有输出只写当前用户 tmp。",
    "结果：成功返回固定字段，脚本拿到的对象与模型看到的 JSON 相同；失败直接报错，脚本里的调用会抛出。warnings 列出被跳过或降级处理的内容；truncated 为 true 表示清单或图片不完整；visuallyReviewed 始终为 false，看过渲染图才能说版式已检查。document_build 和含 content 项的 PPT document_compose 返回 build：build.layouts 是实际排成图示的新页，build.attention 是需要重点看图的页；compose 的页码是输出文件的页码，复用的来源页不在其中。",
    MARKDOWN_HINT,
  ].join("\n\n"),
};
const SKILL_POINTER = "Markdown 写法、图示注释和参数细节见 document-work skill 的 references/build.md。";
// 六个工具不直接声明给模型，只出现在 codemode 的工具清单里（Pi 1.0.0 按每 4 个字符 1 token 估算合计约 1600，
// 在默认 3000 的清单预算内；超出预算的工具不列出，只在命名空间标题上标注）。
const SCRIPT_ONLY: ToolExposure = "codemode";
// 只读资料、只在当前用户 tmp 写新文件；不覆盖已有文件，也不访问外部。
const READS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITES_COPY: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function buildDocumentWorkTools(options: DocumentOptions): ToolDefinition[] {
  const inspect = defineTool({
    name: "document_inspect", label: "检查文档结构", namespace: NAMESPACE, exposure: SCRIPT_ONLY, annotations: READS, outputSchema: inspectOutput,
    description: "检查 DOCX/PPTX 内部引用，返回内容清单路径、摘要和数量。清单包含可定位的段落、Word 正文块、PPT 实际页序。outline=true 时直接返回大纲：PPT 每页标题、文字量、图片/表格数与版式，Word 标题层级与可用样式，用于选页、选章节或选模板；完整段落仍在清单文件中，用 read 按需读取。",
    parameters: Type.Object({ source: Type.String(), outline: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source);
        const { result, report } = await job.python<Inspection>("inspect", { ...source, outline: !!params.outline });
        return structuredResult({ source: source.original, ...summary(result, report) });
      });
    },
  });
  const patch = defineTool({
    name: "document_patch", label: "局部修改文档", namespace: NAMESPACE, exposure: SCRIPT_ONLY, annotations: WRITES_COPY, outputSchema: producedOutput,
    description: "在新副本中替换 DOCX/PPTX 指定段落文字，保留未修改的文件部件。digest 和位置来自 document_inspect；before 在目标段落须唯一，可跨文字片段匹配；只改实际变化的字符，其余保留原格式，新文字格式无法确定时报错。输出仍需检查实际版式。",
    parameters: Type.Object({ source: Type.String(), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      filename: Type.Optional(Type.String()), edits: Type.Array(Type.Object({ part: Type.String(),
        paragraph: Type.Integer({ minimum: 1 }), before: Type.String({ minLength: 1, maxLength: 10000 }), after: Type.String({ maxLength: 10000 }) }), { minItems: 1, maxItems: 200 }) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source, params.digest);
        const output = outputPath(job.directory, params.filename, extname(source.source));
        const { result, report } = await job.python<Inspection>("patch", { ...source, output, edits: params.edits });
        const record = await provenance(job, "patch", [source], output, params.edits);
        return produced(result, report, output, record);
      });
    },
  });
  const compose = defineTool({
    name: "document_compose", label: "组装文档", namespace: NAMESPACE, exposure: SCRIPT_ONLY, annotations: WRITES_COPY, outputSchema: composeOutput,
    description: "按 items 顺序组装同一格式的资料，可混合复用与新增：{source, slides} 选 PPT 实际页码（1 起始，保留来源母版）；{source, start, end} 选 Word 正文块闭区间（省略为全文）；{content} 用 Markdown 在第一份来源的母版/样式上生成新页或新章节。第一项必须是文件，提供页眉页脚、母版及主样式。PPT 含 content 项时，build 按输出页码列出新生成页、实际排成的图示和需重点看图的页。" + SKILL_POINTER,
    parameters: Type.Object({ filename: Type.Optional(Type.String()), items: Type.Array(Type.Object({
      source: Type.Optional(Type.String()), digest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      slides: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 200 })),
      start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 200000 })),
    }), { minItems: 1, maxItems: 20 }) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const sources: Source[] = [], prepared: (Item & { slideFiles?: number[] })[] = [];
        // PPT：每项在输出中依次占用的页（content 项为生成文件的页码）及其生成结果，组装后换算新页的版式结果。
        const parts: { pages: number[]; build?: BuildResult }[] = [];
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
              parts.push({ pages, build: built.build });
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
            parts.push({ pages });
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
        if (kind === "pptx" && parts.some(part => part.build)) result.build = composedBuild(parts, result.slides!.length);
        const record = await provenance(job, "compose", sources, output, selectionRecord(params.items));
        return produced(result, report, output, record);
      });
    },
  });
  const build = defineTool({
    name: "document_build", label: "按模板生成文档", namespace: NAMESPACE, exposure: SCRIPT_ONLY, annotations: WRITES_COPY, outputSchema: buildOutput,
    description: "用 Markdown 内容在本群模板（任意同格式 DOCX/PPTX）的母版、版式与样式上生成可编辑的新 Word 或 PPT；无模板时使用默认中文版式。PPT 中 #/## 起新页，keepSlides 保留模板指定页（封面、封底等），sequence 决定保留页与新页顺序。build.layouts 列出新生成页中实际排成图示的页，描述新页版式时以它为准；build.attention 列出需要重点看图的页。生成后仍需 document_render 检查。" + SKILL_POINTER,
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
        return produced(result, report, output, record);
      });
    },
  });
  const render = defineTool({
    name: "document_render", label: "渲染文档预览", namespace: NAMESPACE, exposure: SCRIPT_ONLY, annotations: WRITES_COPY, outputSchema: renderOutput,
    description: "将 DOCX/PPTX/PDF 渲染为单页 PNG 和联系表，返回图片路径供 read 查看。Office 需要 LibreOffice。默认前 20 页，pages 可指定至多 50 页；明确返回未渲染页。渲染成功不代表已视觉检查。",
    parameters: Type.Object({ source: Type.String(), pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50 })) }),
    async execute(_id, params, signal) {
      return withJob(options, signal, async job => {
        const source = await job.snapshot(params.source, undefined, true);
        const office = extname(source.source) === ".pdf" ? {} : { office: await job.officeProfile() };
        const { result, report } = await job.python<Rendered>("render", { ...source, directory: job.directory, ...office, pages: params.pages });
        return structuredResult({ source: source.original, digest: source.digest, pages: result.pages, images: result.images,
          contacts: result.contacts, unrenderedPages: result.unrenderedPages, visuallyReviewed: false as const, warnings: [], report });
      });
    },
  });
  const images = defineTool({
    name: "document_images", label: "提取图片素材", namespace: NAMESPACE, exposure: SCRIPT_ONLY, annotations: WRITES_COPY, outputSchema: imagesOutput,
    description: "从 PDF、PPTX、DOCX 中提取内嵌的位图图片到本用户 tmp，作为 Markdown 图片的素材；返回每张图的页码、像素尺寸和页面位置（box 为页面比例，左上角为原点），重复出现的图只保留一次。矢量图无法提取，可用 crops 按页面比例截取渲染区域（Office 需要 LibreOffice）。PDF 默认处理前 20 页、PPT 前 50 页，pages 每次最多 50 页；单次最多返回 60 张，超出时 truncated 为 true。",
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
        // Crops of an Office file are cut from its LibreOffice rendering.
        const office = params.crops && extname(source.source) !== ".pdf" ? { office: await job.officeProfile() } : {};
        const { result, report } = await job.python<ImageExtraction>("images",
          { ...source, directory: job.directory, ...office, pages: params.pages, minSize: params.minSize, crops: params.crops });
        return structuredResult({ source: source.original, digest: source.digest, pages: result.pages, selectedPages: result.selectedPages,
          images: result.images, crops: result.crops, skipped: result.skipped, unsupported: result.unsupported,
          truncated: result.skipped.limit > 0, warnings: result.warnings, directory: result.directory, report });
      });
    },
  });
  return [inspect, patch, compose, build, render, images];
}
