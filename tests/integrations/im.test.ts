import { describe, expect, test } from "bun:test";
import {
  sendFile,
  sendImage,
  sendReplyWithMention,
} from "../../src/integrations/im.ts";

describe("IM outbound group routing", () => {
  test("keeps groupId explicit when two groups share a callback key", async () => {
    const payloads: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const sharedCallback =
      `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=shared-${crypto.randomUUID()}`;

    try {
      await sendReplyWithMention("**A 群回复**", "group-a", "+8613800000000", sharedCallback);
      await sendReplyWithMention("**B 群回复**", "group-b", "+8613800000000", sharedCallback);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(payloads).toHaveLength(2);
    expect(payloads).toMatchObject([
      { type: "markdown", groupId: "group-a", markdown: { groupId: "group-a" } },
      { type: "markdown", groupId: "group-b", markdown: { groupId: "group-b" } },
    ]);
  });

  test("keeps callback URL and groupId bound to the current group", async () => {
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
      await sendReplyWithMention("**A 群回复**", "group-a", "+8613800000000", callbackA);
      await sendReplyWithMention("**B 群回复**", "group-b", "+8613800000000", callbackB);
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
      type: "markdown",
      groupId: "group-a",
      markdown: { groupId: "group-a" },
    });
    expect(requests[1]?.payload).toMatchObject({
      type: "markdown",
      groupId: "group-b",
      markdown: { groupId: "group-b" },
    });
    expect(requests[2]?.payload).toMatchObject({
      type: "image",
      imageMsg: { fileId: "image-b", groupId: "group-b" },
    });
    expect(requests[3]?.payload).toMatchObject({
      type: "file",
      fileMsg: { fileId: "file-b", groupId: "group-b" },
    });
  });
});
