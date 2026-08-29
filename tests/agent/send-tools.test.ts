import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSendTools } from "../../src/agent/send-tools.ts";
import { MAX_ATTACHMENT_BYTES } from "../../src/core/config.ts";
import type { RelayConfig } from "../../src/integrations/relay.ts";
import { openRelayIndex } from "../../src/integrations/relay-index.ts";

const CALLBACK_URL =
  "https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=send-tools-test";

const RELAY: RelayConfig = {
  webdavUrl: "http://127.0.0.1:5244/dav/relay/",
  publicBaseUrl: "https://files.example.com/d/relay/",
  username: "bot",
  password: "secret",
  maxBytes: 2 * 1024 ** 3,
};

/** 一个刚好越过 IM 单条附件上限的文件，用来触发外链分支。 */
async function writeOversizedFile(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024));
  return path;
}

describe("attachment send tools", () => {
  test("honors the Pi tool abort signal before downloading", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const imageTool = buildSendTools({
      getCallbackUrl: () => CALLBACK_URL,
      groupId: "group-a",
      phone: "+8613800000000",
      workspaceDir: ".",
      tempDir: ".",
    }).find((tool) => tool.name === "send_image")!;

    try {
      await expect(
        imageTool.execute(
          "send-aborted-image",
          { source: "https://example.com/image.png" },
          controller.signal,
          undefined,
          {} as never
        )
      ).rejects.toThrow();
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("relays an oversized local file and posts the link to the group", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-relay-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    const originalFetch = globalThis.fetch;
    const requests: { url: string; method?: string; auth?: string }[] = [];
    let sentText = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method,
        auth: headers.get("authorization") ?? undefined,
      });
      // WebDAV PUT / 去重探测
      if (init?.method === "PUT") return new Response(null, { status: 201 });
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      // IM 出站发送
      const body = init?.body;
      if (typeof body === "string") {
        sentText = (JSON.parse(body).textMsg?.content as string) ?? "";
      }
      return new Response(JSON.stringify({ ok: true, code: 200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await writeOversizedFile(workspace, "report.bin");
      const fileTool = buildSendTools({
        getCallbackUrl: () => CALLBACK_URL,
        groupId: "group-a",
        phone: "+8613800000000",
        workspaceDir: workspace,
        tempDir: userTemp,
        relay: RELAY,
        // 用临时索引，别把测试产物写进仓库的 data/runtime。
        relayIndex: await openRelayIndex(join(root, "relay-index.jsonl")),
      }).find((tool) => tool.name === "send_file")!;

      const result = await fileTool.execute(
        "send-large-file",
        { source: "report.bin" },
        undefined,
        undefined,
        {} as never
      );

      const put = requests.find((r) => r.method === "PUT")!;
      expect(put).toBeDefined();
      expect(put.url.startsWith(RELAY.webdavUrl)).toBe(true);
      // 对象名不可枚举，且保留原文件名便于人辨认。
      expect(put.url).toContain("report.bin");
      expect(put.url).not.toBe(`${RELAY.webdavUrl}report.bin`);
      expect(put.auth).toBe(`Basic ${Buffer.from("bot:secret").toString("base64")}`);

      const details = result.details as { url: string; mode: string };
      expect(details.mode).toBe("relay");
      expect(details.url.startsWith(RELAY.publicBaseUrl)).toBe(true);
      // 链接必须真的发进群里，不能只留在工具结果里让模型转述。
      expect(sentText).toContain(details.url);
      // 附件上传端点不该被碰过——大文件根本没进 IM 的通道。
      expect(requests.some((r) => r.url.includes("upload"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("rejects an oversized local file when no relay is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-norelay-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    await Promise.all([mkdir(workspace), mkdir(userTemp)]);

    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    try {
      await writeOversizedFile(workspace, "report.bin");
      const fileTool = buildSendTools({
        getCallbackUrl: () => CALLBACK_URL,
        groupId: "group-a",
        phone: "+8613800000000",
        workspaceDir: workspace,
        tempDir: userTemp,
      }).find((tool) => tool.name === "send_file")!;

      await expect(
        fileTool.execute(
          "send-large-file-no-relay",
          { source: "report.bin" },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("超过");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("keeps the workspace boundary on the relay path", async () => {
    const root = await mkdtemp(join(tmpdir(), "mixin-chatbot-relay-guard-"));
    const workspace = join(root, "workspace");
    const userTemp = join(root, "user-tmp");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(userTemp), mkdir(outside)]);

    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    try {
      const outsideFile = await writeOversizedFile(outside, "secret.bin");
      const fileTool = buildSendTools({
        getCallbackUrl: () => CALLBACK_URL,
        groupId: "group-a",
        phone: "+8613800000000",
        workspaceDir: workspace,
        tempDir: userTemp,
        relay: RELAY,
        relayIndex: await openRelayIndex(join(root, "relay-index.jsonl")),
      }).find((tool) => tool.name === "send_file")!;

      await expect(
        fileTool.execute(
          "send-outside-file",
          { source: outsideFile },
          undefined,
          undefined,
          {} as never
        )
      ).rejects.toThrow("只能发送");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
