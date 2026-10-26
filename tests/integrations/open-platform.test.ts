import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PlatformClient, PlatformRequestError } from "../../src/integrations/open-platform/client.ts";
import { parseAppBotConfig, platformEndpoints } from "../../src/integrations/open-platform/config.ts";
import { DirectoryClient, decryptV2 } from "../../src/integrations/open-platform/directory.ts";
import { downloadFile, uploadFile } from "../../src/integrations/open-platform/files.ts";
import { parseImageHeader } from "../../src/integrations/open-platform/image.ts";
import { markdownMessage, measure, MessageSender, splitText, textMessage } from "../../src/integrations/open-platform/messages.ts";
import { StreamConnection, type StreamEvent } from "../../src/integrations/open-platform/stream.ts";
import { encryptV2, FakePlatform, json } from "../helpers/fake-platform.ts";
import { tempFixture } from "../helpers/temp.ts";

let fake: FakePlatform;
beforeEach(() => { fake = new FakePlatform(); });
afterEach(() => fake.stop());

const client = (options: { now?: () => number; timeoutMs?: number; retryDelaysMs?: number[] } = {}) =>
  new PlatformClient(fake.config, { endpoints: fake.endpoints, retryDelaysMs: [5, 5], ...options });

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await Bun.sleep(5);
  }
}

describe("config", () => {
  test("accepts only the fixed hosts and rejects unknown fields", () => {
    expect(platformEndpoints("production").api).toBe("https://imtwo.zdxlz.com");
    expect(platformEndpoints("production").stream).toBe("wss://imtwo.zdxlz.com/open-apis/v1/events/stream");
    expect(platformEndpoints("staging").api).toBe("https://mxpre.zdxlz.com:1443");
    expect(() => parseAppBotConfig({ appId: "abcd", appSecret: "secret-value", apiBase: "https://evil.example" })).toThrow("未知字段");
    expect(() => parseAppBotConfig({ appId: "abcd", appSecret: "secret-value", environment: "custom" })).toThrow("environment");
    expect(parseAppBotConfig({ appId: "abcd", appSecret: "secret-value" }).environment).toBe("production");
    const storage = platformEndpoints("production").storage;
    expect(storage(new URL("https://imfl.zdxlz.com/a?sig=1"))).toBe(true);
    expect(storage(new URL("http://imfl.zdxlz.com/a"))).toBe(false);
    expect(storage(new URL("https://zdxlz.com.evil.example/a"))).toBe(false);
  });
});

describe("token cache", () => {
  test("coalesces concurrent fetches and refreshes 60 s before expiry", async () => {
    let now = 1_000_000;
    const api = client({ now: () => now });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => api.appToken.get()));
    expect(new Set(tokens).size).toBe(1);
    expect(fake.tokenCount).toBe(1);
    now += (7200 - 61) * 1000;
    expect(await api.appToken.get()).toBe(tokens[0]!);
    now += 2000;
    expect(await api.appToken.get()).not.toBe(tokens[0]!);
    expect(fake.tokenCount).toBe(2);
  });

  test("a 401 invalidates the token and retries once", async () => {
    const api = client();
    await api.appToken.get();
    let calls = 0;
    fake.route("POST /open-apis/v1/messages/v1/send", () => ++calls === 1 ? json({ code: 401 }, 401) : json({ success: true, code: 200 }));
    const outcome = await new MessageSender(api).send({ kind: "direct", receiveId: "u1" }, textMessage("hi"));
    expect(outcome).toEqual({ status: "sent" });
    expect(fake.tokenCount).toBe(2);
    const auths = fake.requestsTo("/open-apis/v1/messages/v1/send").map(request => request.headers.get("authorization"));
    expect(auths).toEqual(["Bearer app-1", "Bearer app-2"]);
  });

  test("a failing token endpoint reports the request as unsent", async () => {
    fake.route("POST /open-apis/v1/auth/token", () => json({ error: "x" }, 500));
    const error = await client().request("GET", "/x").catch(error => error);
    expect(error).toBeInstanceOf(PlatformRequestError);
    expect((error as PlatformRequestError).kind).toBe("unsent");
  });
});

