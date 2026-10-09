// Document tool result protocol with stubbed Python: every success carries structuredContent that matches the tool's
// outputSchema exactly and equals the model-facing text and details; failures throw. Also checks the namespace,
// descriptions and annotations that P1-B moved, and that the send tools are model-only.
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stubDocumentPython } from "./document-python-stub.ts";

const { calls, controls } = await stubDocumentPython();
const { buildDocumentTool } = await import("../../src/agent/document-extract.ts");
const { buildDocumentWorkTools } = await import("../../src/agent/modules/document-work/tools.ts");
const { buildSendTools } = await import("../../src/agent/send-tools.ts");
const { application } = await import("../../src/core/lifecycle.ts");

const root = process.cwd(), workspace = join(root, "workspace"), tempDir = join(root, "user-tmp"), other = join(root, "other-tmp");
await Promise.all([workspace, tempDir, other, join(root, "index")].map((path) => mkdir(path, { recursive: true })));
for (const name of ["资料.docx", "方案.pptx", "补充.pptx", "页面.pdf", "many.pdf"]) await writeFile(join(workspace, name), "fixture " + name);
await writeFile(join(other, "私有.docx"), "another member's file");
const options = { workspaceDir: workspace, tempDir, indexPath: join(root, "index", "materials.md"), venvDir: join(root, "venv") };
const moduleTools = buildDocumentWorkTools(options);
const tools: ToolDefinition[] = [buildDocumentTool(options), ...moduleTools];

/** Strict check: pi-ai's validator coerces and cleans, so the validated copy must equal the original untouched. */
function conforms(tool: ToolDefinition, value: unknown): boolean {
  try {
    const validated = validateToolArguments({ name: tool.name, description: "", parameters: tool.outputSchema! },
      { type: "toolCall", id: "check", name: tool.name, arguments: structuredClone(value) as never });
    return JSON.stringify(validated) === JSON.stringify(value);
  } catch { return false; }
}

const results: Record<string, any> = {};
async function call(name: string, params: Record<string, unknown>, label = name) {
  const tool = tools.find((candidate) => candidate.name === name)!;
  assert.ok(tool.outputSchema, `${name} declares no outputSchema`);
  const result = await tool.execute("call", params as never, undefined, undefined, {} as never);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, undefined, name);
  assert.equal(result.content.length, 1);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), structured, `${name}: text and structuredContent differ`);
  assert.deepEqual(result.details, structured, `${name}: details and structuredContent differ`);
  assert.ok(conforms(tool, structured), `${label} does not match its outputSchema: ${JSON.stringify(structured)}`);
  results[label] = structured;
  return structured as any;
}

// The strict check itself: an extra field, a wrong type or a missing field must fail.
const extractTool = tools[0]!;
const sample = await call("document_extract", { source: "资料.docx" });
assert.equal(conforms(extractTool, { ...sample, extra: 1 }), false);
assert.equal(conforms(extractTool, { ...sample, truncated: "false" }), false);
const { warnings: _dropped, ...missing } = sample;
assert.equal(conforms(extractTool, missing), false);

// document_extract: resolved source, format, page-like units, and truncation reported as a warning.
assert.equal(sample.source, join(workspace, "资料.docx"));
assert.deepEqual([sample.format, sample.units, sample.truncated, sample.cacheHit, sample.warnings], ["docx", 2, false, false, []]);
assert.equal(await readFile(sample.path, "utf8"), "fixture 资料.docx");
const again = await call("document_extract", { source: join(workspace, "资料.docx") }, "extract-again");
assert.deepEqual({ ...again, cacheHit: false }, sample, "the same document gives the same result apart from cacheHit");
const cut = await call("document_extract", { source: "方案.pptx", maxChars: 1000 }, "extract-truncated");
assert.equal(cut.truncated, true);
assert.match(cut.warnings.join(""), /提取已截断/);

// document-work: each tool once, both formats where they differ.
const word = await call("document_inspect", { source: "资料.docx", outline: true }, "inspect-docx");
assert.deepEqual([word.format, word.paragraphs, word.blocks, word.slides, word.outline.headings.length], ["docx", 2, 2, undefined, 1]);
const deck = await call("document_inspect", { source: "方案.pptx", outline: true }, "inspect-pptx");
assert.deepEqual([deck.slides, deck.blocks, deck.outline.slides.length], [2, undefined, 2]);
assert.equal(JSON.parse(await readFile(deck.inspection, "utf8")).paragraphs.length, 2);
const patched = await call("document_patch", { source: "资料.docx", digest: word.digest,
  edits: [{ part: "word/document.xml", paragraph: 1, before: "客户A", after: "客户B" }] });
