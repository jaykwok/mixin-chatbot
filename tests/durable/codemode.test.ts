// Codemode on the Durable engine (pi-durable 1.2.0's official codemode tool, adapted in src/durable/codemode/index.ts),
// driven by faux codemode calls through a real group Harness wired as the service is (the door first, then mixin.base,
// fixture extensions and mixin.codemode). Real sandbox, shells and files under tmp/; a local fake Responses endpoint on
// 127.0.0.1 for the grammar replay; no network.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readFile, realpath, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Message, type Models, Type, type Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { CODEMODE_SOURCE_GRAMMAR, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "@earendil-works/pi-codemode";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  configure, type Conversation, DEFAULT_PROGRESS_POLICY, defineExtension, type Extension, type HarnessSettings, LiveDoc, type ModelRef, NestedCallDoc,
  type ProgressPolicy, type Storage, type ToolExecutionApi, type ToolRegistration, UsageDoc,
} from "@earendil-works/pi-durable";
import { openModelRuntime } from "../../src/core/model-config.ts";
import { isPathInside } from "../../src/contracts/paths.ts";
import { type CodemodeDetails, codemodeExtension, CodemodeStoreDoc } from "../../src/durable/codemode/index.ts";
import { removeResultDirectories, resultsDirName, resultsRoot } from "../../src/durable/results/files.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { projectConversation } from "../../src/durable/projection.ts";
import {
  baseMemberTools, type BaseToolsOptions, type MemberCall, memberPlaces, memberRegistration, type MemberTool,
} from "../../src/durable/tools.ts";
import { type GroupHarness, openGroupHarness, PROJECT_PROGRESS as PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-codemode-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const ALICE = "+8613800000001";
const BOB = "+8613800000002";
let counter = 0;

/** A fixture extension of member tools (registered as the registry registers them). */
type Module = { name: string; tools: MemberTool[] };
type Setup = {
  /** Fixture extensions of member tools, installed after mixin.base; their tools are the codemode adapter's too. */
  modules?: Module[];
  /** Other extensions (wraps), installed after the modules. */
  extensions?: Extension[];
  door?: false;
  /** The group the tools serve (another group: the conversations' identities do not match). */
  toolsGroup?: string;
  /** Models besides the faux provider (the faux provider is added to them). */
  models?: Models & { registerNativeProvider?(provider: unknown): void };
  settings?: HarnessSettings;
  storage?: (storage: Storage) => Storage;
};

type Group = {
  opened: GroupHarness;
  faux: ReturnType<typeof fauxProvider>;
  model: ModelRef;
  base: BaseToolsOptions;
  extensions: Extension[];
  extension(name: string): Extension;
  close(): Promise<void>;
  /** Close (if open) and open the same database with the same registry contents. */
  reopen(): Promise<GroupHarness>;
};

async function openGroup(setup: Setup = {}): Promise<Group> {
  const n = ++counter;
  const faux = fauxProvider({ tokenSize: { min: 50, max: 50 } });
  let models: Models;
  if (setup.models === undefined) {
    const created = createModels();
    created.setProvider(faux.provider);
    models = created;
  } else {
    setup.models.registerNativeProvider!(faux.provider);
    models = setup.models;
  }
  const model = faux.getModel();
  const base: BaseToolsOptions = { root: join(fixture.root, `群数据-${n}`), groupId: setup.toolsGroup ?? GROUP };
  const members = baseMemberTools(base);
  const modules = setup.modules ?? [];
  const extensions = [
    defineExtension({ name: "mixin.base", tools: members.map(memberRegistration) }),
    ...modules.map((module) => defineExtension({ name: module.name, tools: module.tools.map(memberRegistration) })),
    ...setup.extensions ?? [],
    codemodeExtension({ members: base, tools: [...members, ...modules.flatMap((module) => module.tools)] }),
  ];
  const path = join(fixture.root, `db-${n}.sqlite`);
  const open = () => openGroupHarness(path, models, {
    group: GROUP, door: setup.door, extensions, settings: setup.settings ?? { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } }, storage: setup.storage,
  });
  const group: Group = {
    opened: await open(), faux, model: { provider: model.provider, modelId: model.id }, base, extensions,
    extension: (name) => extensions.find((extension) => extension.name === name)!,
    close: () => group.opened.close(),
    async reopen() {
      await group.opened.close().catch(() => {});
      group.opened = await open();
      return group.opened;
    },
  };
  return group;
}

async function member(group: Group, phone = ALICE): Promise<Conversation> {
  return (await memberConversation(group.opened.harness, GROUP, phone, { model: group.model }, context)).conversation;
}

const places = (group: Group, phone = ALICE) => memberPlaces(group.base, GROUP, phone);

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError: boolean; text: string; content: Content[]; details?: CodemodeDetails & { fullOutputPath?: string }; usage?: Usage };

/** The tool result of `callId` in the conversation. */
async function resultOf(conversation: Conversation, callId: string): Promise<Result | undefined> {
  for (const entry of (await conversation.entries({}, 1000, undefined, context)).items) {
    const message = entry.model?.[0] as { toolCallId?: string; isError: boolean; content: Content[]; details?: Result["details"]; usage?: Usage } | undefined;
    if (entry.kind !== "pi.tool-result" || message?.toolCallId !== callId) continue;
    return { isError: message.isError, content: message.content, details: message.details, usage: message.usage, text: message.content.map((item) => item.text ?? "").join("") };
  }
  return undefined;
}

async function outcomeOf(group: Group, callId: string): Promise<string | undefined> {
  const tasks = await group.opened.harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 1000), context);
  const task = tasks.items.find((each) => (each.input as { callId: string }).callId === callId);
  return task === undefined ? undefined : task.state.status === "terminal" ? task.state.outcome.status : task.state.status;
}

let scripts = 0;
type Run = { id: string; result: Result; outcome: string | undefined; request: Message[]; settled: { status: string; reason?: string } };

/** One turn: the model runs `code` with codemode, then answers. `during` runs while the turn is under way. */
async function script(group: Group, conversation: Conversation, code: string, during?: (id: string) => Promise<void>): Promise<Run> {
  const id = `cm-${++scripts}`;
  let request: Message[] = [];
  group.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }),
    (transcript) => { request = transcript.messages; return fauxAssistantMessage("好的"); },
  ]);
  const submission = await conversation.submit({ type: "input", content: "运行脚本" }, context);
  await during?.(id);
  const settled = await submission.wait(context) as unknown as Run["settled"];
  const result = await resultOf(conversation, id);
  if (result === undefined) throw new Error(`no result for ${id}: ${JSON.stringify(settled)}`);
  return { id, result, outcome: await outcomeOf(group, id), request, settled };
}

/** One turn in which the model runs two codemode calls at once; their results, in order. */
async function together(group: Group, conversation: Conversation, codes: [string, string]): Promise<Result[]> {
  const ids = codes.map(() => `cm-${++scripts}`);
  group.faux.setResponses([
    fauxAssistantMessage(codes.map((code, index) => fauxToolCall("codemode", { code }, { id: ids[index]! })), { stopReason: "toolUse" }),
    fauxAssistantMessage("好的"),
  ]);
  await (await conversation.submit({ type: "input", content: "同时运行两个脚本" }, context)).wait(context);
  return Promise.all(ids.map(async (id) => {
    const result = await resultOf(conversation, id);
    if (result === undefined) throw new Error(`no result for ${id}`);
    return result;
  }));
}

/** The request of a plain turn (what the model is offered). */
async function ask(group: Group, conversation: Conversation): Promise<Message[]> {
  let request: Message[] = [];
  group.faux.setResponses([(transcript) => { request = transcript.messages; return fauxAssistantMessage("好的"); }]);
  await (await conversation.submit({ type: "input", content: "你好" }, context)).wait(context);
  return request;
}

/** What a successful script returned: the last output item, parsed (a returned string is its text). */
function returned(result: Result): any {
  expect(result.content[0]?.text).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/);
  const output = result.content.at(-1)!.text!.split(/==> text \d+\/\d+ <==\n/).at(-1)!.trimEnd();
  try { return JSON.parse(output); } catch { return output; }
}

async function until(probe: () => Promise<boolean> | boolean, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

/** Whether the conversation has a running nested call of `name` (pi.live nestedTools). */
async function nestedRunning(group: Group, conversation: Conversation, name: string): Promise<boolean> {
  const live = await group.opened.harness.snapshot(LiveDoc, conversation.id, context);
  return live?.nestedTools?.some((slot) => slot.name === name && slot.status === "running") ?? false;
}

/**
 * Start a script, wait for `ready`, close the Harness (`afterClose` runs then), reopen it and let recovery finish. The
 * model's answers after recovery are `next` (default: a plain answer); returns the recovered result and the last request.
 */
async function interrupt(group: Group, conversation: Conversation, code: string, ready: () => Promise<boolean>,
  options: { afterClose?: () => Promise<void>; next?: ((messages: Message[]) => ReturnType<typeof fauxAssistantMessage>)[] } = {}) {
  const id = `cm-${++scripts}`;
  group.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" })]);
  await conversation.submit({ type: "input", content: "运行脚本" }, context);
  await until(ready, `${id} ready`, 30_000);
  await group.close();
  await options.afterClose?.();
  let request: Message[] = [];
  const next = options.next ?? [() => fauxAssistantMessage("好的")];
  group.faux.setResponses(next.map((answer) => (transcript: { messages: Message[] }) => { request = transcript.messages; return answer(transcript.messages); }));
  await group.reopen();
  const again = (await group.opened.harness.conversation(conversation.id, context))!;
  await again.waitForIdle(context);
  const result = await resultOf(again, id);
  if (result === undefined) throw new Error(`no result for ${id}`);
  return { id, result, request, conversation: again, outcome: await outcomeOf(group, id) };
}

/** A fixture tool reached only from scripts unless `definition` says otherwise; `run` gets the validated arguments. */
function probe(name: string, run: (args: any, call: MemberCall) => Promise<AgentToolResult<unknown>> | AgentToolResult<unknown>,
  definition: Partial<ToolDefinition> = {}, replay: "safe" | "unsafe" = "unsafe"): MemberTool {
  return {
    definition: {
      name, label: name, description: `Fixture tool ${name}.`, exposure: "codemode",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => { throw new Error("fixture tools run through MemberTool.run"); },
      ...definition,
    } as ToolDefinition,
    replay,
    outputLimits: { maxBytes: 64 * 1024, maxLines: 2200 },
    run: async (args, call) => run(args, call),
  };
}

const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }], details: undefined });
/** Never answers; rejects when the sub-call is cancelled. */
const hang = (_args: unknown, call: MemberCall) => new Promise<AgentToolResult<unknown>>((_, reject) => {
  if (call.signal?.aborted) reject(new Error("aborted"));
  call.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});
