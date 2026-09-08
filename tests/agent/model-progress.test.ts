import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ModelProgress } from "../../src/agent/model-progress.ts";

function message(): AssistantMessage {
  return {
    role: "assistant", content: [], api: "openai-completions", provider: "fake", model: "fake",
    stopReason: "pending", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
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
  stream.update({ type: "toolcall_start", contentIndex: 0, partial });
  stream.update({ type: "thinking_end", contentIndex: 1, content: "", partial });
  expect(stream.isIdle(10_000)).toBe(false);
  now = 10_000;
  expect(stream.isIdle(10_000)).toBe(true);
  expect(stream.snapshot()).toMatchObject({ idleSeconds: 10, lastEventSecondsAgo: 1, effectiveChars: 0 });
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
  Object.defineProperty(partial, "content", { get() { throw new Error("must not inspect the full content"); } });
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
  expect(stream.snapshot()).toMatchObject({ active: false, elapsedSeconds: 4, idleSeconds: 4 });
  stream.begin();
  expect(stream.snapshot()).toMatchObject({
    response: 2, active: true, idleSeconds: 0, events: {}, textChars: 0, effectiveChars: 0, responseId: null,
  });
  expect(stream.isIdle(10_000)).toBe(false);
  now += 10_000;
  expect(stream.isIdle(10_000)).toBe(true);
});
