/** Real, offline document operations against an explicitly supplied test venv. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocumentWorkTools } from "../../src/agent/modules/document-work/tools.ts";
import { documentToolchainReady, venvPythonPath } from "../../src/agent/python-toolchain.ts";
import { runProcess } from "../../src/core/process.ts";
import { application } from "../../src/core/lifecycle.ts";

const environment = process.argv[2];
if (!environment) throw new Error("Usage: bun tests/helpers/document-work-integration.ts <test venv> [--office]");
const venvDir = resolve(environment), project = fileURLToPath(new URL("../../", import.meta.url));
const root = join(project, "tmp", "document-validation", "run-" + crypto.randomUUID());
const workspace = join(root, "workspace"), tempDir = join(root, "user-tmp");
await Promise.all([workspace, tempDir].map(p => mkdir(p, { recursive: true })));
process.chdir(root);
assert.equal(await documentToolchainReady(venvDir), true, "test venv must match uv.lock and Python 3.14");
const fixtureScript = fileURLToPath(new URL("./document-fixtures.py", import.meta.url));
const python = async (...args: string[]) => {
  const result = await runProcess({ command: venvPythonPath(venvDir), args: [fixtureScript, ...args], cwd: root,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: 60000 });
  assert.equal(result.exitCode, 0, result.output);
  return result.output;
};
await python("prepare", workspace);
const sourceDigests: Record<string, string> = {};
for (const name of ["source.docx", "source.pptx", "supplement.docx", "supplement.pptx"]) {
  sourceDigests[name] = createHash("sha256").update(await readFile(join(workspace, name))).digest("hex");
}
const tools = buildDocumentWorkTools({ workspaceDir: workspace, tempDir, venvDir, indexPath: join(root, "index/materials.md") });
const call = async (name: string, params: object): Promise<any> => {
  const details = (await tools.find(t => t.name === name)!.execute("verify", params, undefined, undefined, {} as never)).details;
  for (const job of await readdir(tempDir)) {
    const files = await readdir(join(tempDir, job));
    assert(!files.includes(".work"), "completed job retained source copies or Office intermediates");
    assert(files.every(file => !file.endsWith(".request.json") && !file.startsWith("office-")));
  }
  if (name === "document_render") {
    const preview = details as { images: { path: string }[]; contacts: string[]; report: string; pdf?: string };
    assert.equal(preview.pdf, undefined, "render must not return an intermediate PDF that cleanup removes");
    for (const file of [...preview.images.map(image => image.path), ...preview.contacts, preview.report]) await readFile(file);
  }
  return details;
};
const inspection = async (source: string) => {
  const value = await call("document_inspect", { source });
  return JSON.parse(await readFile(value.inspection, "utf8"));
};
const word = await inspection("source.docx");
const locate = (value: any, text: string) => value.paragraphs.find((p: any) => p.text === text);
const customer = locate(word, "客户A 使用正式产品资料。"), table = locate(word, "本地部署");
const wordPatch = await call("document_patch", { source: "source.docx", digest: word.digest, filename: "客户B方案.docx", edits: [
  { part: customer.part, paragraph: customer.paragraph, before: "客户A", after: "客户B" },
  { part: table.part, paragraph: table.paragraph, before: "本地部署", after: "私有化部署" },
] });
const wordCompose = await call("document_compose", { items: [{ source: wordPatch.output }, { source: "supplement.docx" }] });
const wordSelection = await call("document_compose", { items: [{ source: "source.docx", start: 1, end: 2 }] });
const pptCompose = await call("document_compose", { filename: "客户方案.pptx", items: [
  { source: "source.pptx", slides: [2, 1] }, { source: "supplement.pptx", slides: [1] }, { source: "source.pptx", slides: [2] },
] });
const deck = await inspection(pptCompose.output);
const pptPart = deck.slides[0].part;
const pptText = deck.paragraphs.find((p: any) => p.part === pptPart && p.text === "客户A");
const pptPatch = await call("document_patch", { source: pptCompose.output, digest: deck.digest, edits: [
  { part: pptText.part, paragraph: pptText.paragraph, before: "客户A", after: "客户B" },
] });
await assert.rejects(call("document_patch", { source: "source.docx", digest: "0".repeat(64), edits: [] }), /已变化/);
await assert.rejects(call("document_patch", { source: "source.docx", digest: word.digest, filename: "../overwrite.docx", edits: [] }), /filename/);
await assert.rejects(call("document_compose", { items: [{ source: "source.pptx", slides: [99] }] }), /页码不存在/);
await assert.rejects(call("document_patch", { source: "source.docx", digest: word.digest, edits: [
  { part: customer.part, paragraph: customer.paragraph, before: "原件不存在的文字", after: "不应修改" },
] }), /恰好出现一次/);
// Outline, Markdown builds on fixture templates and inline content inside compose.
const outline = await call("document_inspect", { source: "source.pptx", outline: true });
const wordOutline = await call("document_inspect", { source: "source.docx", outline: true });
const markdown = [
  "# 客户交流目标", "本次交流围绕 **OpenClaw 安全接入** 展开：", "", "- 现状与风险", "  - 二级要点", "- 试点范围", "", "> 依据：正式产品资料 2026-09 版", "",
  "## 组件与适用场景", "| 场景 | 组件 | 前提 |", "|---|---|:--:|", "| 个人使用 | 小卫士 | 可装客户端 |", "| 私有化 | 安全大脑 | 独立资源池 |", "",
  "## 架构示意", '![产品架构](product.png "width=6cm")', "说明文字与图片同页。", "<!-- notes: 讲稿：强调试点先行 -->", "",
  "## 附录：长文", "很长的一段说明文字用于测试自动续页与字号调整。".repeat(120),
].join("\n");
const wordBuild = await call("document_build", { format: "docx", template: "source.docx", content: markdown, title: "客户交流说明", subtitle: "客户交流版", filename: "模板成稿.docx" });
const wordDefault = await call("document_build", { format: "docx", content: markdown, title: "默认版式" });
const slideBuild = await call("document_build", { format: "pptx", template: "source.pptx", content: markdown, title: "交流方案", subtitle: "面向客户", keepSlides: [1, 3], sequence: [1, "content", 3], filename: "模板成稿.pptx" });
const slideDefault = await call("document_build", { format: "pptx", content: markdown, title: "默认版式", cover: false });
const slideInline = await call("document_compose", { filename: "选编加新页.pptx", items: [
  { source: "source.pptx", slides: [2] }, { content: "## 新增页面\n- 要点一\n- 要点二\n\n| A | B |\n|---|---|\n| 1 | 2 |" }, { source: "supplement.pptx", slides: [1] },
] });
const wordInline = await call("document_compose", { filename: "章节加新章.docx", items: [
  { source: "source.docx", start: 1, end: 2 }, { content: "# 补充章节\n1. 第一步\n2. 第二步\n\n![图](product.png)" },
] });
await assert.rejects(call("document_compose", { items: [{ content: "# 无文件" }] }), /第一项/);
await assert.rejects(call("document_build", { format: "pptx", template: "source.docx", content: "# x" }), /格式/);
await assert.rejects(call("document_build", { format: "pptx", template: "source.pptx", content: "# x", keepSlides: [9] }), /页码不存在/);
await assert.rejects(call("document_build", { format: "pptx", template: "source.pptx", content: "# x", keepSlides: [1], sequence: [2, "content"] }), /keepSlides/);
// Automatic and explicit card / timeline layouts, plus image assets pulled out of PDF, PPT and Word.
const layoutMarkdown = [
  "## 三层防护", "围绕三个层面建立防护。", "", "### 终端侧", "- 客户端", "- 行为监控", "", "### 网络侧", "流量识别与阻断。", "", "### 平台侧", "集中分析。", "",
  "## 实施安排", "1. 第一阶段：调研与试点范围确认", "2. 第二阶段：试点部署", "3. 第三阶段：全量推广", "",
  "## 关键能力", "<!-- cards -->", "- 资产识别：自动发现实例", "- 风险检测：覆盖 12 类风险", "- 审计溯源：完整记录调用链", "",
  "## 保持列表", "<!-- plain -->", "1. 第一阶段：调研", "2. 第二阶段：部署", "3. 第三阶段：推广", "",
  "## 无法分段", "<!-- timeline -->", "只有一段文字，没有分段。", "",
  "## 实施流程", "调研评估 → 方案设计 → 试点部署 → 全量推广", "",
  "## 带图标的流程", "<!-- flow -->", "- 🔍 资产识别：自动发现实例", "- 🛡️ 风险检测：覆盖 12 类风险", "- ⚙️ 策略管控：按部门下发策略", "",
  "## 防护体系架构", "### 应用层", "- 客户端", "- 控制台", "### 平台层", "- 安全大脑", "- 策略中心", "- 情报", "### 基础设施层", "资源池与现网防火墙。", "",
  "## 关键指标", "- 135000+：公网暴露实例", "- 512：审计发现漏洞", "- 24h：预警响应时间", "",
  "## 运营闭环", "<!-- cycle -->", "- 监测：持续发现", "- 分析：研判", "- 处置：阻断", "- 复盘：优化", "",
  "## 能力成熟度", "<!-- pyramid -->", "### 智能防护", "自适应策略", "### 基础防护", "资产识别、审计留痕", "",
  "## 带图标的卡片", "### ⭐ 资产识别", "自动发现实例。", "### 风险检测", "![](product.png)", "覆盖 12 类风险。", "",
  "## 处理流程", "收到告警后按下图处置。", "", "```mermaid", "flowchart TB", "  S([收到告警]) --> A[初判]", "  A --> B{是否高危?}", "  B -- 是 --> C[立即阻断]",
  "  B -- 否 --> D[进入队列]", "  C --> E([结束])", "  D --> E", "  E -.-> A", "```", "",
  "## 无法解析", "```mermaid", "A -->", "```", "",
  "## 图片分层", "<!-- layers -->", "### 应用层", "![](product.png)", "客户端。", "### 平台层", "![](product.png)", "安全大脑。", "",
  "## 指标单位", "- 135,000+ : 公网暴露实例", "- 82 个国家 : 分布范围", "- 14.6%：高危占比", "",
  "## 小数指标", "- 1024.50 GB：已用容量", "- 2048.25 GB：总容量", "- 4096.75 GB：峰值", "",
  "## 年月形小数指标", "- 2000.01 GB：已用容量", "- 2000.02 GB：总容量", "- 2000.03 GB：峰值", "",
  "## 混合小数指标", "- 1024.50 GB：已用容量", "- 2048.01 GB：总容量", "- 4096.75 GB：峰值", "",
  "## 小数指标单位", "- 2000.01GiB：存储", "- 2000.02 ms：延迟", "- 2000.03 万元：投入", "- 2000.04%：增长率", "",
  "## 日期节点", "- 2026年3月：立项", "- 2026.06：试点", "- 2026-09-30：验收", "",
  "## 日期事件", "- 2026年3月立项：完成方案评审", "- 2026年6月试点：两个部门上线", "- 2026年9月验收：全量推广", "",
  "## 数字日期事件", "- 2026.03 立项：完成方案评审", "- 2026.06 上线：两个部门上线", "- 2026.09 UAT：全量验收", "",
  "## 分期安排", "1. 第一阶段（第 1 个月）风险摸底与试点：暴露面探测与资产清点", "2. 第二阶段（第 2-3 个月）能力部署：出口与终端部署", "3. 第三阶段（第 4 个月起）常态运营：巡检与复盘", "",
  "## 宽图说明", "整体架构如下图。", "![架构](product.png)", "",
  "## 未识别列表", "- 资产识别能力（含影子资产发现）：自动发现实例", "- 风险检测能力（含配置基线）：覆盖 12 类风险", "- 审计溯源能力（含调用链）：完整记录",
].join("\n");
const layoutBuild = await call("document_build", { format: "pptx", template: "source.pptx", content: layoutMarkdown, title: "布局", cover: false, filename: "布局.pptx" });
// Edge cases: inherited headers, links to dropped template pages, explicit line breaks, tall table rows, image filters.
const sectionsBuild = await call("document_build", { format: "docx", template: "sections.docx", content: "# 新标题\n\n新正文。", filename: "多节.docx" });
const linkedBuild = await call("document_build", { format: "pptx", template: "linked.pptx", content: "## 新页\n内容", cover: false, keepSlides: [1, 3], sequence: [1, "content", 3], filename: "链接.pptx" });
const longCell = "这是一段很长的说明文字，用来验证单元格换行后的表格分页是否按实际高度计算，而不是按固定行高。".repeat(2);
const overflowBuild = await call("document_build", { format: "pptx", content: [
  "## 逐行文字", Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("  \n"), "",
  "## 长表格", "| 项目 | 说明 |", "|---|---|", `| 首行较长的项目名称用于验证列宽跨页固定 | ${longCell} |`,
  ...Array.from({ length: 9 }, (_, i) => `| 项目${i + 2} | ${longCell} |`),
].join("\n"), cover: false, filename: "溢出.pptx" });
const shapeImages = await call("document_images", { source: "shapes.pptx" });
const filteredImages = await call("document_images", { source: "shapes.pptx", minSize: 1000 });
const bigImages = await call("document_images", { source: "big.pptx" });
const wordFlow = await call("document_build", { format: "docx", template: "source.docx", filename: "流程.docx", title: "流程",
  content: "# 处理流程\n\n```mermaid\nflowchart TB\n  A([开始]) --> B{通过?}\n  B -- 是 --> C([结束])\n  B -- 否 --> A\n```\n\n后续说明。" });
const pdfImages = await call("document_images", { source: "figure.pdf", crops: [{ page: 1, box: [0.1, 0.1, 0.6, 0.9] }] });
const deckImages = await call("document_images", { source: "source.pptx", pages: [1, 2, 3] });
const wordImages = await call("document_images", { source: "source.docx" });
await assert.rejects(call("document_images", { source: "figure.pdf", pages: [9] }), /页码/);
const preview = await call("document_render", { source: "pages.pdf", pages: [22, 1, 2] });
const officePreviews: unknown[] = [];
if (process.argv.includes("--office")) {
  for (const source of [wordCompose.output, pptPatch.output, wordBuild.output, slideBuild.output, slideInline.output, overflowBuild.output]) {
    officePreviews.push(await call("document_render", { source }));
  }
  // The layout deck has grown past the 20-page render default, so ask for every generated page explicitly.
  officePreviews.push(await call("document_render", { source: layoutBuild.output, pages: layoutBuild.build.generatedPages }));
}
const results = { wordPatch, wordCompose, wordSelection, pptCompose, pptPatch, pptPatchPart: pptPart, preview, officePreviews, sourceDigests,
  outline, wordOutline, wordBuild, wordDefault, slideBuild, slideDefault, slideInline, wordInline, layoutBuild, pdfImages, deckImages, wordImages, wordFlow,
  sectionsBuild, linkedBuild, overflowBuild, shapeImages, filteredImages, bigImages };
const report = join(root, "results.json");
await writeFile(report, JSON.stringify(results, null, 2));
console.log(await python("check", workspace, report));
await application.drain();
console.log(JSON.stringify({ status: "passed", report }));
