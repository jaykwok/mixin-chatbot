import { describe, expect, test } from "bun:test";
import { validateWebhookData } from "../../src/server/webhook.ts";

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: "text",
    textMsg: { content: "你好" },
    phone: "+8613800000000",
    groupId: "研发群",
    callBackUrl:
      "https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=test-key",
    ...overrides,
  };
}

describe("webhook validation", () => {
  test("accepts Unicode group ids and a whitelisted callback", () => {
    expect(validateWebhookData(request())).toMatchObject({
      phone: "+8613800000000",
      groupId: "研发群",
      content: "你好",
    });
  });

  test("rejects control characters in group ids", () => {
    expect(() => validateWebhookData(request({ groupId: "group\nforged-log" }))).toThrow(
      "无效的 groupId"
    );
  });

  test("rejects callback URLs outside the send endpoint", () => {
    expect(() =>
      validateWebhookData(
        request({ callBackUrl: "https://example.com/?key=test-key" })
      )
    ).toThrow("无效的回调URL");
  });
});
