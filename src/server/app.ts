import { Hono, type Context } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSlashCommandMessage } from "../agent/commands.ts";
import { waitFor } from "../core/lifecycle.ts";
import { MAX_WEBHOOK_BODY_BYTES } from "../core/config.ts";
import { WEBHOOK_SECRET_FILE } from "../core/storage.ts";
import { log } from "../core/log.ts";
import { observeCallbackRoute } from "../integrations/callback-route.ts";
import { constantTimeEqual, getClientIp, HttpError, isJsonContentType } from "./http.ts";
import { enqueueUserRequest, enqueueUserNotice, hasUserRequestCapacity, isDuplicate,
  isRateLimited, rememberRequest, validateWebhookData } from "./webhook.ts";

export interface AppOptions {
  signal: AbortSignal;
  webhookSecret: string | null;
  allowInsecure: boolean;
  isStopping: () => boolean;
  adminToken: string;
  shutdown: () => void;
}

/** HTTP construction is separate from SDK startup and OS signal ownership. */
export function createApp(options: AppOptions): Hono {
const app = new Hono();


/** 限量读取 JSON，避免在进入字段校验前接收无限大的请求体。 */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentLength = c.req.header("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isInteger(declared) || declared < 0) {
      throw new HttpError(400, "无效的 Content-Length");
    }
    if (declared > MAX_WEBHOOK_BODY_BYTES) {
      throw new HttpError(413, `请求体过大（上限 ${MAX_WEBHOOK_BODY_BYTES} 字节）`);
    }
  }

  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HttpError(400, "请求体不能为空");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10000)]);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
  while (true) {
    const { done, value } = await waitFor(reader.read(), signal);
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new HttpError(413, `请求体过大（上限 ${MAX_WEBHOOK_BODY_BYTES} 字节）`);
    }
    chunks.push(value);
  }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (signal.aborted) throw new HttpError(408, "请求体读取超时或服务关闭");
    throw error;
  } finally { reader.releaseLock(); }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "请求必须是有效的 UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "请求 JSON 必须是对象");
  }
  return parsed as Record<string, unknown>;
}

/** webhook 业务处理：解析 + 校验 + 去重 + 限流 + 后台异步。 */
const webhookHandler = async (c: Context) => {
  if (options.isStopping()) throw new HttpError(503, "服务正在关闭，请稍后重试");

  // 声明了 Content-Type 时只接受标准 JSON 或 +json 媒体类型。
  const ct = c.req.header("content-type") ?? "";
  if (ct && !isJsonContentType(ct)) {
    throw new HttpError(415, "Content-Type 必须是 application/json");
  }

  const clientIp = getClientIp(c);
  const data = await readJsonBody(c);
  const { phone, groupId, content, callbackUrl } = validateWebhookData(data);
  const callbackRoute = observeCallbackRoute(callbackUrl, groupId);

  log.info(
    `收到请求 - IP: ${clientIp}, 用户: ${phone}, 群组: ${groupId}, 回复key指纹: ${callbackRoute.fingerprint}, 内容长度: ${content.length}`
  );

  if (!callbackRoute.safe) {
    if (callbackRoute.reason === "capacity") {
      log.error(`callback 路由保护容量已满，拒绝未知 key ${callbackRoute.fingerprint}`);
      throw new HttpError(503, "回调路由保护暂时无法接收新的机器人 key");
    }
    log.error(
      `阻止跨群广播：回复 key ${callbackRoute.fingerprint} 同时对应多个群 (${callbackRoute.groups.join(", ")})；请为每个群重新创建独立的会话机器人`
    );
    throw new HttpError(
      409,
      "同一个机器人回复 key 被多个群共用；为防止消息串群，本次请求已停止"
    );
  }

  if (isSlashCommandMessage(content)) {
    if (options.isStopping()) throw new HttpError(503, "服务正在关闭");
    const accepted = enqueueUserRequest(content, phone, groupId, callbackUrl, clientIp);
    return c.json({ status: accepted ? "success" : "busy" }, accepted ? 200 : 503);
  }
  if (isDuplicate(phone, groupId, content)) {
    log.info(`跳过重复请求 - 用户: ${phone}`);
    return c.json({ status: "success" });
  }
  if (!hasUserRequestCapacity()) {
    log.warn(`后台请求容量已满 - 用户: ${phone}, 群: ${groupId}`);
    enqueueUserNotice(
      "capacity",
      "⚠️ 机器人现在比较忙，这条消息未加入队列，不会自动处理，请稍后重新发送。",
      phone,
      groupId,
      callbackUrl
    );
    return c.json({ status: "success" });
  }
  if (isRateLimited(phone, groupId)) {
    log.warn(`速率限制触发 - 用户: ${phone}, 群: ${groupId}`);
    enqueueUserNotice(
      "rate-limit",
      "⚠️ 短时间内收到的消息较多，这条消息未加入队列，不会自动处理，请稍后重新发送。",
      phone,
      groupId,
      callbackUrl
    );
    return c.json({ status: "success" });
  }
  // readJsonBody 等 await 期间可能收到关闭信号；不再接收无法被关机流程追踪的新任务。
  if (options.isStopping()) throw new HttpError(503, "服务正在关闭，请稍后重试");
  // ack 200，后台异步处理；同一会话由 agent 层 FIFO 和控制屏障协调。
  if (!enqueueUserRequest(content, phone, groupId, callbackUrl, clientIp)) {
    // 单线程内无 await，正常不会在容量预检后命中；仍按不可重投平台处理。
    enqueueUserNotice(
      "capacity",
      "⚠️ 机器人现在比较忙，这条消息未加入队列，不会自动处理，请稍后重新发送。",
      phone,
      groupId,
      callbackUrl
    );
    return c.json({ status: "success" });
  }
  rememberRequest(phone, groupId, content);
  return c.json({ status: "success" });
};

