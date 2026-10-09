// D23-R2-1, D23-R3-2 and D23-R3-3 interleavings, run in a child process (tests/durable/codemode-paths.test.ts) so the
// paused file-system calls cannot affect other tests. Each scenario runs one codemode script in a fresh group; at one
// real file-system call of the results code (`open`, `rename`, `rm` or `stat` before it runs, `mkdir` or `realpath`
// after), another writer with the member's rights renames or removes Alice's call directory (or `codemode/`) and puts
// a junction (a symlink on Linux) to Bob's tmp in its place, or (Windows) makes it a junction in place, before the
// original call goes on. The changes use the real functions; nothing the code reads is faked. A few scenarios make the
// call fail instead (no /proc, a full disk) to see what the result says.
// Prints one `SCENARIO <json>` line of observations each and `HARNESS_RESULT=<json>`; the test asserts on them.
//   bun tests/helpers/codemode-path-race-harness.ts <fixture-root>
import { mock } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Conversation, defineExtension } from "@earendil-works/pi-durable";
import type { MemberTool } from "../../src/durable/tools.ts";
import { junctionInPlace } from "./junction-in-place.ts";

const actual = { ...fs };
type Point = "open" | "mkdir" | "rename" | "rm" | "realpath" | "stat";
type Hook = {
  point: Point;
  /** The entry's base name and the whole path. */
  match: (name: string, path: string) => boolean;
  /** Fire at the `nth` match (default the first). */
  nth?: number;
  seen?: number;
  /** The other writer's change; its outcome is recorded. */
  act?: () => Promise<string>;
  /** Instead of the call: this error. */
  fail?: (path: string) => Error;
  outcome?: string;
};
let hooks: Hook[] = [];
async function fire(point: Point, path: string) {
  for (const hook of hooks) {
    if (hook.outcome !== undefined || hook.point !== point || !hook.match(basename(path), path)) continue;
    hook.seen = (hook.seen ?? 0) + 1;
    if (hook.seen < (hook.nth ?? 1)) continue;
    hook.outcome = "running";
    hook.outcome = hook.act === undefined ? "failed" : await hook.act();
    if (hook.fail !== undefined) throw hook.fail(path);
  }
}
mock.module("node:fs/promises", () => ({ ...actual,
  async open(...args: Parameters<typeof fs.open>) {
    await fire("open", String(args[0]));
    return actual.open(...args);
  },
  async mkdir(...args: Parameters<typeof fs.mkdir>) {
    const made = await actual.mkdir(...args);
    await fire("mkdir", String(args[0]));
    return made;
  },
  async rename(...args: Parameters<typeof fs.rename>) {
    await fire("rename", String(args[0]));
    return actual.rename(...args);
  },
  async rm(...args: Parameters<typeof fs.rm>) {
    await fire("rm", String(args[0]));
    return actual.rm(...args);
  },
  async realpath(...args: Parameters<typeof fs.realpath>) {
    const real = await actual.realpath(...args);
    await fire("realpath", String(args[0]));
    return real;
  },
  async stat(...args: Parameters<typeof fs.stat>) {
    await fire("stat", String(args[0]));
    return actual.stat(...args);
  },
}));
const { codemodeExtension } = await import("../../src/durable/codemode/index.ts");
const { resultsRoot } = await import("../../src/durable/codemode/results.ts");
const { memberConversation } = await import("../../src/durable/identity.ts");
const { baseMemberTools, memberPlaces, memberRegistration } = await import("../../src/durable/tools.ts");
const { openGroupHarness } = await import("./durable.ts");

const root = process.argv[2]!;
const WINDOWS = process.platform === "win32";
const GROUP = "race-group", ALICE = "+8613800000201", BOB = "+8613800000202";
const LINK = WINDOWS ? "junction" : "dir";
// A 1x1 GIF and a 1x1 PNG.
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
/** Bob's files where Alice's results go if a write follows the swapped path; no index.txt, so a new one shows. */
const BOB_FILES = ["keep.txt", "1.txt", "1.json", "1-1.png", "output.txt", "output-1.gif"];
/** Where the same-inode scenario moves Alice's call directory, in Bob's tmp. */
const MOVED_INTO_BOB = "moved-alice";

