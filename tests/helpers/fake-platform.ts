// 本地假开放平台：HTTP OpenAPI、对象存储和 Stream WebSocket。只供测试，不连接真实平台。
import type { ServerWebSocket } from "bun";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppBotConfig, PlatformEndpoints } from "../../src/integrations/open-platform/config.ts";
import { signV2 } from "../../src/integrations/open-platform/directory.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export type Handler = (request: Request, body: unknown, url: URL) => Response | Promise<Response>;

export interface FakeDirectory {
  /** 部门 ID → 子部门 ID。 */
  readonly children: Record<string, string[]>;
  /** 部门 ID → 成员。 */
  readonly members: Record<string, { phone: string; name: string }[]>;
  /** 手机号 → imUserId。 */
  readonly ids: Record<string, string>;
  /** 部门 ID → 名称、人数、完整路径；部门详情只认这里列出的部门（其余返回 404002）。 */
  readonly info?: Record<string, { name: string; count?: number; fullName?: string }>;
}

/** 平台的 decryptV2 逆运算（按文档独立实现）：AES-256-CBC，密钥 sha256(base64(sha512(appSecret)):timeStamp:nonce)，IV 在前。 */
export function encryptV2(appSecret: string, timeStamp: string, nonce: string, plain: string): string {
  const secret = createHash("sha512").update(appSecret, "utf8").digest("base64");
  const key = createHash("sha256").update(`${secret}:${timeStamp}:${nonce}`, "utf8").digest(), iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64url");
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

export interface FakePlatformOptions {
  /** Listen address (default 127.0.0.1). */
  readonly hostname?: string;
  /** Host in the addresses handed out (API, Stream, storage); default the listen address. */
  readonly advertise?: string;
  readonly config?: AppBotConfig;
}

export class FakePlatform {
  readonly config: AppBotConfig;
  readonly requests: RecordedRequest[] = [];
  readonly sockets = new Set<ServerWebSocket<unknown>>();
  readonly frames: unknown[] = [];
  readonly sent: { body: Record<string, unknown>; content: unknown }[] = [];
  readonly files = new Map<string, Uint8Array>();
  /** Download metadata per file id (default sample.txt / .txt). */
  readonly fileInfo = new Map<string, { fileName: string; mimeType: string }>();
  readonly uploads = new Map<string, { parts: Map<number, Uint8Array>; aborted: boolean; completed: boolean }>();
  readonly tokens = new Set<string>();
  tokenCount = 0;
  addressTokenCount = 0;
  tokenExpiresIn = 7200;
  /** 接下来这么多次分片上传返回 503（字节不保存）。 */
  putFailures = 0;
  /** 拒绝 Stream 握手（模拟鉴权失败）。 */
  rejectStream = false;
  directory: FakeDirectory = { children: {}, members: {}, ids: {} };
  readonly #routes = new Map<string, Handler>();
  readonly server: ReturnType<typeof Bun.serve>;
  readonly #host: string;

  constructor(options: FakePlatformOptions = {}) {
    this.config = options.config ?? { environment: "production", appId: "fake-app-id", appSecret: "fake-app-secret-value" };
    this.#host = options.advertise ?? options.hostname ?? "127.0.0.1";
    this.server = Bun.serve({
      hostname: options.hostname ?? "127.0.0.1",
      port: 0,
      fetch: (request, server) => this.#fetch(request, server),
      websocket: {
        open: socket => { this.sockets.add(socket); },
        message: (_socket, message) => { this.frames.push(JSON.parse(String(message))); },
        close: socket => { this.sockets.delete(socket); },
      },
    });
  }

  get origin(): string { return `http://${this.#host}:${this.server.port}`; }

  get endpoints(): PlatformEndpoints {
    const origin = this.origin;
    return {
      api: origin,
      stream: `ws://${this.#host}:${this.server.port}/open-apis/v1/events/stream`,
      storage: url => url.origin === origin && url.pathname.startsWith("/storage/"),
    };
  }

  /** 覆盖某个接口；key 形如 `POST /open-apis/v1/messages/v1/send`。 */
  route(key: string, handler: Handler | undefined): void {
    if (handler) this.#routes.set(key, handler);
    else this.#routes.delete(key);
  }

  /** 推送一条事件帧到所有已连接的 Stream。 */
  push(event: Record<string, unknown>, timestamp = Date.now(), signature = ""): void {
    const frame = JSON.stringify({ "X-CTQ-Nonce": randomUUID(), "X-CTQ-Signature": signature, "X-CTQ-Timestamp": String(timestamp), data: JSON.stringify(event) });
    for (const socket of this.sockets) socket.send(frame);
  }

  dropSockets(code = 1011): void {
    for (const socket of this.sockets) socket.close(code, "fake drop");
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter(request => request.path === path);
  }

  encrypted(plain: unknown): Response {
    const timeStamp = String(Date.now()), nonce = randomUUID();
    const encrypt = encryptV2(this.config.appSecret, timeStamp, nonce, JSON.stringify(plain));
    return json({ code: 0, success: true, data: { encrypt, sign: signV2(this.config.appId, timeStamp, nonce, encrypt), timeStamp, nonce } });
  }

  stop(): void {
    for (const socket of this.sockets) socket.close(1001, "stop");
    this.server.stop(true);
  }

  async #fetch(request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }): Promise<Response | undefined> {
    const url = new URL(request.url);
    const raw = request.method === "PUT" ? new Uint8Array(await request.arrayBuffer()) : await request.text();
    let body: unknown = raw;
    if (typeof raw === "string" && raw) {
      const type = request.headers.get("content-type") ?? "";
      if (type.includes("json")) body = JSON.parse(raw);
      else if (type.includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
    }
    this.requests.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    const custom = this.#routes.get(`${request.method} ${url.pathname}`);
    if (custom) return custom(request, body, url);
    if (url.pathname === "/open-apis/v1/events/stream") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (this.rejectStream || !this.tokens.has(token)) return new Response("unauthorized", { status: 401 });
      return server.upgrade(request, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const authorized = () => this.tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    switch (`${request.method} ${url.pathname}`) {
      case "POST /open-apis/v1/auth/token": {
        const form = body as Record<string, string>;
        if (form.client_id !== this.config.appId || form.client_secret !== this.config.appSecret) return json({ error: "invalid_client" }, 401);
        const token = `app-${++this.tokenCount}`;
        this.tokens.add(token);
        return json({ access_token: token, expires_in: this.tokenExpiresIn, token_type: "Bearer" });
      }
      case "POST /seal/oauth2/token": {
        const token = `address-${++this.addressTokenCount}`;
        this.tokens.add(token);
        return json({ access_token: token, expires_in: this.tokenExpiresIn, scope: (body as Record<string, string>).scope });
      }
    }
    if (!url.pathname.startsWith("/storage/") && !authorized()) return json({ code: 401, message: "unauthorized" }, 401);
    const upload = /^\/open-apis\/v1\/files\/upload\/([^/]+)(\/complete)?$/.exec(url.pathname);
    const storageUpload = /^\/storage\/upload\/([^/]+)\/(\d+)$/.exec(url.pathname);
    const download = /^\/open-apis\/v1\/files\/([^/]+)\/download$/.exec(url.pathname);
    const storageFile = /^\/storage\/files\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && url.pathname === "/open-apis/v1/messages/v1/send") {
      const record = body as Record<string, unknown>;
      this.sent.push({ body: record, content: JSON.parse(String(record.content)) });
      return json({ success: true, code: 200 });
    }
    if (request.method === "POST" && url.pathname === "/open-apis/v1/files/upload/init") {
      const { fileSize, chunkSize } = body as { fileSize: number; chunkSize: number };
      const id = randomUUID();
      this.uploads.set(id, { parts: new Map(), aborted: false, completed: false });
      const parts = Array.from({ length: Math.max(1, Math.ceil(fileSize / chunkSize)) }, (_, index) =>
        ({ partNumber: index + 1, uploadUrl: `${this.origin}/storage/upload/${id}/${index + 1}` }));
      return json({ code: 0, success: true, data: { uploadId: id, chunkSize, parts, expiresIn: 3600 } });
    }
    if (storageUpload && request.method === "PUT") {
      const state = this.uploads.get(storageUpload[1]!);
      if (!state) return new Response("no upload", { status: 404 });
      if (this.putFailures > 0) { this.putFailures--; return new Response("busy", { status: 503 }); }
      state.parts.set(Number(storageUpload[2]), raw as Uint8Array);
      return new Response(null, { status: 200, headers: { ETag: `"etag-${storageUpload[2]}"` } });
    }
    if (upload?.[2] && request.method === "POST") {
      const state = this.uploads.get(upload[1]!);
      if (!state) return json({ code: 404 }, 404);
      const parts = [...state.parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes);
      // The platform accepts a missing hash, but clients then fail to verify the download: the fake refuses it outright.
      const content = Buffer.concat(parts);
      if ((body as { fileHash?: unknown }).fileHash !== createHash("md5").update(content).digest("hex")) return json({ code: 400, message: "fileHash is not the MD5 of the parts" }, 400);
      const fileKey = `file-${randomUUID()}`;
      this.files.set(fileKey, content);
      state.completed = true;
      return json({ code: 0, success: true, data: { fileKey } });
    }
    if (upload && !upload[2] && request.method === "DELETE") {
      const state = this.uploads.get(upload[1]!);
      if (state) state.aborted = true;
      return json({ code: 0, success: true });
    }
    if (download && request.method === "GET") {
      const bytes = this.files.get(decodeURIComponent(download[1]!));
      if (!bytes) return json({ code: 404, success: false }, 404);
      const info = this.fileInfo.get(decodeURIComponent(download[1]!)) ?? { fileName: "sample.txt", mimeType: ".txt" };
      return json({ code: 0, success: true, data: { ...info, fileSize: bytes.byteLength, expiresIn: 3600,
        fileUrl: `${this.origin}/storage/files/${download[1]}` } });
    }
    if (storageFile && request.method === "GET") {
      const bytes = this.files.get(decodeURIComponent(storageFile[1]!));
      return bytes ? new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }) : new Response("missing", { status: 404 });
    }
    if (request.method === "POST" && url.pathname === "/open/v2/dept/children") {
      const { dept_id, page_num, page_size } = body as { dept_id: string; page_num: number; page_size: number };
      const all = this.directory.children[dept_id] ?? [];
      return this.encrypted({ departments: all.slice((page_num - 1) * page_size, page_num * page_size).map(id => {
        const info = this.directory.info?.[id];
        return { dept_id: id, ...(info ? { name: info.name, ...(info.count === undefined ? { hide_count: 1 } : { count: info.count, hide_count: 0 }) } : {}) };
      }), total_pages: Math.ceil(all.length / page_size) });
    }
    if (request.method === "POST" && url.pathname === "/open/v2/dept/get") {
      const id = (body as { dept_id: string }).dept_id, info = this.directory.info?.[id];
      if (!info) return json({ code: 404002, msg: "部门不存在" });
      return this.encrypted({ dept_id: id, name: info.name, full_name: info.fullName ?? info.name, count: info.count ?? 0, hide_count: info.count === undefined ? 1 : 0 });
    }
    if (request.method === "POST" && url.pathname === "/open/v2/dept/users/list") {
      const { dept_id, page_num, page_size } = body as { dept_id: string; page_num: number; page_size: number };
      const all = this.directory.members[dept_id] ?? [];
      return this.encrypted({ users: all.slice((page_num - 1) * page_size, page_num * page_size)
        .map(user => ({ ...user, union_id: "u", customer_id: "", extension: "" })), total_pages: Math.ceil(all.length / page_size) });
    }
    if (request.method === "POST" && url.pathname === "/open/applied/v1/user/detailByPhone") {
      const phone = (body as { loginId: string }).loginId;
      const id = this.directory.ids[phone];
      if (!id) return json({ code: 400001, success: false, msg: "用户不存在" });
      return this.encrypted({ userId: `u-${id}`, imUserId: id, userName: `name-${phone}`, loginId: phone, phone });
    }
    return json({ code: 404, message: "not found" }, 404);
  }
}
