// 入口：Hono app + Bun.serve + /webhook 路由 + lifespan。
// 公网鉴权：data/webhook-secret 存在时启用 /webhook/:secret（恒定时长比对，不匹配 404）；
// 不存在则回退开放 /webhook（仅内网/本地）。AI 配置见 data/models.json。
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { log } from "../lib/log.ts";
import { PORT, RATE_LIMIT_CLEANUP_INTERVAL, WEBHOOK_SECRET_FILE } from "../lib/config.ts";
import { getClientIp, HttpError } from "./http.ts";
import {
  cleanupRateLimits,
  enqueueUserRequest,
  isDuplicate,
  isRateLimited,
  validateWebhookData,
} from "./webhook.ts";
import { disposeAllSessions } from "../agent/agent.ts";

const app = new Hono();

// 静态文件（static/ 下）
app.use("/static/*", serveStatic({ root: "./static" }));

/** 读取 webhook 随机密钥；文件不存在/格式无效 → null（回退开放 /webhook，仅内网/本地）。 */
function readWebhookSecret(): string | null {
  try {
    const raw = readFileSync(WEBHOOK_SECRET_FILE, "utf8").trim();
    return /^[0-9a-f]{32,64}$/.test(raw) ? raw : null;
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

/** webhook 业务处理：解析 + 校验 + 去重 + 限流 + 后台异步。 */
const webhookHandler = async (c: Context) => {
  // Content-Type 宽松校验：声明了类型则须含 json（挡表单/异常类型）
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  if (ct && !ct.includes("json")) {
    throw new HttpError(415, "Content-Type 必须是 application/json");
  }

  const clientIp = getClientIp(c);
  let data: Record<string, unknown>;
  try {
    data = await c.req.json();
  } catch {
    throw new HttpError(400, "请求必须是JSON格式");
  }

  const { phone, groupId, content, callbackUrl } = validateWebhookData(
    data as Record<string, unknown>
  );

  log.info(
    `收到请求 - IP: ${clientIp}, 用户: ${phone}, 群组: ${groupId}, 内容长度: ${content.length}`
  );

  if (isDuplicate(phone, content)) {
    log.info(`跳过重复请求 - 用户: ${phone}`);
    return c.json({ status: "success" });
  }
  if (isRateLimited(phone)) {
    log.warn(`速率限制触发 - 用户: ${phone}`);
    throw new HttpError(429, "请求过于频繁，请稍后再试");
  }

  // ack 200，后台异步处理（per-phone 串行）
  enqueueUserRequest(content, phone, groupId, callbackUrl, clientIp);
  return c.json({ status: "success" });
};

// ---- webhook 路由：有密钥走随机路径鉴权，无密钥回退开放（仅内网/本地）----
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
  // 旧开放路径直接 404，强制走密钥路径
  app.post("/webhook", (c) => c.json({ status: "error", message: "Not Found" }, 404));
} else {
  log.warn("未配置 webhook 密钥（data/webhook-secret）——回退开放 /webhook，仅限内网/本地！");
  app.post("/webhook", webhookHandler);
}

app.get("/favicon.svg", async (c) =>
  new Response(await readFile(join("static", "favicon.svg")), {
    headers: { "Content-Type": "image/svg+xml" },
  }));
app.get("/favicon.ico", async (c) =>
  new Response(await readFile(join("static", "favicon.svg")), {
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

log.info(`服务启动完成，监听端口: ${PORT}`);

const rateLimitTimer = setInterval(() => {
  try {
    cleanupRateLimits();
  } catch (e) {
    log.error(`速率限制清理出错: ${String(e)}`);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL);

const server = Bun.serve({ port: PORT, fetch: app.fetch });

async function shutdown() {
  clearInterval(rateLimitTimer);
  server.stop();
  await disposeAllSessions();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
