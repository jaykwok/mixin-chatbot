// Stand-ins for the document tools' Python: answers extract_document.py, document_ops.py and compose_slides.ts with the
// report shapes the real scripts write (trimmed to a few entries), so protocol tests run without a venv. Whether the real
// scripts still produce these shapes is checked against the tools' output schemas by document-work-integration.ts.
// Call stubDocumentPython() before importing the modules under test. Other commands run for real.
import { createHash } from "node:crypto";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { mock } from "bun:test";

const digestOf = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
// A PPTX the stub writes (built or assembled) holds only its page count; any other PPTX has 2 pages.
const deckOf = (pages: number) => "pptx pages " + pages;
const pagesOf = async (path: string) => Number(/^pptx pages (\d+)$/.exec(await readFile(path, "utf8"))?.[1] ?? 2);

async function inspection(path: string, outline = false) {
  const format = extname(path).slice(1);
  const part = format === "docx" ? "word/document.xml" : "ppt/slides/slide1.xml";
  const result: Record<string, unknown> = { format, digest: await digestOf(path), warnings: [], truncated: false,
    paragraphs: [{ part, paragraph: 1, text: "客户A" }, { part, paragraph: 2, text: "正式资料" }] };
  if (format === "docx") result.blocks = [{ block: 1, type: "p", text: "客户A" }, { block: 2, type: "tbl", text: "参数" }];
  else {
    result.size = { width: 12192000, height: 6858000 };
    result.slides = Array.from({ length: await pagesOf(path) }, (_, index) =>
      ({ page: index + 1, part: `ppt/slides/slide${index + 1}.xml`, slideFile: index + 1, hidden: false }));
  }
  if (outline) result.outline = format === "docx"
    ? { headings: [{ block: 1, level: 1, text: "概述" }], tables: 1, inlineImages: 0, styles: ["Heading 1", "Caption"],
        page: { widthCm: 21, heightCm: 29.7 }, header: "" }
    : { slides: [1, 2].map((page) => ({ page, layout: "Title and Content", title: "第 " + page + " 页", chars: 40, pictures: 1, tables: 0,
          charts: 0, groups: 0, hidden: false })), layouts: [{ name: "Title and Content", placeholders: ["TITLE", "BODY"] }],
        titleStyle: { left: 0.5, top: 0.3 }, size: { widthInches: 13.33, heightInches: 7.5 } };
  return result;
}

/**
 * The page plan of a PPT build, as the real builder reports it: an optional cover and one new page per #/## section,
 * kept template pages where `sequence` puts them (new pages at "content", else after them). A section with a layout
 * comment (<!-- cards --> …) is drawn as that diagram with 3 segments; if its title contains "回退" it falls back to
 * the plain layout and is only listed in `attention`.
 */
function slideBuild(request: any) {
  const sections: { title: string; mode?: string }[] = [];
  for (const block of request.blocks) {
    if (block.type === "heading" && block.level <= 2) sections.push({ title: block.runs.map((run: any) => run.text ?? "").join("") });
    else if (block.type === "layout" && sections.length) sections.at(-1)!.mode = block.mode;
  }
  if (!sections.length) sections.push({ title: "概述" });
  const created = (request.title && request.cover !== false ? 1 : 0) + sections.length;
  const sequence: (number | "content")[] = request.sequence ?? [];
  const order = sequence.flatMap((item): (number | "new")[] => item === "content" ? ["new"] : [item]);
  if (!order.includes("new")) order.push("new");
  const pagesOfNew: number[] = [], keptPages: number[] = [];
  let page = 0;
  for (const item of order) {
    if (item === "new") for (let index = 0; index < created; index++) pagesOfNew.push(++page);
    else keptPages.push(++page);
  }
  const sectionPage = (index: number) => pagesOfNew[created - sections.length + index]!;
  const drawn = sections.map((section, index) => ({ ...section, page: sectionPage(index) })).filter((section) => section.mode && section.mode !== "plain");
  return { pages: page, build: { generatedPages: pagesOfNew, keptPages,
    layouts: drawn.filter((section) => !section.title.includes("回退")).map((section) => ({ page: section.page, mode: section.mode!, segments: 3 })),
    attention: drawn.filter((section) => section.title.includes("回退")).map((section) => ({ page: section.page, reason: section.mode + "内容过长，已按普通版式排版" })),
    titleStyle: { left: 0.5, top: 0.3 }, layout: "Title and Content" } };
}

