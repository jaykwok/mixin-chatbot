// The codemode logic ported from coding-agent (src/durable/codemode/upstream.ts) against the installed coding-agent
// modules it was ported from: the mode-on descriptions (prepareLoadout), search and usage functions directly, and the
// same scripts run by upstream's executeCodemode (a stub session) and by the Durable codemode tool (a faux model through
// a group Harness). A difference after an upgrade fails here; port it or record it in upstream.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, Type, type Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { type CallableTool, type CodemodeDetails, codemodeExtension } from "../../src/durable/codemode/index.ts";
import {
  Bm25Ranker, CODEMODE_TOOL_NAME, codemodeToolSystemPromptContribution, combineUsage, createToolSearchDocument,
  DEFAULT_CODEMODE_INLINE_BUDGET, DEFAULT_TOOL_SEARCH_LIMIT, formatSize, toCodemodeDeclaration, tokenize,
} from "../../src/durable/codemode/upstream.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { baseMemberTools, type BaseToolsOptions, memberRegistration, type MemberTool } from "../../src/durable/tools.ts";
import { openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-codemode-upstream-");
afterAll(() => fixture.cleanup());

const AGENT_DIST = dirname(Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir));
const load = async <T>(path: string) => await import(pathToFileURL(join(AGENT_DIST, path)).href) as T;
type Loadout = {
  declared: ToolDefinition[]; callable: ToolDefinition[]; getExposure(name: string): string; getNamespace(name: string): unknown;
  getPromptGuidelines(name: string): string[];
};
type Outcome = { toolCall: { id: string }; result: AgentToolResult<unknown>; isError: boolean };
type UpstreamResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; details: { calls: { name: string; status: string; error?: string }[]; fullOutputPath?: string }; isError?: boolean };
const upstreamTool = await load<{
  CODEMODE_TOOL_NAME: string; DEFAULT_CODEMODE_INLINE_BUDGET: number; codemodeToolSystemPromptContribution: unknown;
  toCodemodeDeclaration(tool: ToolDefinition, guidelines?: readonly string[]): unknown;
  createCodemodeToolDefinition(options: { getInlineBudget?: () => number | undefined }): { prepareLoadout(loadout: Loadout): { descriptions: Record<string, string> } };
}>("extensions/codemode/tool.js");
const upstreamExecute = await load<{
  executeCodemode(id: string, input: { code: string }, signal: AbortSignal | undefined, onUpdate: undefined, ctx: object, options: object): Promise<UpstreamResult>;
}>("extensions/codemode/execute.js");
const upstreamSearch = await load<{
  DEFAULT_TOOL_SEARCH_LIMIT: number; tokenize: typeof tokenize; createToolSearchDocument: typeof createToolSearchDocument; Bm25Ranker: typeof Bm25Ranker;
}>("extensions/tool-search/tool.js");
const upstreamUsage = await load<{ combineUsage: typeof combineUsage }>("core/usage-totals.js");
const upstreamTruncate = await load<{ formatSize: typeof formatSize }>("core/tools/truncate.js");

