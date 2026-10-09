/**
 * Real LibreOffice previews and crops from deep group directories, through the document tools and the controlled read
 * tool as production builds them: a long group data root, a group directory named by its hash, two members' jobs at
 * once, and a job cancelled while LibreOffice runs.
 * Usage: bun tests/helpers/document-office-integration.ts <test venv> [--root <run directory>]
 * soffice must be on PATH or in the standard Windows install directory.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { buildLocalTools } from "../../src/agent/local-tools.ts";
import { buildDocumentWorkTools } from "../../src/agent/modules/document-work/tools.ts";
import { groupWorkspaceDir, isPathInside, materialsIndexPath, userTempDir } from "../../src/agent/paths.ts";
import { documentToolchainReady, venvPythonPath } from "../../src/agent/python-toolchain.ts";
import { application } from "../../src/core/lifecycle.ts";
import { runProcess } from "../../src/core/process.ts";
import { WindowsHandles } from "../../src/core/windows-handles.ts";
import { launchOfficeAtBarrier } from "./office-start-gate.ts";

const environment = process.argv[2];
if (!environment) throw new Error("Usage: bun tests/helpers/document-office-integration.ts <test venv> [--root <run directory>]");
const venvDir = resolve(environment), project = fileURLToPath(new URL("../../", import.meta.url));
const rootArgument = process.argv.indexOf("--root");
const root = resolve(rootArgument > 0 ? process.argv[rootArgument + 1]! : join(project, "tmp", "document-validation", "office-" + crypto.randomUUID().slice(0, 8)));
await mkdir(root, { recursive: true });
// The toolchain check and the tools write data/runtime/tmp below the cwd; the project root may be read-only (CI's image).
process.chdir(root);
assert.equal(await documentToolchainReady(venvDir), true, "test venv must match uv.lock and Python 3.14");

// Every member's tmp is exactly this long. The previous layout put LibreOffice's profile 42 characters below it
// (<tmp>/document-work-XXXXXX/.work/office-profile), 217 here; on the Windows machine where the failure was measured,
// LibreOffice 26.2 already wrote no PDF from 149. The deepest job file stays under 260 characters, which Python needs on
// Windows without long path support.
const USER_TMP_LENGTH = 175;
const scenarios = [
  { name: "hashed-group", groupId: "mixin:group/需要哈希的群", phone: "13800000001" },
  { name: "long-root", groupId: "group-long-root", phone: "13800000002" },
].map((scenario) => {
  const below = userTempDir("", scenario.groupId, scenario.phone).length + 1;
  const padding = USER_TMP_LENGTH - below - root.length - 1 - scenario.name.length - 1;
  if (padding < 1) throw new Error(`run directory too deep for a ${USER_TMP_LENGTH}-character member tmp; pass a shorter --root`);
  const dataRoot = join(root, scenario.name + "-" + "d".repeat(padding));
  const tempDir = userTempDir(dataRoot, scenario.groupId, scenario.phone);
  assert.equal(tempDir.length, USER_TMP_LENGTH);
  return { ...scenario, dataRoot, tempDir, workspace: groupWorkspaceDir(dataRoot, scenario.groupId) };
});
assert.match(basename(dirname(dirname(dirname(scenarios[0]!.tempDir)))), /^sha256-[0-9a-f]{64}$/);

const fixtureScript = fileURLToPath(new URL("./document-fixtures.py", import.meta.url));
const [hashed, longRoot] = await Promise.all(scenarios.map(async (scenario) => {
  await Promise.all([scenario.workspace, scenario.tempDir, dirname(materialsIndexPath(scenario.dataRoot, scenario.groupId))].map((path) => mkdir(path, { recursive: true })));
  const tools = buildDocumentWorkTools({ workspaceDir: scenario.workspace, tempDir: scenario.tempDir, venvDir,
    indexPath: materialsIndexPath(scenario.dataRoot, scenario.groupId) });
  const local = await buildLocalTools({ workspaceDir: scenario.workspace, tempDir: scenario.tempDir, phone: scenario.phone, groupId: scenario.groupId,
    venvDir, materialsIndexPath: materialsIndexPath(scenario.dataRoot, scenario.groupId) });
  const call = async (name: string, params: object, signal?: AbortSignal): Promise<any> =>
    (await tools.find((tool) => tool.name === name)!.execute("verify", params as never, signal, undefined, {} as never)).structuredContent;
  const read = async (path: string) => (await local.find((tool) => tool.name === "read")!.execute("verify", { path } as never, undefined, undefined, {} as never)).content;
  return { ...scenario, call, read };
})) as [any, any];
const fixtures = await runProcess({ command: venvPythonPath(venvDir), args: [fixtureScript, "prepare", hashed.workspace], cwd: root,
  env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: 60000 });
assert.equal(fixtures.exitCode, 0, fixtures.output);
for (const name of ["source.pptx", "source.docx"]) await cp(join(hashed.workspace, name), join(longRoot.workspace, name));

// LibreOffice profile directories this run created under the system temp.
const systemTemp = tmpdir();
const existing = new Set(await readdir(systemTemp));
const ourProfiles = async () => (await readdir(systemTemp)).filter((name) => name.startsWith("mixin-office-") && !existing.has(name));
interface ProcessEntry { pid: number; parent: number; name: string }
// Process listing without WMI, which a restricted session may refuse: Toolhelp snapshots on Windows, /proc on Linux.
const toolhelp = process.platform === "win32" ? dlopen("kernel32.dll", {
  CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
  Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
}).symbols : undefined;
/** Every running process; exited (zombie) processes are left out. Throws when the list cannot be read. */
async function listProcesses(): Promise<ProcessEntry[]> {
  const list: ProcessEntry[] = [];
  if (toolhelp) {
    const snapshot = toolhelp.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0) as bigint;
    if (snapshot === 0xffffffffffffffffn) throw new Error(`CreateToolhelp32Snapshot failed (${toolhelp.GetLastError()})`);
    const resources = new WindowsHandles({ closeNative: { CloseHandle: handle => toolhelp.CloseHandle(handle), GetLastError: () => toolhelp.GetLastError() } });
    const owner = resources.own(snapshot, "Office process snapshot", "CreateToolhelp32Snapshot");
    let failure: unknown;
    try {
      // PROCESSENTRY32W on x64: pid at 8, parent pid at 32, szExeFile (260 UTF-16 units) at 44, 568 bytes in all.
      const entry = new Uint8Array(568), view = new DataView(entry.buffer);
      view.setUint32(0, entry.byteLength, true);
      if (!toolhelp.Process32FirstW(snapshot, ptr(entry))) throw new Error(`Process32FirstW failed (${toolhelp.GetLastError()})`);
      do {
        const name = Buffer.from(entry.buffer, 44, 520).toString("utf16le");
        list.push({ pid: view.getUint32(8, true), parent: view.getUint32(32, true), name: name.slice(0, name.indexOf("\0")) });
      } while (toolhelp.Process32NextW(snapshot, ptr(entry)));
    } catch (error) { failure = error; throw error; } finally {
      try { owner.close(); }
      catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], "Office 进程快照关闭失败", { cause: failure }); }
    }
    return list;
  }
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const [state, parent] = stat.slice(close + 2).split(" ");
    if (state !== "Z") list.push({ pid: Number(pid), parent: Number(parent), name: stat.slice(stat.indexOf("(") + 1, close) });
  }
  return list;
}
/** The processes this helper started, directly or through others (the tools' supervisor, Python, LibreOffice). */
async function ourProcesses(): Promise<ProcessEntry[]> {
  const list = await listProcesses(), found: ProcessEntry[] = [];
  for (let parents = new Set([process.pid]); parents.size; ) {
    const children = list.filter((entry) => parents.has(entry.parent) && entry.pid !== process.pid && !found.includes(entry));
    found.push(...children);
    parents = new Set(children.map((entry) => entry.pid));
  }
  return found;
}
const isOffice = (entry: ProcessEntry) => /^(soffice|oosplash)/i.test(entry.name);
const isOfficeMain = (entry: ProcessEntry) => /^soffice\.bin$/i.test(entry.name);
/** Width and height of a PNG, from its IHDR chunk. */
async function pngSize(path: string) {
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", path + " is not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
/** A render result that LibreOffice and the PDF renderer really produced, inside the member's tmp. */
async function checkPreview(member: any, preview: any, pages: number, landscape: boolean) {
  assert.equal(preview.pages, pages);
  assert.equal(preview.images.length, pages);
  for (const file of [...preview.images.map((image: { path: string }) => image.path), ...preview.contacts, preview.report]) {
    assert.ok(isPathInside(file, member.tempDir), file + " is outside the member's tmp");
    assert.ok((await stat(file)).size > 0);
  }
  for (const image of preview.images) {
    const size = await pngSize(image.path);
    assert.equal(size.width > size.height, landscape, `${image.path} is ${size.width}x${size.height}`);
  }
  const job = dirname(preview.report);
  assert.ok(!(await readdir(job)).includes(".work"), "completed job kept its .work");
  return job;
}
const results: Record<string, unknown> = { root, systemTemp, userTmpLength: USER_TMP_LENGTH,
  scenarios: scenarios.map(({ name, dataRoot, tempDir }) => ({ name, dataRootLength: dataRoot.length, tempDir })) };
const save = () => writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));