describe("stream", () => {
  test("answers stream.validate, delivers events synchronously with their send time, drops signed frames", async () => {
    const events: StreamEvent[] = [];
    const stream = new StreamConnection(client(), { onEvent: event => events.push(event) });
    stream.start();
    try {
      await until(() => fake.sockets.size === 1 && stream.status().connected);
      fake.push({ eventType: "stream.validate", eventId: "v-1", appId: "62964" });
      await until(() => fake.frames.length === 1);
      expect(fake.frames[0]).toEqual({ eventType: "stream.validate.ack", eventId: "v-1", success: true });
      fake.push({ eventType: "callback:direct", msgUid: "M-1", type: "text", content: { content: "hi" } }, 1234567);
      fake.push({ eventType: "callback:direct", msgUid: "M-2" }, Date.now(), "signed");
      fake.push({ eventType: "callback:direct", msgUid: "M-3" });
      await until(() => events.length === 2);
      expect(events[0]!.payload.msgUid).toBe("M-1");
      expect(events[0]!.sentAt).toBe(1234567);
      expect(events[1]!.payload.msgUid).toBe("M-3");
      expect(fake.frames.length).toBe(1);
    } finally { await stream.stop(); }
  });

  test("reconnects with backoff after a drop and after a refused handshake, refreshing the token", async () => {
    const stream = new StreamConnection(client(), { onEvent: () => {}, initialBackoffMs: 20, maxBackoffMs: 40 });
    stream.start();
    try {
      await until(() => stream.status().connected);
      fake.rejectStream = true;
      fake.dropSockets();
      await until(() => !stream.status().connected);
      expect(stream.status().lastDisconnect?.reason).toContain("连接断开");
      await until(() => fake.tokenCount >= 2);
      expect(stream.status().disconnectedSince).toBeNumber();
      fake.rejectStream = false;
      await until(() => stream.status().connected);
      expect(stream.status().reconnects).toBe(1);
      expect(stream.status().disconnectedSince).toBeUndefined();
    } finally { await stream.stop(); }
    await until(() => fake.sockets.size === 0);
  });

  test("a half-open connection that stops answering pings is dropped and reconnected; a peer that never answers is left alone", async () => {
    // 原始 TCP 上的 WebSocket 对端：完成握手后按 mode 回应客户端的帧（Bun.serve 会自动回 pong，模拟不了静默）。
    const silentPeer = (mode: "pong-once" | "never") => {
      let connections = 0;
      const server = Bun.listen<{ handshaken: boolean; pongs: number }>({
        hostname: "127.0.0.1", port: 0,
        socket: {
          open: socket => { socket.data = { handshaken: false, pongs: 0 }; },
          data: (socket, chunk) => {
            if (!socket.data.handshaken) {
              const key = /sec-websocket-key:\s*(\S+)/i.exec(chunk.toString("latin1"))?.[1] ?? "";
              const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
              socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
              socket.data.handshaken = true;
              connections++;
              return;
            }
            if (mode === "pong-once" && socket.data.pongs++ === 0) socket.write(Buffer.from([0x8a, 0x00]));
          },
        },
      });
      return { server, connections: () => connections };
    };
    for (const mode of ["pong-once", "never"] as const) {
      const peer = silentPeer(mode);
      const api = new PlatformClient(fake.config, { endpoints: { ...fake.endpoints, stream: `ws://127.0.0.1:${peer.server.port}/stream` }, retryDelaysMs: [5, 5] });
      const stream = new StreamConnection(api, { onEvent: () => {}, initialBackoffMs: 20, maxBackoffMs: 40, pingIntervalMs: 40 });
      stream.start();
      try {
        await until(() => stream.status().connected);
        if (mode === "pong-once") {
          await until(() => peer.connections() >= 2);
          expect(stream.status().lastDisconnect?.reason).toContain("连接断开");
        } else {
          await Bun.sleep(300);
          expect(peer.connections()).toBe(1);
          expect(stream.status().connected).toBe(true);
        }
      } finally {
        await stream.stop();
        peer.server.stop(true);
      }
    }
  });
});

