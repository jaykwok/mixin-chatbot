// The group registry (D2-4, src/durable/registry.ts): the system prompt against the AgentSession engine's, the tool
// catalogue, what scripts may call, module selection, and the send and document tools run for the calling member.
// Faux models and a recording outbound; no network, no Python.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, InMemoryCredentialStore, InMemoryModelsStore,
  type Message,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Conversation, Extension } from "@earendil-works/pi-durable";
import { buildLocalTools } from "../helpers/native-tools.ts";
import { type AgentModuleDefinition, loadModuleDefinitions } from "../../src/agent/modules.ts";
import { buildChatContext } from "../../src/agent/prompt.ts";
import { recordingOutbound } from "../helpers/recording-outbound.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { recordsOf } from "../../src/durable/records.ts";
import { spaceExtensions } from "../../src/durable/registry.ts";
import { memberPlaces } from "../../src/durable/tools.ts";
import type { RelayConfig } from "../../src/integrations/relay.ts";
import { type GroupHarness, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";

const fixture = await tempFixture("durable-registry-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const ALICE = "+8613800000001";
const BOB = "+8613800000002";
const RELAY: RelayConfig = {
  provider: "s3", endpoint: "https://s3.example.test", region: "test-region", bucket: "test-bucket",
  accessKeyId: "bot", secretAccessKey: "secret", prefix: "relay/", forcePathStyle: false,
  maxBytes: 2 * 1024 ** 3, expireHours: 2, cleanupGraceMinutes: 30,
};

const [documentWork] = await loadModuleDefinitions({ documentWorkEnabled: true }) as [AgentModuleDefinition];
let counter = 0;

type Group = {
  opened: GroupHarness;
  faux: ReturnType<typeof fauxProvider>;
  model: { provider: string; modelId: string };
  root: string;
  extensions: Extension[];
  out: ReturnType<typeof recordingOutbound>;
};

async function openGroup(options: { modules?: readonly AgentModuleDefinition[]; relay?: RelayConfig | null } = {}): Promise<Group> {
  const n = ++counter;
  const faux = fauxProvider({ tokenSize: { min: 50, max: 50 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const root = join(fixture.root, `群数据-${n}`);
  const out = recordingOutbound();
  const extensions = spaceExtensions({
    layout: appLayout(root), scope: groupScope(GROUP), modules: options.modules ?? [documentWork], relay: options.relay ?? null, outbound: out.outbound,
  });
  const opened = await openGroupHarness(join(fixture.root, `db-${n}.sqlite`), models, {
    group: GROUP, extensions, settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } },
  });
  return { opened, faux, model: { provider: model.provider, modelId: model.id }, root, extensions, out };
}

async function member(group: Group, phone = ALICE): Promise<Conversation> {
  return (await memberConversation(group.opened.harness, scopeOf(GROUP), phone, { model: group.model }, context)).conversation;
}

/** Put a started request with its run record at the head of the member's inbox, as the service's worker would. */
async function activate(group: Group, conversation: Conversation, phone: string): Promise<string> {
  const { reply } = group.out.message(GROUP, phone, "发文件");
  const requestId = `msg:${crypto.randomUUID()}`, now = Date.now();
  await group.opened.harness.commit(async tx => {
    (await tx.doc(InboxDoc, conversation.id)).items = [{ requestId, content: "发文件", receivedAt: now, startedAt: now }];
    (await recordsOf(tx, phone)).requests[requestId] = { requestId, reply, createdAt: now, notes: [], deliverables: [], files: [], events: {} };
  }, context);
  return reply.msgUid;
}

/** `prompt` without the official codemode section (pi-durable/codemode), which `section` holds. */
type Seen = { prompt: string; section: string; tools: string[]; descriptions: Record<string, string> };
const seen = (messages: readonly Message[]): Seen => {
  const tools = getCurrentTools(messages as Message[]);
  const full = getCurrentSystemPrompt(messages as Message[]) ?? "", at = full.indexOf("\n\n<codemode>\n");
  return {
    prompt: at < 0 ? full : full.slice(0, at), section: at < 0 ? "" : full.slice(at + 2),
    tools: tools.map((tool) => tool.name),
    descriptions: Object.fromEntries(tools.map((tool) => [tool.name, tool.description])),
  };
};

/** One answered turn; what the model saw. */
async function turn(group: Group, conversation: Conversation, content = "你好"): Promise<Seen> {
  let request: Seen | undefined;
  group.faux.setResponses([(transcript) => { request = seen(transcript.messages); return fauxAssistantMessage("好的"); }]);
  await (await conversation.submit({ type: "input", content }, context)).wait(context);
  if (request === undefined) throw new Error("no request");
  return request;
}

type ToolTurn = { text: string; isError: boolean; structured?: unknown };
/** The model calls `name` once, then answers; the call's result. */
async function call(group: Group, conversation: Conversation, name: string, args: Record<string, unknown>): Promise<ToolTurn> {
  const id = `call-${++counter}`;
  let result: ToolTurn | undefined;
  group.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" }),
    (transcript) => {
      const message = transcript.messages.findLast((each) => each.role === "toolResult" && each.toolCallId === id);
      if (message?.role === "toolResult") {
        result = { text: message.content.map((item) => item.type === "text" ? item.text : "").join(""), isError: message.isError };
      }
      return fauxAssistantMessage("好的");
    },
  ]);
  await (await conversation.submit({ type: "input", content: `调用 ${name}` }, context)).wait(context);
  if (result === undefined) throw new Error(`no result for ${name}`);
  return result;
}

/** The AgentSession engine's prompt for the same group and member (src/agent/session-factory.ts wiring). */
async function agentSessionPrompt(root: string, modules: readonly AgentModuleDefinition[], relayEnabled: boolean): Promise<Seen> {
  const places = memberPlaces({ layout: appLayout(root) }, groupScope(GROUP), ALICE);
  for (const dir of [places.workspaceDir, places.tempDir]) await mkdir(dir, { recursive: true });
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond: 0 });
  runtime.registerNativeProvider(faux.provider);
  const agentDir = join(root, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const [module] = modules;
  const resourceLoader = new DefaultResourceLoader({
    cwd: places.workspaceDir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    skillsOverride: () => module?.skills ?? { skills: [], diagnostics: [] },
    systemPromptOverride: () => buildChatContext({ relayEnabled, ...(module ? { modulePrompt: module.prompt } : {}) }),
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  const customTools = await buildLocalTools({ workspaceDir: places.workspaceDir, tempDir: places.tempDir, phone: ALICE, scope: groupScope(GROUP),
    venvDir: places.venvDir, materialsIndexPath: places.indexPath, resourceReadDirs: module?.readOnlyDirs ?? [] });
  const { session } = await createAgentSession({
    cwd: places.workspaceDir, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
    noTools: "builtin", customTools, settingsManager, resourceLoader,
    sessionManager: SessionManager.open(join(root, "session.jsonl"), undefined, places.workspaceDir),
  });
  let request: Seen | undefined;
  try {
    faux.setResponses([(transcript) => { request = seen(transcript.messages); return fauxAssistantMessage("好的"); }]);
    await session.prompt("你好");
  } finally { session.dispose(); }
  if (request === undefined) throw new Error("no AgentSession request");
  return request;
}

describe("Durable group registry", () => {
  for (const [label, modules, relay] of [
    ["document module on, no relay", [documentWork], null],
    ["document module off, relay configured", [], RELAY],
  ] as const) {
    test(`the system prompt equals the AgentSession engine's (${label})`, async () => {
      const group = await openGroup({ modules, relay });
      try {
        const durable = await turn(group, await member(group));
        const session = await agentSessionPrompt(group.root, modules, relay !== null);
        expect(durable.prompt).toBe(session.prompt);
        // The pieces, so a difference is readable: the project prompt, the skill list, the group workspace.
        expect(durable.prompt.startsWith(buildChatContext({ relayEnabled: relay !== null, ...(modules.length ? { modulePrompt: documentWork.prompt } : {}) }))).toBe(true);
        expect(durable.prompt.includes("<skills>")).toBe(modules.length > 0);
        expect(durable.prompt.endsWith(`<cwd>\n${resolve(appLayout(group.root).workspace).replace(/\\/g, "/")}\n</cwd>`)).toBe(true);
        expect(durable.prompt).not.toContain("Guidelines:");
        expect(durable.prompt).not.toContain("expert coding assistant");
        // The Durable engine appends the official codemode section: the tools scripts can call, never the send tools.
        expect(durable.section.startsWith("<codemode>\n")).toBe(true); expect(durable.section.endsWith("</codemode>")).toBe(true);
        expect(durable.section).toContain("### `read`"); expect(durable.section).not.toContain("send_file");
        expect(durable.section.includes("### `document_inspect`")).toBe(modules.length > 0);
      } finally { await group.opened.close(); }
    });
  }

  test("declares the tools in registry order; the codemode section lists the module's tools; send tools are model-only", async () => {
    const group = await openGroup();
    try {
      const seenBy = await turn(group, await member(group));
      expect(seenBy.tools).toEqual(["read", "bash", "edit", "write", "document_environment", "document_extract", "materials_find", "materials_grep", "send_image", "send_file", "codemode"]);
      // CODEMODE_INLINE_BUDGET keeps every declaration of the registry's own tools in the section.
      for (const name of ["read", "bash", "edit", "write", "document_environment", "document_extract",
        "document_inspect", "document_patch", "document_compose", "document_build", "document_render", "document_images"]) {
        expect(seenBy.section).toContain(`### \`${name}\``);
      }
      expect(seenBy.section).not.toContain("not listed");
      expect(seenBy.section).not.toContain("send_image"); expect(seenBy.section).not.toContain("send_file");
      expect(seenBy.descriptions.codemode).not.toContain("send_file");
    } finally { await group.opened.close(); }
  });

  test("scripts reach document_extract and the selected module's tools, never the send tools; deselecting the module removes it", async () => {
    const group = await openGroup();
    try {
      const alice = await member(group);
      const code = "return { names: ALL_TOOLS.map((tool) => tool.name), send: 'send_file' in tools };";
      const before = await call(group, alice, "codemode", { code });
      expect(before.isError, before.text).toBe(false);
      expect(JSON.parse(before.text.slice(before.text.indexOf("{")))).toEqual({ send: false, names: ["read", "bash", "edit", "write",
        "document_environment", "document_extract", "materials_find", "materials_grep", "document_inspect", "document_patch", "document_compose", "document_build", "document_render",
        "document_images"] });
      const moduleExtension = group.extensions.find((extension) => extension.name === "mixin.document-work")!;
      await alice.configure({ extensions: { remove: [moduleExtension] } }, context);
      const after = await call(group, alice, "codemode", { code });
      expect(after.isError, after.text).toBe(false);
      expect(JSON.parse(after.text.slice(after.text.indexOf("{")))).toEqual({ send: false, names: ["read", "bash", "edit", "write",
        "document_environment", "document_extract", "materials_find", "materials_grep"] });
      const prompt = await turn(group, alice);
      expect(prompt.prompt).not.toContain(documentWork.prompt);
      expect(prompt.prompt).not.toContain("<skills>");
      // The official section is built from the conversation's callable tools each turn (the old description came from
      // the registry and still listed a deselected module's tools).
      expect(prompt.section).toContain("### `document_extract`"); expect(prompt.section).not.toContain("document_inspect");
    } finally { await group.opened.close(); }
  });

  test("send_file sends from the caller's tmp to the caller's own request and refuses another member's tmp", async () => {
    const group = await openGroup();
    try {
      const [alice, bob] = [await member(group, ALICE), await member(group, BOB)];
      const own = memberPlaces({ layout: appLayout(group.root) }, groupScope(GROUP), ALICE), other = memberPlaces({ layout: appLayout(group.root) }, groupScope(GROUP), BOB);
      await mkdir(other.tempDir, { recursive: true });
      await writeFile(join(other.tempDir, "bob.txt"), "Bob 的草稿");
      // Alice's tmp exists once her first call resolved her places.
      await call(group, alice, "read", { path: join(own.workspaceDir, "absent.txt") });
      await writeFile(join(own.tempDir, "报告.txt"), "Alice 的报告");
      const aliceMessage = await activate(group, alice, ALICE);
      const sent = await call(group, alice, "send_file", { source: join(own.tempDir, "报告.txt") });
      expect(sent).toMatchObject({ isError: false, text: "已发送文件: 报告.txt" });
      expect(group.out.sent.map(({ kind, text, phone, space, msgUid }) => ({ kind, text, phone, space, msgUid })))
        .toEqual([{ kind: "file", text: "报告.txt", phone: ALICE, space: GROUP, msgUid: aliceMessage }]);
      group.out.sent.length = 0;
      const refused = await call(group, alice, "send_file", { source: join(other.tempDir, "bob.txt") });
      expect(refused).toMatchObject({ isError: true, text: "只能发送共享资料 workspace 或当前调用用户 tmp 目录内的文件" });
      expect(group.out.sent).toEqual([]);
      // Bob's file goes to Bob's own request.
      const bobMessage = await activate(group, bob, BOB);
      const bobs = await call(group, bob, "send_file", { source: join(other.tempDir, "bob.txt") });
      expect(bobs.isError).toBe(false);
      expect(group.out.sent.map(item => [item.phone, item.msgUid])).toEqual([[BOB, bobMessage]]);
    } finally {
      await group.opened.close();
    }
  });

  test("document_extract and document_environment run for the calling member", async () => {
    const group = await openGroup();
    try {
      const alice = await member(group, ALICE);
      const other = memberPlaces({ layout: appLayout(group.root) }, groupScope(GROUP), BOB);
      await mkdir(other.tempDir, { recursive: true });
      await writeFile(join(other.tempDir, "bob.docx"), "not a real document");
      const refused = await call(group, alice, "document_extract", { source: join(other.tempDir, "bob.docx") });
      expect(refused).toMatchObject({ isError: true, text: "只能解析共享资料 workspace 或当前用户 tmp 中的文档" });
      const own = memberPlaces({ layout: appLayout(group.root) }, groupScope(GROUP), ALICE);
      await writeFile(join(own.tempDir, "notes.txt"), "plain");
      const unsupported = await call(group, alice, "document_extract", { source: join(own.tempDir, "notes.txt") });
      expect(unsupported).toMatchObject({ isError: true, text: "仅支持 PDF、DOCX、PPTX、XLSX；扫描件需要 OCR" });
    } finally { await group.opened.close(); }
  });
});