async function answer(operation: string, request: any): Promise<unknown> {
  switch (operation) {
    case "inspect": return inspection(request.source, request.outline);
    case "patch": await copyFile(request.source, request.output); return inspection(request.output);
    case "build": {
      const plan = request.format === "pptx" ? slideBuild(request) : undefined;
      await writeFile(request.output, plan ? deckOf(plan.pages) : "built " + request.format);
      const result = await inspection(request.output);
      result.build = plan ? plan.build : { headings: 2, templated: !!request.template };
      result.warnings = ["图片不存在，已跳过：missing.png"];
      return result;
    }
    case "compose_word": await writeFile(request.output, "composed docx"); return { warnings: [] };
    case "finalize_slides": await copyFile(request.source, request.output); return { warnings: ["来源母版不同，已沿用第一份来源"] };
    case "render": {
      const selected: number[] = request.pages ?? [1, 2, 3];
      return { pages: 3, images: selected.map((page) => ({ page, path: join(request.directory, `page-${String(page).padStart(4, "0")}.png`) })),
        contacts: [join(request.directory, "contact-1.jpg")], unrenderedPages: [1, 2, 3].filter((page) => !selected.includes(page)),
        visuallyReviewed: false };
    }
    case "images": {
      // A source named many.* stands for a document with more images than one call returns.
      const many = basename(request.source).startsWith("many") || basename(String(request.original ?? "")).startsWith("many");
      const directory = join(request.directory, "images");
      const images = Array.from({ length: many ? 60 : 2 }, (_, index) => ({ page: 1 + (index % 3), pages: [1 + (index % 3)],
        path: join(directory, `s${index}.png`), width: 400, height: 300, box: index === 0 ? null : [0.1, 0.2, 0.5, 0.6], fullPage: false,
        ...(index === 1 ? { name: "Picture 3" } : {}) }));
      return { pages: 3, selectedPages: [1, 2, 3], images,
        crops: (request.crops ?? []).map((crop: any, index: number) => ({ page: crop.page, box: crop.box, path: join(directory, `crop-${index}.png`), width: 800, height: 600 })),
        skipped: { small: 1, repeated: 2, unsupported: 1, limit: many ? 3 : 0 }, unsupported: [{ page: 2, name: "Picture 9", format: "emf" }],
        warnings: ["跳过了 1 张矢量或不支持格式的图片（EMF/WMF/SVG 等），可用 crops 从渲染页面截取",
          ...(many ? ["超过单次 60 张上限，另有 3 张未提取；用 pages 分批提取"] : [])], directory };
    }
  }
  throw new Error("unexpected document operation " + operation);
}

/** A document_ops.py request as the stub received it, with whether its `office` directory existed and held anything. */
export interface StubRequest { operation: string; request: any; office?: { existed: boolean; entries: number } }

/**
 * `delayMs` keeps each stubbed Python run busy that long, or until the run is cancelled; `peak` records how many ran
 * at once, separately for extract_document.py (document_extract) and document_ops.py (the document-work tools).
 * A source whose original name starts with "fail" makes document_ops.py exit 1. compose_slides.ts writes a deck with
 * the selected pages plus `controls.extraComposedPages` (to stand for an assembly that lost or gained pages).
 */
export async function stubDocumentPython(options: { delayMs?: number } = {}): Promise<{ calls: string[]; requests: StubRequest[];
  peak: { extract: number; operations: number }; controls: { extraComposedPages: number } }> {
  const calls: string[] = [], requests: StubRequest[] = [], controls = { extraComposedPages: 0 };
  const active = { extract: 0, operations: 0 }, peak = { extract: 0, operations: 0 }, delayMs = options.delayMs ?? 0;
  const toolchain = await import("../../src/agent/python-toolchain.ts");
  const processes = await import("../../src/core/process.ts");
  const run = processes.runProcess;
  mock.module("../../src/agent/python-toolchain.ts", () => ({ ...toolchain,
    ensureDocumentToolchain: async () => true, venvPythonPath: () => "fixture-python" }));
  mock.module("../../src/core/process.ts", () => ({ ...processes, runProcess: async (options: Parameters<typeof run>[0]) => {
    const [script = "", ...rest] = options.args ?? [];
    if (script.endsWith("compose_slides.ts")) {
      calls.push("compose_slides");
      const request = JSON.parse(await readFile(rest[0]!, "utf8"));
      const selected = request.items.reduce((total: number, item: { slideFiles: number[] }) => total + item.slideFiles.length, 0);
      await writeFile(request.output, deckOf(selected + controls.extraComposedPages));
      return { exitCode: 0, output: "" };
    }
    if (options.command !== "fixture-python") return run(options);
    options.signal?.throwIfAborted();
    const kind = script.endsWith("extract_document.py") ? "extract" : "operations";
    peak[kind] = Math.max(peak[kind], ++active[kind]);
    try {
      let request: any;
      if (kind === "operations") {
        request = JSON.parse(await readFile(rest[1]!, "utf8"));
        const office = typeof request.office === "string"
          ? await readdir(request.office).then(entries => ({ existed: true, entries: entries.length }), () => ({ existed: false, entries: 0 })) : undefined;
        requests.push({ operation: rest[0]!, request, ...(office ? { office } : {}) });
      }
      options.signal?.throwIfAborted();
      if (delayMs) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal!.reason); }, { once: true });
      });
      if (kind === "extract") {
        calls.push("extract");
        const [snapshot, , output, limit] = rest;
        const text = await readFile(snapshot!, "utf8");
        await writeFile(output!, text);
        return { exitCode: 0, output: JSON.stringify({ units: 2, truncated: Number(limit) <= 1000, characters: text.length }) };
      }
      const [operation, , report] = rest;
      calls.push(operation!);
      if (basename(String(request.original ?? "")).startsWith("fail")) return { exitCode: 1, output: "fixture failure" };
      await writeFile(report!, JSON.stringify(await answer(operation!, request)));
      return { exitCode: 0, output: "" };
    } finally { active[kind]--; }
  } }));
  return { calls, requests, peak, controls };
}