// ---- webhook 路由：有密钥走随机路径鉴权；无密钥仅显式开发模式可开放 ----
const webhookSecret = options.webhookSecret;
if (webhookSecret) {
  log.info("Webhook 已启用随机密钥路径鉴权（/webhook/<secret>）");
  app.post("/webhook/:secret", async (c) => {
    const got = c.req.param("secret");
    if (!got || !constantTimeEqual(got, webhookSecret)) {
      return c.json({ status: "error", message: "Not Found" }, 404);
    }
    return webhookHandler(c);
  });
  // 无密钥路径直接 404，强制走密钥路径
  app.post("/webhook", (c) => c.json({ status: "error", message: "Not Found" }, 404));
} else {
  if (!options.allowInsecure) {
    throw new Error(
      `${WEBHOOK_SECRET_FILE} 缺失或格式无效；生产默认拒绝无鉴权启动。本地调试可显式设置 ALLOW_INSECURE_WEBHOOK=1。`
    );
  }
  log.warn("ALLOW_INSECURE_WEBHOOK=1：开放 /webhook，仅限隔离的本地开发环境！");
  app.post("/webhook", webhookHandler);
}

app.get("/favicon.svg", async () =>
  new Response(await readFile(join("public", "favicon.svg")), {
    headers: { "Content-Type": "image/svg+xml" },
  }));
app.get("/favicon.ico", async () =>
  new Response(await readFile(join("public", "favicon.svg")), {
    headers: { "Content-Type": "image/svg+xml" },
  }));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return new Response(JSON.stringify({ status: "error", message: err.message }), {
      status: err.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  log.error(`未处理异常 - IP: ${getClientIp(c)}, 错误: ${String(err)}`);
  return c.json({ status: "error", message: "内部服务器错误" }, 500);
});
app.notFound((c) => c.json({ status: "error", message: "Not Found" }, 404));


app.get("/health", (c) => c.json({ status: options.isStopping() ? "stopping" : "ready", pid: process.pid }));
app.post("/_admin/shutdown", (c) => {
  if (!constantTimeEqual(c.req.header("Authorization") ?? "", "Bearer " + options.adminToken)) return c.notFound();
  setTimeout(options.shutdown, 0);
  return c.json({ status: "stopping" });
});
return app;
}
