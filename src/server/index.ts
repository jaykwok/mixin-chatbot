// 入口：Hono app + Bun.serve + /webhook 路由 + lifespan。
// 无管理页面、无鉴权白名单（安全交防火墙）；AI 配置见 data/models.json。
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../lib/log.ts";
import { PORT, RATE_LIMIT_CLEANUP_INTERVAL } from "../lib/config.ts";
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

app.post("/webhook", async (c) => {
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
});

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
