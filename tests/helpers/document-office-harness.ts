// LibreOffice's profile directory with stubbed Python: an Office render, or Office crops, get a directory with an owner marker
// their own under the system temp, outside the job directory; PDFs and plain image extraction get none; the directory
// is removed after success, failure and cancellation, and concurrent jobs never share one. The real LibreOffice
// behaviour (deep data roots, process exit after cancel) is checked by document-office-integration.ts.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isPathInside } from "../../src/agent/paths.ts";
import { stubDocumentPython } from "./document-python-stub.ts";

const root = process.cwd(), systemTemp = join(root, "system-temp");
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = systemTemp;
await mkdir(systemTemp);
assert.equal(tmpdir(), systemTemp);
const stub = await stubDocumentPython({ delayMs: 300 });
const { buildDocumentWorkTools } = await import("../../src/agent/modules/document-work/tools.ts");
const { application } = await import("../../src/core/lifecycle.ts");

const workspace = join(root, "workspace");
await mkdir(workspace);
for (const name of ["方案.pptx", "资料.docx", "页面.pdf", "fail.pptx"]) await writeFile(join(workspace, name), "fixture " + name);
const user = async (name: string) => {
  const tempDir = join(root, name, "tmp");
  await mkdir(tempDir, { recursive: true });
  const tools = buildDocumentWorkTools({ workspaceDir: workspace, tempDir, indexPath: join(root, "index", "materials.md"), venvDir: join(root, "venv") });
  const call = (tool: string, params: object, signal?: AbortSignal) =>
    tools.find((candidate) => candidate.name === tool)!.execute("call", params as never, signal, undefined, {} as never);
  return { tempDir, call };
};
const alice = await user("alice"), bob = await user("bob");
const systemEntries = () => readdir(systemTemp);
let expectedProfiles = 0;
const profilesRetained = async () => {
  if (process.platform === "linux") assert.equal((await systemEntries()).length, ++expectedProfiles);
  else assert.deepEqual(await systemEntries(), []);
};
const jobs = async (tempDir: string) => (await readdir(tempDir)).filter(name => name !== ".office-jobs");
/** The requests sent to document_ops.py since `from`, by operation. */
const sent = (from: number, operation: string) => stub.requests.slice(from).filter((entry) => entry.operation === operation);

// An Office render: a fresh profile with one owner marker under the system temp, removed with the job's .work.
let mark = stub.requests.length;
const deck = await alice.call("document_render", { source: "方案.pptx" });
const [render] = sent(mark, "render");
assert.ok(render, "render did not reach document_ops.py");
const profile = render.request.office as string;
assert.equal(dirname(profile), systemTemp);
assert.match(profile.slice(systemTemp.length + 1), /^mixin-office-/);
assert.deepEqual(render.office, { existed: true, entries: 1 });
assert.ok(!isPathInside(profile, alice.tempDir) && !isPathInside(profile, workspace));
await profilesRetained();
const [job] = await jobs(alice.tempDir);
assert.ok(job && (await readdir(join(alice.tempDir, job))).includes(".work") === (process.platform === "linux"));
assert.equal((deck.structuredContent as { pages: number }).pages, 3);

// No LibreOffice, no profile: PDF previews and image extraction without crops.
mark = stub.requests.length;
await alice.call("document_render", { source: "页面.pdf" });
await alice.call("document_images", { source: "方案.pptx" });
await alice.call("document_images", { source: "页面.pdf", crops: [{ page: 1, box: [0.1, 0.1, 0.5, 0.5] }] });
assert.deepEqual(stub.requests.slice(mark).map((entry) => [entry.operation, "office" in entry.request]),
  [["render", false], ["images", false], ["images", false]]);

// Crops of an Office file are cut from its rendering, so they get a profile too.
mark = stub.requests.length;
await alice.call("document_images", { source: "资料.docx", crops: [{ page: 1, box: [0.1, 0.1, 0.5, 0.5] }] });
assert.deepEqual(sent(mark, "images")[0]?.office, { existed: true, entries: 1 });
await profilesRetained();

// A failed conversion removes the job and the profile.
const before = await jobs(alice.tempDir);
mark = stub.requests.length;
await assert.rejects(alice.call("document_render", { source: "fail.pptx" }), /文档操作失败：fixture failure/);
assert.equal(sent(mark, "render")[0]?.office?.existed, true);
await profilesRetained();
if (process.platform !== "linux") assert.deepEqual(await jobs(alice.tempDir), before);

// Cancelling while document_ops.py runs removes the job and the profile; earlier results stay.
mark = stub.requests.length;
const controller = new AbortController();
const cancelled = alice.call("document_render", { source: "资料.docx" }, controller.signal);
const settled = cancelled.then(() => "resolved", () => "rejected");
for (let waited = 0; !sent(mark, "render").length; waited += 10) {
  assert.ok(waited < 5000, "cancelled render never reached document_ops.py");
  await Bun.sleep(10);
}
assert.equal((await systemEntries()).length, expectedProfiles + 1);
controller.abort();
assert.equal(await settled, "rejected");
await profilesRetained();
if (process.platform !== "linux") assert.deepEqual(await jobs(alice.tempDir), before);

// Two members at once: two profile directories, both present while both conversions run, both removed.
mark = stub.requests.length;
await Promise.all([alice.call("document_render", { source: "资料.docx" }), bob.call("document_render", { source: "方案.pptx" })]);
const pair = sent(mark, "render");
assert.equal(pair.length, 2);
assert.ok(pair.every((entry) => entry.office?.existed && entry.office.entries === 1));
assert.notEqual(pair[0]!.request.office, pair[1]!.request.office);
assert.equal(stub.peak.operations, 2);
if (process.platform === "linux") expectedProfiles++;
await profilesRetained();
for (const [member, entry] of [[alice, pair.find((item) => item.request.original.endsWith("资料.docx"))!], [bob, pair.find((item) => item.request.original.endsWith("方案.pptx"))!]] as const) {
  assert.ok(isPathInside(entry.request.directory, member.tempDir), "a job wrote outside its member's tmp");
  const receipts = await readdir(join(member.tempDir, ".office-jobs"));
  if (process.platform === "linux") {
    assert(receipts.some(name => name.endsWith(".deferred.json")));
    for (const name of receipts.filter(value => value.endsWith(".deferred.json"))) assert.equal(JSON.parse(await readFile(join(member.tempDir, ".office-jobs", name), "utf8")).result.status, "deferred");
  } else assert.deepEqual(receipts, [], "profile receipt left behind after completion");
}
await application.drain();
console.log("DOCUMENT_OFFICE_PROFILE_PASSED");
