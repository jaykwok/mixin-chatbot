// 入口：Hono app + Bun.serve + 路由 + lifespan。对应 Python app.py。
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";
import { DEFAULT_GROUP_CONFIG, RATE_LIMIT_CLEANUP_INTERVAL } from "./config.ts";
import { authorizeWebhook, getClientIp, HttpError, requireAdminAuth } from "./auth.ts";
import {
  cleanupRateLimits,
  enqueueUserRequest,
  isDuplicate,
  isRateLimited,
  validateWebhookData,
} from "./webhook.ts";
import { disposeAllSessions } from "./pi.ts";

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

  authorizeWebhook(data, clientIp);
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

app.get("/admin", requireAdminAuth, async (c) => {
  const html = await readFile(join("static", "admin.html"));
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

app.get("/admin/api", requireAdminAuth, async (c) => {
  // 扫描 data/sessions/*.jsonl 列出会话（Pi SessionManager 持久化于此）
  const now = Date.now();
  const sessions: Record<string, Record<string, unknown>> = {};
  try {
    const dir = join("data", "sessions");
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const phone = f.slice(0, -6); // 去掉 .jsonl
      const st = await stat(join(dir, f));
      sessions[phone] = {
        message_count: 0,
        group_id: "",
        model: DEFAULT_GROUP_CONFIG.model,
        last_active: new Date(st.mtimeMs).toLocaleString("zh-CN", { hour12: false }),
        active_duration: Math.floor((now - st.mtimeMs) / 1000),
        recent_messages: [],
      };
    }
  } catch {
    // data/sessions 不存在（尚无会话）
  }
  return c.json({
    status: "success",
    active_sessions: Object.keys(sessions).length,
    sessions,
    default_model: DEFAULT_GROUP_CONFIG.model,
    current_time: new Date().toLocaleString("zh-CN", { hour12: false }),
  });
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

const PORT = Number(process.env.PORT ?? "1011");
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