function probe(name: string, run: () => AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>, definition: Partial<ToolDefinition> = {}): MemberTool {
  return {
    definition: {
      name, label: name, description: `Fixture tool ${name}.`, exposure: "codemode",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => { throw new Error("fixture tools run through MemberTool.run"); },
      ...definition,
    } as ToolDefinition,
    replay: "unsafe",
    outputLimits: { maxBytes: 64 * 1024, maxLines: 2200 },
    run: async () => run(),
  };
}
const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }], details: undefined });
/** Runs inside a sub-call, after its start line: the scenario's attack between two index lines. */
let during: (() => Promise<string>) | undefined;
let duringOutcome: string | undefined;
const tools = [
  probe("probe_long", () => text("长".repeat(400))),
  probe("probe_json", () => ({ ...text("j"), structuredContent: { value: "j".repeat(400) } }), { outputSchema: Type.Object({ value: Type.String() }) }),
  probe("probe_image", () => ({ content: [{ type: "text", text: "图" }, { type: "image", data: PNG, mimeType: "image/png" }], details: undefined })),
  probe("probe_attack", async () => { duringOutcome = await during?.(); return text("短"); }),
];

let groups = 0;
async function group() {
  const n = ++groups;
  const faux = fauxProvider({ tokenSize: { min: 50, max: 50 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const base = { models, root: join(root, `group-${n}`), groupId: GROUP };
  const members = baseMemberTools(base);
  const extensions = [
    defineExtension({ name: "mixin.base", tools: members.map(memberRegistration) }),
    defineExtension({ name: "fixture.module" }),
    codemodeExtension({ members: base, tools: [...members.map((tool) => ({ extension: "mixin.base", tool })), ...tools.map((tool) => ({ extension: "fixture.module", tool }))] }),
  ];
  const opened = await openGroupHarness(join(root, `db-${n}.sqlite`), models, { group: GROUP, extensions, settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } } });
  const alice = (await memberConversation(opened.harness, GROUP, ALICE, { model: { provider: model.provider, modelId: model.id } }, context)).conversation;
  const aliceTmp = memberPlaces(base, GROUP, ALICE).tempDir, bobTmp = memberPlaces(base, GROUP, BOB).tempDir;
  await actual.mkdir(aliceTmp, { recursive: true });
  await actual.mkdir(bobTmp, { recursive: true });
  for (const name of BOB_FILES) await actual.writeFile(join(bobTmp, name), `Bob ${name}`);
  return { faux, opened, alice, aliceTmp, bobTmp };
}
type Group = Awaited<ReturnType<typeof group>>;

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function run(g: Group, code: string) {
  const id = `race-${groups}`;
  g.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }), fauxAssistantMessage("好的")]);
  await (await g.alice.submit({ type: "input", content: "运行脚本" }, context)).wait(context);
  return resultOf(g.alice, id);
}
async function resultOf(conversation: Conversation, id: string) {
  for (const entry of (await conversation.entries({}, 1000, undefined, context)).items) {
    const message = entry.model?.[0] as { toolCallId?: string; isError: boolean; content: Content[]; details?: { index?: string; fullOutputPath?: string } } | undefined;
    if (entry.kind === "pi.tool-result" && message?.toolCallId === id) return message;
  }
  throw new Error(`no result for ${id}`);
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);
/** The other writer: move (or move into `to`, as `MOVED_INTO_BOB`) or remove `target`, then put a link in its place. */
async function swap(kind: "rename" | "remove" | "into", target: string, to: string): Promise<string> {
  let linkTo = to;
  try {
    if (kind === "rename") await actual.rename(target, `${target}.moved`);
    else if (kind === "into") await actual.rename(target, linkTo = join(to, MOVED_INTO_BOB));
    else await actual.rm(target, { recursive: true, force: true });
  } catch (error) {
    return `refused:${errorCode(error)}`;
  }
  try {
    await actual.symlink(linkTo, target, LINK);
  } catch (error) {
    return `no-link:${errorCode(error)}`;
  }
  return "done";
}
/** Windows: the other writer makes `target` a junction to `to` in place; first removing its files with `clear`. */
async function inPlace(target: string, to: string, clear = false): Promise<string> {
  if (clear) {
    for (const name of await actual.readdir(target)) {
      const removed = await actual.rm(join(target, name), { recursive: true, force: true }).then(() => undefined, errorCode);
      if (removed !== undefined) return `refused:${removed}`;
    }
  }
  const changed = junctionInPlace(target, to);
  return changed.set ? "done" : `refused:${changed.error}`;
}
/** Alice's call directory (the only one in a fresh group's results root). */
async function callDir(g: Group): Promise<string> {
  const names = (await actual.readdir(resultsRoot(g.aliceTmp))).filter((name) => !name.endsWith(".moved"));
  if (names.length !== 1) throw new Error(`expected one call directory, found ${JSON.stringify(names)}`);
  return join(resultsRoot(g.aliceTmp), names[0]!);
}
/** The name of the call directory a group's first call makes (`<task>-<call>`; the call ID is `race-<group>`). */
const isCallDir = (name: string) => /^\d+-race-\d+$/.test(name);