const module = (...tools: MemberTool[]): Module => ({ name: "fixture.module", tools });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A bash command that records its shell and a child's (Windows) pids in the caller's tmp, appends a run, then waits. */
function waitingCommand(tag: string, extra: string[] = []): string {
  return [
    // Git Bash's $$ and $! are MSYS pids; /proc/<pid>/winpid gives the Windows one.
    'pid() { if [ -r "/proc/$1/winpid" ]; then cat "/proc/$1/winpid"; else echo "$1"; fi; }',
    `echo run >> "$PI_USER_TMP/${tag}-runs.txt"`,
    `pid $$ > "$PI_USER_TMP/${tag}-shell.pid"`,
    `sleep 30 & pid $! > "$PI_USER_TMP/${tag}-sleep.pid.tmp"`,
    `mv "$PI_USER_TMP/${tag}-sleep.pid.tmp" "$PI_USER_TMP/${tag}-sleep.pid"`,
    "wait",
    ...extra,
  ].join("\n");
}

async function expectStopped(dir: string, tag: string) {
  for (const name of [`${tag}-shell.pid`, `${tag}-sleep.pid`]) {
    const pid = Number((await readFile(join(dir, name), "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    await until(() => !alive(pid), `${name} ${pid} gone`);
  }
}

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
    let crc = ~0;
    for (const byte of body) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(~crc >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 120);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

const NAMESPACE = { name: "fixture_ns", description: "Fixture tools for the codemode tests.", instructions: "Call probe_echo first." };
let echoRuns = 0;
const echo = probe("probe_echo", ({ text: value }) => {
  echoRuns++;
  return { content: [{ type: "text", text: value }], details: undefined, structuredContent: { echo: value } };
}, {
  description: "Echo the given text back as a structured value.",
  parameters: Type.Object({ text: Type.String({ description: "Text to echo back" }) }),
  outputSchema: Type.Object({ echo: Type.String() }),
  namespace: NAMESPACE,
});
const send = probe("send_probe", () => text("sent"), { exposure: "model-only", description: "Send something (model only)." });
const sendModule: Module = { name: "fixture.send", tools: [send] };

test("parallel codemode children project nested counts once across cursor replay and projection upgrade", async () => {
  const group = await openGroup({ modules: [module(echo)] }), alice = await member(group);
  const ledger = openStatsLedger(group.base.root);
  try {
    const run = await script(group, alice, 'await Promise.all([tools.probe_echo({text:"one"}),tools.probe_echo({text:"two"})]);');
    expect(run.result.details!.partial).toBeUndefined();
    const identity = { groupId: GROUP, phone: ALICE, conversationId: alice.id };
    await projectConversation(ledger, group.opened.harness, identity, context);
    const rows = () => readLedger(ledger).tools.filter(row => row.kind === "nested").map(({ tool, count }) => ({ tool, count }));
    expect(rows()).toEqual([{ tool: "probe_echo", count: 2 }]);
    await projectConversation(ledger, group.opened.harness, identity, context); expect(rows()).toEqual([{ tool: "probe_echo", count: 2 }]);
    const before = readLedger(ledger).usage;
    ledger.query("UPDATE sources SET projection = 3 WHERE identity = ?").run(`durable:${alice.id}`);
    await projectConversation(ledger, group.opened.harness, identity, context); expect(rows()).toEqual([{ tool: "probe_echo", count: 2 }]);
    expect(readLedger(ledger).usage).toEqual(before);
  } finally { ledger.close(); await group.close(); }
});

describe("Durable codemode: declarations and scope", () => {
  test("declarations: the official grammar tool, replay safe; plain direct tools; the codemode section lists what scripts can call", async () => {
    const group = await openGroup({ modules: [module(echo), sendModule] });
    try {
      const codemode = group.extension("mixin.codemode").tools![0]!;
      expect(codemode.name).toBe("codemode");
      expect(codemode.replay).toBe("safe");
      expect(codemode.callers).toEqual(["model"]);
      expect(codemode.outputLimits).toEqual({ maxBytes: 4 * 1024 * 1024, maxLines: 100_000 });
      expect(codemode.constrainedSampling).toEqual({ type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } });
      // No models: the official description of the variant without models.* globals.
      expect(codemode.description).not.toContain("models.");

      const original = Object.fromEntries(baseMemberTools(group.base).map((tool) => [tool.definition.name, tool.definition.description]));
      const request = await ask(group, await member(group));
      const declared = Object.fromEntries(getCurrentTools(request).map((tool) => [tool.name, tool]));
      // Script-only tools are not offered to the model; direct tools keep their own descriptions.
      expect(Object.keys(declared)).toEqual(["read", "bash", "edit", "write", "send_probe", "codemode"]);
      for (const name of ["read", "bash", "edit", "write"]) expect(declared[name]!.description).toBe(original[name]!);
      expect(declared.send_probe!.description).toBe("Send something (model only).");
      expect(declared.codemode).toMatchObject({ description: codemode.description, constrainedSampling: codemode.constrainedSampling });
      const prompt = getCurrentSystemPrompt(request) ?? "";
      const section = prompt.slice(prompt.indexOf("<codemode>\n"));
      expect(section).toContain("## fixture_ns\nFixture tools for the codemode tests.");
      expect(section).toContain("### `probe_echo`");
      for (const name of ["read", "bash", "edit", "write"]) expect(section).toContain(`### \`${name}\``);
      expect(section).not.toContain("send_probe");

      // A conversation that does not select mixin.codemode keeps the plain declarations and has no section.
      const bob = await member(group, BOB);
      await bob.configure({ extensions: { remove: [group.extension("mixin.codemode")] } }, context);
      const plain = await ask(group, bob);
      expect(getCurrentTools(plain).map((tool) => [tool.name, tool.description])).toEqual([
        ...["read", "bash", "edit", "write"].map((name) => [name, original[name]]), ["send_probe", "Send something (model only)."],
      ]);
      expect(getCurrentSystemPrompt(plain)).not.toContain("<codemode>");
    } finally { await group.close(); }
  });

  test("scope: direct tools and script-only tools of selected extensions; deferred tools through searchTools(); no models", async () => {
    const deferred = probe("probe_deferred", () => text("deferred ok"), { exposure: "deferred", description: "A deferred fixture tool." });
    const off = probe("probe_off", () => text("off"));
    const offModule: Module = { name: "fixture.off", tools: [off] };
    const group = await openGroup({ modules: [module(echo, deferred), offModule, sendModule] });
    try {
      const alice = await member(group);
      await alice.configure({ extensions: { remove: [group.extension("fixture.off")] } }, context);
      const prompt = getCurrentSystemPrompt(await ask(group, alice)) ?? "";
      // Built from the conversation's tools each turn: a deselected extension's tools are not listed; deferred ones neither.
      expect(prompt).not.toContain("probe_off");
      expect(prompt).not.toContain("probe_deferred");
      const run = await script(group, alice, `
const miss = (get) => { try { get(); return "no error"; } catch (error) { return error.message; } };
return {
  names: ALL_TOOLS.map((tool) => tool.name),
  has: ["read", "probe_echo", "probe_deferred", "send_probe", "probe_off", "codemode"].map((name) => name in tools),
  typo: miss(() => tools.Read),
  send: miss(() => tools.send_probe),
  models: typeof models,
  search: (await searchTools("echo text back")).map((tool) => tool.name),
  deferredFound: (await searchTools("deferred fixture")).map((tool) => tool.name),
  scoped: (await searchTools("fixture", { namespace: "fixture_ns" })).map((tool) => tool.name),
  sample: await describeTool("probe_echo"),
  namespace: await describeNamespace("fixture_ns"),
  echo: await tools.probe_echo({ text: "你好" }),
  deferred: await tools.probe_deferred({}),
};`);
      const value = returned(run.result);
      expect(value.names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "probe_echo"]));
      expect(value.names).not.toContain("send_probe");
      expect(value.names).not.toContain("probe_off");
      expect(value.has.slice(0, 2)).toEqual([true, true]);
      expect(value.has.slice(3)).toEqual([false, false, false]);
      expect(value.typo).toStartWith("tools.Read does not exist. Did you mean tools.read?");
      expect(value.send).toStartWith("tools.send_probe does not exist.");
      expect(value.models).toBe("undefined");
      expect(value.search[0]).toBe("probe_echo");
      expect(value.deferredFound).toContain("probe_deferred");
      expect(value.scoped).toEqual(["probe_echo"]);
      expect(value.sample).toContain("probe_echo");
      expect(value.namespace).toMatchObject({ name: NAMESPACE.name, description: NAMESPACE.description, instructions: NAMESPACE.instructions, tools: ["probe_echo"] });
      expect(value.echo).toEqual({ echo: "你好" });
      expect(value.deferred).toBe("deferred ok");
      expect(run.result.details!.calls.map((call) => [call.name, call.status])).toEqual([["probe_echo", "ok"], ["probe_deferred", "ok"]]);

      // A tool the conversation's tool filter removes is not callable from scripts either.
      const bob = await member(group, BOB);
      const bash = group.extension("mixin.base").tools!.find((tool) => tool.name === "bash")!;
      await bob.configure({ tools: { remove: [bash] } }, context);
      const filtered = returned((await script(group, bob, `return { names: ALL_TOOLS.map((tool) => tool.name), bash: "bash" in tools };`)).result);
      expect(filtered.bash).toBe(false);
      expect(filtered.names).not.toContain("bash");
      expect(filtered.names).toContain("probe_off");
    } finally { await group.close(); }
  });

  test("scope: a same-named tool another extension puts in place of a direct tool is what scripts call, never the member's", async () => {
    const other = {
      name: "read", description: "Another extension's read.", parameters: Type.Object({ key: Type.String() }), replay: "safe",
      execute: async () => ({ output: [{ type: "text", text: "other read" }] }),
    } as unknown as ToolRegistration;
    const group = await openGroup({ extensions: [defineExtension({ name: "fixture.other-read", tools: [other] })] });
    try {
      const alice = await member(group);
      const declared = getCurrentTools(await ask(group, alice));
      expect(declared.find((tool) => tool.name === "read")!.description).toBe("Another extension's read.");
      const value = returned((await script(group, alice, `return { read: await tools.read({ key: "k" }), bash: "bash" in tools };`)).result);
      expect(value).toEqual({ read: "other read", bash: true });
    } finally { await group.close(); }
  });

  test("controlled entry: a tool deselected during a script is refused at its next sub-call; arguments are repaired and validated before anything runs", async () => {
    let harness: GroupHarness["harness"] | undefined;
    let target: Conversation["id"] | undefined;
    let removed: Extension | undefined;
    const toggle = probe("probe_toggle", async () => {
      await harness!.commit((tx) => configure(tx, target!, { extensions: { remove: [removed!] } }), context);
      return text("toggled");
    });
    const group = await openGroup({ modules: [module(echo), { name: "fixture.toggle", tools: [toggle] }] });
    try {
      harness = group.opened.harness;
      removed = group.extension("fixture.module");
      const alice = await member(group);
      target = alice.id;
      const runsBefore = echoRuns;
      const run = await script(group, alice, `
const first = await tools.probe_echo({ text: "一" });
await tools.probe_toggle({});
let second;
try { second = await tools.probe_echo({ text: "二" }); } catch (error) { second = error.message; }
return { first, second };`);
      // The script's tools object was fixed at its start; each sub-call is still checked against the conversation's
      // current agent, so a tool deselected meanwhile is refused and does not run.
      expect(returned(run.result)).toEqual({ first: { echo: "一" }, second: "Tool probe_echo is not available" });
      expect(echoRuns - runsBefore).toBe(1);
      // The next codemode call runs with the changed agent.
      const next = await script(group, alice, `
let echo;
try { tools.probe_echo; echo = "present"; } catch (error) { echo = error.message; }
return { names: ALL_TOOLS.map((tool) => tool.name), echo };`);
      expect(returned(next.result)).toMatchObject({ echo: expect.stringContaining("tools.probe_echo does not exist") });
      expect(returned(next.result).names).not.toContain("probe_echo");

      const tmp = places(group, BOB).tempDir;
      await mkdir(tmp, { recursive: true });
      await writeFile(join(tmp, "旧格式.txt"), "甲乙丙\n");
      const bob = await member(group, BOB);
      const echoBefore = echoRuns;
      const args = await script(group, bob, `
const errors = {};
try { await tools.probe_echo({}); } catch (error) { errors.missing = error.message; }
try { await tools.write({ content: "没有路径" }); } catch (error) { errors.write = error.message; }
const legacy = await tools.edit({ path: ${JSON.stringify(join(tmp, "旧格式.txt"))}, oldText: "乙", newText: "丁" });
return { errors, legacy };`);
      const value = returned(args.result);
      expect(value.errors.missing).toContain("text");
      expect(value.errors.write).toContain("path");
      expect(value.legacy).toContain("旧格式.txt");
      expect(echoRuns).toBe(echoBefore);
      expect(await readFile(join(tmp, "旧格式.txt"), "utf8")).toBe("甲丁丙\n");
      // Nothing was saved for the call: its results directory was never made.
      expect((await readdir(tmp)).sort()).toEqual(["旧格式.txt"]);
      expect(args.result.details!.calls.map((call) => [call.name, call.status])).toEqual([["probe_echo", "error"], ["write", "error"], ["edit", "ok"]]);
    } finally { await group.close(); }
  });

  test("identity: another group's tools or a conversation without a member run no script", async () => {
    const marker = join(fixture.root, `marker-${counter}.txt`);
    const code = `await tools.write({ path: ${JSON.stringify(marker)}, content: "ran" }); return 1;`;
    const other = await openGroup({ toolsGroup: "group-b" });
    try {
      const run = await script(other, await member(other), code);
      expect(run.result).toMatchObject({ isError: true });
      expect(run.result.text).toContain("会话的成员身份不属于本群，工具未执行");
      expect(run.outcome).toBe("completed");
      expect(existsSync(other.base.root)).toBe(false);
    } finally { await other.close(); }

    const group = await openGroup({ door: false });
    try {
      const id = await group.opened.harness.commit(async (tx) => {
        const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, record.id, { model: group.model, thinkingLevel: "off" });
        return record.id;
      }, context);
      const run = await script(group, (await group.opened.harness.conversation(id, context))!, code);
      expect(run.result.text).toContain("会话没有成员身份，工具未执行");
      expect(existsSync(group.base.root)).toBe(false);
    } finally { await group.close(); }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("Durable codemode: values and records", () => {
  test("bash: scripts get the structured value (output, exit code); a nonzero exit resolves, a timeout rejects", async () => {
    const group = await openGroup();
    try {
      const run = await script(group, await member(group), `
const exit = await tools.bash({ command: "echo 失败前; exit 3" });
let timeout;
try { await tools.bash({ command: "sleep 30", timeout: 1 }); timeout = "resolved"; } catch (error) { timeout = error.message; }
const ok = await tools.bash({ command: "echo 好" });
return { exit, timeout, ok };`);
      const value = returned(run.result);
      expect(value.exit).toMatchObject({ exit_code: 3, truncated: false });
      expect(value.exit.output).toContain("失败前");
      expect(value.ok).toMatchObject({ exit_code: 0, truncated: false });
      expect(value.ok.output).toContain("好");
      expect(JSON.stringify(value.timeout)).toContain("timed out");
      expect(run.result.details!.calls.map((call) => call.name)).toEqual(["bash", "bash", "bash"]);
    } finally { await group.close(); }
  }, 90_000);

  test("read: a text file's value is its text; an image file's value is an image block the script can show with image()", async () => {
    const group = await openGroup();
    try {
      const tmp = places(group).tempDir;
      await mkdir(tmp, { recursive: true });
      const rows = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行 ${"内容".repeat(10)}`);
      const textFile = join(tmp, "长文.txt");
      await writeFile(textFile, rows.join("\n"));
      const imageFile = join(tmp, "图.png");
      await writeFile(imageFile, png(3, 2));
      const run = await script(group, await member(group), `
const whole = await tools.read({ path: ${JSON.stringify(textFile)} });
const part = await tools.read({ path: ${JSON.stringify(textFile)}, offset: 2, limit: 1 });
const shot = await tools.read({ path: ${JSON.stringify(imageFile)} });
return { whole, part, shot };`);
      expect(run.result.isError).toBe(false);
      const value = returned(run.result);
      expect(value.whole).toBe(rows.join("\n"));
      expect(value.part).toStartWith(`${rows[1]}\n`);
      expect(value.part).toContain("offset=3");
      expect(value.part).not.toContain(rows[2]!);
      expect(value.shot).toEqual({ type: "image", data: png(3, 2).toString("base64"), mimeType: "image/png", note: "Read image file [image/png]" });
      // Nothing was saved for the call.
      expect(existsSync(resultsRoot(tmp))).toBe(false);

      const shown = await script(group, await member(group), `image(await tools.read({ path: ${JSON.stringify(imageFile)} }));`);
      expect(shown.result.isError).toBe(false);
      const label = shown.result.content.find((item) => item.text?.startsWith("[Image saved to "))!;
      expect(label.text).toMatch(new RegExp(`image-1\\.png \\(image/png, ${png(3, 2).length} bytes\\)\\]$`));
      expect(shown.result.content.at(-1)).toMatchObject({ type: "image", mimeType: "image/png", data: png(3, 2).toString("base64") });
    } finally { await group.close(); }
  }, 60_000);

  test("a script that patches a built-in still ends: with a sub-call and store(), when it throws, and the conversation goes on", async () => {
    const group = await openGroup({ modules: [module(echo)] });
    try {
      const alice = await member(group);
      const patched = await script(group, alice, `Array.prototype.toJSON = function () { return {}; };
const echoed = await tools.probe_echo({ text: "补丁之后" });
store("k", [1, 2]);
return [echoed, [1, 2]];`);
      expect(patched.result.isError).toBe(false);
      expect(patched.result.details!.calls.map((call) => [call.name, call.status])).toEqual([["probe_echo", "ok"]]);
      const failed = await script(group, alice, `Object.prototype.toJSON = function () { throw 1; };
throw new Error("脚本出错");`);
      expect(failed.result.isError).toBe(true);
      expect(failed.result.text).toContain("脚本出错");
      // The first script's write was committed; a new script sees the built-ins unpatched.
      const after = await script(group, alice, `return { k: load("k"), json: JSON.stringify([1, 2]) };`);
      expect(returned(after.result)).toEqual({ k: [1, 2], json: "[1,2]" });
    } finally { await group.close(); }
  }, 30_000);

  test("parallel sub-calls finishing in reverse keep their own numbers; a nested call's value saves no file", async () => {
    const wait = probe("probe_wait", async ({ ms, text: value }) => { await Bun.sleep(ms); return text(value); });
    const group = await openGroup({ modules: [module(wait)] });
    try {
      const run = await script(group, await member(group), `
const [a, b] = await Promise.all([tools.probe_wait({ ms: 600, text: "甲".repeat(400) }), tools.probe_wait({ ms: 1, text: "乙".repeat(400) })]);
return [a.length, b.length];`);
      expect(returned(run.result)).toEqual([400, 400]);
      expect(run.result.content).toHaveLength(2);
      expect(run.result.details).toMatchObject({ calls: [{ id: 1, name: "probe_wait", status: "ok" }, { id: 2, name: "probe_wait", status: "ok" }] });
      expect(run.result.details!.partial).toBeUndefined();
      expect(existsSync(resultsRoot(places(group).tempDir))).toBe(false);
    } finally { await group.close(); }
  });

  test("restart: the script reruns from its journal; finished sub-calls are not run again, the interrupted one fails", async () => {
    let texts = 0;
    const textProbe = probe("probe_text", ({ length }) => { texts++; return text("字".repeat(length)); });
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ modules: [module(textProbe, hangProbe)] });
    try {
      const alice = await member(group);
      const recovered = await interrupt(group, alice, `
const a = await tools.probe_text({ length: 3 });
const b = await tools.probe_text({ length: 4 });
let hung;
try { await tools.probe_hang({}); hung = "resolved"; } catch (error) { hung = error.message; }
return { a, b, hung };`, async () => nestedRunning(group, alice, "probe_hang"));
      const { result } = recovered;
      expect(recovered.outcome).toBe("completed");
      expect(result.isError).toBe(false);
      const value = returned(result);
      expect(value.a).toBe("字".repeat(3));
      expect(value.b).toBe("字".repeat(4));
      expect(value.hung).toBe("Tool probe_hang was interrupted and may have partially run");
      expect(texts).toBe(2);
      expect(result.details!.calls.map((call) => [call.name, call.status])).toEqual([["probe_text", "ok"], ["probe_text", "ok"], ["probe_hang", "error"]]);
    } finally { await group.close(); }
  }, 60_000);

  test("usage: a sub-call's usage is the child tool's in pi.usage, summed in the codemode result's details, never on its message", async () => {
    const usage = (n: number): Usage => ({
      input: n, output: 2 * n, cacheRead: 0, cacheWrite: 0, totalTokens: 3 * n, reasoning: n,
      cost: { input: n / 1000, output: n / 500, cacheRead: 0, cacheWrite: 0, total: 3 * n / 1000 },
    });
    const metered = probe("probe_metered", ({ n }) => ({ ...text(String(n)), usage: usage(n) }));
    const group = await openGroup({ modules: [module(metered)] });
    try {
      const alice = await member(group);
      const run = await script(group, alice, `await Promise.all([tools.probe_metered({ n: 10 }), tools.probe_metered({ n: 32 })]); return 1;`);
      expect(run.result.details!.usage).toEqual(usage(42));
      expect(run.result.usage).toBeUndefined();
      const tools = (await group.opened.harness.snapshot(UsageDoc, alice.id, context))?.tools;
      expect(tools?.probe_metered).toEqual(usage(42));
      expect(tools?.codemode).toBeUndefined();

      // Statistics charge the nested usage once, as the codemode result's, also when projected again.
      const ledger = openStatsLedger(group.base.root);
      try {
        const identity = { groupId: GROUP, phone: ALICE, conversationId: alice.id };
        const charged = () => readLedger(ledger).usage.filter((row) => row.kind === "tool")
          .map(({ requests, input, output, cost }) => ({ requests, input, output, cost: Math.round(cost * 1e6) / 1e6 }));
        await projectConversation(ledger, group.opened.harness, identity, context);
        expect(charged()).toEqual([{ requests: 2, input: 42, output: 84, cost: 0.126 }]);
        await projectConversation(ledger, group.opened.harness, identity, context);
        expect(charged()).toEqual([{ requests: 2, input: 42, output: 84, cost: 0.126 }]);
      } finally { ledger.close(); }
    } finally { await group.close(); }
  });

  describe("usage across a restart: receipts charge each confirmed sub-call once, also when no VM reaches it again", () => {
    const usage = (n: number): Usage => ({
      input: n, output: 2 * n, cacheRead: 0, cacheWrite: 0, totalTokens: 3 * n, reasoning: n,
      cost: { input: n / 1000, output: n / 500, cacheRead: 0, cacheWrite: 0, total: 3 * n / 1000 },
    });
    const once = [{ requests: 1, input: 42, output: 84, cost: 0.126 }];
    type Start = { version: number; fingerprint?: string };
    /**
     * Around the codemode call's API: `found` edits what a rerun's first commit found, `afterOutcome` runs once the outcome
     * commit is done, `afterCommit` after every commit (before the others), `nested` before a nested call is made (or
     * reattached).
     */
    const hooks: {
      found?: (start: Start, taskId: number) => void | Promise<void>;
      afterOutcome?: (signal: AbortSignal | undefined) => Promise<void>;
      afterCommit?: (signal: AbortSignal | undefined) => Promise<void>;
      nested?: (key: string | undefined, signal: AbortSignal | undefined) => Promise<void>;
    } = {};
    const rerunFound = defineExtension({
      name: "fixture.rerun-found",
      wraps: [{
        tool: "codemode",
        wrap: (tool: ToolRegistration) => ({
          ...tool,
          execute: (args: unknown, api: ToolExecutionApi, ctx: typeof context) => tool.execute(args as never, new Proxy(api, {
            get(target, property) {
              if (property === "commit") {
                return async (run: never, callContext: typeof context) => {
                  const value = await target.commit(run, callContext) as unknown;
                  await hooks.afterCommit?.(ctx.abortSignal);
                  if (typeof value !== "object" || value === null) return value;
                  if ("start" in value && (value as { rerun?: boolean }).rerun === true) await hooks.found?.((value as { start: Start }).start, target.taskId as number);
                  if ("output" in value) await hooks.afterOutcome?.(ctx.abortSignal);
                  return value;
                };
              }
              if (property === "executeTool") {
                return async (...call: Parameters<ToolExecutionApi["executeTool"]>) => {
                  await hooks.nested?.(call[3]?.key, call[2].abortSignal);
                  return target.executeTool(...call);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }), ctx),
        }),
      }],
    });
    let runs = 0;
    const metered = probe("probe_metered", ({ n }) => { runs++; return { ...text(String(n)), usage: usage(n) }; });
    const body = `await tools.probe_metered({ n: 42 });\nawait tools.probe_hang({});\nreturn 1;`;

    async function usageGroup(...tools: MemberTool[]) {
      runs = 0;
      delete hooks.found;
      delete hooks.afterOutcome;
      delete hooks.afterCommit;
      delete hooks.nested;
      return openGroup({ modules: [module(metered, probe("probe_hang", hang), ...tools)], extensions: [rerunFound] });
    }

    /** The tool rows the ledger charged, after projecting the conversation twice (the same both times). */
    async function charged(group: Group, conversation: Conversation) {
      const ledger = openStatsLedger(group.base.root);
      try {
        const identity = { groupId: GROUP, phone: ALICE, conversationId: conversation.id };
        const rows = () => readLedger(ledger).usage.filter((row) => row.kind === "tool")
          .map(({ requests, input, output, cost }) => ({ requests, input, output, cost: Math.round(cost * 1e6) / 1e6 }));
        await projectConversation(ledger, group.opened.harness, identity, context);
        const first = rows();
        await projectConversation(ledger, group.opened.harness, identity, context);
        expect(rows()).toEqual(first);
        return first;
      } finally { ledger.close(); }
    }

    test("the deadline passed while the Harness was closed: the timeout result charges the finished sub-call", async () => {
      const group = await usageGroup();
      try {
        const alice = await member(group);
        const startedAt = Date.now();
        const recovered = await interrupt(group, alice, `// @options: {"timeout_ms": 4000}\n${body}`,
          async () => nestedRunning(group, alice, "probe_hang"), { afterClose: () => Bun.sleep(Math.max(0, startedAt + 4_300 - Date.now())) });
        expect(recovered.result.isError).toBe(true);
        expect(recovered.result.text).toContain("Script timed out: its deadline passed while it was interrupted.");
        expect(recovered.result.details).toEqual({ calls: [], usage: usage(42) });
        expect(runs).toBe(1);
        expect(await charged(group, alice)).toEqual(once);
      } finally { await group.close(); }
    }, 60_000);

    for (const [what, edit, why] of [
      ["it started under another code mode version", (start: Start) => { start.version = -1; }, "The script cannot resume: it started under code mode version -1"],
      ["its sandbox changed", (start: Start) => { start.fingerprint = "fixture-fingerprint"; }, "The script cannot resume: the sandbox changed since it started"],
    ] as const) {
      test(`the rerun is refused because ${what}: the refusal charges the finished sub-call`, async () => {
        const group = await usageGroup();
        try {
          const alice = await member(group);
          const recovered = await interrupt(group, alice, body, async () => {
            if (!await nestedRunning(group, alice, "probe_hang")) return false;
            hooks.found = edit;
            return true;
          });
          expect(recovered.result.isError).toBe(true);
          expect(recovered.result.text).toContain(why);
          expect(recovered.result.details!.usage).toEqual(usage(42));
          expect(runs).toBe(1);
          expect(await charged(group, alice)).toEqual(once);
        } finally { await group.close(); }
      }, 60_000);
    }

    test("an earlier attempt's sub-call finishes on its own while the rerun is refused: the refusal charges it too", async () => {
      let waits = 0;
      const found = Promise.withResolvers<void>();
      const wait = probe("probe_wait", async (args, call) => {
        if (++waits === 1) return hang(args, call);
        await found.promise;
        return { ...text("late"), usage: usage(8) };
      }, {}, "safe");
      const group = await usageGroup(wait);
      try {
        const alice = await member(group);
        const code = `await tools.probe_metered({ n: 42 });
await tools.probe_wait({});
return 1;`;
        const recovered = await interrupt(group, alice, code, async () => {
          if (!await nestedRunning(group, alice, "probe_wait")) return false;
          // After the rerun's first commit, the earlier call finishes (its replay is safe), then the sandbox is refused.
          hooks.found = async (start, taskId) => {
            found.resolve();
            await until(async () => (await group.opened.harness.snapshot(NestedCallDoc, taskId as never, "c2", context))?.result !== undefined, "c2 finished");
            start.fingerprint = "fixture-fingerprint";
          };
          return true;
        });
        expect(recovered.result.text).toContain("The script cannot resume: the sandbox changed since it started");
        expect(recovered.result.details!.usage).toEqual(usage(50));
        expect([runs, waits]).toEqual([1, 2]);
        expect(await charged(group, alice)).toEqual([{ requests: 2, input: 50, output: 100, cost: 0.15 }]);
      } finally { await group.close(); }
    }, 60_000);

    test("the deadline passed, the timeout was stored and the Harness closed again: the next rerun returns it with its usage", async () => {
      const group = await usageGroup();
      try {
        const alice = await member(group);
        const id = `cm-${++scripts}`;
        group.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: `// @options: {"timeout_ms": 4000}
${body}` }, { id })], { stopReason: "toolUse" })]);
        const startedAt = Date.now();
        await alice.submit({ type: "input", content: "运行脚本" }, context);
        await until(() => nestedRunning(group, alice, "probe_hang"), "probe_hang running");
        await group.close();
        await Bun.sleep(Math.max(0, startedAt + 4_300 - Date.now()));
        // The rerun stores the timeout (the commit after its first one) and is closed before the call settles.
        const stored = Promise.withResolvers<void>();
        let next = false;
        hooks.found = () => { next = true; };
        hooks.afterCommit = async (signal) => {
          if (!next) return;
          next = false;
          stored.resolve();
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        };
        await group.reopen();
        group.opened.harness.resume();
        await stored.promise;
        delete hooks.found;
        delete hooks.afterCommit;
        group.faux.setResponses([fauxAssistantMessage("好的")]);
        await group.reopen();
        const again = (await group.opened.harness.conversation(alice.id, context))!;
        await again.waitForIdle(context);
        const result = (await resultOf(again, id))!;
        expect(result.text).toContain("Script timed out: its deadline passed while it was interrupted.");
        expect(result.details).toEqual({ calls: [], usage: usage(42) });
        expect(runs).toBe(1);
        expect(await charged(group, alice)).toEqual(once);
      } finally { await group.close(); }
    }, 60_000);

    test("cancelled after a restart before the rerun reached the finished sub-call: the result built from the call's slot charges it", async () => {
      const group = await usageGroup();
      try {
        const alice = await member(group);
        const id = `cm-${++scripts}`;
        group.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: body }, { id })], { stopReason: "toolUse" })]);
        await alice.submit({ type: "input", content: "运行脚本" }, context);
        await until(() => nestedRunning(group, alice, "probe_hang"), "probe_hang running");
        await group.close();
        // The rerun's replay of the finished call waits until the call is cancelled.
        const holding = Promise.withResolvers<void>();
        hooks.nested = async (key, signal) => {
          if (key !== "c1") return;
          holding.resolve();
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        };
        group.faux.setResponses([fauxAssistantMessage("好的")]);
        await group.reopen();
        const again = (await group.opened.harness.conversation(alice.id, context))!;
        group.opened.harness.resume();
        await holding.promise;
        // The rerun's own details are in its slot: the finished call is running again there.
        await until(async () => {
          const slot = (await group.opened.harness.snapshot(LiveDoc, alice.id, context))?.tools?.find((each) => each.callId === id);
          const calls = (slot?.details as CodemodeDetails | undefined)?.calls;
          return calls?.length === 1 && calls[0]!.name === "probe_metered" && calls[0]!.status === "running";
        }, "the rerun's details");
        await again.abort(context);
        await again.waitForIdle(context);
        expect(await outcomeOf(group, id)).toBe("aborted");
        const result = (await resultOf(again, id))!;
        expect(result.details).toMatchObject({ partial: true, usage: usage(42) });
        expect(runs).toBe(1);
        expect(await charged(group, alice)).toEqual(once);
      } finally { await group.close(); }
    }, 60_000);

    test("the outcome was stored before the restart: the recorded result keeps its usage", async () => {
      const group = await usageGroup();
      try {
        const alice = await member(group);
        const committed = Promise.withResolvers<void>();
        hooks.afterOutcome = async (signal) => {
          committed.resolve();
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        };
        const recovered = await interrupt(group, alice, `await tools.probe_metered({ n: 42 });\nreturn 1;`, async () => {
          await committed.promise;
          delete hooks.afterOutcome;
          return true;
        });
        expect(returned(recovered.result)).toBe(1);
        expect(recovered.result.details!.usage).toEqual(usage(42));
        expect(runs).toBe(1);
        expect(await charged(group, alice)).toEqual(once);
      } finally { await group.close(); }
    }, 60_000);
  });

  test("sequential tools run one at a time within a script; others overlap", async () => {
    const active = { sequential: 0, parallel: 0 };
    const peak = { sequential: 0, parallel: 0 };
    const tracked = (kind: "sequential" | "parallel") => probe(`probe_${kind}`, async () => {
      peak[kind] = Math.max(peak[kind], ++active[kind]);
      await Bun.sleep(150);
      active[kind]--;
      return text(kind);
    }, kind === "sequential" ? { executionMode: "sequential" } : {});
    const group = await openGroup({ modules: [module(tracked("sequential"), tracked("parallel"))] });
    try {
      const run = await script(group, await member(group), `
await Promise.all([tools.probe_sequential({}), tools.probe_sequential({}), tools.probe_sequential({}), tools.probe_parallel({}), tools.probe_parallel({})]);
return 1;`);
      expect(returned(run.result)).toBe(1);
      expect(peak).toEqual({ sequential: 1, parallel: 2 });
    } finally { await group.close(); }
  });
});