const NAMESPACE = { name: "fixture_ns", description: "Fixture tools for the comparison.", instructions: "Use probe_struct for numbers." };
const OTHER = { name: "mcp__other-server", description: "Another fixture namespace." };
const STRUCT = Type.Object({ value: Type.Number({ description: "A number" }), label: Type.String() });
/** An MCP CallToolResult output schema (content array, isError, _meta) with structured content. */
const MCP_RESULT = {
  type: "object",
  properties: {
    content: { type: "array", items: { type: "object" } },
    structuredContent: { type: "object", properties: { rows: { type: "array", items: { type: "string" } } }, required: ["rows"] },
    isError: { type: "boolean" },
    _meta: { type: "object" },
  },
} as const;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type Probe = { definition: ToolDefinition; run(args: any, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> | AgentToolResult<unknown> };
const text = (...values: string[]): AgentToolResult<unknown> => ({ content: values.map((value) => ({ type: "text", text: value })), details: undefined });
function probe(name: string, run: Probe["run"], definition: Partial<ToolDefinition> = {}): Probe {
  return {
    definition: {
      name, label: name, description: `Fixture tool ${name}: ${definition.description ?? "returns fixed values"}.`, exposure: "codemode",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => { throw new Error("fixture tools run through the comparison"); },
      ...definition,
    } as ToolDefinition,
    run,
  };
}
/** read's output schema and value for an image file (coding-agent 1.0.4). */
const READ_IMAGE = Type.Union([Type.String(), Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() })]);
const PROBES: Probe[] = [
  // Guidelines with surrounding spaces, an empty one and a repeat: AgentSession's loadout trims them and drops both.
  probe("probe_text", () => text("文本结果", "第二段"), {
    namespace: NAMESPACE, promptGuidelines: ["  Use probe_text for text.  ", " ", "Use probe_text for text.", "Then read the second part."],
  }),
  probe("probe_struct", () => ({ ...text("七"), structuredContent: { value: 7, label: "七" } }), {
    outputSchema: STRUCT, namespace: NAMESPACE, description: "Return a structured value", promptGuidelines: ["Prefer probe_struct for numbers."],
  }),
  probe("probe_struct_error", () => ({ ...text("出错"), structuredContent: { value: -1, label: "错误" }, isError: true }), { outputSchema: STRUCT, namespace: NAMESPACE }),
  probe("probe_fail", () => ({ ...text("失败了"), isError: true })),
  probe("probe_throw", () => { throw new Error("抛出"); }),
  probe("probe_image", () => ({ content: [{ type: "text", text: "图" }, { type: "image", data: PNG, mimeType: "image/png" }], details: undefined })),
  probe("probe_slow", (_args, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))),
  probe("probe_mcp", () => ({ ...text("rows"), structuredContent: { rows: ["一", "二"] } }), { outputSchema: MCP_RESULT as never, namespace: OTHER }),
  probe("probe_deferred", () => text("deferred"), { exposure: "deferred", namespace: OTHER, promptGuidelines: ["Only when asked."] }),
  probe("probe_read_image", () => ({
    content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: PNG, mimeType: "image/png" }],
    structuredContent: { type: "image", data: PNG, mimeType: "image/png", note: "Read image file [image/png]" }, details: undefined,
  }), { outputSchema: READ_IMAGE as never }),
];
/** Prompt guidelines as AgentSession's loadout gives them (agent-session.js `_normalizePromptGuidelines`, 1.0.4). */
const loadoutGuidelines = (tool: ToolDefinition | undefined) =>
  [...new Set((tool?.promptGuidelines ?? []).map((guideline) => guideline.trim()).filter((guideline) => guideline.length > 0))];
const namespaceOf = (name: string) => PROBES.find((each) => each.definition.name === name)?.definition.namespace;

/**
 * Remove the output files upstream's executeCodemode wrote for `results` (coding-agent `writeOutputFile`: the system temp
 * directory, `pi-codemode-<16 hex digits>.<ext>`): the full output and image files the results name, nothing else.
 */
async function removeUpstreamOutputFiles(results: UpstreamResult[]) {
  const systemTemp = await realpath(tmpdir());
  const named = new Set(results.flatMap((result) => [
    ...(result.details.fullOutputPath === undefined ? [] : [result.details.fullOutputPath]),
    ...result.content.flatMap((item) => /^\[Image saved to (.+) \(image\/[a-z]+, \d+B\)\]$/.exec(item.text ?? "")?.slice(1) ?? []),
  ]));
  for (const path of named) {
    if (!/^pi-codemode-[0-9a-f]{16}\.(txt|png|jpg|gif|webp)$/.test(basename(path))) continue;
    if (dirname(await realpath(path).catch(() => "")) === systemTemp) await rm(path, { force: true });
  }
}

function memberProbe(each: Probe): MemberTool {
  return { definition: each.definition, replay: "unsafe", outputLimits: { maxBytes: 64 * 1024, maxLines: 2200 }, run: async (args, call) => each.run(args, call.signal) };
}