// 1. Deep paths: every scenario renders a deck and a Word file and crops a deck page (cut from its LibreOffice rendering).
// All outcomes are printed before any assertion.
const deepCases = [
  ["render source.pptx", "document_render", { source: "source.pptx" }],
  ["render source.docx", "document_render", { source: "source.docx" }],
  ["crop source.pptx", "document_images", { source: "source.pptx", crops: [{ page: 1, box: [0.05, 0.3, 0.4, 0.75] }] }],
] as const;
const deep: Record<string, any> = {};
for (const member of [hashed, longRoot]) {
  for (const [label, tool, params] of deepCases) {
    const key = `${member.name} ${label}`;
    try {
      const value = await member.call(tool, params);
      deep[key] = { value, member };
      console.log(`deep ${key}: ok; old profile path would have been ${dirname(value.report).length + "/.work/office-profile".length} characters`);
    } catch (error) {
      deep[key] = { error: String(error) };
      console.log(`deep ${key}: FAILED ${String(error).slice(0, 300)}`);
    }
  }
}
results.deep = Object.fromEntries(Object.entries(deep).map(([key, value]) => [key, value.error ?? value.value]));
await save();
for (const [key, { error, value, member }] of Object.entries(deep)) {
  assert.equal(error, undefined, key);
  if (key.endsWith("render source.pptx")) await checkPreview(member, value, 3, true);
  else if (key.endsWith("render source.docx")) await checkPreview(member, value, 1, false);
  else {
    assert.equal(value.crops.length, 1, key);
    const [crop] = value.crops;
    assert.ok(isPathInside(crop.path, member.tempDir), crop.path + " is outside the member's tmp");
    assert.deepEqual(await pngSize(crop.path), { width: crop.width, height: crop.height });
  }
}
assert.deepEqual(await ourProfiles(), [], "profile directory left behind after deep renders");