assert.deepEqual([patched.visuallyReviewed, patched.format], [false, "docx"]);
assert.ok(patched.output.startsWith(tempDir) && patched.provenance.startsWith(tempDir));
const wordComposed = await call("document_compose", { items: [{ source: "资料.docx" }, { content: "# 补充\n正文" }] }, "compose-docx");
assert.equal(wordComposed.build, undefined, "Word compose reports no page layouts");
const slides = await call("document_compose", { filename: "选编.pptx", items: [{ source: "方案.pptx", slides: [2] }, { content: "## 新页\n- 要点" },
  { source: "补充.pptx", slides: [1] }] }, "compose-pptx");
assert.ok(slides.warnings.includes("来源母版不同，已沿用第一份来源"));
assert.deepEqual([slides.slides, slides.build], [3, { generatedPages: [2], layouts: [], attention: [] }]);
// Content pages are reported at their output positions: a page selected twice takes two places, several content
// items each add their pages, a diagram that falls back is only in attention, and reused source pages are never generated.
const mixed = await call("document_compose", { filename: "穿插.pptx", items: [{ source: "方案.pptx", slides: [2, 2] },
  { content: "## 卡片页\n<!-- cards -->\n- 一\n- 二\n- 三" }, { source: "补充.pptx", slides: [1] },
  { content: "## 回退的时间轴\n<!-- timeline -->\n只有一段。\n\n## 普通页\n正文" }, { source: "方案.pptx", slides: [1] }] }, "compose-mixed");
assert.deepEqual([mixed.slides, mixed.build], [7, { generatedPages: [3, 5, 6], layouts: [{ page: 3, mode: "cards", segments: 3 }],
  attention: [{ page: 5, reason: "timeline内容过长，已按普通版式排版" }] }]);
const reused = await call("document_compose", { items: [{ source: "方案.pptx", slides: [1, 1] }, { source: "补充.pptx" }] }, "compose-no-content");
assert.deepEqual([reused.slides, reused.build], [4, undefined]);
const built = await call("document_build", { format: "pptx", template: "方案.pptx", content: "## 新页\n<!-- cards -->\n![图](missing.png)", keepSlides: [1] }, "build-pptx");
assert.deepEqual(built.build.layouts, [{ page: 2, mode: "cards", segments: 3 }]);
assert.ok(built.warnings.includes("图片不存在，已跳过：missing.png"));
const plain = await call("document_build", { format: "docx", content: "# 标题\n正文" }, "build-docx");
assert.deepEqual(plain.build, { headings: 2, templated: false });
// outline comes only from document_inspect, build only from document_build (always) and document_compose (PPT with
// content, only the three page lists), so only they declare it.
const toolNamed = (name: string) => tools.find((tool) => tool.name === name)!;
const properties = (name: string) => (toolNamed(name).outputSchema as { properties: Record<string, any> }).properties;
for (const tool of moduleTools) {
  assert.equal("outline" in properties(tool.name), tool.name === "document_inspect", `${tool.name} and outline`);
  assert.equal("build" in properties(tool.name), ["document_build", "document_compose"].includes(tool.name), `${tool.name} and build`);
}
const { build: _build, ...unbuilt } = plain;
assert.equal(conforms(toolNamed("document_build"), unbuilt), false, "document_build without build");
assert.deepEqual(Object.keys(properties("document_compose").build.properties), ["generatedPages", "layouts", "attention"]);
assert.equal(conforms(toolNamed("document_compose"), { ...slides, build: { ...slides.build, keptPages: [1] } }), false, "compose build with keptPages");
const preview = await call("document_render", { source: "页面.pdf", pages: [2] });
assert.deepEqual([preview.pages, preview.unrenderedPages, preview.visuallyReviewed, preview.warnings], [3, [1, 3], false, []]);
const pictures = await call("document_images", { source: "页面.pdf", crops: [{ page: 1, box: [0.1, 0.1, 0.5, 0.5] }] });
assert.deepEqual([pictures.truncated, pictures.images.length, pictures.crops.length, pictures.skipped.limit], [false, 2, 1, 0]);
const many = await call("document_images", { source: "many.pdf" }, "images-many");
assert.deepEqual([many.truncated, many.images.length, many.skipped.limit], [true, 60, 3]);
assert.match(many.warnings.join(""), /60 张上限/);

