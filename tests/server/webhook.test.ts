import { describe, expect, test } from "bun:test";
import { RATE_LIMIT_MAX_REQUESTS } from "../../src/core/config.ts";
import {
  drainUserRequests,
  enqueueUserNotice,
  isDuplicate,
  isRateLimited,
  rememberRequest,
  validateWebhookData,
} from "../../src/server/webhook.ts";

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
    expect(() => validateWebhookData(request({ groupId: "group\u2028forged" }))).toThrow(
      "无效的 groupId"
    );
  });

  test("rejects payload fields with the wrong JSON types", () => {
    expect(() => validateWebhookData(request({ phone: 13800000000 }))).toThrow(
      "必须使用正确类型"
    );
    expect(() =>
      validateWebhookData(request({ textMsg: { content: { value: "你好" } } }))
    ).toThrow("textMsg.content 必须是字符串");
  });

  test("rejects callback URLs outside the send endpoint", () => {
    expect(() =>
      validateWebhookData(
        request({ callBackUrl: "https://example.com/?key=test-key" })
      )
    ).toThrow("无效的回调URL");
    expect(() =>
      validateWebhookData(
        request({
          callBackUrl:
            "https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=a&key=b",
        })
      )
    ).toThrow("只能包含一个");
  });

  test("deduplicates accepted requests and isolates rate limits by group", () => {
    const suffix = crypto.randomUUID();
    const phone = `user-${suffix.slice(0, 20)}`;
    const content = `content-${suffix}`;

    expect(isDuplicate(phone, "group-a", content)).toBe(false);
    rememberRequest(phone, "group-a", content);
    expect(isDuplicate(phone, "group-a", content)).toBe(true);
    expect(isDuplicate(phone, "group-b", content)).toBe(false);

    for (let index = 0; index < RATE_LIMIT_MAX_REQUESTS; index++) {
      expect(isRateLimited(phone, "group-a")).toBe(false);
    }
    expect(isRateLimited(phone, "group-a")).toBe(true);
    expect(isRateLimited(phone, "group-b")).toBe(false);
  });

  test("sends overload feedback through the callback and merges duplicate notices", async () => {
    let requestCount = 0;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requestCount++;
      started();
      await pending;
      return new Response(JSON.stringify({ ok: true, code: 200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=notice-${crypto.randomUUID()}`;

    try {
      enqueueUserNotice(
        "capacity",
        "任务已满",
        "+8613800000000",
        "group-a",
        callbackUrl
      );
      await firstStarted;
      enqueueUserNotice(
        "capacity",
        "任务已满",
        "+8613800000000",
        "group-a",
        callbackUrl
      );
      await Promise.resolve();
      expect(requestCount).toBe(1);
      release();
      await drainUserRequests();
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(1);
  });
});