describe("Durable codemode: store, failures and limits", () => {
  test("store: a successful script's writes are committed; a failed or aborted one writes nothing; values outlive a restart", async () => {
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ modules: [module(hangProbe)] });
    try {
      const alice = await member(group);
      const values = async () => (await group.opened.harness.snapshot(CodemodeStoreDoc, alice.id, context))?.values;
      expect(returned((await script(group, alice, `store("a", { n: 1 }); store("b", "乙"); return load("a");`)).result)).toEqual({ n: 1 });
      expect(await values()).toEqual({ a: { n: 1 }, b: "乙" });

      const failed = await script(group, alice, `store("a", 2); throw new Error("坏了");`);
      expect(failed.result.isError).toBe(true);
      expect(failed.result.text).toContain("坏了");
      expect(await values()).toEqual({ a: { n: 1 }, b: "乙" });

      expect(returned((await script(group, alice, `store("b", undefined); store("c", [1, 2]); return [load("a"), load("b") ?? null];`)).result)).toEqual([{ n: 1 }, null]);
      expect(await values()).toEqual({ a: { n: 1 }, c: [1, 2] });

      const aborted = await script(group, alice, `store("d", 1); await tools.probe_hang({});`, async () => {
        await until(() => nestedRunning(group, alice, "probe_hang"), "hang started");
        await alice.abort(context);
      });
      expect(aborted.outcome).toBe("aborted");
      expect(await values()).toEqual({ a: { n: 1 }, c: [1, 2] });

      await group.reopen();
      const again = (await group.opened.harness.conversation(alice.id, context))!;
      expect(returned((await script(group, again, `return [load("a"), load("c")];`)).result)).toEqual([{ n: 1 }, [1, 2]]);
      // Per conversation.
      expect(returned((await script(group, await member(group, BOB), `return load("a") ?? "none";`)).result)).toBe("none");
    } finally { await group.close(); }
  });

  test("store limits hold for the merged store: scripts that ran at the same time cannot together exceed them", async () => {
    let arrived = 0;
    let met = Promise.withResolvers<void>();
    // Each script has read the store and made its writes before either commits.
    const meet = probe("probe_meet", async () => {
      if (++arrived % 2 === 0) met.resolve();
      await Promise.race([met.promise, Bun.sleep(20_000).then(() => { throw new Error("the other script never arrived"); })]);
      return text("met");
    });
    const group = await openGroup({ modules: [module(meet)] });
    try {
      let phones = 0;
      const fresh = () => member(group, `+861380001${String(++phones).padStart(4, "0")}`);
      const values = async (conversation: Conversation) => (await group.opened.harness.snapshot(CodemodeStoreDoc, conversation.id, context))?.values;
      type Writes = Record<string, number | undefined>;
      const stores = (writes: Writes) => Object.entries(writes)
        .map(([key, n]) => `store(${JSON.stringify(key)}, ${n === undefined ? "undefined" : `"x".repeat(${n})`});`).join("\n");
      /** Two scripts at once: each makes its writes (key: length of an ASCII value; undefined deletes), meets the other, returns 1. */
      const both = (conversation: Conversation, a: Writes, b: Writes) => {
        met = Promise.withResolvers<void>();
        return together(group, conversation, [`${stores(a)}\nawait tools.probe_meet({});\nreturn 1;`, `${stores(b)}\nawait tools.probe_meet({});\nreturn 1;`]);
      };
      const seed = async (conversation: Conversation, writes: Writes) => expect(returned((await script(group, conversation, `${stores(writes)}\nreturn 1;`)).result)).toBe(1);
      /** Characters the sandbox counts: key and JSON of each value. */
      const size = (stored: Record<string, JsonValue> | undefined) => Object.entries(stored ?? {}).reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0);
      const lengths = (stored: Record<string, JsonValue> | undefined) => Object.fromEntries(Object.entries(stored ?? {}).map(([key, value]) => [key, String(value).length]));
      const three = (prefix: string) => ({ [`${prefix}0`]: 250_000, [`${prefix}1`]: 250_000, [`${prefix}2`]: 250_000 });
      /** Two values that bring three 250000-character values (750012 characters) to the total limit plus `extra`. */
      const rest = (extra: number) => {
        const left = MAX_STORE_TOTAL_CHARS - 3 * (2 + 250_002) + extra - 2 * (2 + 2);
        return { b0: Math.floor(left / 2), b1: Math.ceil(left / 2) };
      };
      const failedOne = (results: Result[]) => {
        expect(results.map((result) => result.isError).sort()).toEqual([false, true]);
        const failed = results.find((result) => result.isError)!;
        expect(failed.text).toStartWith("Script failed\n");
        expect(failed.text).toContain("store() writes were not saved: store is full: with the writes of other scripts, stored values would have ");
        return results.indexOf(failed);
      };

      // Each within the limits on its own, together over: the second commit fails whole.
      const over = await fresh();
      const lost = failedOne(await both(over, three("a"), three("b")));
      expect(lengths(await values(over))).toEqual(lost === 0 ? three("b") : three("a"));

      // Together exactly at the limit, and one character over it.
      const exact = await fresh();
      expect((await both(exact, three("a"), rest(0))).map((result) => result.isError)).toEqual([false, false]);
      expect(size(await values(exact))).toBe(MAX_STORE_TOTAL_CHARS);
      const overByOne = await fresh();
      const byOne = failedOne(await both(overByOne, three("a"), rest(1)));
      expect(lengths(await values(overByOne))).toEqual(byOne === 0 ? rest(1) : three("a"));

      // Overwriting a key counts its new size only; deleting frees its size before the check.
      const overwrite = await fresh();
      await seed(overwrite, three("k"));
      expect((await both(overwrite, { k0: 250_000 }, rest(0))).map((result) => result.isError)).toEqual([false, false]);
      expect(lengths(await values(overwrite))).toEqual({ ...three("k"), ...rest(0) });
      expect(size(await values(overwrite))).toBe(MAX_STORE_TOTAL_CHARS);
      const deleted = await fresh();
      await seed(deleted, three("k"));
      expect((await both(deleted, { k0: undefined, a0: 250_000 }, { b0: 250_000 })).map((result) => result.isError)).toEqual([false, false]);
      expect(lengths(await values(deleted))).toEqual({ k1: 250_000, k2: 250_000, a0: 250_000, b0: 250_000 });

      // One value: the sandbox takes JSON of exactly MAX_STORE_VALUE_CHARS and refuses one more character.
      const single = await fresh();
      await seed(single, { v: MAX_STORE_VALUE_CHARS - 2 });
      const tooLong = await script(group, single, stores({ w: MAX_STORE_VALUE_CHARS - 1 }));
      expect(tooLong.result.text).toContain(`${MAX_STORE_VALUE_CHARS + 1}`);
      expect(lengths(await values(single))).toEqual({ v: MAX_STORE_VALUE_CHARS - 2 });
      // A stored value over the limit (not written by a script) fails every commit until it is deleted.
      await group.opened.harness.commit(async (tx) => {
        (await tx.doc(CodemodeStoreDoc, single.id)).values.v = "x".repeat(MAX_STORE_VALUE_CHARS - 1);
      }, context);
      const blocked = await script(group, single, `store("k", 1);\nreturn 1;`);
      expect(blocked.result.text).toContain(`store() writes were not saved: store("v") value has ${MAX_STORE_VALUE_CHARS + 1} characters of JSON`);
      expect(Object.keys((await values(single))!)).toEqual(["v"]);
      expect(returned((await script(group, single, `store("v", undefined);\nstore("k", 1);\nreturn 1;`)).result)).toBe(1);
      expect(await values(single)).toEqual({ k: 1 });
    } finally { await group.close(); }
  }, 120_000);

  test("store and outcome commit together: aborted before it, nothing is written; closed after it, recovery returns the recorded result and runs nothing again", async () => {
    let hold = false;
    let committed = Promise.withResolvers<void>();
    let runs = 0;
    const count = probe("probe_count", () => { runs++; return text("counted"); });
    // Lets the outcome commit finish, then keeps the call from going on until it is stopped.
    const holding = defineExtension({
      name: "fixture.hold-after-outcome",
      wraps: [{
        tool: "codemode",
        wrap: (tool: ToolRegistration) => ({
          ...tool,
          execute: (args: unknown, api: ToolExecutionApi, ctx: typeof context) => tool.execute(args as never, new Proxy(api, {
            get(target, property) {
              if (property === "commit") {
                return async (run: never, callContext: typeof context) => {
                  const value = await target.commit(run, callContext);
                  if (hold && typeof value === "object" && value !== null && "output" in value) {
                    committed.resolve();
                    await new Promise<void>((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
                  }
                  return value;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }), ctx),
        }),
      }],
    });
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ modules: [module(hangProbe, count)], extensions: [holding] });
    try {
      const alice = await member(group);
      const values = async () => (await group.opened.harness.snapshot(CodemodeStoreDoc, alice.id, context))?.values;

      // Aborted while the script runs: its writes were never committed.
      const before = await script(group, alice, `store("before", 1); await tools.probe_hang({});`, async () => {
        await until(() => nestedRunning(group, alice, "probe_hang"), "hang started");
        await alice.abort(context);
      });
      expect(before.outcome).toBe("aborted");
      // The official tool reads (and so creates) the store when a script starts; nothing was written to it.
      expect(await values()).toEqual({});

      // Closed after the outcome commit: recovery returns the recorded result, the store was written once, nothing reran.
      hold = true;
      const closed = await interrupt(group, alice, `await tools.probe_count({}); store("closed", "kept"); return "完成";`, async () => {
        await committed.promise;
        return true;
      });
      hold = false;
      expect(closed.outcome).toBe("completed");
      expect(returned(closed.result)).toBe("完成");
      expect(runs).toBe(1);
      expect(await values()).toEqual({ closed: "kept" });
    } finally { await group.close(); }
  }, 60_000);

  test("interrupted bash in a script stops with the Harness and is not run again", async () => {
    const group = await openGroup();
    try {
      const alice = await member(group);
      const tmp = places(group).tempDir;
      const recovered = await interrupt(group, alice, `
try { await tools.bash({ command: ${JSON.stringify(waitingCommand("recover"))} }); return "resolved"; } catch (error) { return error.message; }`,
        async () => existsSync(join(tmp, "recover-sleep.pid")), { afterClose: () => expectStopped(tmp, "recover") });
      expect(returned(recovered.result)).toBe("Tool bash was interrupted and may have partially run");
      expect(await readFile(join(tmp, "recover-runs.txt"), "utf8")).toBe("run\n");
    } finally { await group.close(); }
  }, 90_000);

  test("cancel: aborting the conversation stops a script's bash; a call the script leaves running is cancelled when it ends", async () => {
    const until_ = probe("probe_until", async ({ path }) => { await until(() => existsSync(path), path, 30_000); return text("there"); });
    const group = await openGroup({ modules: [module(until_)] });
    try {
      const alice = await member(group);
      const tmp = places(group).tempDir;
      const aborted = await script(group, alice, `await tools.bash({ command: ${JSON.stringify(waitingCommand("abort"))} }); return 1;`, async () => {
        await until(() => existsSync(join(tmp, "abort-sleep.pid")), "abort pids", 30_000);
        await alice.abort(context);
      });
      expect(aborted.settled).toMatchObject({ reason: "aborted" });
      expect(aborted.outcome).toBe("aborted");
      await expectStopped(tmp, "abort");

      const left = await script(group, alice, `
tools.bash({ command: ${JSON.stringify(waitingCommand("left", ['echo late > "$PI_USER_TMP/late.txt"']))} });
await tools.probe_until({ path: ${JSON.stringify(join(tmp, "left-sleep.pid"))} });
return "done";`);
      expect(returned(left.result)).toBe("done");
      expect(left.result.details!.calls.map((call) => [call.name, call.status])).toEqual([["bash", "cancelled"], ["probe_until", "ok"]]);
      await expectStopped(tmp, "left");
      expect(existsSync(join(tmp, "late.txt"))).toBe(false);
    } finally { await group.close(); }
  }, 90_000);

  test("timeout: the script fails, its pending sub-call is cancelled", async () => {
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ modules: [module(hangProbe)] });
    try {
      const run = await script(group, await member(group), `// @options: {"timeout_ms": 300}\nawait tools.probe_hang({});\nreturn 1;`);
      expect(run.result.isError).toBe(true);
      expect(run.result.text).toContain("Script failed");
      expect(run.result.text).toContain("Script timed out");
      expect(run.result.details!.calls).toMatchObject([{ name: "probe_hang", status: "cancelled" }]);
    } finally { await group.close(); }
  });

  test("output limits: 100000 items and 16Mi characters pass and spill into the caller's tmp; one more fails without store writes", async () => {
    const group = await openGroup({ modules: [module(echo)] });
    try {
      const alice = await member(group);
      const tmp = await realpath(places(group).tempDir).catch(() => places(group).tempDir);
      const items = await script(group, alice, `for (let i = 0; i < 100000; i++) text("x");`);
      expect(items.result.isError).toBe(false);
      expect(items.result.text.includes("Warning: truncated output (original token count:")).toBe(true);
      const spilled = items.result.details!.fullOutputPath!;
      expect(isPathInside(spilled, await realpath(dirname(spilled)))).toBe(true);
      expect(isPathInside(await realpath(spilled), tmp)).toBe(true);
      expect(items.result.text).toContain(`[Full output: ${spilled} (read with offset/limit)]`);
      const full = await readFile(spilled, "utf8");
      expect(full.startsWith("==> text 1/100000 <==\nx\n")).toBe(true);
      expect(full.endsWith("==> text 100000/100000 <==\nx")).toBe(true);
      expect(full.match(/^x$/gm)).toHaveLength(100000);

      const tooMany = await script(group, alice, `for (let i = 0; i < 100001; i++) text("x");`);
      expect(tooMany.result.isError).toBe(true);
      expect(tooMany.result.text).toContain("script output exceeded the limit");

      const chars = await script(group, alice, `text("x".repeat(16 * 1024 * 1024));`);
      expect(chars.result.isError).toBe(false);
      expect((await readFile(chars.result.details!.fullOutputPath!, "utf8")).length).toBe(16 * 1024 * 1024);

      const over = await script(group, alice, `store("k", 1); await tools.probe_echo({ text: "a" }); text("x".repeat(16 * 1024 * 1024 + 1));`);
      expect(over.result.isError).toBe(true);
      expect(over.result.text).toContain("script output exceeded the limit");
      expect(over.result.text).toContain("Tool calls made before the failure (they are not undone): probe_echo (");
      // Never written.
      expect(await group.opened.harness.snapshot(CodemodeStoreDoc, alice.id, context)).toEqual({ values: {} });
    } finally { await group.close(); }
  }, 120_000);
});

