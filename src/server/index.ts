// 入口：Hono app + Bun.serve + /webhook 路由 + lifespan。
// 公网鉴权：data/webhook-secret 存在时启用 /webhook/:secret（恒定时长比对，不匹配 404）；
// 缺失或无效时默认拒绝启动；仅显式设置 ALLOW_INSECURE_WEBHOOK=1 才开放开发端点。AI 配置见 data/models.json。
import { Hono, type Context } from "hono";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { log } from "../core/log.ts";
import {
  ALLOW_INSECURE_WEBHOOK,
  HOST,
  MAX_WEBHOOK_BODY_BYTES,
  PORT,
  RATE_LIMIT_CLEANUP_INTERVAL,
  WEBHOOK_SECRET_FILE,
} from "../core/config.ts";
import { getClientIp, HttpError } from "./http.ts";
import {
  cleanupRateLimits,
  enqueueUserRequest,
  isDuplicate,
  isRateLimited,
  validateWebhookData,
} from "./webhook.ts";
import { cleanupIdleSessions, disposeAllSessions } from "../agent/runtime.ts";

const app = new Hono();

/** 读取 webhook 随机密钥；文件不存在/格式无效返回 null，由启动逻辑决定是否拒绝。 */
function readWebhookSecret(): string | null {
  try {
    const raw = readFileSync(WEBHOOK_SECRET_FILE, "utf8").trim();
    return /^[0-9a-f]{32,64}$/i.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 恒定时长字符串比较（密钥比对，避免逐字节定时侧信道）。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // 抹平耗时，仍返回 false
    return false;
  }
  return timingSafeEqual(ab, bb);
}

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
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, `请求体过大（上限 ${MAX_WEBHOOK_BODY_BYTES} 字节）`);
    }
    chunks.push(value);
  }

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
  // Content-Type 宽松校验：声明了类型则须含 json（挡表单/异常类型）
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("json")) {
    throw new HttpError(415, "Content-Type 必须是 application/json");
  }

  const clientIp = getClientIp(c);
  const data = await readJsonBody(c);
  const { phone, groupId, content, callbackUrl } = validateWebhookData(data);

  log.info(
    `收到请求 - IP: ${clientIp}, 用户: ${phone}, 群组: ${groupId}, 内容长度: ${content.length}`
  );

  if (isRateLimited(phone)) {
    log.warn(`速率限制触发 - 用户: ${phone}`);
    throw new HttpError(429, "请求过于频繁，请稍后再试");
  }
  if (isDuplicate(phone, groupId, content)) {
    log.info(`跳过重复请求 - 用户: ${phone}`);
    return c.json({ status: "success" });
  }

  // ack 200，后台异步处理；同一会话忙碌时由 agent 层 steer/指令路由协调。
  enqueueUserRequest(content, phone, groupId, callbackUrl, clientIp);
  return c.json({ status: "success" });
};

// ---- webhook 路由：有密钥走随机路径鉴权；无密钥仅显式开发模式可开放 ----
const webhookSecret = readWebhookSecret();
if (webhookSecret) {
  log.info("Webhook 已启用随机密钥路径鉴权（/webhook/<secret>）");
  app.post("/webhook/:secret", async (c) => {
    const got = c.req.param("secret");
    if (!got || !safeEqual(got, webhookSecret)) {
      return c.json({ status: "error", message: "Not Found" }, 404);
    }
    return webhookHandler(c);
  });
  // 无密钥路径直接 404，强制走密钥路径
  app.post("/webhook", (c) => c.json({ status: "error", message: "Not Found" }, 404));
} else {
  if (!ALLOW_INSECURE_WEBHOOK) {
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

const rateLimitTimer = setInterval(() => {
  try {
    cleanupRateLimits();
  } catch (e) {
    log.error(`速率限制清理出错: ${String(e)}`);
  }
  void cleanupIdleSessions().catch((e) =>
    log.error(`空闲会话清理出错: ${String(e)}`)
  );
}, RATE_LIMIT_CLEANUP_INTERVAL);

const server = Bun.serve({ hostname: HOST, port: PORT, fetch: app.fetch });
log.info(`服务启动完成，监听地址: ${HOST}:${PORT}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(rateLimitTimer);
  server.stop();
  await disposeAllSessions();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
