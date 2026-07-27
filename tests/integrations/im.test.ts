import { describe, expect, test } from "bun:test";
import {
  sendFile,
  sendImage,
  sendReplyWithMention,
} from "../../src/integrations/im.ts";

describe("IM outbound group routing", () => {
  test("uses text for plain replies and markdown plus completion mention for formatting", async () => {
    const payloads: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 200 });
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
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const callbackA =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=a-${crypto.randomUUID()}`;
    const callbackB =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=b-${crypto.randomUUID()}`;

    try {
      await sendReplyWithMention("A 群回复", "group-a", "+8613800000000", callbackA);
      await sendReplyWithMention("B 群回复", "group-b", "+8613800000000", callbackB);
      await sendImage("image-b", "group-b", callbackB);
      await sendFile("file-b", "group-b", callbackB);
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
      imageMsg: { fileId: "image-b" },
    });
    expect(requests[3]?.payload).toMatchObject({
      type: "file",
      fileMsg: { fileId: "file-b" },
    });
    for (const { payload } of requests) {
      expect(payload).not.toHaveProperty("groupId");
      expect(JSON.stringify(payload)).not.toContain('"groupId"');
    }
  });
});