describe("Durable codemode: results directory", () => {
  test("links: results are written only under the real path of the caller's tmp; links in the way are refused or replaced, never followed", async () => {
    // Before each codemode call runs, `prepare` gets its results directory (the call ID and task are known then).
    let prepare: ((dir: string) => Promise<void>) | undefined;
    let aliceTmp = "";
    const prepared = defineExtension({
      name: "fixture.prepare",
      wraps: [{
        tool: "codemode",
        wrap: (tool: ToolRegistration) => ({
          ...tool,
          execute: async (args: unknown, api: ToolExecutionApi, ctx: typeof context) => {
            await prepare?.(join(resultsRoot(aliceTmp), resultsDirName(api.taskId as number, api.callId)));
            return tool.execute(args as never, api, ctx);
          },
        }),
      }],
    });
    const group = await openGroup({ extensions: [prepared] });
    aliceTmp = places(group).tempDir;
    const bobTmp = places(group, BOB).tempDir;
    try {
      const alice = await member(group);
      await mkdir(aliceTmp, { recursive: true });
      await mkdir(bobTmp, { recursive: true });
      const bobFile = join(bobTmp, "keep.txt");
      await writeFile(bobFile, "Bob 的文件");
      const bobUnchanged = async () => {
        expect(await readdir(bobTmp)).toEqual(["keep.txt"]);
        expect(await readFile(bobFile, "utf8")).toBe("Bob 的文件");
      };
      const removeLink = (path: string) => (process.platform === "win32" ? rmdir(path) : unlink(path));
      const SPILL = `// @options: {"max_output_tokens": 10}\ntext("长".repeat(400));`;
      const refused = async (pattern: string) => {
        const run = await script(group, alice, SPILL);
        expect(run.result.isError).toBe(false);
        expect(run.result.text).toContain("[Could not save the full output: ");
        expect(run.result.text).toContain(pattern);
        expect(run.result.details!.fullOutputPath).toBeUndefined();
        return run;
      };

      // The results root is a junction (a symlink on Linux) to Bob's tmp.
      prepare = async () => symlink(bobTmp, resultsRoot(aliceTmp), "junction");
      await refused("results are only written inside the caller's tmp");
      expect(await realpath(resultsRoot(aliceTmp))).toBe(await realpath(bobTmp));
      await bobUnchanged();
      await removeLink(resultsRoot(aliceTmp));

      // The call directory is one.
      prepare = async (dir) => {
        await mkdir(resultsRoot(aliceTmp), { recursive: true });
        await symlink(bobTmp, dir, "junction");
      };
      await refused("results are only written inside the caller's tmp");
      await bobUnchanged();

      // A hard link to Bob's file where the full output goes is replaced by the file, not written through.
      prepare = async (dir) => {
        await mkdir(dir, { recursive: true });
        await link(bobFile, join(dir, "output.txt"));
      };
      const replaced = await script(group, alice, SPILL);
      expect(await readFile(replaced.result.details!.fullOutputPath!, "utf8")).toBe("长".repeat(400));
      await bobUnchanged();

      // Normal: the files are private (where modes apply), the directory is released when the call ends, and the
      // member's read opens the file.
      prepare = undefined;
      const normal = await script(group, alice, SPILL);
      const path = normal.result.details!.fullOutputPath!;
      const dir = dirname(path);
      expect(isPathInside(await realpath(path), await realpath(aliceTmp))).toBe(true);
      const { rename } = await import("node:fs/promises");
      await rename(dir, `${dir}.closed`);
      await rename(`${dir}.closed`, dir);
      if (process.platform !== "win32") {
        for (const [entry, mode] of [[dir, 0o700], [path, 0o600]] as const) {
          expect([entry, (await stat(entry)).mode & 0o777]).toEqual([entry, mode]);
        }
      }
      const read = await script(group, alice, `return await tools.read({ path: ${JSON.stringify(path)} });`);
      expect(returned(read.result)).toContain("长".repeat(400));
      // Another member's script cannot read it.
      const denied = returned((await script(group, await member(group, BOB), `try { await tools.read({ path: ${JSON.stringify(path)} }); return "read"; } catch (error) { return error.message; }`)).result);
      expect(denied).not.toBe("read");
      await bobUnchanged();
    } finally { await group.close(); }
  }, 120_000);

  test("images a script shows: each distinct one saved once in the call's directory and named just before it, also after the text budget; a failed save is reported and the result stands", async () => {
    let prepare: ((dir: string) => Promise<void>) | undefined;
    let aliceTmp = "";
    const prepared = defineExtension({
      name: "fixture.prepare",
      wraps: [{
        tool: "codemode",
        wrap: (tool: ToolRegistration) => ({
          ...tool,
          execute: async (args: unknown, api: ToolExecutionApi, ctx: typeof context) => {
            await prepare?.(join(resultsRoot(aliceTmp), resultsDirName(api.taskId as number, api.callId)));
            return tool.execute(args as never, api, ctx);
          },
        }),
      }],
    });
    const pngBytes = png(3, 2);
    const PNG = pngBytes.toString("base64");
    const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    // A tool whose structured value is an image block: the script passes it on with image().
    const block = probe("probe_block", () => ({ ...text("图"), structuredContent: { type: "image", data: PNG, mimeType: "image/png" } }),
      { outputSchema: Type.Object({ type: Type.String(), data: Type.String(), mimeType: Type.String() }) });
    const group = await openGroup({ modules: [module(block)], extensions: [prepared] });
    aliceTmp = places(group).tempDir;
    const labelled = (content: Content[]) => content.flatMap((item, index) => {
      const match = /\[Image saved to ([^\n]+) \((image\/[a-z]+), (\d+) bytes\)\]$/.exec(item.text ?? "");
      return match === null ? [] : [{ path: match[1]!, mimeType: match[2]!, size: Number(match[3]!), next: content[index + 1]! }];
    });
    try {
      const alice = await member(group);
      const shown = await script(group, alice, `image("data:image/png;base64,${PNG}");
text("中间");
image(await tools.probe_block({}));
image({ type: "image", data: "${PNG}", mimeType: "image/png" });
image("data:image/gif;base64,${GIF}");
return "完成";`);
      expect(shown.result.isError).toBe(false);
      expect(returned(shown.result)).toBe("完成");
      const labels = labelled(shown.result.content);
      // Four images, two distinct: the PNG (from a data URL, a tool's block and a literal block) is saved once.
      expect(labels.map((label) => [basename(label.path), label.mimeType, label.size])).toEqual([
        ["image-1.png", "image/png", pngBytes.length], ["image-1.png", "image/png", pngBytes.length],
        ["image-1.png", "image/png", pngBytes.length], ["image-2.gif", "image/gif", Buffer.from(GIF, "base64").length],
      ]);
      // Each label is directly followed by its image, which stays in the result.
      expect(labels.map((label) => [label.next.type, label.next.mimeType, label.next.data])).toEqual([
        ["image", "image/png", PNG], ["image", "image/png", PNG], ["image", "image/png", PNG], ["image", "image/gif", GIF],
      ]);
      expect(shown.result.text).toContain("==> text 1/2 <==\n中间");
      expect(shown.result.text).toContain("==> text 2/2 <==\n完成");
      const dir = dirname(labels[0]!.path);
      expect(isPathInside(await realpath(dir), await realpath(aliceTmp))).toBe(true);
      expect(await readFile(labels[0]!.path)).toEqual(pngBytes);
      expect((await readFile(labels[3]!.path)).toString("base64")).toBe(GIF);
      if (process.platform !== "win32") {
        for (const label of labels) expect([label.path, (await stat(label.path)).mode & 0o777]).toEqual([label.path, 0o600]);
      }

      // Over the text budget: the text is cut and saved, the image's label comes after the cut and is whole.
      const cut = await script(group, alice, `// @options: {"max_output_tokens": 10}
text("x".repeat(100)); image("data:image/png;base64,${PNG}"); text("y".repeat(100));`);
      expect(cut.result.content[1]!.text).toStartWith("Warning: truncated output");
      expect(cut.result.text).toContain(`[Full output: ${cut.result.details!.fullOutputPath}`);
      const [after] = labelled(cut.result.content);
      expect(basename(after!.path)).toBe("image-1.png");
      expect(dirname(after!.path)).toBe(dirname(cut.result.details!.fullOutputPath!));
      expect(await readFile(after!.path)).toEqual(pngBytes);

      // A save that fails (a directory has the file's name) is reported where the path would be; the script completed.
      prepare = async (callDir) => { await mkdir(join(callDir, "image-1.png"), { recursive: true }); };
      const failed = await script(group, alice, `image("data:image/png;base64,${PNG}"); return "仍完成";`);
      prepare = undefined;
      expect(failed.result.isError).toBe(false);
      expect(returned(failed.result)).toBe("仍完成");
      expect(failed.result.content[1]!.text).toStartWith(`[Image (image/png, ${pngBytes.length} bytes) could not be saved: `);
      expect(failed.result.content[2]).toMatchObject({ type: "image", data: PNG });
      expect(labelled(failed.result.content)).toEqual([]);

      // Expiry removes the saved images with their call directories (Linux keeps them for the rootless reclaimer).
      const removed = await removeResultDirectories(aliceTmp, Number.POSITIVE_INFINITY);
      if (process.platform === "linux") expect(removed).toEqual([]);
      else expect(removed).toEqual(expect.arrayContaining([basename(dir), basename(dirname(after!.path))]));
      expect(existsSync(labels[0]!.path) || existsSync(after!.path)).toBe(process.platform === "linux");
    } finally { await group.close(); }
  }, 60_000);
});