const options = (n: string): BaseToolsOptions => ({ root: join(fixture.root, `群数据-${n}`), groupId: "group-a" });

describe("codemode port vs installed coding-agent", () => {
  test("the installed packages are the ported version", () => {
    const version = (name: string) => (JSON.parse(readFileSync(join(dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir)), "package.json"), "utf8")) as { version: string }).version;
    expect(version("@earendil-works/pi-coding-agent")).toBe("1.1.0");
    expect(version("@earendil-works/pi-codemode")).toBe("1.1.0");
    expect(CODEMODE_TOOL_NAME).toBe(upstreamTool.CODEMODE_TOOL_NAME);
    expect(DEFAULT_CODEMODE_INLINE_BUDGET).toBe(upstreamTool.DEFAULT_CODEMODE_INLINE_BUDGET);
    expect(codemodeToolSystemPromptContribution).toEqual(upstreamTool.codemodeToolSystemPromptContribution as never);
    expect(DEFAULT_TOOL_SEARCH_LIMIT).toBe(upstreamSearch.DEFAULT_TOOL_SEARCH_LIMIT);
    for (const each of PROBES) {
      expect(toCodemodeDeclaration(each.definition)).toEqual(upstreamTool.toCodemodeDeclaration(each.definition) as never);
      const guidelines = each.definition.promptGuidelines;
      expect(toCodemodeDeclaration(each.definition, guidelines)).toEqual(upstreamTool.toCodemodeDeclaration(each.definition, guidelines) as never);
    }
    // The guidelines were exercised: listed after the description, trimmed, the empty one dropped (a repeat stays here).
    expect((toCodemodeDeclaration(PROBES[0]!.definition, PROBES[0]!.definition.promptGuidelines) as { description: string }).description)
      .toBe("Fixture tool probe_text: returns fixed values.\n\n- Use probe_text for text.\n- Use probe_text for text.\n- Then read the second part.");
  });

  test("mode on: the codemode description and the direct tools' descriptions equal upstream's prepareLoadout", () => {
    const base = baseMemberTools(options("loadout"));
    const send = probe("send_probe", () => text("sent"), { exposure: "model-only" });
    const all = [...base.map((tool) => tool.definition), send.definition, ...PROBES.map((each) => each.definition)];
    const exposure = (name: string) => all.find((tool) => tool.name === name)?.exposure ?? "direct";
    const loadout: Loadout = {
      declared: all.filter((tool) => ["direct", "model-only"].includes(exposure(tool.name))),
      // What scripts can call: everything but model-only and hidden tools.
      callable: all.filter((tool) => ["direct", "codemode", "deferred"].includes(exposure(tool.name))),
      getExposure: exposure,
      getNamespace: namespaceOf,
      getPromptGuidelines: (name) => loadoutGuidelines(all.find((tool) => tool.name === name)),
    };
    const callable: CallableTool[] = [
      ...base.map((tool) => ({ extension: "mixin.base", tool })),
      { extension: "fixture.send", tool: memberProbe(send) },
      ...PROBES.map((each) => ({ extension: "fixture.module", tool: memberProbe(each) })),
    ];
    for (const budget of [undefined, 400, 120, 0]) {
      const upstream = upstreamTool.createCodemodeToolDefinition({ getInlineBudget: () => budget }).prepareLoadout(loadout).descriptions;
      const extension = codemodeExtension({ members: options("loadout"), tools: callable, ...(budget === undefined ? {} : { inlineBudget: budget }) });
      expect(extension.tools![0]!.description).toBe(upstream.codemode!);
      const wrapped = Object.fromEntries((extension.wraps ?? []).map((wrap) => {
        const target = base.find((tool) => tool.definition.name === (wrap as { tool: string }).tool)!;
        return [target.definition.name, (wrap as { wrap(tool: unknown): { description: string } }).wrap(memberRegistration(target)).description];
      }));
      expect(wrapped).toEqual(Object.fromEntries(Object.entries(upstream).filter(([name]) => name !== "codemode")));
    }
    // Listed tools carry their guidelines as the loadout gives them.
    expect(upstreamTool.createCodemodeToolDefinition({}).prepareLoadout(loadout).descriptions.codemode!)
      .toContain("Fixture tool probe_text: returns fixed values.\n\n- Use probe_text for text.\n- Then read the second part.");
    // The budgets exercised the listing branches.
    const tight = upstreamTool.createCodemodeToolDefinition({ getInlineBudget: () => 120 }).prepareLoadout(loadout).descriptions.codemode!;
    expect(tight).toContain("(some tools not listed)");
    expect(upstreamTool.createCodemodeToolDefinition({ getInlineBudget: () => 0 }).prepareLoadout(loadout).descriptions.codemode!).toContain("(tools not listed)");
    expect(upstreamTool.createCodemodeToolDefinition({}).prepareLoadout(loadout).descriptions.codemode!).toContain("Shared MCP Types:");
  });

  test("search and usage functions equal upstream's", () => {
    for (const sample of ["readFile and writeFiles", "HTTPServer issues searches", "the batches of a boxes", "mcp__dev-radius__list_items", "", "数据 表格 sheet3"]) {
      expect(tokenize(sample)).toEqual(upstreamSearch.tokenize(sample));
    }
    const definitions = [...baseMemberTools(options("search")).map((tool) => tool.definition), ...PROBES.map((each) => each.definition)];
    const documents = definitions.map((tool) => createToolSearchDocument(tool, namespaceOf(tool.name)));
    expect(documents).toEqual(definitions.map((tool) => upstreamSearch.createToolSearchDocument(tool, namespaceOf(tool.name))));
    for (const [query, limit] of [["structured value", 8], ["read file", 3], ["fixture numbers", 8], ["nothing matches zzz", 8], ["text", 1]] as const) {
      expect(new Bm25Ranker().rank(query, documents, limit)).toEqual(new upstreamSearch.Bm25Ranker().rank(query, documents, limit));
    }
    const usage = (n: number, extra: Partial<Usage> = {}): Usage => ({
      input: n, output: n + 1, cacheRead: n + 2, cacheWrite: n + 3, totalTokens: 4 * n + 6,
      cost: { input: n / 10, output: n / 5, cacheRead: n / 20, cacheWrite: n / 40, total: n }, ...extra,
    });
    for (const [first, second] of [[usage(1), usage(2)], [usage(1, { reasoning: 5 }), usage(2)], [usage(1), usage(3, { cacheWrite1h: 4, reasoning: 1 })]]) {
      expect(combineUsage(first!, second!)).toEqual(upstreamUsage.combineUsage(first!, second!));
    }
    for (const bytes of [0, 70, 1023, 1024, 1536, 1024 * 1024 - 1, 1024 * 1024, 5_000_000]) {
      expect(formatSize(bytes)).toBe(upstreamTruncate.formatSize(bytes));
    }
  });

  test("the same scripts give the same output, values, errors and sub-call statuses as upstream's executeCodemode", async () => {
    const scripts = [
      `return "文本";`,
      `text("a"); console.log("b", { c: 1 }, [2]); text({ d: 1 }); return { e: [1, "二"] };`,
      `throw new TypeError("坏了");`,
      `return await tools.probe_struct({});`,
      `return await tools.probe_struct_error({});`,
      `return await tools.probe_mcp({});`,
      `try { await tools.probe_fail({}); } catch (error) { return error.message; }`,
      `try { await tools.probe_throw({}); } catch (error) { return error.message; }`,
      `const t = await tools.probe_text({}); text(t); await tools.probe_fail({});`,
      `await tools.probe_struct_error({}); throw new Error("之后");`,
      `// @options: {"max_output_tokens": 10}\ntext("x".repeat(30)); text("y".repeat(30)); image("data:image/png;base64,${PNG}"); return await tools.probe_image({});`,
      // 1.0.3 saves each distinct image once and names its file before it.
      `image("data:image/png;base64,${PNG}"); text("间"); image({ type: "image", data: "${PNG}", mimeType: "image/png" }); image("data:image/gif;base64,${GIF}"); return 1;`,
      // Durable commits each sub-call's start and result (about 200 ms): that time counts against timeout_ms.
      `// @options: {"timeout_ms": 5000}\nawait tools.probe_text({});\nawait new Promise(() => {});`,
      `// @options: {"timeout_ms": 400}\nawait tools.probe_slow({});`,
      `return { all: ALL_TOOLS, search: await searchTools("structured value"), scoped: await searchTools("fixture", { namespace: "other-server" }),
  described: await describeTool("probe_struct"), missing: (await describeTool("nope")) ?? null, ns: await describeNamespace("fixture_ns"),
  deferred: await tools.probe_deferred({}), bad: await searchTools("x", { limit: 0 }).catch((error) => error.message) };`,
      `text("before"); exit(); text("after");`,
      // Just within and just over the default budget (10000 tokens, 4 characters each).
      `text("z".repeat(39_990)); return 1;`,
      `text("z".repeat(40_001));`,
      `tools.probe_slow({}); return "left";`,
      `store("k", { v: 1 }); return load("k");`,
      // 1.0.4: read's image block; the script shows it with image().
      `const shot = await tools.probe_read_image({}); image(shot); return { keys: Object.keys(shot).sort(), note: shot.note, same: shot.data === "${PNG}" };`,
    ];
    const base = baseMemberTools(options("execute"));
    const definitions = [...base.map((tool) => tool.definition), ...PROBES.map((each) => each.definition)];

    // Upstream: executeCodemode with a stub session whose executeTool runs the probes.
    let upstreamCalls = 0;
    const ctx = {
      tools: definitions,
      sessionManager: { getBranch: () => [] },
      executeTool: async (name: string, args: unknown, { signal }: { signal?: AbortSignal }): Promise<Outcome> => {
        const toolCall = { id: `up/${++upstreamCalls}` };
        const each = PROBES.find((candidate) => candidate.definition.name === name)!;
        try {
          const result = await each.run(args, signal);
          return { toolCall, result, isError: result.isError === true };
        } catch (error) {
          return { toolCall, result: text((error as Error).message), isError: true };
        }
      },
    };
    const upstream: UpstreamResult[] = [];
    // As codemode's extension passes them (index.js, 1.0.4): every tool's guidelines as its definition has them.
    const getToolGuidelines = () => new Map(definitions.map((tool) => [tool.name, tool.promptGuidelines ?? []]));
    try {
      for (const code of scripts) {
        upstream.push(await upstreamExecute.executeCodemode("up", { code }, undefined, undefined, ctx, { getToolNamespace: namespaceOf, getToolGuidelines }));
      }
    } finally {
      // Upstream writes its output files to the system temp directory: remove the ones these runs named.
      await removeUpstreamOutputFiles(upstream);
    }

    // Durable: the same tools in a group Harness, one codemode call per script.
    const faux = fauxProvider({ tokenSize: { min: 50, max: 50 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const tools: BaseToolsOptions = options("execute");
    const extensions: Extension[] = [
      defineExtension({ name: "mixin.base", tools: base.map(memberRegistration) }),
      defineExtension({ name: "fixture.module" }),
      codemodeExtension({ members: tools, tools: [...base.map((tool) => ({ extension: "mixin.base", tool })), ...PROBES.map((each) => ({ extension: "fixture.module", tool: memberProbe(each) }))] }),
    ];
    const opened = await openGroupHarness(join(fixture.root, "execute.sqlite"), models, { group: "group-a", extensions, settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } } });
    const ours: UpstreamResult[] = [];
    try {
      const model = faux.getModel();
      const { conversation } = await memberConversation(opened.harness, "group-a", "+8613800000001", { model: { provider: model.provider, modelId: model.id } }, context);
      for (const [index, code] of scripts.entries()) {
        const id = `cm-${index}`;
        faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }), fauxAssistantMessage("好的")]);
        await (await conversation.submit({ type: "input", content: "运行" }, context)).wait(context);
        const entry = (await conversation.entries({}, 1000, undefined, context)).items
          .map((item) => item.model?.[0] as unknown as { toolCallId?: string } & UpstreamResult & { details: CodemodeDetails })
          .find((message) => message?.toolCallId === id)!;
        ours.push(entry);
      }
    } finally { await opened.close(); }

    const normalise = (result: UpstreamResult) => {
      const spill = result.details.fullOutputPath;
      // Image files are numbered by first appearance, so a file saved once for a repeated image stays visible.
      const images: string[] = [];
      const image = (path: string) => {
        if (!images.includes(path)) images.push(path);
        return `<image ${images.indexOf(path) + 1}>`;
      };
      return {
        isError: result.isError === true,
        content: result.content.map((item) => item.type === "text"
          ? {
            type: "text",
            text: item.text!.replace(/Wall time \d+\.\d seconds/, "Wall time <t> seconds").replace(spill ?? "\u0000", "<full output>")
              .replace(/\[Image saved to ([^\n]+) \((image\/[a-z]+, \d+B)\)\]/g, (_, path: string, kind: string) => `[Image saved to ${image(path)} (${kind})]`),
          }
          : { type: item.type, data: item.data, mimeType: item.mimeType }),
        // A call cancelled while its start was committed does not run here (upstream runs it into the abort), so the
        // error texts of cancelled calls differ.
        calls: result.details.calls.map((call) => [call.name, call.status, call.status === "cancelled" ? "<cancelled>" : call.error]),
      };
    };
    for (const [index, code] of scripts.entries()) {
      expect({ code, ...normalise(ours[index]!) }).toEqual({ code, ...normalise(upstream[index]!) });
    }
    // The comparison covered failures (a deadlock and a timeout among them), truncation with a spilled file, and
    // cancelled calls.
    const at = (start: string) => scripts.findIndex((code) => code.startsWith(start));
    expect(upstream.map((result, index) => result.isError ? index : -1).filter((index) => index >= 0))
      .toEqual([at("throw new TypeError"), at("const t ="), at("await tools.probe_struct_error"), at(`// @options: {"timeout_ms": 5000}`), at(`// @options: {"timeout_ms": 400}`)]);
    expect(upstream[at(`// @options: {"timeout_ms": 5000}`)]!.content.at(-1)!.text).toContain("can never settle");
    expect(upstream[at(`// @options: {"timeout_ms": 400}`)]!.content.at(-1)!.text).toContain("Script timed out");
    expect(ours[at(`// @options: {"max_output_tokens": 10}`)]!.details.fullOutputPath).toBeString();
    // Image labels were compared: after the cut text, and one file for the repeated PNG.
    const labels = (result: UpstreamResult) => normalise(result).content.flatMap(item => [...(item.text ?? "").matchAll(/\[Image saved to [^\n]+\]/g)].map(match => match[0]));
    expect(labels(upstream[at(`// @options: {"max_output_tokens": 10}`)]!)).toEqual(["[Image saved to <image 1> (image/png, 70B)]"]);
    expect(labels(upstream[at(`image("data:image/png`)]!)).toEqual([
      "[Image saved to <image 1> (image/png, 70B)]", "[Image saved to <image 1> (image/png, 70B)]", "[Image saved to <image 2> (image/gif, 42B)]",
    ]);
    expect(ours[at("tools.probe_slow({}); return")]!.details.calls).toMatchObject([{ name: "probe_slow", status: "cancelled" }]);
    // read's image block reached the script whole and was shown; describeTool() listed the guidelines.
    expect(labels(upstream[at("const shot")]!)).toEqual(["[Image saved to <image 1> (image/png, 70B)]"]);
    expect(upstream[at("const shot")]!.content.at(-1)!.text).toBe(`{"keys":["data","mimeType","note","type"],"note":"Read image file [image/png]","same":true}`);
    expect(upstream[at("return { all: ALL_TOOLS")]!.content.at(-1)!.text).toContain("- Prefer probe_struct for numbers.");
  }, 60_000);
});
