import { expect, test } from "bun:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { ModelProgress } from "../../src/agent/model-progress.ts";

function message(): AssistantMessage {
  return {
    role: "assistant", content: [], api: "openai-completions", provider: "fake", model: "fake",
    stopReason: "pending", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function tool(partial: AssistantMessage, index: number, args: ToolCall["arguments"] = {}): ToolCall {
  const block: ToolCall = { type: "toolCall", id: "call-" + index, name: "bash", arguments: args };
  partial.content[index] = block;
  return block;
}

test("first-content deadline starts with the turn; metadata events cannot renew it", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  expect(stream.snapshot()).toBeUndefined();
  expect(stream.isIdle(10_000)).toBe(false);
  stream.begin();
  now = 9_000;
  stream.start(partial);
  tool(partial, 0);
  stream.update({ type: "toolcall_start", contentIndex: 0, partial });
  expect(stream.sampleToolArguments()).toBe(false);
  stream.update({ type: "thinking_end", contentIndex: 1, content: "", partial });
  expect(stream.isIdle(10_000)).toBe(false);
  now = 10_000;
  expect(stream.isIdle(10_000)).toBe(true);
  expect(stream.snapshot()).toMatchObject({ idleSeconds: 10, lastEventSecondsAgo: 1, effectiveChars: 0,
    parsedToolArgsChars: 2, toolArgsChanges: 0, toolArgsLastChangeSecondsAgo: null });
});

test("empty and whitespace-only tool deltas keep event activity separate from content growth", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  stream.begin();
  stream.start(partial);
  now = 1_000;
  expect(stream.update({ type: "text_delta", contentIndex: 0, delta: "答 复", partial })).toBe(true);
  now = 2_000;
  expect(stream.update({ type: "thinking_delta", contentIndex: 1, delta: "\n思考", partial })).toBe(true);
  now = 3_000;
  tool(partial, 2, { x: 1 });
  expect(stream.update({ type: "toolcall_delta", contentIndex: 2, delta: '{"x": 1}', partial })).toBe(true);
  for (now = 4_000; now <= 13_000; now += 1_000) {
    expect(stream.update({ type: "toolcall_delta", contentIndex: 2, delta: "", partial })).toBe(false);
    expect(stream.update({ type: "toolcall_delta", contentIndex: 2, delta: " \n\t", partial })).toBe(false);
  }
  now = 13_000;
  expect(stream.isIdle(10_000)).toBe(true);
  expect(stream.snapshot()).toMatchObject({
    active: true, idleSeconds: 10, lastEventSecondsAgo: 0, lastEvent: "toolcall_delta",
    emptyDeltas: 10, whitespaceDeltas: 10, textChars: 3, thinkingChars: 3, toolArgsChars: 38, effectiveChars: 11,
    events: { message_start: 1, text_delta: 1, thinking_delta: 1, toolcall_delta: 21 },
  });
});

test("growing output renews the budget, including thinking and partial tool arguments", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  stream.begin();
  for (const type of ["thinking_delta", "toolcall_delta", "text_delta"] as const) {
    now += 9_000;
    expect(stream.isIdle(10_000)).toBe(false);
    if (type === "toolcall_delta") tool(partial, 0, { command: "新🙂" });
    stream.update({ type, contentIndex: 0, delta: "新🙂", partial });
    expect(stream.snapshot()?.idleSeconds).toBe(0);
  }
  now += 9_999;
  expect(stream.isIdle(10_000)).toBe(false);
  now++;
  expect(stream.isIdle(10_000)).toBe(true);
  expect(stream.snapshot()?.effectiveChars).toBe(9);
});