describe("Durable codemode: grammar and replay", () => {
  type Item = { type?: string; call_id?: string; id?: string; name?: string; input?: string; arguments?: string };
  type Body = { tools: { type: string; name: string; format?: unknown }[]; input: Item[] };
  const sse = (events: ({ type: string } & Record<string, unknown>)[]) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
  const completed = (id: string) => ({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  const CODE = `return "from-model";`;
  /** A Responses turn with a codemode custom tool call and a read function call, as OpenAI streams them. */
  const toolCalls = () => sse([
    { type: "response.created", response: { id: "resp_tools" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_one", call_id: "call_one", name: "codemode", input: "" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "ctc_one", call_id: "call_one", name: "codemode", input: CODE } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_two", call_id: "call_two", name: "read", arguments: "" } },
    { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_two", call_id: "call_two", name: "read", arguments: JSON.stringify({ path: "note.txt" }) } },
    completed("resp_tools"),
  ]);
  const answer = (text: string) => sse([
    { type: "response.created", response: { id: "resp_text" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_one", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_one", content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_one", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
    completed("resp_text"),
  ]);

  test("Responses: codemode is a custom grammar tool; the model's own ctc_/fc_ items replay unchanged; another provider's calls replay without item ids", async () => {
    const bodies: Body[] = [];
    const answers: (() => Response)[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json() as Body);
        return (answers.shift() ?? (() => answer("完成")))();
      },
    });
    try {
      const agentDir = join(fixture.root, "agent-responses");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          "local-responses": {
            api: "openai-responses", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "synthetic-literal-key",
            models: [{
              id: "grammar", name: "grammar", contextWindow: 32000, maxTokens: 1024, reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsOpenAIGrammarTools: true },
            }],
          },
        },
      }));
      const models = await openModelRuntime({ modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
      const group = await openGroup({
        models: models as never,
        settings: { retry: { maxRetries: 0, baseDelayMs: 5, maxAgentDelayMs: 20 }, stream: { maxRetries: 0, timeoutMs: 10_000 } },
      });
      const responses = { provider: "local-responses", modelId: "grammar" };
      const item = (body: Body, type: string, callId: string) => {
        const found = body.input.filter((entry) => entry.type === type && entry.call_id === callId);
        expect(found.map((entry) => [entry.type, entry.call_id])).toEqual([[type, callId]]);
        return found[0]!;
      };
      const prefixes = (body: Body) => {
        for (const entry of body.input) {
          if (entry.type === "custom_tool_call" && entry.id !== undefined) expect(entry.id).toMatch(/^ctc_/);
          if (entry.type === "function_call" && entry.id !== undefined) expect(entry.id).toMatch(/^fc_/);
        }
      };
      try {
        const workspace = places(group).workspaceDir;
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, "note.txt"), "replay fixture note");

        // The Responses model writes the history: its custom tool call runs the raw source as a script.
        const alice = (await memberConversation(group.opened.harness, GROUP, ALICE, { model: responses }, context)).conversation;
        answers.push(toolCalls);
        await (await alice.submit({ type: "input", content: "先做两件事" }, context)).wait(context);
        expect(bodies).toHaveLength(2);
        expect(bodies[0]!.tools.find((tool) => tool.name === "codemode")).toMatchObject({
          type: "custom", format: { type: "grammar", syntax: "lark", definition: CODEMODE_SOURCE_GRAMMAR },
        });
        expect(bodies[0]!.tools.filter((tool) => tool.name !== "codemode").map((tool) => [tool.name, tool.type]))
          .toEqual(["read", "bash", "edit", "write"].map((name) => [name, "function"]));
        const script = await resultOf(alice, "call_one|ctc_one");
        expect(script).toMatchObject({ isError: false });
        expect(returned(script!)).toBe("from-model");
        expect((await resultOf(alice, "call_two|fc_two"))!.text).toContain("replay fixture note");
        await (await alice.submit({ type: "input", content: "继续" }, context)).wait(context);
        expect(bodies).toHaveLength(3);
        for (const body of bodies.slice(1)) {
          expect(item(body, "custom_tool_call", "call_one")).toMatchObject({ id: "ctc_one", name: "codemode", input: CODE });
          item(body, "custom_tool_call_output", "call_one");
          expect(item(body, "function_call", "call_two")).toMatchObject({ id: "fc_two", name: "read" });
          item(body, "function_call_output", "call_two");
          prefixes(body);
        }

        // Another provider wrote the history (a gateway's "call|item" ids, a plain id): the calls replay with
        // normalised call ids and no item ids, codemode still as a custom tool call.
        const bob = await member(group, BOB);
        const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
        group.faux.setResponses([
          call("codemode", { code: `return "from-gateway";` }, "call_gw|ctc_gw"),
          call("read", { path: "note.txt" }, "call_rd|fc_rd"),
          call("codemode", { code: `return "plain-id";` }, "call_plain"),
          () => fauxAssistantMessage("RECORDED"),
        ]);
        await (await bob.submit({ type: "input", content: "先做三件事" }, context)).wait(context);
        for (const id of ["call_gw|ctc_gw", "call_rd|fc_rd", "call_plain"]) expect(await resultOf(bob, id)).toMatchObject({ isError: false });
        await bob.configure({ model: responses }, context);
        await (await bob.submit({ type: "input", content: "继续" }, context)).wait(context);
        expect(bodies).toHaveLength(4);
        const replay = bodies[3]!;
        expect(replay.input.filter((entry) => entry.type?.endsWith("call")).map((entry) => [entry.type, entry.call_id, entry.id, entry.name])).toEqual([
          ["custom_tool_call", "call_gw_ctc_gw", undefined, "codemode"],
          ["function_call", "call_rd_fc_rd", undefined, "read"],
          ["custom_tool_call", "call_plain", undefined, "codemode"],
        ]);
        expect(item(replay, "custom_tool_call", "call_gw_ctc_gw").input).toBe(`return "from-gateway";`);
        for (const callId of ["call_gw_ctc_gw", "call_plain"]) item(replay, "custom_tool_call_output", callId);
        item(replay, "function_call_output", "call_rd_fc_rd");
        prefixes(replay);
      } finally { await group.close(); }
    } finally { server.stop(true); }
  }, 60_000);
});