describe("segmentation", () => {
  test("respects both character and byte limits, including the first-segment prefix", () => {
    const chinese = "测".repeat(5000);
    const parts = splitText(chinese, { firstReserve: measure("> 回复 张三：问题\n\n") });
    for (const part of parts) {
      expect(measure(part).chars).toBeLessThanOrEqual(3500);
      expect(measure(part).bytes).toBeLessThanOrEqual(10 * 1024);
    }
    expect(measure(parts[0]!).bytes + measure("> 回复 张三：问题\n\n").bytes).toBeLessThanOrEqual(10 * 1024);
    expect(parts.join("")).toBe(chinese);
    const ascii = "a".repeat(8000);
    expect(splitText(ascii).map(part => part.length)).toEqual([3500, 3500, 1000]);
  });

  test("prefers line boundaries and never splits a surrogate pair", () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}行 😀 ${"x".repeat(30)}`).join("\n");
    const parts = splitText(text, { maxChars: 200, maxBytes: 10_000 });
    expect(parts.join("")).toBe(text);
    for (const part of parts.slice(0, -1)) expect(part.endsWith("\n")).toBe(true);
    const emoji = "😀".repeat(30);
    const pieces = splitText(emoji, { maxChars: 7, maxBytes: 1000 });
    expect(pieces.join("")).toBe(emoji);
    for (const piece of pieces) expect(piece).not.toMatch(/[\ud800-\udbff]$/);
  });

  test("closes and reopens code fences across segments", () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n");
    const text = `前言\n\`\`\`ts\n${code}\n\`\`\`\n结尾`;
    const parts = splitText(text, { maxChars: 200, maxBytes: 10_000 });
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(measure(part).chars).toBeLessThanOrEqual(200);
      const fences = part.split("\n").filter(line => line.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
    expect(parts[1]!.startsWith("```ts\n")).toBe(true);
    const restored = parts.map((part, index) => {
      let value = part;
      if (index > 0 && value.startsWith("```ts\n") && index < parts.length) value = value.slice(6);
      if (index < parts.length - 1 && value.endsWith("```")) value = value.slice(0, -3);
      return value;
    }).join("");
    expect(restored.replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
  });
});

