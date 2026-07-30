import { describe, expect, test } from "bun:test";
import {
  getOutboundRateStatus,
  sendFile,
  sendImage,
  sendReplyWithMention,
  sendText,
  uploadAttachment,
} from "../../src/integrations/im.ts";

function webhookResponse(
  body: Record<string, unknown> = {
    ok: true,
    code: 200,
    message: "成功",
    content: null,
    data: null,
  }
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("IM outbound group routing", () => {
  test("uses text for plain replies and markdown plus completion mention for formatting", async () => {
    const payloads: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return webhookResponse();
    }) as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=format-${crypto.randomUUID()}`;

    try {
      await sendReplyWithMention(
        "第一段普通文字。\n\n第二段普通文字。",
        "group-a",
        "+8613800000000",
        callbackUrl
      );
      await sendReplyWithMention(
        "## 标题\n这是 **重点** 和 [链接](https://example.com)",
        "group-a",
        "+8613800000000",
        callbackUrl
      );
      await sendReplyWithMention(
        "| 项目 | 状态 |\n| --- | --- |\n| 路由 | 正常 |",
        "group-a",
        "+8613800000000",
        callbackUrl
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloads).toHaveLength(5);
    expect(payloads[0]).toMatchObject({
      type: "text",
      textMsg: { content: "第一段普通文字。\n\n第二段普通文字。" },
    });
    expect(payloads[1]).toMatchObject({
      type: "markdown",
      markdown: {
        content: "## 标题\n这是 **重点** 和 [链接](https://example.com)",
      },
    });
    expect(payloads[2]).toMatchObject({
      type: "text",
      textMsg: {
        content: "✅ 任务已完成，请查看上方回复",
        isMentioned: true,
        mentionedMobileList: ["+8613800000000"],
      },
    });
    expect(payloads[3]).toMatchObject({
      type: "markdown",
      markdown: {
        content: "| 项目 | 状态 |\n| --- | --- |\n| 路由 | 正常 |",
      },
    });
    expect(payloads[4]).toMatchObject({
      type: "text",
      textMsg: {
        content: "✅ 任务已完成，请查看上方回复",
        isMentioned: true,
        mentionedMobileList: ["+8613800000000"],
      },
    });
  });

  test("uses each incoming callback URL and the documented outbound schema", async () => {
    const requests: { url: string; payload: Record<string, unknown> }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        payload: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return webhookResponse();
    }) as typeof fetch;

    const callbackA =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=a-${crypto.randomUUID()}`;
    const callbackB =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=b-${crypto.randomUUID()}`;

    try {
      await sendReplyWithMention("A 群回复", "group-a", "+8613800000000", callbackA);
      await sendReplyWithMention("B 群回复", "group-b", "+8613800000000", callbackB);
      await sendImage(
        "image-b",
        "group-b",
        callbackB,
        "+8613900000000",
        640,
        480
      );
      await sendFile("file-b", "group-b", callbackB, "+8613900000000");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(4);
    expect(requests.map(({ url }) => url)).toEqual([
      callbackA,
      callbackB,
      callbackB,
      callbackB,
    ]);
    expect(requests[0]?.payload).toMatchObject({
      type: "text",
      textMsg: { content: "A 群回复" },
    });
    expect(requests[1]?.payload).toMatchObject({
      type: "text",
      textMsg: { content: "B 群回复" },
    });
    expect(requests[2]?.payload).toMatchObject({
      type: "image",
      imageMsg: {
        fileId: "image-b",
        width: 640,
        height: 480,
        isMentioned: true,
        mentionedMobileList: ["+8613900000000"],
      },
    });
    expect(requests[3]?.payload).toMatchObject({
      type: "file",
      fileMsg: {
        fileId: "file-b",
        isMentioned: true,
        mentionedMobileList: ["+8613900000000"],
      },
    });
    for (const { payload } of requests) {
      expect(payload).not.toHaveProperty("groupId");
      expect(JSON.stringify(payload)).not.toContain('"groupId"');
    }
  });

  test("checks business responses and falls back when undocumented markdown is rejected", async () => {
    const payloads: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return payloads.length === 1
        ? webhookResponse({ ok: false, code: 400, message: "不支持的消息类型" })
        : webhookResponse();
    }) as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=business-${crypto.randomUUID()}`;
    try {
      expect(
        await sendReplyWithMention(
          "## 标题\n这是 **重点**",
          "group-a",
          "+8613800000000",
          callbackUrl
        )
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ type: "markdown" });
    expect(payloads[1]).toMatchObject({
      type: "text",
      textMsg: {
        isMentioned: true,
        mentionedMobileList: ["+8613800000000"],
      },
    });
  });

  test("splits text at the documented 5000-character limit and mentions only once", async () => {
    const payloads: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return webhookResponse();
    }) as typeof fetch;

    const content = "甲".repeat(5001);
    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=split-${crypto.randomUUID()}`;
    try {
      expect(
        await sendReplyWithMention(
          content,
          "group-a",
          "+8613800000000",
          callbackUrl
        )
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const textMessages = payloads.map(
      (payload) => payload.textMsg as Record<string, unknown>
    );
    expect(textMessages).toHaveLength(2);
    expect(textMessages.map((message) => String(message.content)).join("")).toBe(
      content
    );
    expect(textMessages.every((message) => String(message.content).length <= 5000)).toBe(
      true
    );
    expect(textMessages[0]).not.toHaveProperty("isMentioned");
    expect(textMessages[1]).toMatchObject({
      isMentioned: true,
      mentionedMobileList: ["+8613800000000"],
    });
  });

  test("sends upload credentials as multipart fields and accepts content.id", async () => {
    const requests: { url: string; form: FormData }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), form: init?.body as FormData });
      return webhookResponse({
        ok: true,
        code: 200,
        message: "成功",
        content: { id: "uploaded-image" },
      });
    }) as typeof fetch;

    const key = `upload-${crypto.randomUUID()}`;
    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=${key}`;
    let fileId: string | null;
    try {
      fileId = await uploadAttachment(
        callbackUrl,
        new Uint8Array([1, 2, 3]),
        "report.png",
        "image"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fileId).toBe("uploaded-image");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://imtwo.zdxlz.com/im-external/v1/webhook/upload-attachment"
    );
    expect(requests[0]?.form.get("key")).toBe(key);
    expect(requests[0]?.form.get("type")).toBe("1");
    expect(requests[0]?.form.get("file")).toBeInstanceOf(Blob);
  });

  test("marks the custom webhook window full on a business rate-limit response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      webhookResponse({
        ok: false,
        code: 429,
        message: "请稍后再试",
      })) as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=limited-${crypto.randomUUID()}`;
    try {
      expect(
        await sendText(
          "可丢弃状态",
          "group-a",
          "+8613800000000",
          callbackUrl,
          { traffic: "status" }
        )
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(getOutboundRateStatus(callbackUrl)).toMatchObject({
      used: 20,
      limit: 20,
      pending: 0,
      mode: "cooldown",
    });
  });

  test("shares one 20 RPM window for the same robot key across allowed hosts", async () => {
    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requestCount++;
      return webhookResponse({
        ok: false,
        code: 10029,
        message: "请稍后再试",
      });
    }) as unknown as typeof fetch;

    const key = `shared-${crypto.randomUUID()}`;
    const callbackA =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=${key}`;
    const callbackB =
      `https://im.zdxlz.com/im-external/v1/webhook/send?key=${key}`;
    try {
      expect(
        await sendText("状态 A", "group-a", "+8613800000000", callbackA, {
          traffic: "status",
        })
      ).toBe(false);
      expect(
        await sendText("状态 B", "group-a", "+8613800000000", callbackB, {
          traffic: "status",
        })
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(1);
    expect(getOutboundRateStatus(callbackB)).toMatchObject({
      used: 20,
      limit: 20,
      mode: "cooldown",
    });
  });

  test("keeps a rate-limited required message at the FIFO head until cooldown", async () => {
    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requestCount++;
      return webhookResponse({
        ok: false,
        code: 429,
        message: "触发限流",
      });
    }) as unknown as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=head-${crypto.randomUUID()}`;
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const first = sendText(
        "限流中的第一条",
        "group-a",
        "+8613800000000",
        callbackUrl,
        { signal: firstController.signal }
      );
      for (
        let attempt = 0;
        attempt < 100 &&
        getOutboundRateStatus(callbackUrl).mode !== "cooldown";
        attempt++
      ) {
        await Bun.sleep(1);
      }
      expect(getOutboundRateStatus(callbackUrl).mode).toBe("cooldown");
      const second = sendText(
        "后来的第二条",
        "group-a",
        "+8613900000000",
        callbackUrl,
        { signal: secondController.signal }
      );
      const settled = Promise.allSettled([first, second]);
      await Promise.resolve();

      expect(requestCount).toBe(1);
      expect(getOutboundRateStatus(callbackUrl)).toMatchObject({
        used: 20,
        pending: 2,
        mode: "cooldown",
      });

      firstController.abort(new DOMException("test abort", "AbortError"));
      secondController.abort(new DOMException("test abort", "AbortError"));
      expect((await settled).map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
    } finally {
      firstController.abort();
      secondController.abort();
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(1);
    expect(getOutboundRateStatus(callbackUrl).pending).toBe(0);
  });

  test("keeps the active send at the front of the callback FIFO", async () => {
    const payloads: Record<string, unknown>[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      payloads.push(payload);
      if (payloads.length === 1) {
        markFirstStarted();
        await firstReleased;
      }
      return webhookResponse();
    }) as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=fifo-${crypto.randomUUID()}`;
    try {
      const first = sendText(
        "第一条",
        "group-a",
        "+8613800000000",
        callbackUrl
      );
      await firstStarted;
      const second = sendText(
        "第二条",
        "group-a",
        "+8613900000000",
        callbackUrl
      );
      await Promise.resolve();
      expect(payloads).toHaveLength(1);
      expect(getOutboundRateStatus(callbackUrl)).toMatchObject({
        used: 1,
        pending: 2,
      });
      releaseFirst();
      expect(await Promise.all([first, second])).toEqual([true, true]);
    } finally {
      releaseFirst();
      globalThis.fetch = originalFetch;
    }

    expect(payloads.map((payload) => (payload.textMsg as { content: string }).content)).toEqual([
      "第一条",
      "第二条",
    ]);
    expect(getOutboundRateStatus(callbackUrl)).toMatchObject({
      used: 2,
      pending: 0,
    });
  });

  test("cancels a queued send without waiting for the active FIFO head", async () => {
    let markFirstStarted!: () => void;
    let releaseFirst!: (response: Response) => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount++;
      if (requestCount === 1) {
        markFirstStarted();
        return firstResponse;
      }
      return webhookResponse();
    }) as unknown as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=abort-queued-${crypto.randomUUID()}`;
    const controller = new AbortController();
    try {
      const first = sendText(
        "占据队首",
        "group-a",
        "+8613800000000",
        callbackUrl
      );
      await firstStarted;
      const second = sendText(
        "排队后取消",
        "group-a",
        "+8613900000000",
        callbackUrl,
        { signal: controller.signal }
      );
      await Promise.resolve();
      controller.abort(new DOMException("test abort", "AbortError"));

      const secondResult = await Promise.race([
        second.then(
          () => "fulfilled",
          () => "rejected"
        ),
        Bun.sleep(100).then(() => "timeout"),
      ]);
      expect(secondResult).toBe("rejected");
      expect(requestCount).toBe(1);
      expect(getOutboundRateStatus(callbackUrl).pending).toBe(1);

      releaseFirst(webhookResponse());
      expect(await first).toBe(true);
    } finally {
      controller.abort();
      releaseFirst(webhookResponse());
      globalThis.fetch = originalFetch;
    }

    expect(getOutboundRateStatus(callbackUrl).pending).toBe(0);
  });

  test("keeps every chunk of one logical reply together in the FIFO", async () => {
    const contents: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        textMsg: { content: string };
      };
      contents.push(payload.textMsg.content);
      if (contents.length === 1) {
        markFirstStarted();
        await firstReleased;
      }
      return webhookResponse();
    }) as typeof fetch;

    const callbackUrl =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=chunks-${crypto.randomUUID()}`;
    const longReply = "甲".repeat(5001);
    try {
      const first = sendText(
        longReply,
        "group-a",
        "+8613800000000",
        callbackUrl
      );
      await firstStarted;
      const second = sendText(
        "另一位用户的消息",
        "group-a",
        "+8613900000000",
        callbackUrl
      );
      releaseFirst();
      expect(await Promise.all([first, second])).toEqual([true, true]);
    } finally {
      releaseFirst();
      globalThis.fetch = originalFetch;
    }

    expect(contents).toEqual([
      "甲".repeat(5000),
      "甲",
      "另一位用户的消息",
    ]);
  });
});