describe("Durable codemode: latency", () => {
  test("sub-call overhead: sequential sub-calls paced by the progress policy (the project's, Durable's default as control); parallel calls share commits", async () => {
    /** Commits of a script with no sub-call, 10 sequential and 10 parallel ones, and the times the script measured. */
    const measure = async (progress: ProgressPolicy) => {
      let commits = 0;
      const counting = (storage: Storage): Storage => new Proxy(storage, {
        get: (target, property) => {
          if (property === "commit") return (...args: Parameters<Storage["commit"]>) => { commits++; return target.commit(...args); };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const group = await openGroup({
        modules: [module(echo)], storage: counting,
        settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 }, progress },
      });
      try {
        const conversation = await member(group);
        const counted = async (code: string) => {
          const before = commits;
          const run = await script(group, conversation, code);
          return { commits: commits - before, ms: returned(run.result) as number };
        };
        const none = await counted(`const started = Date.now(); return Date.now() - started;`);
        const sequential = await counted(`const started = Date.now();
for (let i = 0; i < 10; i++) await tools.probe_echo({ text: String(i) });
return Date.now() - started;`);
        const parallel = await counted(`const started = Date.now();
await Promise.all(Array.from({ length: 10 }, (_, i) => tools.probe_echo({ text: String(i) })));
return Date.now() - started;`);
        return { none: none.commits, sequential, parallel };
      } finally { await group.close(); }
    };
    const project = await measure(PROGRESS);
    const control = await measure(DEFAULT_PROGRESS_POLICY);
    for (const [name, policy, measured] of [["project", PROGRESS, project], ["Durable default", DEFAULT_PROGRESS_POLICY, control]] as const) {
      console.log(`codemode sub-call latency, ${name} outputIntervalMs=${policy.outputIntervalMs}: 10 sequential ${measured.sequential.ms} ms`
        + ` (${(measured.sequential.ms / 10).toFixed(0)} ms each), ${measured.sequential.commits - measured.none} more commits than a script`
        + ` without sub-calls (${measured.none}); 10 parallel ${measured.parallel.ms} ms, ${measured.parallel.commits - measured.none} more commits`);
      // Parallel calls share commits. The times are only logged: under load, and paced by the progress interval, a
      // parallel run can take as long as the sequential one (WSL full run, 2026-10-14: 153 ms against 145 ms).
      expect(measured.parallel.commits).toBeLessThan(measured.sequential.commits);
    }
  }, 60_000);
});
