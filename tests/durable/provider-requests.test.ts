// Pi 1.4.0 provider conversions the project relies on, checked on the requests a local fake provider receives (no network):
// a tool result of only whitespace is sent as a placeholder, so the conversation goes on, and a tool set that loses a tool
// and later gets it back (an MCP server gone and back across restarts) is declared the way the model's compat allows.
// The shapes only; nothing here measures cache hits or cost.
import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { appLayout, groupScope } from "../../src/core/layout.ts";
import { openModelRuntime } from "../../src/core/model-config.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { baseMemberTools, type BaseToolsOptions, memberPlaces, memberRegistration } from "../../src/durable/tools.ts";
import { openGroupHarness } from "../helpers/durable.ts";
import { scopeOf } from "../helpers/layout.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-provider-requests-");
afterAll(() => fixture.cleanup());

const GROUP = "group-a", ALICE = "+8613800000001";
const SETTINGS = { retry: { maxRetries: 0, baseDelayMs: 5, maxAgentDelayMs: 20 }, stream: { maxRetries: 0, timeoutMs: 10_000 } };
type Item = { type?: string; role?: string; call_id?: string; output?: unknown; content?: unknown; tools?: { name: string }[] };
type Body = { tools?: { name: string }[]; input?: Item[]; messages?: { role: string; content?: unknown; tool_call_id?: string }[] };

const sse = (events: unknown[], done = false) => new Response(events.map((event) => `${event !== null && typeof event === "object" && "type" in event
  ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), {
  headers: { "Content-Type": "text/event-stream" },
});
const completed = (id: string) => ({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
const responsesAnswer = (text: string) => sse([
  { type: "response.created", response: { id: "resp_text" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_one", role: "assistant", content: [] } },
  { type: "response.output_text.delta", output_index: 0, item_id: "msg_one", content_index: 0, delta: text },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_one", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
  completed("resp_text"),
]);
const responsesRead = (path: string) => sse([
  { type: "response.created", response: { id: "resp_read" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: "" } },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: JSON.stringify({ path }) } },
  completed("resp_read"),
]);
const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => ({ id: "chat", object: "chat.completion.chunk", created: 0, model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const completionsAnswer = (text: string) => sse([chunk({ role: "assistant", content: text }), chunk({}, "stop", USAGE)], true);
const completionsRead = (path: string) => sse([
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }] }),
  chunk({}, "tool_calls", USAGE),
], true);

/** A local provider that records every request body and answers from a queue (then a plain answer). */
function provider(api: "openai-responses" | "openai-completions") {
  const bodies: Body[] = [], answers: (() => Response)[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.json() as Body);
    return (answers.shift() ?? (() => api === "openai-responses" ? responsesAnswer("完成") : completionsAnswer("完成")))();
  } });
  return { bodies, answers, server, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

async function models(name: string, providers: Record<string, unknown>) {
  const dir = join(fixture.root, `models-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers }));
  return await openModelRuntime({ modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
}
const model = (id: string, compat?: Record<string, boolean>) => ({ id, name: id, contextWindow: 32000, maxTokens: 1024, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(compat === undefined ? {} : { compat }) });

/** The member tools as the service registers them, optionally without some. */
function memberTools(base: BaseToolsOptions, without: string[] = []): Extension {
  return defineExtension({ name: "mixin.base", tools: baseMemberTools(base).filter((tool) => !without.includes(tool.definition.name)).map(memberRegistration) });
}

async function turn(path: string, runtime: unknown, extensions: Extension[], ref: { provider: string; modelId: string }, content: string) {
  const opened = await openGroupHarness(path, runtime as never, { group: GROUP, extensions, settings: SETTINGS });
  try {
    const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), ALICE, { model: ref }, context);
    expect((await (await conversation.submit({ type: "input", content }, context)).wait(context)).status).toBe("done");
  } finally { await opened.close(); }
}