/** Changes in Bob's tmp: new or missing entries, changed files (what the other writer made there is allowed). */
async function bobChanges(g: Group, allowed: { emptyDir?: string; movedDir?: string }): Promise<string[]> {
  const changes: string[] = [];
  const names = (await actual.readdir(g.bobTmp)).sort();
  for (const name of names) {
    if (name === allowed.movedDir) continue;
    if (name === allowed.emptyDir) {
      const inside = await actual.readdir(join(g.bobTmp, name));
      if (inside.length > 0) changes.push(`${name}/ has ${JSON.stringify(inside)}`);
    } else if (!BOB_FILES.includes(name)) changes.push(`new ${name}`);
  }
  for (const name of BOB_FILES) {
    const data = await actual.readFile(join(g.bobTmp, name), "utf8").catch(() => undefined);
    if (data !== `Bob ${name}`) changes.push(`${name}: ${data === undefined ? "missing" : `changed (${data.length} chars)`}`);
  }
  return changes;
}

/** Temporary files left anywhere under `dir` (links are not followed). */
async function leftovers(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await actual.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    const info = await actual.lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      if (WINDOWS && (await actual.readlink(path).then(() => true, () => false))) continue;
      found.push(...await leftovers(path));
    } else if (entry.name.endsWith(".tmp")) found.push(path);
  }
  return found;
}

/**
 * Every path the result gives out (the index, the full output, image labels, sub-call references in the index) must
 * name a file in Alice's real tmp holding what was said; returns the problems and the number of paths checked.
 */
async function checkPaths(g: Group, result: Awaited<ReturnType<typeof resultOf>>, full: string) {
  const problems: string[] = [];
  let checked = 0;
  const aliceReal = await actual.realpath(g.aliceTmp);
  const inside = async (path: string) => {
    checked++;
    const real = await actual.realpath(path).catch(() => undefined);
    const rel = real === undefined ? undefined : relative(aliceReal, real);
    if (rel === undefined || rel.startsWith("..") || rel === "") problems.push(`${path} resolves to ${real ?? "nothing"}`);
    return real !== undefined;
  };
  const text = result.content.map((item) => item.text ?? "").join("\n");
  let indexText = "";
  if (result.details?.index !== undefined && await inside(result.details.index)) {
    indexText = await actual.readFile(result.details.index, "utf8");
    if (!indexText.startsWith("codemode call ")) problems.push(`index ${result.details.index} starts ${JSON.stringify(indexText.slice(0, 40))}`);
  }
  if (result.details?.fullOutputPath !== undefined && await inside(result.details.fullOutputPath)) {
    if (await actual.readFile(result.details.fullOutputPath, "utf8") !== full) problems.push(`full output ${result.details.fullOutputPath} differs`);
  }
  for (const match of text.matchAll(/\[Full output: (.+?) \(read with offset\/limit\)\]/g)) {
    if (match[1] !== result.details?.fullOutputPath) problems.push(`full output ${match[1]} named in the text but not in the details`);
  }
  for (const match of text.matchAll(/\[Image saved to (.+?) \((image\/[a-z]+), \d+B\)\]/g)) {
    if (await inside(match[1]!) && (await actual.readFile(match[1]!)).toString("base64") !== GIF) problems.push(`image ${match[1]} differs`);
  }
  for (const match of `${text}\n${indexText}`.matchAll(/\[([a-z]+\/[a-z]+) (\d+) B: (.+?) sha256:([0-9a-f]{16})\]/g)) {
    if (!(await inside(match[3]!))) continue;
    const data = await actual.readFile(match[3]!);
    if (data.length !== Number(match[2]) || !createHash("sha256").update(data).digest("hex").startsWith(match[4]!)) problems.push(`reference ${match[3]} differs`);
  }
  return { problems, checked };
}