describe("sending", () => {
  const direct = { kind: "direct" as const, receiveId: "user-1" };
  const group = { kind: "group" as const, receiveId: "1234567890123456789" };

  test("builds the documented body with conversation type, reply id and Markdown mention", async () => {
    const sender = new MessageSender(client());
    expect(await sender.send(group, markdownMessage("> 回复 张三：问题\n\n正文", "im-user-1"), { replyMsgId: "M-1", idemKey: "d-1" })).toEqual({ status: "sent" });
    expect(await sender.send(direct, textMessage("hello"))).toEqual({ status: "sent" });
    const [first, second] = fake.sent;
    expect(first!.body).toMatchObject({ receive_id: group.receiveId, conversation_type: "group", msg_type: "markdown", reply_msg_id: "M-1", idem_key: "d-1" });
    expect(first!.content).toEqual({ title: "回复 张三：问题", content: "> 回复 张三：问题\n\n正文", a: [{ i: "im-user-1" }] });
    expect(second!.body).toMatchObject({ receive_id: "user-1", conversation_type: "single", msg_type: "text" });
    expect(second!.content).toEqual({ content: "hello" });
    expect(fake.requestsTo("/open-apis/v1/messages/v1/send")[0]!.headers.get("x-client-id")).toBe(fake.config.appId);
  });

  test("classifies explicit rejections as failed and gateway timeouts as uncertain", async () => {
    const sender = new MessageSender(client());
    fake.route("POST /open-apis/v1/messages/v1/send", () => json({ code: 500, message: "INTERNAL_SERVER_ERROR" }, 500));
    expect((await sender.send(direct, textMessage("x"))).status).toBe("failed");
    fake.route("POST /open-apis/v1/messages/v1/send", () => json({ success: false, code: 40001 }));
    expect((await sender.send(direct, textMessage("x"))).status).toBe("failed");
    fake.route("POST /open-apis/v1/messages/v1/send", () => new Response("gateway", { status: 504 }));
    expect((await sender.send(direct, textMessage("x"))).status).toBe("uncertain");
    // 没有自动重发：每次只到达一次。
    expect(fake.requestsTo("/open-apis/v1/messages/v1/send").length).toBe(3);
  });

  test("a 2xx response that neither confirms nor rejects is uncertain and never resent", async () => {
    const sender = new MessageSender(client());
    const bodies = ['{"success":', "", "{}", '{"data":{}}', '{"code":null}', '{"code":{"value":400}}', '{"code":[400]}', '{"code":"400"}', "[]"];
    for (const body of bodies) {
      fake.route("POST /open-apis/v1/messages/v1/send", () => new Response(body, { status: 200 }));
      expect(await sender.send(direct, textMessage("x"))).toMatchObject({ status: "uncertain", reason: expect.stringContaining("无法确认") });
    }
    // 2xx 里的明确拒绝仍是 failed。
    fake.route("POST /open-apis/v1/messages/v1/send", () => json({ code: 400, message: "bad" }));
    expect((await sender.send(direct, textMessage("x"))).status).toBe("failed");
    expect(fake.requestsTo("/open-apis/v1/messages/v1/send").length).toBe(bodies.length + 1);
  });

  test("a timeout after the platform received the message is uncertain and never resent", async () => {
    const sender = new MessageSender(client({ timeoutMs: 100 }));
    let received = 0;
    fake.route("POST /open-apis/v1/messages/v1/send", async () => { received++; await Bun.sleep(400); return json({ success: true, code: 200 }); });
    const outcome = await sender.send(direct, textMessage("x"));
    expect(outcome.status).toBe("uncertain");
    await Bun.sleep(50);
    expect(received).toBe(1);
  });

  test("a reset connection is uncertain; a refused connection is retried and then failed", async () => {
    const sender = new MessageSender(client());
    let received = 0;
    fake.route("POST /open-apis/v1/messages/v1/send", async () => { received++; fake.server.stop(true); return new Promise<Response>(() => {}); });
    expect((await sender.send(direct, textMessage("x"))).status).toBe("uncertain");
    expect(received).toBe(1);
    // 服务器已停止：后续连接被拒绝，确定没有发出。
    const refused = new MessageSender(new PlatformClient(fake.config, { endpoints: { ...fake.endpoints }, retryDelaysMs: [5, 5] }));
    const outcome = await refused.send(direct, textMessage("y"));
    expect(outcome.status).toBe("failed");
  });

  test("a 429 cools down and retries because the platform did not process it", async () => {
    const sender = new MessageSender(client());
    let calls = 0;
    fake.route("POST /open-apis/v1/messages/v1/send", () => ++calls === 1 ? json({ code: 429 }, 429, { "Retry-After": "1" }) : json({ success: true, code: 200 }));
    const started = Date.now();
    expect(await sender.send(direct, textMessage("x"))).toEqual({ status: "sent" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(calls).toBe(2);
  });

  test("limits the per-conversation rate and keeps a transaction's messages together", async () => {
    const sender = new MessageSender(client(), { perTarget: 3, global: 100, windowMs: 300 });
    const started = Date.now();
    await Promise.all(Array.from({ length: 4 }, (_, i) => sender.send(direct, textMessage(`m${i}`))));
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    fake.sent.length = 0;
    const order: string[] = [];
    await Promise.all([
      sender.transaction(group, async send => { for (const text of ["a1", "a2"]) { await send(textMessage(text)); order.push(text); } }),
      sender.send(group, textMessage("b1")).then(() => order.push("b1")),
    ]);
    expect(fake.sent.map(item => (item.content as { content: string }).content)).toEqual(["a1", "a2", "b1"]);
  });

  test("a cancelled send waiting in the queue is reported as not sent", async () => {
    const sender = new MessageSender(client(), { perTarget: 1, global: 100, windowMs: 1000 });
    await sender.send(direct, textMessage("first"));
    const controller = new AbortController();
    const pending = sender.send(direct, textMessage("second"), { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: "failed", reason: "发送前已取消" });
    expect(fake.sent.length).toBe(1);
  });
});

describe("files", () => {
  test("uploads in 5 MiB parts and the result downloads byte for byte", async () => {
    const fixture = await tempFixture("open-platform-");
    try {
      const path = join(fixture.root, "big.bin");
      const bytes = new Uint8Array(6 * 1024 * 1024 + 123).map((_, i) => i % 251);
      await writeFile(path, bytes);
      const api = client();
      const fileId = await uploadFile(api, { path, fileName: "big.bin", size: bytes.byteLength, mimeType: "application/octet-stream" });
      const [state] = [...fake.uploads.values()];
      expect(state!.parts.size).toBe(2);
      expect(state!.completed).toBe(true);
      const target = join(fixture.root, "copy.part");
      const result = await downloadFile(api, fileId, target);
      expect(result.size).toBe(bytes.byteLength);
      expect(Buffer.compare(await readFile(target), Buffer.from(bytes))).toBe(0);
      const complete = fake.requests.find(request => request.path.endsWith("/complete"))!;
      expect((complete.body as { fileHash: string }).fileHash).toBe(createHash("md5").update(bytes).digest("hex"));
    } finally { await fixture.cleanup(); }
  });

  test("a retried part is hashed once: the completed MD5 matches the bytes actually uploaded", async () => {
    const fixture = await tempFixture("open-platform-");
    try {
      const path = join(fixture.root, "retry.bin");
      const bytes = new Uint8Array(5 * 1024 * 1024 + 10).map((_, i) => (i * 7) % 256);
      await writeFile(path, bytes);
      fake.putFailures = 1;
      const fileId = await uploadFile(client(), { path, fileName: "retry.bin", size: bytes.byteLength, mimeType: "application/octet-stream" });
      expect(fake.requests.filter(request => request.method === "PUT").length).toBe(3);
      expect(Buffer.compare(Buffer.from(fake.files.get(fileId)!), Buffer.from(bytes))).toBe(0);
    } finally { await fixture.cleanup(); }
  });

  test("aborts the upload when a part or the storage host fails", async () => {
    const fixture = await tempFixture("open-platform-");
    try {
      const path = join(fixture.root, "small.txt");
      await writeFile(path, "hello");
      const api = client();
      const initRoute = "POST /open-apis/v1/files/upload/init";
      fake.route(initRoute, () => json({ code: 0, success: true, data: { uploadId: "up-1", chunkSize: 5 * 1024 * 1024,
        parts: [{ partNumber: 1, uploadUrl: `${fake.origin}/storage/upload/up-1/1` }] } }));
      fake.route("PUT /storage/upload/up-1/1", () => new Response("denied", { status: 403 }));
      await expect(uploadFile(api, { path, fileName: "small.txt", size: 5, mimeType: "text/plain" })).rejects.toThrow("HTTP 403");
      expect(fake.requests.some(request => request.method === "DELETE" && request.path === "/open-apis/v1/files/upload/up-1")).toBe(true);
      fake.route(initRoute, () => json({ code: 0, success: true, data: { uploadId: "up-2", chunkSize: 5 * 1024 * 1024,
        parts: [{ partNumber: 1, uploadUrl: "https://attacker.example/upload" }] } }));
      await expect(uploadFile(api, { path, fileName: "small.txt", size: 5, mimeType: "text/plain" })).rejects.toThrow("不在平台对象存储");
      expect(fake.requests.some(request => request.method === "DELETE" && request.path === "/open-apis/v1/files/upload/up-2")).toBe(true);
    } finally { await fixture.cleanup(); }
  });

  test("downloads have no size limit, a stalled body fails without a partial file, storage must be the platform's", async () => {
    const fixture = await tempFixture("open-platform-");
    try {
      const api = client({ retryDelaysMs: [] });
      const target = join(fixture.root, "a.part");
      // The declared size is not a limit (the event and the download info may both understate it).
      fake.route("GET /open-apis/v1/files/liar/download", () => json({ code: 0, success: true, data: { fileName: "x", fileSize: 10,
        fileUrl: `${fake.origin}/storage/files/liar` } }));
      let sent = 0;
      fake.route("GET /storage/files/liar", () => new Response(new ReadableStream({
        pull(controller) { if (sent++ < 5) controller.enqueue(new Uint8Array(400)); else controller.close(); },
      })));
      expect((await downloadFile(api, "liar", target)).size).toBe(2000);
      fake.route("GET /open-apis/v1/files/stuck/download", () => json({ code: 0, success: true, data: { fileName: "x", fileUrl: `${fake.origin}/storage/files/stuck` } }));
      fake.route("GET /storage/files/stuck", () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(10)); },
      })));
      await expect(downloadFile(api, "stuck", target, { stallMs: 200 })).rejects.toThrow("没有收到数据");
      expect(await stat(target).catch(() => undefined)).toBeUndefined();
      fake.route("GET /open-apis/v1/files/far/download", () => json({ code: 0, success: true, data: { fileSize: 1, fileUrl: "https://elsewhere.example/f" } }));
      await expect(downloadFile(api, "far", target)).rejects.toThrow("不在平台对象存储");
    } finally { await fixture.cleanup(); }
  });

  test("partial reads and writes move every byte; a write error leaves no file and no result", async () => {
    const fixture = await tempFixture("open-platform-");
    const target = join(fixture.root, "a.part"), source = join(fixture.root, "upload.bin");
    const content = Buffer.from(Array.from({ length: 6 * 1024 * 1024 + 17 }, (_, i) => (i * 31) % 251));
    await writeFile(source, content);
    let failWrite = false, writes = 0;
    const realOpen = fs.open;
    // Each read or write moves at most half of what it was asked for (at least one byte), as the OS may.
    const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const write = handle.write.bind(handle) as (buffer: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>;
      const read = handle.read.bind(handle) as (buffer: Uint8Array, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;
      if (String(args[0]) === target) handle.write = (async (buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset) => {
        // The second write of a failing download hits an I/O error after part of the file was stored.
        if (failWrite && ++writes > 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return write(buffer, offset, Math.max(1, Math.floor(length / 2)));
      }) as typeof handle.write;
      if (String(args[0]) === source) handle.read = (async (buffer: Uint8Array, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.max(1, Math.floor(length / 2)), position)) as typeof handle.read;
      return handle;
    });
    try {
      const api = client({ retryDelaysMs: [] });
      fake.files.set("whole", Buffer.from("0123456789abcdef"));
      const result = await downloadFile(api, "whole", target);
      expect(await readFile(target)).toEqual(Buffer.from("0123456789abcdef"));
      expect(result.size).toBe(16);
      expect(result.sha256).toBe(createHash("sha256").update("0123456789abcdef").digest("hex"));
      failWrite = true;
      await expect(downloadFile(api, "whole", target)).rejects.toThrow("disk full");
      expect(await stat(target).catch(() => undefined)).toBeUndefined();
      const fileKey = await uploadFile(api, { path: source, fileName: "upload.bin", size: content.length, mimeType: "application/octet-stream" });
      // The fake refuses a fileHash that is not the MD5 of the stored parts.
      expect(Buffer.from(fake.files.get(fileKey)!)).toEqual(content);
    } finally { opening.mockRestore(); await fixture.cleanup(); }
  });

  test("retries a download whose storage fetch failed transiently", async () => {
    const fixture = await tempFixture("open-platform-");
    try {
      fake.files.set("f", new TextEncoder().encode("content"));
      let calls = 0;
      fake.route("GET /storage/files/f", () => ++calls === 1 ? new Response("busy", { status: 503 }) : new Response("content"));
      const result = await downloadFile(client(), "f", join(fixture.root, "f.part"));
      expect(result.size).toBe(7);
      expect(calls).toBe(2);
    } finally { await fixture.cleanup(); }
  });
});