test("terminal metadata stays observable without copying content or double-counting end events", () => {
  const stream = new ModelProgress(() => 0);
  const partial = message();
  tool(partial, 0, { command: "secret-tool-arguments" });
  partial.content.push({ type: "thinking", get thinking(): string { throw new Error("must not serialize thinking"); } });
  stream.begin();
  stream.update({ type: "toolcall_delta", contentIndex: 0, delta: "secret-tool-arguments", partial });
  // Some providers mutate only metadata without emitting another SDK delta.
  partial.responseId = "response-test-id";
  partial.rawStopReason = "tool_calls";
  expect(stream.snapshot()).toMatchObject({ responseId: "response-test-id", rawStopReason: "tool_calls" });
  partial.stopReason = "aborted";
  partial.errorMessage = "secret-provider-body";
  stream.finish(partial);
  expect(stream.isIdle(0)).toBe(false);
  expect(stream.snapshot()).toMatchObject({ stopReason: "aborted", lastEvent: "message_end", toolArgsChars: 21 });
  const serialized = JSON.stringify(stream.snapshot());
  expect(serialized).not.toContain("secret-tool-arguments");
  expect(serialized).not.toContain("secret-provider-body");
  expect(stream.snapshot()?.tools).toEqual([{ contentIndex: 0, name: "bash", parsedArgsChars: 35, changes: 1, lastChangeSecondsAgo: 0 }]);
  partial.responseId = "sk-123456abcdef";
  partial.rawStopReason = "x".repeat(10_000);
  expect(stream.snapshot()?.responseId).toBe("sk-***");
  expect(stream.snapshot()?.rawStopReason?.length).toBe(160);
});

test("pauses freeze model time and the next response starts with fresh counters and metadata", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  partial.responseId = "old-response";
  stream.begin();
  stream.update({ type: "text_delta", contentIndex: 0, delta: "old text", partial });
  now = 4_000;
  stream.pause();
  now = 60_000;
  expect(stream.isIdle(10_000)).toBe(false);
  expect(stream.isExpired(10_000)).toBe(false);
  expect(stream.snapshot()).toMatchObject({ active: false, elapsedSeconds: 4, idleSeconds: 4 });
  stream.begin();
  expect(stream.snapshot()).toMatchObject({
    response: 2, active: true, idleSeconds: 0, events: {}, textChars: 0, effectiveChars: 0, responseId: null,
    parsedToolArgsChars: 0, toolArgsChanges: 0, tools: [], toolArgsLastChangeSecondsAgo: null,
  });
  expect(stream.isIdle(10_000)).toBe(false);
  now += 10_000;
  expect(stream.isIdle(10_000)).toBe(true);
});

test("nonempty raw tool deltas with unchanged parsed arguments do not renew the idle budget", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  const block = tool(partial, 0, { command: "private-command", timeout: 60 });
  const event = { type: "toolcall_delta", contentIndex: 0, delta: "repeated".repeat(1000), partial } as const;
  stream.begin();
  expect(stream.update(event)).toBe(true);
  for (now = 1000; now <= 10_000; now += 1000) {
    // Match the SDK: it can return new object identities containing the same values.
    block.arguments = { command: "private-command", timeout: 60 };
    expect(stream.update(event)).toBe(false);
  }
  now = 10_000;
  expect(stream.isIdle(10_000)).toBe(true);
  expect(stream.snapshot()).toMatchObject({
    toolArgsChars: 88_000, effectiveChars: 88_000, parsedToolArgsChars: JSON.stringify(block.arguments).length,
    toolArgsChanges: 1, toolArgsLastChangeSecondsAgo: 10, idleSeconds: 10, lastEventSecondsAgo: 0,
  });
  expect(JSON.stringify(stream.snapshot())).not.toContain("private-command");
});

test("same-length parsed changes and in-place mutations count independently for multiple tools", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  const first = tool(partial, 0, { command: "a", options: { count: 1 } });
  const second = tool(partial, 1, { command: "z" });
  stream.begin();
  stream.update({ type: "toolcall_delta", contentIndex: 0, delta: "a", partial });
  now = 1000;
  first.arguments.options.count = 2;
  expect(stream.update({ type: "toolcall_delta", contentIndex: 0, delta: "2", partial })).toBe(true);
  now = 2000;
  expect(stream.update({ type: "toolcall_delta", contentIndex: 1, delta: "z", partial })).toBe(true);
  now = 3000;
  second.arguments.command = "x";
  expect(stream.update({ type: "toolcall_delta", contentIndex: 1, delta: "x", partial })).toBe(true);
  now = 4000;
  expect(stream.update({ type: "toolcall_delta", contentIndex: 0, delta: "repeated", partial })).toBe(false);
  expect(stream.snapshot()).toMatchObject({ toolArgsChanges: 4, idleSeconds: 1, toolCalls: 2,
    tools: [{ contentIndex: 0, changes: 2, lastChangeSecondsAgo: 3 }, { contentIndex: 1, changes: 2, lastChangeSecondsAgo: 1 }] });
});

