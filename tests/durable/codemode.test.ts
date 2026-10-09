// Codemode on the Durable engine (D2-3, src/durable/codemode/), driven by faux codemode calls through a real group
// Harness wired as the service will be (the door first, then mixin.base, fixtures and mixin.codemode). Real sandbox,
// shells and files under tmp/; a local fake Responses endpoint on 127.0.0.1 for the grammar replay; no network.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readFile, readlink, realpath, rename, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Message, type Models, Type, type Usage } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { CODEMODE_SOURCE_GRAMMAR, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS, renderToolSample } from "@earendil-works/pi-codemode";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  configure, type Conversation, DEFAULT_PROGRESS_POLICY, defineExtension, type Extension, type HarnessSettings, LiveDoc, type ModelRef,
  type ProgressPolicy, type Storage, type ToolExecutionApi, type ToolRegistration, UsageDoc,
} from "@earendil-works/pi-durable";
import { openModelRuntime } from "../../src/core/model-config.ts";
import { isPathInside } from "../../src/agent/paths.ts";
import { type CallableTool, type CodemodeDetails, codemodeExtension, CodemodeStoreDoc } from "../../src/durable/codemode/index.ts";
import { PREVIEW_LIMIT, removeCodemodeResults, resultsDirName, resultsRoot } from "../../src/durable/codemode/results.ts";
import { toCodemodeDeclaration } from "../../src/durable/codemode/upstream.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { projectConversation } from "../../src/durable/projection.ts";
import {
  baseMemberTools, type BaseToolsOptions, type MemberCall, memberPlaces, memberRegistration, type MemberTool, resolveMember,
} from "../../src/durable/tools.ts";
import { type GroupHarness, openGroupHarness, PROJECT_PROGRESS as PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-codemode-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const ALICE = "+8613800000001";
const BOB = "+8613800000002";
let counter = 0;

type Setup = {
  /** Catalogue entries besides mixin.base's four tools. */
  tools?: CallableTool[];
  /** Installed between mixin.base and mixin.codemode. */
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
  const extensions = [
    defineExtension({ name: "mixin.base", tools: members.map(memberRegistration) }),
    ...setup.extensions ?? [],
    codemodeExtension({ members: base, tools: [...members.map((tool) => ({ extension: "mixin.base", tool })), ...setup.tools ?? []] }),
  ];
  const path = join(fixture.root, `db-${n}.sqlite`);
  const open = () => openGroupHarness(path, models, {
    group: GROUP, door: setup.door, extensions, settings: setup.settings ?? { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } }, storage: setup.storage,
  });
  const group: Group = {
    opened: await open(), faux, model: { provider: model.provider, modelId: model.id }, base, extensions,
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
type Result = { isError: boolean; text: string; content: Content[]; details?: CodemodeDetails; usage?: Usage };

/** The tool result of `callId` in the conversation. */
async function resultOf(conversation: Conversation, callId: string): Promise<Result | undefined> {
  for (const entry of (await conversation.entries({}, 1000, undefined, context)).items) {
    const message = entry.model?.[0] as { toolCallId?: string; isError: boolean; content: Content[]; details?: CodemodeDetails; usage?: Usage } | undefined;
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

/** The committed running output of the conversation's running tool slot. */
async function slotOutput(group: Group, conversation: Conversation): Promise<string> {
  const live = await group.opened.harness.snapshot(LiveDoc, conversation.id, context);
  return live?.tools?.find((slot) => slot.status === "running")?.output ?? "";
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
  definition: Partial<ToolDefinition> = {}): MemberTool {
  return {
    definition: {
      name, label: name, description: `Fixture tool ${name}.`, exposure: "codemode",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => { throw new Error("fixture tools run through MemberTool.run"); },
      ...definition,
    } as ToolDefinition,
    replay: "unsafe",
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
const fixtures = (extension: string, ...tools: MemberTool[]): CallableTool[] => tools.map((tool) => ({ extension, tool }));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = async (path: string) => (await readFile(path, "utf8")).trimEnd().split("\n");

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

test("parallel codemode children project nested counts once across cursor replay and projection upgrade", async () => {
  const group = await openGroup({ tools: fixtures("fixture.module", echo), extensions: [moduleExtension] }), alice = await member(group);
  const ledger = openStatsLedger(group.base.root);
  try {
    const run = await script(group, alice, 'await Promise.all([tools.probe_echo({text:"one"}),tools.probe_echo({text:"two"})]);');
    expect(run.result.details!.complete).toBe(true);
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
const send = probe("send_probe", () => text("sent"), { exposure: "model-only", description: "Send something (model only)." });
const sendExtension = defineExtension({ name: "fixture.send", tools: [memberRegistration(send)] });
const moduleExtension = defineExtension({ name: "fixture.module" });

describe("Durable codemode: declarations and scope", () => {
  test("declarations: the grammar codemode tool, the mode-on line on direct tools, the script-only tools listed", async () => {
    const group = await openGroup({
      tools: [...fixtures("fixture.module", echo), ...fixtures("fixture.send", send)], extensions: [moduleExtension, sendExtension],
    });
    try {
      const codemode = group.extensions.at(-1)!.tools![0]!;
      expect(codemode.name).toBe("codemode");
      expect(codemode.replay).toBe("unsafe");
      expect(codemode.outputLimits).toEqual({ maxBytes: 256 * 1024, maxLines: 50_000, retain: "head" });
      expect(codemode.constrainedSampling).toEqual({ type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } });
      // Mode on: only the script-only tools are listed, under their namespace.
      expect(codemode.description).toContain("## fixture_ns\nFixture tools for the codemode tests.\n\n### `probe_echo`");
      for (const name of ["send_probe", "### `read`", "### `bash`"]) expect(codemode.description).not.toContain(name);

      const original = Object.fromEntries(baseMemberTools(group.base).map((tool) => [tool.definition.name, tool.definition.description]));
      const declared = Object.fromEntries(getCurrentTools(await ask(group, await member(group))).map((tool) => [tool.name, tool]));
      expect(Object.keys(declared)).toEqual(["read", "bash", "edit", "write", "send_probe", "codemode"]);
      for (const name of ["edit", "write"]) {
        expect(declared[name]!.description).toBe(`${original[name]!.trim()}\n\nCodemode: \`tools.${name}(args)\` resolves to a string.`);
      }
      // coding-agent 1.0.4: read's value is the text, or an image block for an image file.
      expect(declared.read!.description).toBe(`${original.read!.trim()}\n\nCodemode: \`tools.read(args)\` resolves to `
        + "`string | { data: string; mimeType: string; note: string; type: \"image\"; }`.");
      expect(declared.bash!.description)
        .toBe(`${original.bash!.trim()}\n\nCodemode: \`tools.bash(args)\` resolves to \`{ output, truncated, full_output_path?, exit_code, wall_time_seconds }\`.`);
      expect(declared.send_probe!.description).toBe("Send something (model only).");
      expect(declared.codemode).toMatchObject({ description: codemode.description, constrainedSampling: codemode.constrainedSampling });

      // A conversation that does not select mixin.codemode keeps the plain declarations.
      const bob = await member(group, BOB);
      await bob.configure({ extensions: { remove: [group.extensions.at(-1)!] } }, context);
      const plain = getCurrentTools(await ask(group, bob));
      expect(plain.map((tool) => [tool.name, tool.description])).toEqual([
        ...["read", "bash", "edit", "write"].map((name) => [name, original[name]]), ["send_probe", "Send something (model only)."],
      ]);
    } finally { await group.close(); }
  });

  test("scope: direct tools offered and script-only tools of selected extensions; discovery globals; no models", async () => {
    const deferred = probe("probe_deferred", () => text("deferred ok"), { exposure: "deferred", description: "A deferred fixture tool." });
    const hidden = probe("probe_hidden", () => text("hidden"), { exposure: "hidden" });
    const off = probe("probe_off", () => text("off"));
    const offExtension = defineExtension({ name: "fixture.off" });
    const group = await openGroup({
      tools: [...fixtures("fixture.module", echo, deferred, hidden), ...fixtures("fixture.off", off), ...fixtures("fixture.send", send)],
      extensions: [moduleExtension, offExtension, sendExtension],
    });
    try {
      const description = group.extensions.at(-1)!.tools![0]!.description;
      expect(description).not.toContain("probe_deferred");
      expect(description).not.toContain("probe_hidden");
      // The description is per registry: a tool of an extension one conversation deselects stays listed (not callable).
      expect(description).toContain("### `probe_off`");

      const alice = await member(group);
      await alice.configure({ extensions: { remove: [offExtension] } }, context);
      const run = await script(group, alice, `
const miss = (get) => { try { get(); return "no error"; } catch (error) { return error.message; } };
return {
  names: ALL_TOOLS.map((tool) => tool.name),
  has: ["read", "probe_echo", "probe_deferred", "send_probe", "probe_hidden", "probe_off", "codemode"].map((name) => name in tools),
  typo: miss(() => tools.Read),
  send: miss(() => tools.send_probe),
  models: typeof models,
  search: (await searchTools("echo text back")).map((tool) => tool.name),
  scoped: (await searchTools("fixture", { namespace: "fixture_ns" })).map((tool) => tool.name),
  sample: await describeTool("probe_echo"),
  namespace: await describeNamespace("fixture_ns"),
  echo: await tools.probe_echo({ text: "你好" }),
  deferred: await tools.probe_deferred({}),
};`);
      const value = returned(run.result);
      expect(value.names).toEqual(["read", "bash", "edit", "write", "probe_echo", "probe_deferred"]);
      expect(value.has).toEqual([true, true, true, false, false, false, false]);
      expect(value.typo).toStartWith("tools.Read does not exist. Did you mean tools.read?");
      expect(value.send).toStartWith("tools.send_probe does not exist.");
      expect(value.models).toBe("undefined");
      expect(value.search[0]).toBe("probe_echo");
      expect(value.scoped).toEqual(["probe_echo"]);
      expect(value.sample).toBe(renderToolSample(toCodemodeDeclaration(echo.definition)));
      expect(value.namespace).toEqual({ ...NAMESPACE, tools: ["probe_echo"] });
      expect(value.echo).toEqual({ echo: "你好" });
      expect(value.deferred).toBe("deferred ok");
      expect(run.result.details).toMatchObject({ complete: true, calls: [{ name: "probe_echo", status: "ok" }, { name: "probe_deferred", status: "ok" }] });

      // A tool the conversation's tool filter removes is not callable from scripts either.
      const bob = await member(group, BOB);
      const bash = group.extensions[0]!.tools!.find((tool) => tool.name === "bash")!;
      await bob.configure({ tools: { remove: [bash] } }, context);
      const filtered = returned((await script(group, bob, `return { names: ALL_TOOLS.map((tool) => tool.name), bash: "bash" in tools };`)).result);
      expect(filtered).toEqual({ names: ["read", "edit", "write", "probe_echo", "probe_deferred", "probe_off"], bash: false });
    } finally { await group.close(); }
  });

  test("scope: a same-named tool another extension puts in place of a direct tool is neither described nor called as that tool", async () => {
    const other = {
      name: "read", description: "Another extension's read.", parameters: Type.Object({ key: Type.String() }), replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: "other read" }] }),
    } as unknown as ToolRegistration;
    const group = await openGroup({ extensions: [defineExtension({ name: "fixture.other-read", tools: [other] })] });
    try {
      const alice = await member(group);
      const declared = getCurrentTools(await ask(group, alice));
      expect(declared.find((tool) => tool.name === "read")!.description).toBe("Another extension's read.");
      expect(declared.find((tool) => tool.name === "bash")!.description).toContain("Codemode: `tools.bash(args)`");
      expect(returned((await script(group, alice, `return { read: "read" in tools, bash: "bash" in tools };`)).result)).toEqual({ read: false, bash: true });
    } finally { await group.close(); }
  });

  test("controlled entry: availability is fixed per codemode call (Durable's phase agent); arguments are repaired and validated before anything runs", async () => {
    let harness: GroupHarness["harness"] | undefined;
    let target: Conversation["id"] | undefined;
    const toggle = probe("probe_toggle", async () => {
      await harness!.commit((tx) => configure(tx, target!, { extensions: { remove: [moduleExtension] } }), context);
      return text("toggled");
    });
    const group = await openGroup({
      tools: [...fixtures("fixture.module", echo), ...fixtures("fixture.toggle", toggle)],
      extensions: [moduleExtension, defineExtension({ name: "fixture.toggle" })],
    });
    try {
      harness = group.opened.harness;
      const alice = await member(group);
      target = alice.id;
      const runsBefore = echoRuns;
      const run = await script(group, alice, `
const first = await tools.probe_echo({ text: "一" });
await tools.probe_toggle({});
let second;
try { await tools.probe_echo({ text: "二" }); second = "ran"; } catch (error) { second = error.message; }
return { first, second };`);
      // Durable resolved this phase's agent before the change, as it resolved the codemode call itself.
      expect(returned(run.result)).toEqual({ first: { echo: "一" }, second: "ran" });
      expect(echoRuns - runsBefore).toBe(2);
      // The next codemode call runs with the changed agent.
      const next = await script(group, alice, `
let echo;
try { tools.probe_echo; echo = "present"; } catch (error) { echo = error.message; }
return { names: ALL_TOOLS.map((tool) => tool.name), echo };`);
      expect(returned(next.result)).toMatchObject({ names: ["read", "bash", "edit", "write", "probe_toggle"], echo: expect.stringContaining("tools.probe_echo does not exist") });
      expect(echoRuns - runsBefore).toBe(2);

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
      expect((await readdir(tmp)).sort()).toEqual(["codemode", "旧格式.txt"]);
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
  test("bash: scripts get the structured value (exit code, output), a timeout rejects, a large output's full file is in the caller's tmp", async () => {
    const group = await openGroup();
    try {
      const large = `awk 'BEGIN { for (i = 0; i < 30000; i++) printf "line-%05d %s\\n", i, "xxxxxxxxxxxxxxxxxxxxxxxxxxxx" }'`;
      const run = await script(group, await member(group), `
const exit = await tools.bash({ command: "echo 失败前; exit 3" });
let timeout;
try { await tools.bash({ command: "sleep 30", timeout: 1 }); } catch (error) { timeout = error.message; }
const big = await tools.bash({ command: ${JSON.stringify(large)} });
return { exit, timeout, big: {
  truncated: big.truncated, path: big.full_output_path, length: big.output.length, exit: big.exit_code,
  head: big.output.slice(0, 11), omitted: big.output.includes(" bytes omitted ...]"), tail: big.output.slice(-40),
} };`);
      const value = returned(run.result);
      expect(value.exit).toMatchObject({ output: "失败前\n", truncated: false, exit_code: 3 });
      expect(typeof value.exit.wall_time_seconds).toBe("number");
      expect(value.timeout).toContain("Command timed out after 1 seconds");
      // The official structured output: the first and last 512 KiB around a notice.
      expect(value.big).toMatchObject({ truncated: true, exit: 0, head: "line-00000 ", omitted: true, tail: "line-29999 xxxxxxxxxxxxxxxxxxxxxxxxxxxx\n" });
      expect(value.big.length).toBeLessThanOrEqual(1024 * 1024 + 64);
      expect(isPathInside(value.big.path, await realpath(places(group).tempDir))).toBe(true);
      const full = await readFile(value.big.path, "utf8");
      expect(full.startsWith("line-00000 ") && full.includes("line-29999 ")).toBe(true);
      expect(run.result.details!.calls.map((call) => [call.name, call.status])).toEqual([["bash", "error"], ["bash", "error"], ["bash", "ok"]]);
      expect(run.result.details!.calls[0]!.error).toContain("Command exited with code 3");
    } finally { await group.close(); }
  }, 90_000);

  test("read (coding-agent 1.0.4): a text file's value is its text, recorded as text; an image file's value is an image block, recorded as its note and one image file", async () => {
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
image(shot);
return { whole, part, keys: Object.keys(shot).sort(), type: shot.type, mimeType: shot.mimeType, note: shot.note, data: shot.data };`);
      expect(run.result.isError).toBe(false);
      const value = returned(run.result);
      // The text whole, and offset/limit as the official read applies them (1-based offset, a continuation note).
      expect(value.whole).toBe(rows.join("\n"));
      expect(value.part).toStartWith(`${rows[1]}\n`);
      expect(value.part).toContain("offset=3");
      expect(value.part).not.toContain(rows[2]!);
      expect([value.keys, value.type, value.mimeType]).toEqual([["data", "mimeType", "note", "type"], "image", "image/png"]);
      expect(value.note).toStartWith("Read image file [image/png]");
      // The script showed the block: label and image, the image being read's data.
      const shown = run.result.content.findIndex((item) => item.type === "image");
      expect(run.result.content[shown]).toMatchObject({ type: "image", mimeType: "image/png", data: value.data });
      expect(run.result.content[shown - 1]!.text).toStartWith("[Image saved to ");

      // Records: the long text as text (1.txt, not JSON); the short part whole in its line; the image block as its note and
      // one image file (3-1.png), no JSON with the base64 data.
      const dir = dirname(run.result.details!.index!);
      expect((await readdir(dir)).sort()).toEqual(["1.txt", "3-1.png", "index.txt", "output-1.png"]);
      expect(await readFile(join(dir, "1.txt"), "utf8")).toBe(rows.join("\n"));
      expect(await readFile(join(dir, "3-1.png"))).toEqual(Buffer.from(value.data, "base64"));
      const index = await lines(run.result.details!.index!);
      const ended = (n: number) => index.find((line) => line.startsWith(`[${run.id}/${n}] read ok`))!;
      expect(ended(1)).toContain(`(first ${PREVIEW_LIMIT} of ${rows.join("\n").length} characters; full text: [text/plain `);
      expect(ended(1)).toContain(`${join(dir, "1.txt")} sha256:`);
      expect(ended(2)).toBe(`[${run.id}/2] read ok -> ${JSON.stringify(value.part)}`);
      expect(ended(3)).toStartWith(`[${run.id}/3] read ok -> ${JSON.stringify(value.note)} [image/png ${Buffer.from(value.data, "base64").length} B: ${join(dir, "3-1.png")} sha256:`);
      expect(index.join("\n")).not.toContain(value.data);
    } finally { await group.close(); }
  }, 60_000);

  test("a script that patches a built-in still ends (pi-codemode 1.0.4, #10444): with a sub-call and store(), when it throws, and the conversation goes on", async () => {
    const group = await openGroup({ tools: fixtures("fixture.module", echo), extensions: [moduleExtension] });
    try {
      const alice = await member(group);
      // pi-codemode 1.0.3 never settled these: its host threw while reading the store writes or the value.
      const patched = await script(group, alice, `Array.prototype.toJSON = function () { return {}; };
const echoed = await tools.probe_echo({ text: "补丁之后" });
store("k", [1, 2]);
return [echoed, [1, 2]];`);
      expect(patched.result.isError).toBe(false);
      expect(returned(patched.result)).toEqual([{ echo: "补丁之后" }, [1, 2]]);
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

  test("parallel sub-calls finishing in reverse keep their own numbers and files; the index has every event", async () => {
    const wait = probe("probe_wait", async ({ ms, text: value }) => { await Bun.sleep(ms); return text(value); });
    const group = await openGroup({ tools: fixtures("fixture.module", wait), extensions: [moduleExtension] });
    try {
      const run = await script(group, await member(group), `
const [a, b] = await Promise.all([tools.probe_wait({ ms: 600, text: "甲".repeat(400) }), tools.probe_wait({ ms: 1, text: "乙".repeat(400) })]);
return [a.length, b.length];`);
      expect(returned(run.result)).toEqual([400, 400]);
      expect(run.result.content).toHaveLength(2);
      const { details } = run.result;
      expect(details).toMatchObject({ complete: true, calls: [{ id: `${run.id}/1`, status: "ok" }, { id: `${run.id}/2`, status: "ok" }] });
      const dir = dirname(details!.index!);
      expect(isPathInside(dir, places(group).tempDir)).toBe(true);
      expect(await readFile(join(dir, "1.txt"), "utf8")).toBe("甲".repeat(400));
      expect(await readFile(join(dir, "2.txt"), "utf8")).toBe("乙".repeat(400));
      const index = await lines(details!.index!);
      expect(index[0]).toStartWith(`codemode call ${run.id} (task `);
      const events = index.slice(1).map((line) => line.split(" ").slice(0, 3).join(" "));
      expect(events.slice(0, 2).sort()).toEqual([`[${run.id}/1] probe_wait started`, `[${run.id}/2] probe_wait started`]);
      expect(events.slice(2)).toEqual([`[${run.id}/2] probe_wait ok`, `[${run.id}/1] probe_wait ok`]);
      expect(index[3]).toContain(`(first ${PREVIEW_LIMIT} of 400 characters; full text: [text/plain 1200 B: ${join(dir, "2.txt")} sha256:`);
      // Private where modes apply: directories 0700, files 0600.
      if (process.platform !== "win32") {
        for (const [path, mode] of [[resultsRoot(places(group).tempDir), 0o700], [dir, 0o700], [details!.index!, 0o600], [join(dir, "1.txt"), 0o600]] as const) {
          expect([path, (await stat(path)).mode & 0o777]).toEqual([path, mode]);
        }
      }
    } finally { await group.close(); }
  });

  test("interrupted: what finished is in the recovered result with previews and file references; the model reads the full text", async () => {
    const textProbe = probe("probe_text", ({ length }) => text("字".repeat(length)));
    const structProbe = probe("probe_struct", ({ length }) => ({ ...text("ignored"), structuredContent: { data: "x".repeat(length) } }), {
      outputSchema: Type.Object({ data: Type.String() }),
    });
    const image = png(4, 4);
    const imageProbe = probe("probe_image", () => ({ content: [{ type: "text", text: "图" }, { type: "image", data: image.toString("base64"), mimeType: "image/png" }], details: undefined }));
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ tools: fixtures("fixture.module", textProbe, structProbe, imageProbe, hangProbe), extensions: [moduleExtension] });
    try {
      const alice = await member(group);
      const reference = (messages: Message[], callId: string) => {
        const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === callId) as { content: Content[] } | undefined;
        const found = result?.content.map((item) => item.text ?? "").join("").match(/full text: \[text\/plain 903 B: (.+?) sha256:/);
        if (!found) throw new Error(`no reference in ${callId}`);
        return found[1]!;
      };
      let readPath = "";
      const recovered = await interrupt(group, alice, `
await tools.probe_text({ length: 300 });
await tools.probe_text({ length: 301 });
await tools.probe_struct({ length: 10 });
await tools.probe_struct({ length: 2000 });
await tools.probe_image({});
await tools.probe_hang({});
return "unreachable";`, async () => (await slotOutput(group, alice)).includes("probe_hang started"), {
        next: [
          (messages) => {
            readPath = reference(messages, `cm-${scripts}`);
            return fauxAssistantMessage([fauxToolCall("read", { path: readPath }, { id: "follow" })], { stopReason: "toolUse" });
          },
          () => fauxAssistantMessage("好的"),
        ],
      });
      const { id, result } = recovered;
      expect(recovered.outcome).toBe("failed");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Tool codemode was interrupted and may have partially run");
      const dir = dirname(result.details!.index!);
      expect(result.text).toStartWith(`Sub-call index: ${result.details!.index!} (every sub-call and its result; read it if this output is cut short)\n`);
      const ref = (name: string, mime: string, bytes: number) => `[${mime} ${bytes} B: ${join(dir, name)} sha256:`;
      expect(result.text).toContain(`[${id}/1] probe_text ok -> ${JSON.stringify("字".repeat(300))}\n`);
      expect(result.text).toContain(`[${id}/2] probe_text ok -> ${JSON.stringify(`${"字".repeat(300)}…`)} (first 300 of 301 characters; full text: ${ref("2.txt", "text/plain", 903)}`);
      expect(result.text).toContain(`[${id}/3] probe_struct ok -> ${JSON.stringify(JSON.stringify({ data: "x".repeat(10) }))}\n`);
      expect(result.text).toContain(`[${id}/4] probe_struct ok -> ${JSON.stringify(`${JSON.stringify({ data: "x".repeat(2000) }).slice(0, 300)}…`)} (first 300 of 2011 characters; full text: ${ref("4.json", "application/json", 2011)}`);
      expect(result.text).toContain(`[${id}/5] probe_image ok -> "图" ${ref("5-1.png", "image/png", image.length)}`);
      expect(result.text).toContain(`[${id}/6] probe_hang started {}`);
      expect(result.text).not.toContain("unreachable");
      expect(result.details!.calls.slice(0, 5).map((call) => call.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
      expect(["running", "cancelled"]).toContain(result.details!.calls[5]!.status);
      expect(result.details!.complete).toBe(false);

      // The references hold the full values.
      expect(await readFile(join(dir, "2.txt"), "utf8")).toBe("字".repeat(301));
      expect(JSON.parse(await readFile(join(dir, "4.json"), "utf8"))).toEqual({ data: "x".repeat(2000) });
      expect(Buffer.compare(await readFile(join(dir, "5-1.png")), image)).toBe(0);
      // Every reference names the file's size and sha256 prefix.
      const references = [...result.text.matchAll(/\[[a-z]+\/[a-z]+ (\d+) B: (.+?) sha256:([0-9a-f]{16})\]/g)];
      expect(references.map((found) => basename(found[2]!))).toEqual(["2.txt", "4.json", "5-1.png"]);
      for (const [, bytes, path, sha] of references) {
        const data = await readFile(path!);
        expect([data.length, createHash("sha256").update(data).digest("hex").slice(0, 16)]).toEqual([Number(bytes), sha!]);
      }

      // The model read the full text with the member's read; the request carried both results.
      expect(readPath).toBe(join(dir, "2.txt"));
      const follow = await resultOf(recovered.conversation, "follow");
      expect(follow).toMatchObject({ isError: false });
      expect(follow!.text).toContain("字".repeat(301));
      const payload = JSON.stringify(convertMessages({ ...group.faux.getModel(), api: "openai-completions" } as never, { messages: recovered.request } as never, {} as never));
      expect(payload).toContain(`[${id}/2] probe_text ok`);
      expect(payload).toContain("字".repeat(301));

      // Another member's script cannot read them.
      const bob = await member(group, BOB);
      const denied = returned((await script(group, bob, `try { await tools.read({ path: ${JSON.stringify(join(dir, "2.txt"))} }); return "read"; } catch (error) { return error.message; }`)).result);
      expect(denied).not.toBe("read");
    } finally { await group.close(); }
  }, 60_000);

  test("running output over its limit: the recovered result keeps the head and names the index, which has every event", async () => {
    const hangProbe = probe("probe_hang", hang);
    const limits = defineExtension({
      name: "fixture.limits",
      wraps: [{ tool: "codemode", wrap: (tool: ToolRegistration) => ({ ...tool, outputLimits: { maxBytes: 1500, maxLines: 50_000, retain: "head" as const } }) }],
    });
    const group = await openGroup({ tools: fixtures("fixture.module", echo, hangProbe), extensions: [moduleExtension, limits] });
    try {
      const alice = await member(group);
      const root = resultsRoot(places(group).tempDir);
      // The output is cut, so the committed details say when the last start is durable.
      const recovered = await interrupt(group, alice, `
await Promise.all(Array.from({ length: 30 }, (_, i) => tools.probe_echo({ text: "第" + i + "次" })));
await tools.probe_hang({});`, async () => {
        const live = await group.opened.harness.snapshot(LiveDoc, alice.id, context);
        const details = live?.tools?.find((slot) => slot.status === "running")?.details as CodemodeDetails | undefined;
        return details?.calls[30]?.status === "running";
      });
      const { result } = recovered;
      const [dir] = await readdir(root);
      const index = join(root, dir!, "index.txt");
      expect(result.details!.index).toBe(index);
      expect(result.text).toStartWith(`Sub-call index: ${index} (`);
      expect(result.text).toMatch(/\[warn\] Output truncated: \d+ lines, \d+ bytes dropped/);
      expect(result.text).not.toContain("probe_hang started");
      const events = (await lines(index)).slice(1);
      expect(events.filter((line) => / probe_echo ok -> /.test(line))).toHaveLength(30);
      expect(events).toContain(`[${recovered.id}/31] probe_hang started {}`);
      expect(result.details!.calls).toHaveLength(31);
    } finally { await group.close(); }
  }, 60_000);

  test("details record the first 256 sub-calls; every call runs and is in the index", async () => {
    const group = await openGroup({ tools: fixtures("fixture.module", echo), extensions: [moduleExtension] });
    try {
      const before = echoRuns;
      const run = await script(group, await member(group), `
const values = await Promise.all(Array.from({ length: 257 }, (_, i) => tools.probe_echo({ text: String(i) })));
return values.at(-1);`);
      expect(returned(run.result)).toEqual({ echo: "256" });
      expect(echoRuns - before).toBe(257);
      expect(run.result.details!.calls).toHaveLength(256);
      expect(run.result.details!.complete).toBe(false);
      const events = (await lines(run.result.details!.index!)).slice(1);
      expect(events.filter((line) => / probe_echo ok -> /.test(line))).toHaveLength(257);
    } finally { await group.close(); }
  }, 60_000);

  test("usage of sub-calls adds up on the codemode result and in pi.usage", async () => {
    const usage = (n: number): Usage => ({
      input: n, output: 2 * n, cacheRead: 0, cacheWrite: 0, totalTokens: 3 * n, reasoning: n,
      cost: { input: n / 1000, output: n / 500, cacheRead: 0, cacheWrite: 0, total: 3 * n / 1000 },
    });
    const metered = probe("probe_metered", ({ n }) => ({ ...text(String(n)), usage: usage(n) }));
    const group = await openGroup({ tools: fixtures("fixture.module", metered), extensions: [moduleExtension] });
    try {
      const alice = await member(group);
      const run = await script(group, alice, `await Promise.all([tools.probe_metered({ n: 10 }), tools.probe_metered({ n: 32 })]); return 1;`);
      expect(run.result.usage).toEqual(usage(42));
      expect((await group.opened.harness.snapshot(UsageDoc, alice.id, context))?.tools.codemode).toEqual(usage(42));
    } finally { await group.close(); }
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
    const group = await openGroup({ tools: fixtures("fixture.module", tracked("sequential"), tracked("parallel")), extensions: [moduleExtension] });
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
  test("store: a successful script's writes are committed; a failed one, or one aborted before its store commit, writes nothing; values outlive a restart", async () => {
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ tools: fixtures("fixture.module", hangProbe), extensions: [moduleExtension] });
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
        await until(async () => (await slotOutput(group, alice)).includes("probe_hang started"), "hang started");
        await alice.abort(context);
      });
      expect(aborted.outcome).toBe("aborted");
      expect(aborted.result.text).toContain("Tool codemode was aborted");
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
    const group = await openGroup({ tools: fixtures("fixture.module", meet), extensions: [moduleExtension] });
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
        expect(failed.text).toContain("store() writes were not saved: store is full: with the writes of other scripts, stored values would have ");
        return results.indexOf(failed);
      };

      // Each within the limits on its own, together over: the second commit fails whole.
      const over = await fresh();
      const overResults = await both(over, three("a"), three("b"));
      const lost = failedOne(overResults);
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
      expect(tooLong.result.text).toContain(`value has ${MAX_STORE_VALUE_CHARS + 1} characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}`);
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

  test("store commit point: aborted before it, nothing is written; after it, the writes stay although the result is aborted or interrupted", async () => {
    let hold = false;
    let committed = Promise.withResolvers<void>();
    // Lets the real store commit finish, then keeps the call from going on until it is stopped.
    const holding = defineExtension({
      name: "fixture.hold-after-store",
      wraps: [{
        tool: "codemode",
        wrap: (tool: ToolRegistration) => ({
          ...tool,
          execute: (args: unknown, api: ToolExecutionApi, ctx: typeof context) => tool.execute(args as never, new Proxy(api, {
            get(target, property) {
              if (property === "commit") {
                return async (run: never, callContext: typeof context) => {
                  const value = await target.commit(run, callContext);
                  if (hold) {
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
    const group = await openGroup({ tools: fixtures("fixture.module", hangProbe), extensions: [moduleExtension, holding] });
    try {
      const alice = await member(group);
      const values = async () => (await group.opened.harness.snapshot(CodemodeStoreDoc, alice.id, context))?.values;

      // Aborted while the script runs: its writes were never committed.
      const before = await script(group, alice, `store("before", 1); await tools.probe_hang({});`, async () => {
        await until(async () => (await slotOutput(group, alice)).includes("probe_hang started"), "hang started");
        await alice.abort(context);
      });
      expect(before.outcome).toBe("aborted");
      expect(await values()).toBeUndefined();

      // Aborted after the store commit: the result is aborted, the writes stay.
      hold = true;
      const after = await script(group, alice, `store("after", "kept"); return 1;`, async () => {
        await committed.promise;
        await alice.abort(context);
      });
      expect(after.outcome).toBe("aborted");
      expect(after.result.text).toContain("Tool codemode was aborted");
      expect(await values()).toEqual({ after: "kept" });

      // Closed after the store commit: the recovered result is interrupted (not run again), the writes stay.
      committed = Promise.withResolvers<void>();
      const closed = await interrupt(group, alice, `store("closed", "kept"); return 1;`, async () => {
        await committed.promise;
        return true;
      });
      hold = false;
      expect(closed.result.text).toContain("Tool codemode was interrupted and may have partially run");
      expect(await values()).toEqual({ after: "kept", closed: "kept" });
    } finally { await group.close(); }
  }, 60_000);

  test("faults: a start or a result that cannot be committed fails the sub-call; a store commit failure fails the script; a close before the result commit loses only that result", async () => {
    type Faults = { details?: (n: number, signal: AbortSignal | undefined) => Promise<void>; commit?: boolean };
    let faults: Faults = {};
    const injected = defineExtension({
      name: "fixture.faults",
      wraps: [{
        tool: "codemode",
        wrap: (tool: ToolRegistration) => ({
          ...tool,
          execute: (args: unknown, api: ToolExecutionApi, ctx: typeof context) => {
            let n = 0;
            const wrapped = new Proxy(api, {
              get(target, property) {
                if (property === "details") {
                  return async (details: never, callContext: typeof context) => {
                    await faults.details?.(++n, ctx.abortSignal);
                    return target.details(details, callContext);
                  };
                }
                if (property === "commit" && faults.commit) return async () => { throw new Error("injected commit failure"); };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            return tool.execute(args as never, wrapped, ctx);
          },
        }),
      }],
    });
    let counted = 0;
    let marked = 0;
    const count = probe("probe_count", () => { counted++; return text("counted"); });
    const mark = probe("probe_mark", () => { marked++; return text("marked"); });
    // Puts a non-empty directory where its full text would be renamed to, so saving the result fails.
    const blocked = probe("probe_blocked", async (_args, call) => {
      const { places: own } = await resolveMember(group.base, call);
      // The codemode call's api (a sub-call runs with it).
      const api = call.api as ToolExecutionApi;
      await mkdir(join(resultsRoot(own.tempDir), resultsDirName(api.taskId as number, api.callId), "1.txt", "in-the-way"), { recursive: true });
      return text("x".repeat(PREVIEW_LIMIT + 1));
    });
    const group = await openGroup({ tools: fixtures("fixture.module", count, mark, blocked), extensions: [moduleExtension, injected] });
    try {
      const alice = await member(group);
      const attempt = `try { await tools.probe_count({}); return "resolved"; } catch (error) { return error.message; }`;
      const fail = (at: number) => async (n: number) => { if (n === at) throw new Error("injected details failure"); };

      faults = { details: fail(1) };
      const start = await script(group, alice, attempt);
      expect(returned(start.result)).toBe("Tool probe_count was not started: the call could not be recorded (injected details failure)");
      expect(counted).toBe(0);
      expect(start.result.details!.calls).toMatchObject([{ name: "probe_count", status: "error" }]);

      faults = { details: fail(2) };
      const finish = await script(group, alice, attempt);
      expect(returned(finish.result)).toBe("The result of probe_count could not be recorded: injected details failure");
      expect(counted).toBe(1);
      expect(finish.result.details!.calls).toMatchObject([{ name: "probe_count", status: "error" }]);

      faults = { commit: true };
      const store = await script(group, alice, `store("k", 1); return 1;`);
      expect(store.result.isError).toBe(true);
      expect(store.result.text).toContain("store() writes were not saved: injected commit failure");
      // Never written.
      expect(await group.opened.harness.snapshot(CodemodeStoreDoc, alice.id, context)).toBeUndefined();

      // The full text cannot be saved: the script gets an error instead of the value, and no partial file is left.
      faults = {};
      const unsaved = await script(group, alice, `try { await tools.probe_blocked({}); return "resolved"; } catch (error) { return error.message; }`);
      expect(returned(unsaved.result)).toStartWith("The result of probe_blocked could not be saved: ");
      expect(unsaved.result.details!.calls).toMatchObject([{ name: "probe_blocked", status: "error" }]);
      const index = unsaved.result.details!.index!;
      expect((await readdir(dirname(index))).sort()).toEqual(["1.txt", "index.txt"]);
      expect(await readdir(join(dirname(index), "1.txt"))).toEqual(["in-the-way"]);
      expect((await lines(index)).at(-1)).toStartWith(`[${unsaved.id}/1] probe_blocked error: "The result of probe_blocked could not be saved: `);

      // The result's commit never completes: the script never sees the value, and recovery reports the call interrupted.
      // (Its line may still have been committed with the output: it says how the sub-call ended, not what the script got.)
      const { promise: held, resolve: holding } = Promise.withResolvers<void>();
      faults = {
        details: async (n, signal) => {
          if (n !== 2) return;
          holding();
          await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("closed")), { once: true }));
        },
      };
      const recovered = await interrupt(group, alice, `await tools.probe_count({}); await tools.probe_mark({}); return 1;`, async () => {
        await held;
        return true;
      });
      expect(counted).toBe(2);
      expect(marked).toBe(0);
      expect(recovered.result.text).toContain(`[${recovered.id}/1] probe_count started {}`);
      expect(recovered.result.text).not.toContain("probe_mark");
      expect(recovered.result.text).toContain("Tool codemode was interrupted and may have partially run");
    } finally { await group.close(); }
  }, 60_000);

  test("interrupted bash in a script stops with the Harness and is not run again", async () => {
    const group = await openGroup();
    try {
      const alice = await member(group);
      const tmp = places(group).tempDir;
      const recovered = await interrupt(group, alice, `await tools.bash({ command: ${JSON.stringify(waitingCommand("recover"))} });`,
        async () => existsSync(join(tmp, "recover-sleep.pid")), { afterClose: () => expectStopped(tmp, "recover") });
      expect(recovered.result.text).toContain(`[${recovered.id}/1] bash started {"command":`);
      expect(recovered.result.text).toContain("Tool codemode was interrupted and may have partially run");
      expect(await readFile(join(tmp, "recover-runs.txt"), "utf8")).toBe("run\n");
    } finally { await group.close(); }
  }, 90_000);

  test("cancel: aborting the conversation stops a script's bash; a call the script leaves running is cancelled when it ends", async () => {
    const until_ = probe("probe_until", async ({ path }) => { await until(() => existsSync(path), path, 30_000); return text("there"); });
    const group = await openGroup({ tools: fixtures("fixture.module", until_), extensions: [moduleExtension] });
    try {
      const alice = await member(group);
      const tmp = places(group).tempDir;
      const aborted = await script(group, alice, `await tools.bash({ command: ${JSON.stringify(waitingCommand("abort"))} }); return 1;`, async () => {
        await until(() => existsSync(join(tmp, "abort-sleep.pid")), "abort pids", 30_000);
        await alice.abort(context);
      });
      expect(aborted.settled).toMatchObject({ reason: "aborted" });
      expect(aborted.outcome).toBe("aborted");
      expect(aborted.result.text).toContain(`[${aborted.id}/1] bash started`);
      expect(aborted.result.text).toContain("Tool codemode was aborted");
      await expectStopped(tmp, "abort");

      const left = await script(group, alice, `
tools.bash({ command: ${JSON.stringify(waitingCommand("left", ['echo late > "$PI_USER_TMP/late.txt"']))} });
await tools.probe_until({ path: ${JSON.stringify(join(tmp, "left-sleep.pid"))} });
return "done";`);
      expect(returned(left.result)).toBe("done");
      expect(left.result.details!.calls.map((call) => [call.name, call.status])).toEqual([["bash", "cancelled"], ["probe_until", "ok"]]);
      expect(left.result.details!.complete).toBe(true);
      await expectStopped(tmp, "left");
      expect(existsSync(join(tmp, "late.txt"))).toBe(false);
    } finally { await group.close(); }
  }, 90_000);

  test("a sub-call the script stops waiting for before its start is committed never runs", async () => {
    let counted = 0;
    const count = probe("probe_count", () => { counted++; return text("counted"); });
    const group = await openGroup({ tools: fixtures("fixture.module", count), extensions: [moduleExtension] });
    try {
      const run = await script(group, await member(group), `tools.probe_count({}); return "left";`);
      expect(returned(run.result)).toBe("left");
      expect(run.result.details!.calls).toMatchObject([{ name: "probe_count", status: "cancelled", error: "Tool probe_count was cancelled before it ran" }]);
      await Bun.sleep(300);
      expect(counted).toBe(0);
    } finally { await group.close(); }
  });

  test("timeout: the script fails, its pending sub-call is cancelled", async () => {
    const hangProbe = probe("probe_hang", hang);
    const group = await openGroup({ tools: fixtures("fixture.module", hangProbe), extensions: [moduleExtension] });
    try {
      const run = await script(group, await member(group), `// @options: {"timeout_ms": 300}\nawait tools.probe_hang({});\nreturn 1;`);
      expect(run.result.isError).toBe(true);
      expect(run.result.text).toContain("Script failed");
      expect(run.result.text).toContain("Script timed out");
      expect(run.result.details!.calls).toMatchObject([{ name: "probe_hang", status: "cancelled" }]);
    } finally { await group.close(); }
  });

  test("output limits: 100000 items and 16Mi characters pass and spill; one more fails without store writes and lists the calls made", async () => {
    const group = await openGroup({ tools: fixtures("fixture.module", echo), extensions: [moduleExtension] });
    try {
      const alice = await member(group);
      const tmp = await realpath(places(group).tempDir).catch(() => places(group).tempDir);
      const items = await script(group, alice, `for (let i = 0; i < 100000; i++) text("x");`);
      expect(items.result.isError).toBe(false);
      expect(items.result.text.includes("Warning: truncated output (original token count:")).toBe(true);
      const spilled = items.result.details!.fullOutputPath!;
      expect(items.result.details!.index).toBeUndefined();
      expect(isPathInside(spilled, tmp) || isPathInside(spilled, places(group).tempDir)).toBe(true);
      expect(items.result.text).toContain(`[Full output: ${spilled} (read with offset/limit)]`);
      const full = await readFile(spilled, "utf8");
      expect(full.startsWith("==> text 1/100000 <==\nx\n")).toBe(true);
      expect(full.endsWith("==> text 100000/100000 <==\nx")).toBe(true);
      expect(full.match(/^x$/gm)).toHaveLength(100000);

      const tooMany = await script(group, alice, `for (let i = 0; i < 100001; i++) text("x");`);
      expect(tooMany.result.isError).toBe(true);
      expect(tooMany.result.text).toContain("RangeError: script output exceeded the limit of 16777216 characters or 100000");

      const chars = await script(group, alice, `text("x".repeat(16 * 1024 * 1024));`);
      expect(chars.result.isError).toBe(false);
      expect((await readFile(chars.result.details!.fullOutputPath!, "utf8")).length).toBe(16 * 1024 * 1024);

      const over = await script(group, alice, `store("k", 1); await tools.probe_echo({ text: "a" }); text("x".repeat(16 * 1024 * 1024 + 1));`);
      expect(over.result.isError).toBe(true);
      expect(over.result.text).toContain("RangeError: script output exceeded the limit");
      expect(over.result.text).toContain("Tool calls made before the failure (they are not undone): probe_echo (");
      // Never written.
      expect(await group.opened.harness.snapshot(CodemodeStoreDoc, alice.id, context)).toBeUndefined();
    } finally { await group.close(); }
  }, 120_000);
});

describe("Durable codemode: results directory", () => {
  test("removeCodemodeResults: only call directories older than the cutoff; links and other names are left alone", async () => {
    const temp = join(fixture.root, "清理", "tmp");
    const root = resultsRoot(temp);
    expect(await removeCodemodeResults(temp, Number.POSITIVE_INFINITY)).toEqual([]);
    const old = new Date(Date.now() - 2 * 86_400_000);
    const make = async (name: string, aged: boolean, indexAged = aged) => {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "index.txt"), "header\n");
      if (indexAged) await utimes(join(root, name, "index.txt"), old, old);
      if (aged) await utimes(join(root, name), old, old);
    };
    await make("1-old", true);
    await make("2-new", false);
    await make("3-old-dir-new-index", true, false);
    await make("notes", true);
    await writeFile(join(root, "4-file"), "x");
    await utimes(join(root, "4-file"), old, old);
    const outside = join(fixture.root, "清理", "外部");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(root, "5-link"), "junction");
    expect(await removeCodemodeResults(temp, Date.now() - 86_400_000)).toEqual(process.platform === "linux" ? [] : ["1-old"]);
    expect(await removeCodemodeResults(temp, Number.POSITIVE_INFINITY)).toEqual(process.platform === "linux" ? [] : ["2-new", "3-old-dir-new-index"]);
    expect((await readdir(root)).sort()).toEqual(process.platform === "linux" ? ["1-old", "2-new", "3-old-dir-new-index", "4-file", "5-link", "notes"] : ["4-file", "5-link", "notes"]);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

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
    let runs = 0;
    const long = probe("probe_long", () => { runs++; return text("长".repeat(400)); });
    // Puts a junction to Bob's tmp in place of its own call directory while it runs (where the system allows it).
    let swapped: string | undefined;
    let swappedDir = "";
    const swap = probe("probe_swap", async (_args, call) => {
      runs++;
      const api = call.api as ToolExecutionApi;
      const dir = join(resultsRoot(aliceTmp), resultsDirName(api.taskId as number, api.callId));
      swappedDir = dir;
      try {
        await rename(dir, `${dir}.moved`);
        await symlink(bobTmp, dir, "junction");
        swapped = "swapped";
      } catch (error) {
        // Windows refuses to rename the held call directory (src/durable/codemode/directory.ts).
        swapped = (error as NodeJS.ErrnoException).code;
      }
      return text("长".repeat(400));
    });
    const group = await openGroup({ tools: fixtures("fixture.module", long, swap), extensions: [moduleExtension, prepared] });
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
      const attempt = `try { return (await tools.probe_long({})).length; } catch (error) { return error.message; }`;
      const refused = async (pattern: string) => {
        const run = await script(group, alice, attempt);
        expect(String(returned(run.result))).toStartWith("Tool probe_long was not started: the call could not be recorded (");
        expect(String(returned(run.result))).toContain(pattern);
        expect(run.result.details!.calls).toMatchObject([{ name: "probe_long", status: "error" }]);
        // No index was created, so none is named.
        expect(run.result.details!.index).toBeUndefined();
        return run;
      };

      // The results root is a junction (a symlink on Linux) to Bob's tmp.
      prepare = async () => symlink(bobTmp, resultsRoot(aliceTmp), "junction");
      await refused("results are only written inside the caller's tmp");
      expect(runs).toBe(0);
      expect(await realpath(resultsRoot(aliceTmp))).toBe(await realpath(bobTmp));
      await bobUnchanged();
      await removeLink(resultsRoot(aliceTmp));

      // The call directory is one.
      prepare = async (dir) => {
        await mkdir(resultsRoot(aliceTmp), { recursive: true });
        await symlink(bobTmp, dir, "junction");
      };
      await refused("results are only written inside the caller's tmp");
      expect(runs).toBe(0);
      await bobUnchanged();

      // An entry is already where the index goes: a hard link to Bob's file, and a file symlink where this user may
      // make one (not in an ordinary Windows terminal).
      const trial = join(aliceTmp, "symlink-trial");
      const fileSymlinks = await symlink(bobFile, trial, "file").then(async () => { await unlink(trial); return true; }, (error: NodeJS.ErrnoException) => {
        if (process.platform === "win32" && error.code === "EPERM") return false;
        throw error;
      });
      for (const kind of fileSymlinks ? ["hard", "symbolic"] : ["hard"]) {
        prepare = async (dir) => {
          await mkdir(dir, { recursive: true });
          await (kind === "hard" ? link(bobFile, join(dir, "index.txt")) : symlink(bobFile, join(dir, "index.txt"), "file"));
        };
        await refused("EEXIST");
        expect(runs).toBe(0);
        await bobUnchanged();
      }

      // A link where a result file goes is replaced by the file, not written through.
      prepare = async (dir) => {
        await mkdir(dir, { recursive: true });
        await link(bobFile, join(dir, "1.txt"));
      };
      const replaced = await script(group, alice, attempt);
      expect(returned(replaced.result)).toBe(400);
      expect(await readFile(join(dirname(replaced.result.details!.index!), "1.txt"), "utf8")).toBe("长".repeat(400));
      await bobUnchanged();

      // Normal: the files are private (where modes apply) and the member's read opens the reference.
      prepare = undefined;
      const normal = await script(group, alice, attempt);
      expect(returned(normal.result)).toBe(400);
      const dir = dirname(normal.result.details!.index!);
      // The index is closed and the directory released when the call ends: Windows refuses to rename a held directory or
      // one with an open file in it, Linux lists open files and directories in /proc.
      await rename(dir, `${dir}.closed`);
      await rename(`${dir}.closed`, dir);
      if (process.platform === "linux") {
        const targets = await Promise.all((await readdir("/proc/self/fd")).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
        expect(targets.filter((target) => target.includes(basename(dir)))).toEqual([]);
      }
      if (process.platform !== "win32") {
        // (The test made the results root here; the parallel test checks one the code made.)
        for (const [path, mode] of [[dir, 0o700], [join(dir, "index.txt"), 0o600], [join(dir, "1.txt"), 0o600]] as const) {
          expect([path, (await stat(path)).mode & 0o777]).toEqual([path, mode]);
        }
      }
      const read = await script(group, alice, `return await tools.read({ path: ${JSON.stringify(join(dir, "1.txt"))} });`);
      expect(returned(read.result)).toContain("长".repeat(400));

      // The call directory changes while a sub-call runs: the result is not saved through it.
      prepare = undefined;
      const raced = await script(group, alice, `try { return (await tools.probe_swap({})).length; } catch (error) { return error.message; }`);
      const value = String(returned(raced.result));
      console.log(`codemode results directory swapped during a sub-call: ${swapped}`);
      if (swapped === "swapped") {
        expect(value).toStartWith("The result of probe_swap could not be saved: ");
        expect(value).toContain("results are only written inside the caller's tmp");
        // The index lines went on into the file that was created, now under the moved directory; the result no longer
        // names the index, whose path leads to Bob's tmp.
        const moved = await lines(join(`${swappedDir}.moved`, "index.txt"));
        expect(moved.at(-1)).toStartWith(`[${raced.id}/1] probe_swap error: "The result of probe_swap could not be saved: `);
        expect(raced.result.details!.index).toBeUndefined();
        await removeLink(swappedDir);
      } else {
        expect(["EPERM", "EACCES", "EBUSY"]).toContain(swapped!);
        expect(value).toBe("400");
      }
      await bobUnchanged();
    } finally { await group.close(); }
  }, 120_000);

  test("images a script shows (coding-agent 1.0.3): each distinct one saved once in the call's directory and named just before it, also after the text budget; a failed save is reported and the result stands", async () => {
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
    const group = await openGroup({ tools: fixtures("fixture.module", block), extensions: [moduleExtension, prepared] });
    aliceTmp = places(group).tempDir;
    const labelled = (content: Content[]) => content.flatMap((item, index) => {
      const match = /\[Image saved to ([^\n]+) \((image\/[a-z]+), (\d+B)\)\]$/.exec(item.text ?? "");
      return match === null ? [] : [{ path: match[1]!, mimeType: match[2]!, size: match[3]!, next: content[index + 1]! }];
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
        ["output-1.png", "image/png", `${pngBytes.length}B`], ["output-1.png", "image/png", `${pngBytes.length}B`],
        ["output-1.png", "image/png", `${pngBytes.length}B`], ["output-2.gif", "image/gif", `${Buffer.from(GIF, "base64").length}B`],
      ]);
      // Each label is directly followed by its image, which stays in the result.
      expect(labels.map((label) => [label.next.type, label.next.mimeType, label.next.data])).toEqual([
        ["image", "image/png", PNG], ["image", "image/png", PNG], ["image", "image/png", PNG], ["image", "image/gif", GIF],
      ]);
      expect(shown.result.content.map(item => item.type).slice(1)).toEqual(["text", "image", "text", "image", "text", "image", "text", "image", "text"]);
      expect(shown.result.text).toContain("==> text 1/2 <==\n中间");
      expect(shown.result.text).toContain("==> text 2/2 <==\n完成");
      const dir = dirname(labels[0]!.path);
      expect(basename(dir)).toBe(basename(dirname(shown.result.details!.index!)));
      expect(isPathInside(dir, await realpath(aliceTmp))).toBe(true);
      expect(await readFile(labels[0]!.path)).toEqual(pngBytes);
      expect((await readFile(labels[3]!.path)).toString("base64")).toBe(GIF);
      if (process.platform !== "win32") {
        for (const label of labels) expect([label.path, (await stat(label.path)).mode & 0o777]).toEqual([label.path, 0o600]);
      }

      // Over the text budget: the text is cut and saved, the image's label comes after the cut and is whole.
      const cut = await script(group, alice, `// @options: {"max_output_tokens": 10}
text("x".repeat(100)); image("data:image/png;base64,${PNG}"); text("y".repeat(100));`);
      expect(cut.result.content.map((item) => item.type)).toEqual(["text", "text", "image"]);
      expect(cut.result.content[1]!.text).toStartWith("Warning: truncated output");
      expect(cut.result.content[1]!.text).toContain(`[Full output: ${cut.result.details!.fullOutputPath}`);
      const [after] = labelled(cut.result.content);
      expect(basename(after!.path)).toBe("output-1.png");
      expect(dirname(after!.path)).toBe(dirname(cut.result.details!.fullOutputPath!));
      expect(await readFile(after!.path)).toEqual(pngBytes);

      // A save that fails (a directory has the file's name) is reported where the path would be; the script completed.
      prepare = async (callDir) => { await mkdir(join(callDir, "output-1.png"), { recursive: true }); };
      const failed = await script(group, alice, `image("data:image/png;base64,${PNG}"); return "仍完成";`);
      prepare = undefined;
      expect(failed.result.isError).toBe(false);
      expect(returned(failed.result)).toBe("仍完成");
      expect(failed.result.content[1]!.text).toStartWith(`[Image (image/png, ${pngBytes.length}B) could not be saved: `);
      expect(failed.result.content[2]).toMatchObject({ type: "image", data: PNG });
      expect(labelled(failed.result.content)).toEqual([]);

      // /clear removes the saved images with their call directories.
      const removed = await removeCodemodeResults(aliceTmp, Number.POSITIVE_INFINITY);
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
  test("sub-call overhead: two progress commits per sequential sub-call, paced by outputIntervalMs (the project's 20 ms, Durable's 100 ms as control); parallel calls share commits", async () => {
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
        tools: fixtures("fixture.module", echo), extensions: [moduleExtension], storage: counting,
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
      // A sequential sub-call waits for its start and its result commit, at most one per interval.
      expect(measured.sequential.ms).toBeGreaterThanOrEqual(10 * policy.outputIntervalMs);
      expect(measured.sequential.commits - measured.none).toBeGreaterThanOrEqual(2 * 10);
      // Parallel calls share commits.
      expect(measured.parallel.commits).toBeLessThan(measured.sequential.commits);
      expect(measured.parallel.ms).toBeLessThan(measured.sequential.ms);
    }
    expect(project.sequential.ms).toBeLessThan(control.sequential.ms);
  }, 60_000);
});
