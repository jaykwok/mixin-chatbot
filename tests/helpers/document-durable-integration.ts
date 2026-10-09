/**
 * Real, offline document work through the Durable engine (D2-4; the D2-P re-check): the group registry as the service
 * will build it (src/durable/registry.ts) with the document module, a Durable group Harness with the request door, a
 * faux model that writes the scripts, the explicitly supplied test venv and, with --office, LibreOffice for previews.
 * The same scenarios as document-codemode-integration.ts (the AgentSession engine): comparing several materials in
 * parallel, selecting PPT pages with new content, and a Word patch through to its preview, which the model then reads
 * as an image. Synthetic documents only (document-fixtures.py).
 * Usage: bun tests/helpers/document-durable-integration.ts <test venv> [--office]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadModuleDefinitions } from "../../src/agent/modules.ts";
import { groupWorkspaceDir } from "../../src/agent/paths.ts";
import { documentToolchainReady, venvPythonPath } from "../../src/agent/python-toolchain.ts";
import { createOutboundNotes } from "../../src/agent/send-tools.ts";
import { runProcess } from "../../src/core/process.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { groupExtensions } from "../../src/durable/registry.ts";
import { openGroupHarness } from "./durable.ts";

const environment = process.argv[2];
if (!environment) throw new Error("Usage: bun tests/helpers/document-durable-integration.ts <test venv> [--office]");
const office = process.argv.includes("--office");
const venvDir = resolve(environment), project = fileURLToPath(new URL("../../", import.meta.url));
const root = join(project, "tmp", "document-validation", "durable-" + crypto.randomUUID());
await mkdir(root, { recursive: true });
globalThis.fetch = (() => { throw new Error("Unexpected network request"); }) as unknown as typeof fetch;

assert.equal(await documentToolchainReady(venvDir), true, "test venv must match uv.lock and Python 3.14");
const groupRoot = join(root, "groups"), group = "group";
const workspace = groupWorkspaceDir(groupRoot, group);
await mkdir(workspace, { recursive: true });
const fixtures = await runProcess({ command: venvPythonPath(venvDir), args: [fileURLToPath(new URL("./document-fixtures.py", import.meta.url)), "prepare", resolve(workspace)],
  cwd: root, env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: 60000 });
assert.equal(fixtures.exitCode, 0, fixtures.output);

const faux = fauxProvider({ tokensPerSecond: 0 });
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const extensions = groupExtensions({
  root: groupRoot, groupId: group, venvDir, modules: await loadModuleDefinitions({ documentWorkEnabled: true }), relay: null,
  delivery: { callbackUrl: () => { throw new Error("unexpected send"); }, notes: () => createOutboundNotes() },
});
const opened = await openGroupHarness(join(root, "durable.sqlite"), models, { group, extensions });

type Transcript = { messages: readonly Message[] };
const results: Record<string, ToolResultMessage> = {};
const lastResult = (transcript: Transcript) => transcript.messages.findLast((message): message is ToolResultMessage => message.role === "toolResult")!;
const text = (result: ToolResultMessage) => result.content.map((part) => part.type === "text" ? part.text : "").join("");
const output = (key: string) => {
  const value = text(results[key]!);
  assert.equal(results[key]!.isError, false, value);
  return JSON.parse(value.slice(value.indexOf("{")));
};
let calls = 0;
const step = (key: string | undefined, name: string, args: (transcript: Transcript) => Record<string, unknown>) => (transcript: Transcript) => {
  if (key) results[key] = lastResult(transcript);
  return fauxAssistantMessage([fauxToolCall(name, args(transcript) as never, { id: `call-${++calls}` })], { stopReason: "toolUse" });
};
const OFFICE = JSON.stringify(office);
const compare = `
const decks = await Promise.all(["source.pptx", "supplement.pptx"].map((source) => tools.document_inspect({ source, outline: true })));
const texts = await Promise.all(["source.docx", "supplement.docx"].map((source) => tools.document_extract({ source })));
return { decks: decks.map((deck) => ({ source: deck.source, slides: deck.outline.slides.map((slide) => slide.page + " " + slide.title) })),
  texts: texts.map((result) => ({ source: result.source, format: result.format, units: result.units, path: result.path })) };`;
const select = `
const deck = await tools.document_inspect({ source: "source.pptx", outline: true });
const picked = deck.outline.slides.filter((slide) => /能力|部署/.test(slide.title)).map((slide) => slide.page);
const composed = await tools.document_compose({ filename: "选编方案.pptx", items: [{ source: "source.pptx", slides: picked },
  { content: "## 试点安排\\n1. 第一阶段：调研与范围确认\\n2. 第二阶段：试点部署\\n3. 第三阶段：全量推广" }, { source: "supplement.pptx", slides: [1] }] });
const preview = ${OFFICE} ? await tools.document_render({ source: composed.output }) : null;
return { picked, output: composed.output, slides: composed.slides, warnings: composed.warnings,
  preview: preview && { pages: preview.pages, contacts: preview.contacts, unrenderedPages: preview.unrenderedPages } };`;
const patch = `
const doc = await tools.document_inspect({ source: "source.docx" });
const listing = JSON.parse(await tools.read({ path: doc.inspection }));
const target = listing.paragraphs.find((paragraph) => paragraph.text.includes("客户A"));
const patched = await tools.document_patch({ source: doc.source, digest: doc.digest, filename: "客户B方案.docx",
  edits: [{ part: target.part, paragraph: target.paragraph, before: "客户A", after: "客户B" }] });
const check = await tools.document_extract({ source: patched.output });
const preview = ${OFFICE} ? await tools.document_render({ source: patched.output }) : null;
return { target, output: patched.output, provenance: patched.provenance, extracted: check.path,
  preview: preview && { pages: preview.pages, contacts: preview.contacts, unrenderedPages: preview.unrenderedPages } };`;
try {
  faux.setResponses([
    step(undefined, "codemode", () => ({ code: compare })),
    step("compare", "codemode", () => ({ code: select })),
    step("select", "codemode", () => ({ code: patch })),
    ...office ? [step("patch", "read", (transcript: Transcript) => {
      const value = text(lastResult(transcript));
      return { path: JSON.parse(value.slice(value.indexOf("{"))).preview.contacts[0] };
    }), (transcript: Transcript) => { results.contact = lastResult(transcript); return fauxAssistantMessage("DONE"); }]
      : [(transcript: Transcript) => { results.patch = lastResult(transcript); return fauxAssistantMessage("DONE"); }],
  ]);
  const { conversation } = await memberConversation(opened.harness, group, "alice", { model: { provider: model.provider, modelId: model.id } }, context);
  const settled = await (await conversation.submit({ type: "input", content: "比较资料、选编并改稿" }, context)).wait(context);
  assert.equal(faux.getPendingResponseCount(), 0, JSON.stringify(settled));

  const compared = output("compare");
  assert.deepEqual(compared.decks.map((deck: { slides: string[] }) => deck.slides.length), [3, 1]);
  assert.deepEqual(compared.texts.map((entry: { format: string }) => entry.format), ["docx", "docx"]);
  const selected = output("select");
  // The fixture deck's logical order is 部署, 实施, 能力 (slide1.xml moved last), so the script picks pages 1 and 3.
  assert.deepEqual(compared.decks[0].slides, ["1 第二页：部署", "2 第三页：实施", "3 第一页：能力"]);
  assert.deepEqual(selected.picked, [1, 3]);
  assert.equal(selected.slides, 4);
  const patched = output("patch");
  assert.match(await readFile(patched.extracted, "utf8"), /客户B/);
  assert.doesNotMatch(await readFile(patched.extracted, "utf8"), /客户A 使用/);
  if (office) {
    for (const preview of [selected.preview, patched.preview]) {
      assert.ok(preview.pages > 0 && preview.contacts.length > 0 && preview.unrenderedPages.length === 0, JSON.stringify(preview));
    }
    assert.equal(results.contact!.isError, false, text(results.contact!));
    assert.ok(results.contact!.content.some((part) => part.type === "image"), "the contact sheet was not read as an image");
  }
  const summary = { root, office, compared, selected, patched };
  await writeFile(join(root, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("DOCUMENT_DURABLE_INTEGRATION_PASSED");
} finally { await opened.close(); }