// 2. Two members at once: each LibreOffice run has its own profile directory and writes only into its member's tmp.
const seen = new Set<string>();
assert.deepEqual((await ourProcesses()).filter(isOfficeMain), [], "a previous conversion left LibreOffice running");
const observedOffice = new Map<number, ProcessEntry>();
let simultaneous = 0, officeAtOnce = 0, officeJobsAtOnce = 0, running = true;
let peakOffice: { entries: ProcessEntry[]; jobRoots: number[]; tree: ProcessEntry[] } | undefined;
const watcher = (async () => {
  while (running) {
    const [current, processes] = await Promise.all([ourProfiles(), ourProcesses()]);
    current.forEach((name) => seen.add(name));
    simultaneous = Math.max(simultaneous, current.length);
    const main = processes.filter(isOfficeMain), byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const roots = new Set(main.map((entry) => {
      let root = entry;
      for (let depth = 0; byPid.has(root.parent); depth++) {
        assert.ok(depth < processes.length, "cyclic process snapshot");
        root = byPid.get(root.parent)!;
      }
      return root.pid;
    }));
    for (const entry of main) observedOffice.set(entry.pid, entry);
    officeAtOnce = Math.max(officeAtOnce, main.length);
    if (roots.size > officeJobsAtOnce || (roots.size === officeJobsAtOnce && main.length >= (peakOffice?.entries.length ?? 0))) {
      officeJobsAtOnce = roots.size; peakOffice = { entries: main, jobRoots: [...roots], tree: processes };
    }
    await Bun.sleep(50);
  }
})();
const previousPath = process.env.PATH;
const gate = join(root, "office-launch-gate");
if (process.platform === "win32") {
  const command = Bun.which("soffice"); assert(command, "the test requires real LibreOffice on PATH");
  assert.equal(typeof launchOfficeAtBarrier, "function");
  await mkdir(gate);
  const script = fileURLToPath(new URL("./office-start-gate.ts", import.meta.url));
  await writeFile(join(gate, "soffice.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  process.env.MIXIN_OFFICE_GATE_ROOT = gate; process.env.MIXIN_OFFICE_GATE_COMMAND = command;
  process.env.PATH = gate + delimiter + previousPath;
}
let hashedWord: any, longDeck: any;
try {
  [hashedWord, longDeck] = await Promise.all([hashed.call("document_render", { source: "source.docx" }), longRoot.call("document_render", { source: "source.pptx" })]);
} finally {
  process.env.PATH = previousPath; delete process.env.MIXIN_OFFICE_GATE_ROOT; delete process.env.MIXIN_OFFICE_GATE_COMMAND;
  running = false; await watcher;
}
await checkPreview(hashed, hashedWord, 1, false);
await checkPreview(longRoot, longDeck, 3, true);
const remainingOffice = (await listProcesses()).filter((entry) => observedOffice.get(entry.pid)?.name === entry.name);
results.concurrent = { launchBarrier: process.platform === "win32" ? (await readdir(gate)).filter(name => name.endsWith(".ready") || name.endsWith(".exit")) : [], profileDirectories: [...seen], simultaneous, officeMainProcessesAtOnce: officeAtOnce,
  officeJobsAtOnce, peakOffice, observedOffice: [...observedOffice.values()], remainingOffice };
await save();
console.log(`concurrent: ${seen.size} profile directories, ${simultaneous} at once; ${officeAtOnce} LibreOffice (soffice.bin) processes at once`);
assert.equal(seen.size, 2);
assert.equal(simultaneous, 2, "the two conversions never ran with separate profiles at the same time");
// A conversion may have several main processes during startup. Prove two separate supervised jobs, with no leftover.
assert.equal(officeJobsAtOnce, 2, "the two conversions never ran LibreOffice in separate process trees at the same time");
assert.deepEqual(remainingOffice, [], "a completed conversion left a LibreOffice process running");
assert.deepEqual(await ourProfiles(), []);
// The controlled read tool keeps members apart: own preview readable, the other member's refused.
assert.ok((await hashed.read(hashedWord.images[0].path)).some((part: { type: string }) => part.type === "image"));
await assert.rejects(hashed.read(longDeck.images[0].path), /仅允许当前用户 tmp/);

// 3. Cancel while LibreOffice runs: the processes exit, the job and its profile are removed, earlier results stay readable.
const jobsBefore = (await readdir(hashed.tempDir)).sort();
// Child processes the helper has anyway (a console host, for one) are not the job's.
const baseline = await ourProcesses();
const ofJob = (entries: ProcessEntry[]) => entries.filter((entry) => !baseline.some((other) => other.pid === entry.pid && other.name === entry.name));
const controller = new AbortController();
const cancelled = hashed.call("document_render", { source: "source.pptx" }, controller.signal);
let settled = false;
const outcome = cancelled.then(() => "resolved", (error: unknown) => String(error)).finally(() => { settled = true; });
let profileName: string | undefined, jobName: string | undefined, job: ProcessEntry[] = [];
for (const started = Date.now(); !(profileName && job.some(isOfficeMain)); await Bun.sleep(50)) {
  assert.ok(!settled, "the job ended before LibreOffice was seen running");
  assert.ok(Date.now() - started < 90000, "LibreOffice never started for the job to cancel");
  [profileName] = await ourProfiles();
  jobName = (await readdir(hashed.tempDir)).find((name) => !jobsBefore.includes(name));
  job = ofJob(await ourProcesses());
}
assert.ok(jobName, "the cancelled job's directory was never seen");
controller.abort();
const reason = await outcome;
const stopped = Date.now();
const stillRunning = async () => { const now = await listProcesses(); return job.filter((entry) => now.some((other) => other.pid === entry.pid && other.name === entry.name)); };
let remaining = await stillRunning();
while (remaining.length && Date.now() - stopped < 10000) { await Bun.sleep(100); remaining = await stillRunning(); }
const observedAfter = Date.now() - stopped, leftOver = ofJob(await ourProcesses());
results.cancel = { profileName, jobName, jobProcessesBeforeCancel: job, reason, remaining, leftOver, exitObservedAfterMs: observedAfter };
await save();
console.log(`cancel: job ran ${job.map((entry) => entry.name).join(", ")}; call ${reason.slice(0, 120)}; ${remaining.length} of them still running ${observedAfter} ms after the call returned`);
assert.notEqual(reason, "resolved");
assert.ok(job.some(isOffice) && job.some((entry) => /^python/i.test(entry.name)), "the job's Python and LibreOffice processes were not identified");
assert.deepEqual(remaining, [], "processes of the cancelled job are still running");
assert.deepEqual(leftOver, [], "the cancelled job left child processes behind");
assert.deepEqual(await ourProfiles(), [], "the cancelled job's profile directory is still there");
assert.deepEqual((await readdir(hashed.tempDir)).sort(), jobsBefore, "the cancelled job's directory is still there");
const earlier = deep[`${hashed.name} render source.pptx`].value;
for (const file of [earlier.images[0].path, earlier.contacts[0], hashedWord.images[0].path]) {
  assert.ok((await hashed.read(file)).some((part: { type: string }) => part.type === "image"), file + " is no longer readable");
}
assert.ok(JSON.parse((await hashed.read(earlier.report))[0].text).pages === 3);

// 4. The same member renders again after the cancellation.
const again = await hashed.call("document_render", { source: "source.pptx" });
await checkPreview(hashed, again, 3, true);
assert.deepEqual(await ourProfiles(), []);
results.after = again;
await save();
await application.drain();
console.log(JSON.stringify({ status: "DOCUMENT_OFFICE_INTEGRATION_PASSED", report: join(root, "results.json") }));
