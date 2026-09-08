// Own the service lease, SDK startup and the single bounded shutdown sequence.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { application } from "../core/lifecycle.ts";
import { acquireLease, archiveFile } from "../core/maintenance.ts";
import { ALLOW_INSECURE_WEBHOOK, HOST, PORT, RATE_LIMIT_CLEANUP_INTERVAL, SHUTDOWN_TIMEOUT_MS } from "../core/config.ts";
import { STATE_DIR, WEBHOOK_SECRET_FILE } from "../core/storage.ts";
import { log } from "../core/log.ts";
import { cleanupCallbackRoutes } from "../integrations/callback-route.ts";
import { initializeRelay, sweepExpiredRelayObjects } from "../integrations/relay.ts";
import { cleanupRateLimits, drainUserRequests } from "./webhook.ts";
import { cleanupIdleSessions, disposeAllSessions, initializeAgentRuntime } from "../agent/runtime.ts";

let stopping = false;
let server: ReturnType<typeof Bun.serve> | undefined;
let releaseLease: (() => Promise<void>) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let maintenance: Promise<unknown> | undefined;
const instanceFile = join(STATE_DIR, "instance.json");
const adminToken = randomBytes(32).toString("hex");

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  application.abort();
  // Includes filesystem/lease cleanup; none of the awaited operations may extend this deadline.
  const force = setTimeout(() => {
    log.error("关机超过总期限，强制退出；进程监督器将回收工具后代");
    void server?.stop(true);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    const results = await Promise.allSettled([
      server?.stop(), disposeAllSessions(), drainUserRequests(), application.drain(),
    ]);
    if (results.some((result) => result.status === "rejected")) code = 1;
    if (releaseLease) {
      await archiveFile(instanceFile);
      await releaseLease();
    }
  } catch (error) {
    log.error("关机清理失败: " + String(error));
    code = 1;
  }
  clearTimeout(force);
  log.info("收到 " + reason + "，服务关闭完成");
  process.exit(code);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  releaseLease = await application.track(acquireLease("service"));
  application.signal.throwIfAborted();
  let webhookSecret: string | null = null;
  try {
    const raw = readFileSync(WEBHOOK_SECRET_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) webhookSecret = raw;
  } catch {}
  const app = createApp({ signal: application.signal, webhookSecret, allowInsecure: ALLOW_INSECURE_WEBHOOK,
    isStopping: () => stopping, adminToken, shutdown: () => void shutdown("local control") });
  await initializeAgentRuntime();
  application.signal.throwIfAborted();
  initializeRelay();
  server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 15, fetch: app.fetch });
  await application.track(writeFile(instanceFile, JSON.stringify({ pid: process.pid, port: server.port, token: adminToken,
    host: HOST, cwd: process.cwd(), startedAt: Date.now() - process.uptime() * 1000 }), { mode: 0o600 }));
  application.signal.throwIfAborted();
  const maintain = () => {
    if (maintenance || stopping) return;
    cleanupRateLimits();
    cleanupCallbackRoutes();
    maintenance = application.track(Promise.allSettled([cleanupIdleSessions(), sweepExpiredRelayObjects()]));
    void maintenance.then((results) => {
      for (const result of results as PromiseSettledResult<unknown>[]) {
        if (result.status === "rejected") log.error("后台维护失败: " + String(result.reason));
      }
    }).finally(() => { maintenance = undefined; });
  };
  timer = setInterval(() => { try { maintain(); } catch (error) { log.error(String(error)); } }, RATE_LIMIT_CLEANUP_INTERVAL);
  maintain();
  log.info("服务启动完成，监听地址: " + HOST + ":" + PORT);
} catch (error) {
  log.error("服务启动失败: " + String(error));
  await shutdown("startup failure", 1);
}