test("argument sampling is bounded during a delta flood, with a fresh sample before idle cancellation", () => {
  let now = 0;
  let reads = 0;
  let command = "private-a";
  const stream = new ModelProgress(() => now);
  const partial = message();
  tool(partial, 0, { get command() { reads++; return command; } });
  const event = { type: "toolcall_delta", contentIndex: 0, delta: "repeated", partial } as const;
  stream.begin();
  for (let i = 0; i < 10_000; i++) {
    now = i / 10;
    stream.update(event);
    stream.sampleToolArguments();
    stream.snapshot();
  }
  expect(reads).toBe(1);
  now = 9900;
  stream.update(event);
  expect(reads).toBe(2);
  now = 10_000;
  command = "private-b";
  expect(stream.update(event)).toBe(false); // Within the normal one-second sampling interval.
  expect(stream.sampleToolArguments(stream.isIdle(10_000))).toBe(true);
  expect(stream.isIdle(10_000)).toBe(false);
  expect(reads).toBe(3);
  stream.pause();
  now = 30_000;
  stream.update(event);
  stream.sampleToolArguments(true);
  expect(reads).toBe(3);
  expect(stream.isExpired(10_000)).toBe(false);
});

test("response hard deadline includes first-content wait and cannot be renewed by progress", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  expect(stream.isExpired(0)).toBe(false);
  stream.begin();
  now = 9000;
  stream.start(partial);
  expect(stream.isExpired(10_000)).toBe(false);
  stream.update({ type: "thinking_delta", contentIndex: 0, delta: "fresh", partial });
  now = 10_000;
  expect(stream.isIdle(10_000)).toBe(false);
  expect(stream.isExpired(10_000)).toBe(true);
  stream.finish(partial);
  now = 100_000;
  expect(stream.isExpired(10_000)).toBe(false);
  stream.begin();
  expect(stream.isExpired(10_000)).toBe(false);
  now += 10_000;
  expect(stream.isExpired(10_000)).toBe(true);
});

test("terminal tools are sampled without executing them, and logs cap tool details but track every call", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  stream.begin();
  for (let index = 0; index < 10; index++) {
    tool(partial, index, { command: "private-" + index });
    stream.update({ type: "toolcall_start", contentIndex: index, partial });
  }
  stream.sampleToolArguments();
  now = 9000;
  const last = tool(partial, 9, { command: "changed" });
  stream.update({ type: "toolcall_end", contentIndex: 9, toolCall: last, partial });
  expect(stream.sampleToolArguments()).toBe(true);
  // Invalid names must not smuggle argument text into metadata logs.
  const first = partial.content[0] as ToolCall;
  first.name = "bash\nprivate-arguments";
  now = 9100;
  first.arguments.command = "terminal-private-value";
  stream.finish(partial);
  const stats = stream.snapshot()!;
  expect(stats).toMatchObject({ active: false, toolCalls: 10, toolArgsChanges: 12, idleSeconds: 0 });
  expect(stats.tools).toHaveLength(8);
  expect(stats.tools[0]!.name).toBe("<invalid>");
  expect(stats.parsedToolArgsChars).toBe(partial.content.reduce((sum, block) => sum + JSON.stringify((block as ToolCall).arguments).length, 0));
  expect(JSON.stringify(stats)).not.toContain("private");
  now = 20_000;
  stream.finish(partial);
  expect(stream.snapshot()).toMatchObject({ active: false, toolArgsChanges: 12, elapsedSeconds: 9 });
});

test("unserializable partial arguments cannot crash progress tracking or conceal inactivity", () => {
  let now = 0;
  const stream = new ModelProgress(() => now);
  const partial = message();
  const block = tool(partial, 0);
  block.arguments.self = block.arguments;
  stream.begin();
  now = 10_000;
  expect(() => stream.update({ type: "toolcall_delta", contentIndex: 0, delta: "private", partial })).not.toThrow();
  expect(stream.isIdle(10_000)).toBe(true);
  expect(stream.snapshot()).toMatchObject({ toolArgsChanges: 0, parsedToolArgsChars: 0 });
  expect(() => stream.finish(partial)).not.toThrow();
});
