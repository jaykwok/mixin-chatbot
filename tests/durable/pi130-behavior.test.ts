import { expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";
import { transformMessages, splitErrorToolResultImages } from "@earendil-works/pi-ai/api/transform-messages";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension } from "@earendil-works/pi-durable";
import { memberConversation } from "../../src/durable/identity.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";

test("finished malformed JSON cannot execute write/send/MCP; repaired Unicode escapes preserve every following field", async () => {
  const f = await tempFixture("strict-tool-json-");
  const { faux, models, model } = fauxModels();
  const called: unknown[] = [];
  const names = ["write", "send_file", "fixture_mcp"];
  const extension = defineExtension({ name: "strict-fixture", tools: names.map(name => ({ name, description: name,
    parameters: Type.Object({ path: Type.String(), content: Type.String(), after: Type.String() }), replay: "unsafe" as const,
    execute: async args => { called.push(args); return { output: [{ type: "text" as const, text: "executed" }] }; },
  })) });
  const opened = await openGroupHarness(join(f.root, "group.sqlite"), models, { extensions: [extension] });
  try {
    const raw = '{"path":"a","content":"partial"';
    const bad = parseToolCallArguments(raw);
    expect(bad.argumentsError).toContain(raw); expect(bad.arguments).toEqual({});
    const valid = parseToolCallArguments(String.raw`{"path":"report.tex","content":"\usepackage{booktabs}","after":"kept"}`);
    expect(valid.argumentsError).toBeUndefined(); expect(valid.arguments).toEqual({ path: "report.tex", content: "\\usepackage{booktabs}", after: "kept" });
    faux.setResponses([fauxAssistantMessage(names.map((name, i) => ({ ...fauxToolCall(name, {}, { id: `bad-${i}` }), ...bad })), { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write", valid.arguments, { id: "valid" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const { conversation } = await memberConversation(opened.harness, scopeOf("group-a"), "alice", { model }, context);
    expect((await (await conversation.submit({ type: "input", content: "work" }, context)).wait(context)).status).toBe("done");
    expect(called).toEqual([valid.arguments]);
    const transcript = JSON.stringify((await conversation.entries({}, 100, undefined, context)).items);
    expect(transcript).toContain("partial");
  } finally { await opened.close(); await f.cleanup(); }
});

test("cross-model conversion drops prior thinking while retaining the visible answer; error images split out of Anthropic/Bedrock tool results", () => {
  const model = kimiCodingProvider().getModels()[0]!;
  const previous = { ...fauxAssistantMessage("visible answer"), provider: "other", model: "other",
    content: [{ type: "thinking" as const, thinking: "private reasoning", thinkingSignature: "opaque" }, { type: "text" as const, text: "visible answer" }] };
  const messages = transformMessages([previous], model);
  expect(JSON.stringify(messages)).toContain("visible answer"); expect(JSON.stringify(messages)).not.toContain("private reasoning");
  const split = splitErrorToolResultImages({ role: "toolResult", toolCallId: "call", toolName: "read", isError: true, timestamp: 1,
    content: [{ type: "text", text: "failed" }, { type: "image", data: "AA==", mimeType: "image/png" }] });
  expect(split!.images).toHaveLength(1); expect(split!.content.every(part => part.type === "text")).toBe(true);
  expect(split!.caption).toContain("read");
});

test("Kimi uses Chat Completions /v1 URL; one proxy delta containing reasoning and text preserves thinking before text", async () => {
  const model = kimiCodingProvider().getModels()[0]!;
  expect(model.api).toBe("openai-completions"); expect(model.baseUrl.endsWith("/v1")).toBe(true);
  expect(model.contextWindow).toBeGreaterThan(model.maxTokens);
  let url = "";
  const events = [
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: "reason", content: "answer" }, finish_reason: null }] },
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
  ];
  const response = () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const request = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
  await stream(model as never, request, { apiKey: "fixture", maxRetries: 0, fetch: (async input => { url = String(input); return response(); }) as typeof fetch }).result();
  expect(url).toBe(model.baseUrl + "/chat/completions");
  const proxy = deepseekProvider().getModels()[0]!;
  const output = stream(proxy as never, request, { apiKey: "fixture", maxRetries: 0, fetch: (async () => response()) as unknown as typeof fetch });
  const order: string[] = []; for await (const event of output) order.push(event.type);
  expect(order.indexOf("thinking_end")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("thinking_delta")).toBeLessThan(order.indexOf("text_delta"));
  expect((await output.result()).content.map(part => part.type)).toEqual(["thinking", "text"]);
});
