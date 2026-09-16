/** Real, offline document operations against an explicitly supplied test venv. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const call = async (name: string, params: object): Promise<any> =>
  (await tools.find(t => t.name === name)!.execute("verify", params, undefined, undefined, {} as never)).details;
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
const preview = await call("document_render", { source: "pages.pdf", pages: [22, 1, 2] });
const officePreviews: unknown[] = [];
if (process.argv.includes("--office")) {
  for (const source of [wordCompose.output, pptPatch.output, "客户方案.docx", "补充页面.pptx"]) {
    officePreviews.push(await call("document_render", { source }));
  }
}
const results = { wordPatch, wordCompose, wordSelection, pptCompose, pptPatch, pptPatchPart: pptPart, preview, officePreviews, sourceDigests };
const report = join(root, "results.json");
await writeFile(report, JSON.stringify(results, null, 2));
console.log(await python("check", workspace, report));
await application.drain();
console.log(JSON.stringify({ status: "passed", report }));