describe("directory", () => {
  test("decryptV2 round-trips and pages are decoded with AppID signatures", async () => {
    expect(decryptV2("s", "1", "n", encryptV2("s", "1", "n", "明文"))).toBe("明文");
    fake.directory = { children: { "1": ["2", "3"] }, members: { "2": [{ phone: "13800000001", name: "甲" }] }, ids: { "13800000001": "im-1" } };
    const directory = new DirectoryClient(client());
    expect(await directory.departments("1", 1)).toEqual({ items: ["2", "3"], totalPages: 1 });
    expect(await directory.members("2", 1)).toEqual({ items: [{ phone: "13800000001", name: "甲" }], totalPages: 1 });
    expect(await directory.detailByPhone("13800000001")).toEqual({ imUserId: "im-1", phone: "13800000001", name: "name-13800000001" });
    expect(fake.addressTokenCount).toBe(1);
    expect(fake.requestsTo("/seal/oauth2/token")[0]!.body).toMatchObject({ scope: "address" });
    await expect(directory.detailByPhone("13900000000")).rejects.toThrow("code=400001");
  });

  test("rejects a response whose signature does not match", async () => {
    fake.route("POST /open/v2/dept/children", () => {
      const response = { code: 0, success: true, data: { encrypt: encryptV2(fake.config.appSecret, "1", "n", "{}"), sign: "00", timeStamp: "1", nonce: "n" } };
      return json(response);
    });
    await expect(new DirectoryClient(client()).departments("1", 1)).rejects.toThrow("验签失败");
  });
});

describe("image header", () => {
  test("reads PNG, GIF and JPEG dimensions", () => {
    const png = (() => {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(640, 0); header.writeUInt32BE(480, 4); header[8] = 8; header[9] = 6;
      const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.alloc(4, 0).fill(0), Buffer.from(type), data, Buffer.alloc(4)]);
      const ihdr = chunk("IHDR", header); ihdr.writeUInt32BE(13, 0);
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, chunk("IDAT", deflateSync(Buffer.alloc(1)))]);
    })();
    expect(parseImageHeader(png)).toEqual({ width: 640, height: 480, format: "png" });
    const gif = Buffer.from("GIF89a\x20\x00\x10\x00", "latin1");
    expect(parseImageHeader(gif)).toEqual({ width: 32, height: 16, format: "gif" });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0]);
    expect(parseImageHeader(jpeg)).toEqual({ width: 600, height: 300, format: "jpg" });
    expect(parseImageHeader(Buffer.from("not an image"))).toBeUndefined();
  });
});