for (const api of ["openai-responses", "openai-completions"] as const) {
  test(`${api}: a whitespace-only tool result goes to the provider as a placeholder and the conversation goes on`, async () => {
    const local = provider(api);
    try {
      const runtime = await models(`blank-${api}`, { local: { api, baseUrl: local.baseUrl, apiKey: "synthetic-literal-key", models: [model("m")] } });
      const base: BaseToolsOptions = { layout: appLayout(join(fixture.root, `data-blank-${api}`)), scope: groupScope(GROUP) };
      const workspace = memberPlaces(base, groupScope(GROUP), ALICE).workspaceDir;
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "blank.txt"), "  \n\t\n");
      local.answers.push(() => api === "openai-responses" ? responsesRead("blank.txt") : completionsRead("blank.txt"));
      const path = join(fixture.root, `blank-${api}.sqlite`);
      await turn(path, runtime, [memberTools(base)], { provider: "local", modelId: "m" }, "读一下 blank.txt");
      expect(local.bodies).toHaveLength(2);
      const sent = api === "openai-responses"
        ? local.bodies[1]!.input!.filter((item) => item.type === "function_call_output" && item.call_id === "call_read").map((item) => item.output)
        : local.bodies[1]!.messages!.filter((message) => message.role === "tool" && message.tool_call_id === "call_read").map((message) => message.content);
      expect(sent).toEqual(["(no tool output)"]);
      // And the next turn of the same conversation is answered.
      await turn(path, runtime, [memberTools(base)], { provider: "local", modelId: "m" }, "继续");
      expect(local.bodies).toHaveLength(3);
    } finally { local.server.stop(true); }
  });
}

test("Responses: a tool removed and later declared again is sent as top-level tools by default, and as additional_tools changes when the model allows them", async () => {
  const local = provider("openai-responses");
  try {
    const runtime = await models("tool-changes", { local: { api: "openai-responses", baseUrl: local.baseUrl, apiKey: "synthetic-literal-key", models: [
      model("plain"), model("changes", { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }),
    ] } });
    for (const modelId of ["plain", "changes"]) {
      const base: BaseToolsOptions = { layout: appLayout(join(fixture.root, `data-tools-${modelId}`)), scope: groupScope(GROUP) };
      const path = join(fixture.root, `tools-${modelId}.sqlite`), ref = { provider: "local", modelId }, from = local.bodies.length;
      await turn(path, runtime, [memberTools(base)], ref, "第一轮");
      await turn(path, runtime, [memberTools(base, ["write"])], ref, "第二轮");
      await turn(path, runtime, [memberTools(base)], ref, "第三轮");
      const bodies = local.bodies.slice(from);
      expect(bodies).toHaveLength(3);
      const names = (tools?: { name: string }[]) => tools?.map((tool) => tool.name);
      const declared = bodies.map((body) => body.input!.filter((item) => item.type === "additional_tools").map((item) => names(item.tools)));
      // additional_tools items have the developer role too; the notices are the instruction messages.
      const notices = bodies.map((body) => body.input!.filter((item) => item.type !== "additional_tools" && (item.role === "system" || item.role === "developer"))
        .map((item) => String(item.content).split("\n")[0]));
      if (modelId === "plain") {
        // Each request declares exactly the current tools at the top level; the transcript carries no tool changes.
        expect(bodies.map((body) => names(body.tools))).toEqual([ALL, ALL.filter((name) => name !== "write"), ALL]);
        expect({ declared, notices }).toEqual({ declared: [[], [], []], notices: [[], [], []] });
      } else {
        // Every tool is declared in additional_tools items: all at the head, the removal as text, the re-addition as an
        // incremental item. Each request extends the previous one's input unchanged.
        expect(bodies.map((body) => body.tools ?? [])).toEqual([[], [], []]);
        expect(declared).toEqual([[ALL], [ALL], [ALL, ["write"]]]);
        expect(notices).toEqual([[], [REMOVED], [REMOVED, INCREMENTAL]]);
        expect(bodies[1]!.input!.at(-1)!.content).toBe(`${REMOVED}\n- write`);
        expect(String(bodies[2]!.input!.at(-2)!.content)).not.toContain("Still unavailable");
        for (const index of [1, 2]) expect(bodies[index]!.input!.slice(0, bodies[index - 1]!.input!.length)).toEqual(bodies[index - 1]!.input!);
      }
    }
  } finally { local.server.stop(true); }
});
const ALL = ["read", "bash", "edit", "write"];
const REMOVED = "The following tools are no longer available. Do not call them:";
const INCREMENTAL = "This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.";