// Failures throw with the reason; nothing comes back as a successful result.
await assert.rejects(tools[0]!.execute("call", { source: join(other, "私有.docx") } as never, undefined, undefined, {} as never), /只能解析/);
const patch = tools.find((tool) => tool.name === "document_patch")!;
await assert.rejects(patch.execute("call", { source: "资料.docx", digest: "0".repeat(64),
  edits: [{ part: "word/document.xml", paragraph: 1, before: "客户A", after: "客户B" }] } as never, undefined, undefined, {} as never), /原文件已变化/);
const compose = tools.find((tool) => tool.name === "document_compose")!;
await assert.rejects(compose.execute("call", { items: [{ content: "# 无文件" }] } as never, undefined, undefined, {} as never), /第一项/);
// A compose that fails after building a content item, or whose assembled deck does not have the selected pages (so the
// page numbers could not be mapped), leaves no job directory behind.
const jobs = async () => (await readdir(tempDir)).sort();
const jobsBefore = await jobs();
await assert.rejects(compose.execute("call", { items: [{ source: "方案.pptx" }, { content: "## 新页" }, { source: "资料.docx" }] } as never,
  undefined, undefined, {} as never), /相同格式/);
controls.extraComposedPages = -1;
await assert.rejects(compose.execute("call", { items: [{ source: "方案.pptx", slides: [1] }, { content: "## 新页" }] } as never,
  undefined, undefined, {} as never), /组装结果 1 页，与选择的 2 页不符/);
controls.extraComposedPages = 0;
if (process.platform === "linux") {
  const added = (await jobs()).filter(name => !jobsBefore.includes(name)); assert.equal(added.length, 2);
  for (const name of added) assert.equal(JSON.parse(await readFile(join(tempDir, name, ".reclamation.json"), "utf8")).status, "deferred");
} else assert.deepEqual(await jobs(), jobsBefore);

// One namespace for the module, short descriptions, the long guidance in the namespace and the skill.
const namespace = moduleTools[0]!.namespace!;
assert.equal(namespace.name, "document_work");
for (const tool of moduleTools) {
  assert.equal(tool.namespace, namespace, `${tool.name} has its own namespace object`);
  assert.ok(tool.description.length <= 320, `${tool.name} description is ${tool.description.length} chars`);
  assert.ok(!tool.description.includes("<!-- cards"), `${tool.name} still carries the Markdown guide`);
}
for (const phrase of ["digest", "恰好出现一次", "第一项必须是文件", "keepSlides", "sequence", "visuallyReviewed", "truncated", "<!-- cards", "```mermaid", "<!-- notes:"]) {
  assert.ok(namespace.instructions!.includes(phrase), `namespace instructions lack ${phrase}`);
}
const guide = await readFile(new URL("../../src/agent/modules/document-work/skills/document-work/references/build.md", import.meta.url), "utf8");
for (const phrase of ["<!-- notes:", "<!-- cards -->", "<!-- timeline -->", "```mermaid", "width=8cm", "`---`", "build.layouts", "build.attention", "keepSlides"]) {
  assert.ok(guide.includes(phrase), `references/build.md lacks ${phrase}`);
}
assert.equal(tools[0]!.namespace, undefined, "document_extract stays outside the module namespace");

// Annotations describe semantics only; the send tools are declared to the model but not callable from scripts.
const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
for (const name of ["document_extract", "document_inspect"]) assert.equal(annotations[name]?.readOnlyHint, true, name);
for (const name of ["document_patch", "document_compose", "document_build", "document_render", "document_images"]) {
  assert.deepEqual([annotations[name]?.readOnlyHint, annotations[name]?.destructiveHint, annotations[name]?.openWorldHint], [false, false, false], name);
}
const send = buildSendTools({ getCallbackUrl: () => "https://im.zdxlz.com/x", groupId: "group", workspaceDir: workspace, tempDir,
  notes: { add() {} } as never });
for (const tool of send) {
  assert.equal(tool.exposure, "model-only", tool.name);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, tool.name);
}

assert.deepEqual([...new Set(calls)].sort(), ["build", "compose_slides", "compose_word", "extract", "finalize_slides", "images", "inspect", "patch", "render"]);
await writeFile(join(root, "protocol-results.json"), JSON.stringify(results, null, 2));
await application.drain();
console.log("DOCUMENT_PROTOCOL_PASSED");
