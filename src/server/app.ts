// Own the service lease, the Durable message service (src/durable/service.ts) and the single bounded shutdown sequence.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { createApp } from "./http-app.ts";
import { application } from "../core/lifecycle.ts";
import { acquireGroupRootLease, acquireLease, archiveFile } from "../core/maintenance.ts";
import { ALLOW_INSECURE_WEBHOOK, GROUP_DATA_ROOT, HOST, MODEL_IDLE_TIMEOUT_MS, MODEL_RESPONSE_TIMEOUT_MS, PORT, RATE_LIMIT_CLEANUP_INTERVAL,
  RUN_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from "../core/config.ts";
import { RUNTIME_DIR, STATE_DIR, WEBHOOK_SECRET_FILE } from "../core/storage.ts";
import { log } from "../core/log.ts";
import { cleanupCallbackRoutes } from "../integrations/callback-route.ts";
import { abortOutboundRequests } from "../integrations/im.ts";
import { getRelayConfig, initializeRelay, sweepExpiredRelayObjects } from "../integrations/relay.ts";
import { bindMessageService, cleanupRateLimits, drainUserRequests } from "./webhook.ts";
import { loadModuleDefinitions } from "../agent/modules.ts";
import { sweepSessionStats } from "../agent/stats-ledger.ts";
import { runtimeSetting } from "../core/runtime-config.ts";
import { RUNTIME_DEFAULTS } from "../core/runtime-schema.ts";
import { openModelSelection } from "../durable/models.ts";
import { DurableService } from "../durable/service.ts";
import { readAuxiliaryConfig } from "../core/auxiliary-config.ts";
import { readMcpConfig } from "../core/mcp-config.ts";
import { McpTools } from "../integrations/mcp.ts";

import { assertDataVersion } from "../core/data-version.ts";
import { validateCurrentData } from "../core/data-validation.ts";

let stopping = false;
let server: ReturnType<typeof Bun.serve> | undefined;
let releaseLease: (() => Promise<void>) | undefined;
let releaseGroupLease: (() => Promise<void>) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let maintenance: Promise<unknown> | undefined;
let messages: DurableService | undefined;
let mcp: McpTools | undefined;
const instanceFile = join(STATE_DIR, "instance.json");
const adminToken = randomBytes(32).toString("hex");
const instanceId = randomUUID();
const startedAt = Date.now() - process.uptime() * 1000;

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  application.abort();
  // Sends waiting for the rate limit or in flight end now, so the service can close in time.
  abortOutboundRequests();
  // Includes filesystem/lease cleanup; none of the awaited operations may extend this deadline.
  const force = setTimeout(() => {
    log.error("关机超过总期限，强制退出；进程监督器将回收工具后代");
    void server?.stop(true);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    const results = await Promise.allSettled([
      server?.stop(), drainUserRequests(), messages?.close(), mcp?.close(), application.drain(),
    ]);
    if (results.some((result) => result.status === "rejected")) code = 1;
    await releaseGroupLease?.();
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
  // 租约丢失说明别的进程可能已经接管数据。普通关机会入账、归档，并等待任务、维护和扩展退出，这些都要写数据，
  // 所以这里不走关机，立即退出，此后本进程不再写入；工具进程的监督进程在管道断开时回收工具及其后代。
  const onLost = (error: Error) => {
    log.error("服务租约丢失，立即退出，不再写入数据: " + String(error));
    process.exit(1);
  };
  releaseLease = await application.track(acquireLease("service", undefined, { onLost }));
  releaseGroupLease = await application.track(acquireGroupRootLease("service", GROUP_DATA_ROOT, { onLost }));
  assertDataVersion(process.cwd(), GROUP_DATA_ROOT);
  await validateCurrentData(process.cwd(), GROUP_DATA_ROOT);
  application.signal.throwIfAborted();
  let webhookSecret: string | null = null;
  try {
    const raw = readFileSync(WEBHOOK_SECRET_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) webhookSecret = raw;
  } catch {}
  const app = createApp({ signal: application.signal, webhookSecret, allowInsecure: ALLOW_INSECURE_WEBHOOK,
    isStopping: () => stopping, adminToken, instanceId, startedAt, shutdown: () => void shutdown("local control") });
  // One model for the instance, checked before any message is accepted; the Pi model catalogue cache lives in data/runtime.
  await mkdir(RUNTIME_DIR, { recursive: true });
  const retention = runtimeSetting("PI_CACHE_RETENTION") as CacheRetention | undefined;
  const selection = await openModelSelection({ signal: application.signal, ...(retention ? { cacheRetention: retention } : {}) });
  for (const notice of selection.notices) log.warn(notice);
  // The task log extraction (scripts/ops/task-logs.*) reports the last line starting so before a task.
  log.info(`Pi ModelRuntime 就绪（provider=${selection.model.provider}, model=${selection.model.id}, api=${selection.model.api}, ` +
    `thinkingLevel=${selection.thinkingLevel}, 群数据总根=${GROUP_DATA_ROOT}）`);
  application.signal.throwIfAborted();
  // The relay configuration is read once here: the group registries shape send_file and the prompt by it.
  initializeRelay();
  const modules = await loadModuleDefinitions({
    documentWorkEnabled: (runtimeSetting("BOT_DOCUMENT_WORK_ENABLED") ?? RUNTIME_DEFAULTS.BOT_DOCUMENT_WORK_ENABLED) === "1" });
  const documentEnv = runtimeSetting("BOT_DOCUMENT_ENV");
  const mcpConfig = readMcpConfig();
  if (mcpConfig?.servers.length) { mcp = new McpTools(mcpConfig); await mcp.initialize(application.signal); }
  messages = new DurableService({
    root: GROUP_DATA_ROOT, selection, modules, relay: getRelayConfig(), ...(documentEnv ? { venvDir: resolve(documentEnv) } : {}),
    auxiliary: readAuxiliaryConfig(),
    mcp,
    limits: { runTimeoutMs: RUN_TIMEOUT_MS, modelIdleMs: MODEL_IDLE_TIMEOUT_MS, modelResponseMs: MODEL_RESPONSE_TIMEOUT_MS },
    onReport: (error) => log.error("消息服务后台错误: " + String(error)),
    onFatal: (error) => {
      log.error("群存储发生无法确认的提交失败，立即退出，等待监督器重启: " + String(error) + "; cause: " + String(error.cause));
      process.exit(1);
    },
    onLog: (line) => log.info(line),
  });
  // Groups with unfinished work open now: waiting controls run again and the members' workers resume their inboxes.
  const resumed = await messages.start();
  if (resumed.length) log.info(`恢复 ${resumed.length} 个群的未完成工作`);
  bindMessageService(messages);
  application.signal.throwIfAborted();
  server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 15, fetch: app.fetch });
  await application.track(writeFile(instanceFile, JSON.stringify({ pid: process.pid, port: server.port, token: adminToken,
    host: HOST, cwd: process.cwd(), instanceId, startedAt }), { mode: 0o600 }));
  application.signal.throwIfAborted();
  /**
   * 旧会话文件的入账：一天一次全量扫 AgentSession 引擎留下的会话文件。
   *
   * 数据版本 3 起对话在 Durable 群库里，用量由消息服务在每次回复后和维护时投影入账；
   * 原会话文件原地保留，这里只补它们尚未入账的尾部，所以没必要每轮维护都把所有文件摸一遍。
   */
  const sweepStats = async () => {
    const result = await sweepSessionStats(GROUP_DATA_ROOT, {
      onError: (path, error) => log.warn(`统计账本扫描失败 - 路径: ${path}, 错误: ${String(error)}`),
    });
    if (!result.skippedDay) {
      const detail = `${result.files} 份会话、${result.records} 条新记录，跳过当天已完成且未变化的 ${result.skippedFiles} 份`;
      if (result.failed) log.warn(`统计账本扫描未完成：${detail}，${result.failed} 项失败，下轮维护重试`);
      else log.info(`统计账本入账完成：${detail}`);
    }
  };
  const maintain = () => {
    if (maintenance || stopping) return;
    cleanupRateLimits();
    cleanupCallbackRoutes();
    maintenance = application.track(Promise.allSettled([messages!.maintain(), sweepExpiredRelayObjects(), sweepStats()]));
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