const sub = (tool: string) => `try { const value = await tools.${tool}({}); return typeof value === "string" ? value.length : JSON.stringify(value).length; } catch (error) { return error.message; }`;
const OUTPUT_TEXT = `// @options: {"max_output_tokens": 10}\ntext("x".repeat(2000));`;
const OUTPUT_IMAGE = `image("data:image/gif;base64,${GIF}"); return "done";`;
/** A sub-call, then the script's full text: the index exists before the output files. */
const SUB_THEN_TEXT = `// @options: {"max_output_tokens": 10}\nawait tools.probe_long({}); text("x".repeat(2000));`;
/** The script's full text, then its image: the full output is saved before the image. */
const TEXT_THEN_IMAGE = `// @options: {"max_output_tokens": 10}\ntext("x".repeat(2000)); image("data:image/gif;base64,${GIF}");`;
const isTemp = (name: string) => (entry: string) => entry.startsWith(`${name}.`) && entry.endsWith(".tmp");

type Scenario = {
  name: string;
  /** Where it applies (default both): some calls exist only on one system. */
  only?: NodeJS.Platform;
  code: string;
  /** The full output text, when the script spills it. */
  full?: string;
  /** Set up the hooks for this group. */
  arm?: (g: Group) => void | Promise<void>;
};
/** An empty directory the other writer made in Bob's tmp (allowed there, must stay empty). */
let madeInBob: string | undefined;
const callSwap = (g: Group, kind: "rename" | "remove" | "into") => async () => swap(kind, await callDir(g), g.bobTmp);
const callInPlace = (g: Group, clear = false) => async () => inPlace(await callDir(g), g.bobTmp, clear);
/** Just before a write through the held call directory: after its check (the last call of which is this realpath). */
const beforeWrite = (nth: number, act: () => Promise<string>): Hook => ({ point: "realpath", match: isCallDir, nth, act });
const full = "x".repeat(2000);
const scenarios: Scenario[] = [
  { name: "control: every kind of file", code: `// @options: {"max_output_tokens": 10}
const a = await tools.probe_long({}); const b = await tools.probe_json({}); const c = await tools.probe_image({});
image("data:image/gif;base64,${GIF}"); text("x".repeat(2000));`, full },
  { name: "index first open: call directory renamed", code: sub("probe_long"),
    arm: (g) => { hooks = [{ point: "open", match: (name) => name === "index.txt", act: callSwap(g, "rename") }]; } },
  { name: "index first open: call directory removed", code: sub("probe_long"),
    arm: (g) => { hooks = [{ point: "open", match: (name) => name === "index.txt", act: callSwap(g, "remove") }]; } },
  { name: "index first open: codemode/ renamed", code: sub("probe_long"),
    arm: (g) => {
      hooks = [{ point: "open", match: (name) => name === "index.txt", act: async () => {
        // Bob's tmp gets an empty directory with the call's name, so the swapped path leads into it.
        madeInBob = basename(await callDir(g));
        await actual.mkdir(join(g.bobTmp, madeInBob));
        return swap("rename", resultsRoot(g.aliceTmp), g.bobTmp);
      } }];
    } },
  // Linux makes a directory, then opens it; Windows makes and opens it in one call through its parent's handle.
  { name: "call directory swapped after mkdir, before it is held", only: "linux", code: sub("probe_long"),
    arm: (g) => { hooks = [{ point: "mkdir", match: isCallDir, act: callSwap(g, "rename") }]; } },
  { name: "codemode/ swapped after mkdir, before it is held", only: "linux", code: sub("probe_long"),
    arm: (g) => { hooks = [{ point: "mkdir", match: (name) => name === "codemode", act: () => swap("rename", resultsRoot(g.aliceTmp), g.bobTmp) }]; } },
  // Windows: a directory made a junction in place (D23-R2-1 round 3): before it is held, while empty, once it is not.
  { name: "codemode/ made a junction in place before it is held", only: "win32", code: sub("probe_long"),
    arm: async (g) => {
      await actual.mkdir(resultsRoot(g.aliceTmp));
      hooks = [{ point: "realpath", match: (_name, path) => path === g.aliceTmp, act: async () => inPlace(resultsRoot(g.aliceTmp), g.bobTmp) }];
    } },
  { name: "index first create: empty call directory made a junction in place", only: "win32", code: sub("probe_long"),
    arm: (g) => { hooks = [beforeWrite(1, callInPlace(g))]; } },
  { name: "output-only full text: empty call directory made a junction in place", only: "win32", code: OUTPUT_TEXT, full,
    arm: (g) => { hooks = [beforeWrite(1, callInPlace(g))]; } },
  { name: "standalone image: empty call directory made a junction in place", only: "win32", code: OUTPUT_IMAGE,
    arm: (g) => { hooks = [beforeWrite(1, callInPlace(g))]; } },
  { name: "sub-call text: call directory holding the index made a junction in place", only: "win32", code: sub("probe_long"),
    arm: (g) => { hooks = [beforeWrite(2, callInPlace(g))]; } },
  { name: "index opened for writing: call directory made a junction in place", only: "win32", code: sub("probe_long"),
    arm: (g) => { hooks = [{ point: "open", match: (name) => name === "index.txt", act: callInPlace(g) }]; } },
  { name: "sub-call text before its temporary file", code: sub("probe_long"),
    arm: (g) => { hooks = [{ point: "open", match: isTemp("1.txt"), act: callSwap(g, "rename") }]; } },
  { name: "sub-call JSON before its temporary file", code: sub("probe_json"),
    arm: (g) => { hooks = [{ point: "open", match: isTemp("1.json"), act: callSwap(g, "rename") }]; } },
  { name: "sub-call image before its temporary file", code: sub("probe_image"),
    arm: (g) => { hooks = [{ point: "open", match: isTemp("1-1.png"), act: callSwap(g, "rename") }]; } },
  { name: "output-only full text before its temporary file", code: OUTPUT_TEXT, full,
    arm: (g) => { hooks = [{ point: "open", match: isTemp("output.txt"), act: callSwap(g, "rename") }]; } },
  { name: "standalone image before its temporary file", code: OUTPUT_IMAGE,
    arm: (g) => { hooks = [{ point: "open", match: isTemp("output-1.gif"), act: callSwap(g, "rename") }]; } },
  // Windows renames through the file's handle, not through fs.rename.
  { name: "output-only full text before the rename", only: "linux", code: OUTPUT_TEXT, full,
    arm: (g) => { hooks = [{ point: "rename", match: isTemp("output.txt"), act: callSwap(g, "rename") }]; } },
  { name: "failure cleanup: swapped before the temporary file is removed", code: OUTPUT_TEXT, full,
    arm: (g) => {
      hooks = [
        // Not the other writer: a directory where output.txt goes makes the rename fail, so the cleanup runs.
        { point: "open", match: isTemp("output.txt"), act: async () => { await actual.mkdir(join(await callDir(g), "output.txt")); return "prepared"; } },
        // Windows removes the file through its handle: the swap comes before the write instead.
        { point: WINDOWS ? "open" : "rm", match: isTemp("output.txt"), act: callSwap(g, "rename") },
      ];
    } },
  { name: "later index line: call directory renamed during a sub-call", code: sub("probe_attack"),
    arm: (g) => { during = callSwap(g, "rename"); } },
  { name: "later index line: call directory removed during a sub-call", code: sub("probe_attack"),
    arm: (g) => { during = callSwap(g, "remove"); } },
  // D23-R3-2: the index exists before the full output; a save that finds the directory moved drops it.
  { name: "sub-call, then full output: call directory renamed before its temporary file", code: SUB_THEN_TEXT, full,
    arm: (g) => { hooks = [{ point: "open", match: isTemp("output.txt"), act: callSwap(g, "rename") }]; } },
  // D23-R3-2: the full output saved first is not named once the image's save found the directory gone.
  { name: "full output, then image: call directory renamed before the image", only: "linux", code: TEXT_THEN_IMAGE, full,
    arm: (g) => { hooks = [{ point: "open", match: isTemp("output-1.gif"), act: callSwap(g, "rename") }]; } },
  { name: "full output, then image: call directory emptied and made a junction in place before the image", only: "win32", code: TEXT_THEN_IMAGE, full,
    arm: (g) => { hooks = [beforeWrite(2, callInPlace(g, true))]; } },
  // D23-R3-3: the same directory, moved out of Alice's tmp and linked back: written, but not readable there.
  { name: "full output: call directory moved into Bob's tmp and linked back", code: OUTPUT_TEXT, full,
    arm: (g) => { hooks = [{ point: "open", match: isTemp("output.txt"), act: callSwap(g, "into") }]; } },
  // ... and when that happened before a write: the directory's check (its real path) stops the write.
  { name: "during a sub-call: call directory moved into Bob's tmp and linked back", full,
    code: `// @options: {"max_output_tokens": 10}\ntry { await tools.probe_attack({}); } catch {}\ntext("x".repeat(2000));`,
    arm: (g) => { during = callSwap(g, "into"); } },
  // ... and a file alone, its directory in place: only the file's own check (its real path) withdraws it. Linux only:
  // making a file symlink on Windows needs a privilege a member does not have (a junction is a directory).
  { name: "full output, then image: the full output moved into Bob's tmp and linked back", only: "linux", code: TEXT_THEN_IMAGE, full,
    arm: (g) => { hooks = [{ point: "open", match: isTemp("output-1.gif"), act: async () => swap("into", join(await callDir(g), "output.txt"), g.bobTmp) }]; } },
  // D23-R3-2 on both systems: the full output removed once saved, before the image; the directory stays in place.
  { name: "full output, then image: the full output removed before the image", code: TEXT_THEN_IMAGE, full,
    arm: (g) => {
      hooks = [{ point: "open", match: isTemp("output-1.gif"), act: async () => {
        await actual.rm(join(await callDir(g), "output.txt"));
        return "done";
      } }];
    } },
  // What a result says when a write fails: the entry's path below the member's tmp, never /proc/self/fd.
  { name: "full output: the disk is full", code: OUTPUT_TEXT, full,
    arm: () => {
      hooks = [{ point: "open", match: isTemp("output.txt"), fail: (path) => Object.assign(new Error(`ENOSPC: no space left on device, open '${path}'`), { code: "ENOSPC" }) }];
    } },
  { name: "full output: permission denied", code: OUTPUT_TEXT, full,
    arm: () => {
      hooks = [{ point: "open", match: isTemp("output.txt"), fail: (path) => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" }) }];
    } },
  { name: "no /proc: nothing is held", only: "linux", code: sub("probe_long"),
    arm: () => {
      hooks = [{ point: "stat", match: (_name, path) => /^\/proc\/self\/fd\/\d+$/.test(path), fail: (path) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" }) }];
    } },
];

const results = [];
for (const scenario of scenarios) {
  if (scenario.only !== undefined && scenario.only !== process.platform) continue;
  const g = await group();
  hooks = [];
  during = undefined;
  duringOutcome = undefined;
  madeInBob = undefined;
  try {
    await scenario.arm?.(g);
    const result = await run(g, scenario.code);
    const attacks = [...hooks.map((hook) => hook.outcome ?? "not reached"), ...(during === undefined ? [] : [duringOutcome ?? "not reached"])];
    hooks = [];
    during = undefined;
    const calls = await actual.readdir(resultsRoot(g.aliceTmp)).catch(() => [] as string[]);
    const moved = calls.find((name) => name.endsWith(".moved"));
    const movedRoot = (await actual.readdir(g.aliceTmp)).includes("codemode.moved") ? join(g.aliceTmp, "codemode.moved") : undefined;
    const intoBob = (await actual.readdir(g.bobTmp)).includes(MOVED_INTO_BOB) ? join(g.bobTmp, MOVED_INTO_BOB) : undefined;
    const movedDir = moved !== undefined ? join(resultsRoot(g.aliceTmp), moved)
      : movedRoot !== undefined ? join(movedRoot, (await actual.readdir(movedRoot))[0] ?? "") : intoBob;
    const paths = await checkPaths(g, result, scenario.full ?? "");
    const observed = {
      name: scenario.name,
      platform: process.platform,
      attacks,
      isError: result.isError,
      last: result.content.at(-1)?.text ?? "",
      texts: result.content.map((item) => item.text ?? `<${item.type}>`).slice(1),
      aliceTmp: g.aliceTmp,
      index: result.details?.index !== undefined,
      fullOutputPath: result.details?.fullOutputPath !== undefined,
      bobChanges: await bobChanges(g, { emptyDir: madeInBob, movedDir: intoBob === undefined ? undefined : MOVED_INTO_BOB }),
      pathProblems: paths.problems,
      pathsChecked: paths.checked,
      leftovers: [...await leftovers(g.aliceTmp), ...(intoBob === undefined ? [] : await leftovers(intoBob))].map((path) => relative(root, path)),
      movedEntries: movedDir === undefined ? undefined : (await actual.readdir(movedDir).catch(() => [])).sort(),
    };
    console.log(`SCENARIO ${JSON.stringify(observed)}`);
    results.push(observed);
  } finally {
    hooks = [];
    during = undefined;
    await g.opened.close();
  }
}
console.log(`HARNESS_RESULT=${JSON.stringify(results.map((result) => result.name))}`);
