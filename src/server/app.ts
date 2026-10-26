// Own the service lease, the app bot's event stream, the Durable message service (src/durable/service.ts) and the single
// bounded shutdown sequence.
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { createApp } from "./http-app.ts";
import { application } from "../core/lifecycle.ts";
import { acquireLease, archiveFile } from "../core/maintenance.ts";
import { HOST, LAYOUT, MODEL_IDLE_TIMEOUT_MS, MODEL_RESPONSE_TIMEOUT_MS, PORT, MAINTENANCE_INTERVAL_MS,
  RUN_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS, CLOSEOUT_MS, DELIVERY_RESERVE_MS, FALLBACK_SEND_MS } from "../core/config.ts";
import { APP_BOT_CONFIG_PATH, RUNTIME_DIR, STATE_DIR } from "../core/storage.ts";
import { log } from "../core/log.ts";
import { stateDatabase } from "../core/state.ts";
import { getRelayConfig, initializeRelay, sweepExpiredRelayObjects } from "../integrations/relay.ts";
import { PlatformClient } from "../integrations/open-platform/client.ts";
import { readAppBotConfig } from "../integrations/open-platform/config.ts";
import { DirectoryClient } from "../integrations/open-platform/directory.ts";
import { IdentityDirectory } from "../integrations/open-platform/identity-directory.ts";
import { readDirectoryScope, sameScope, writeDirectoryScope } from "../integrations/open-platform/directory-scope.ts";
import { MessageSender } from "../integrations/open-platform/messages.ts";
import { StreamConnection } from "../integrations/open-platform/stream.ts";
import { platformOutbound } from "../durable/outbound.ts";
import { downloadFile } from "../integrations/open-platform/files.ts";
import { InboundRouter } from "./inbound.ts";
import { loadModuleDefinitions } from "../agent/modules.ts";
import { runtimeSetting } from "../core/runtime-config.ts";
import { RUNTIME_DEFAULTS } from "../core/runtime-schema.ts";
import { openModelSelection } from "../durable/models.ts";
import { DurableService } from "../durable/service.ts";
import { codemodeWorkers } from "../durable/codemode/workers.ts";
import { readAuxiliaryConfig } from "../core/auxiliary-config.ts";
import { readMcpConfig } from "../core/mcp-config.ts";
import { McpTools } from "../integrations/mcp.ts";
import { configuredRootlessTasks } from "../core/task-backend.ts";

import { applicationBinding, assertDataVersion } from "../core/data-version.ts";
import { APP_BUILD, APP_VERSION, DATA_VERSION } from "../core/version.ts";
import { validateCurrentData } from "../core/data-validation.ts";

let stopping = false;
let server: ReturnType<typeof Bun.serve> | undefined;
let releaseLease: (() => Promise<void>) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let maintenance: Promise<unknown> | undefined;
let relayMaintenance: Promise<void> | undefined;
let messages: DurableService | undefined;
let mcp: McpTools | undefined;
let platform: PlatformClient | undefined;
let stream: StreamConnection | undefined;
let router: InboundRouter | undefined;
let dailyScan: ReturnType<typeof setTimeout> | undefined;
const instanceFile = join(STATE_DIR, "instance.json");
const adminToken = randomBytes(32).toString("hex");
const instanceId = randomUUID();
const startedAt = Date.now() - process.uptime() * 1000;

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  codemodeWorkers.stop();
  if (timer) clearInterval(timer);
  clearTimeout(dailyScan);
  // No new events: the stream closes before anything else stops.
  const streamStopped = stream?.stop();
  application.abort();
  // Sends waiting for the rate limit or in flight end now, so the service can close in time.
  platform?.close();
  // Includes filesystem/lease cleanup; none of the awaited operations may extend this deadline.
  const force = setTimeout(() => {
    log.error("关机超过总期限，强制退出；进程监督器将回收工具后代");
    void server?.stop(true);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    const results = await Promise.allSettled([
      server?.stop(), streamStopped, router?.drain(), messages?.close(), mcp?.close(), application.drain(),
    ]);
    if (results.some((result) => result.status === "rejected")) code = 1;
    await codemodeWorkers.drain();
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
  assertDataVersion(process.cwd());
  // Application binding and workspace layout included: refused before the directory, spaces or tasks open.
  await validateCurrentData(process.cwd());
  await configuredRootlessTasks()?.verify();
  application.signal.throwIfAborted();
  const appBot = readAppBotConfig();
  if (!appBot) throw new Error(`未配置应用机器人（${APP_BOT_CONFIG_PATH}），请先运行配置向导`);
  const client = platform = new PlatformClient(appBot);
  const outbound = platformOutbound(platform, new MessageSender(platform));
  const directoryClient = new DirectoryClient(platform);
  const directory = new IdentityDirectory(stateDatabase(), applicationBinding(appBot), { scope: readDirectoryScope() });
  const app = createApp({ isStopping: () => stopping, adminToken, instanceId, startedAt, shutdown: () => void shutdown("local control"),
    health: () => ({ stream: stream?.status(), directory: directory.status(), attention: messages?.attention() }),
    confirmRevocations: (scanId) => directory.confirmRevocations(scanId, directoryClient, application.signal),
    listDepartments: (parent, signal) => directoryClient.childDepartments(parent, AbortSignal.any([signal, application.signal])),
    describeDepartments: (ids, signal) => directoryClient.describe(ids, AbortSignal.any([signal, application.signal])),
    changeScope: async (departments, signal) => {
      // The same set again (order aside) neither rewrites the file nor restarts a full scan.
      if (sameScope(directory.status().scope, departments)) return "unchanged";
      // Every department must exist and be visible to the app before anything is saved; a caller that went away saves nothing.
      const checking = AbortSignal.any([signal, application.signal]);
      const checked = await directoryClient.verify(departments ?? [], checking);
      checking.throwIfAborted();
      await writeDirectoryScope(departments);
      await directory.changeScope(departments, directoryClient, application.signal);
      return checked;
    } });
  // One model for the instance, checked before any message is accepted; the Pi model catalogue cache lives in data/runtime.
  await mkdir(RUNTIME_DIR, { recursive: true });
  const retention = runtimeSetting("PI_CACHE_RETENTION") as CacheRetention | undefined;
  const selection = await openModelSelection({ signal: application.signal, ...(retention ? { cacheRetention: retention } : {}) });
  // The task log extraction (scripts/ops/task-logs.*) reports the last line starting so before a task.
  log.info(`Pi ModelRuntime 就绪（provider=${selection.model.provider}, model=${selection.model.id}, api=${selection.model.api}, ` +
    `thinkingLevel=${selection.thinkingLevel}, 资料 workspace=${resolve(LAYOUT.workspace)}）`);
  application.signal.throwIfAborted();
  // The relay configuration is read once here: the space registries shape send_file and the prompt by it.
  await initializeRelay();
  const pptxTemplate = runtimeSetting("BOT_DOCUMENT_PPTX_TEMPLATE"), docxTemplate = runtimeSetting("BOT_DOCUMENT_DOCX_TEMPLATE");
  const modules = await loadModuleDefinitions({
    documentWorkEnabled: (runtimeSetting("BOT_DOCUMENT_WORK_ENABLED") ?? RUNTIME_DEFAULTS.BOT_DOCUMENT_WORK_ENABLED) === "1",
    documentTemplates: { ...(pptxTemplate ? { pptx: pptxTemplate } : {}), ...(docxTemplate ? { docx: docxTemplate } : {}) } });
  const documentEnv = runtimeSetting("BOT_DOCUMENT_ENV");
  const mcpConfig = readMcpConfig();
  if (mcpConfig?.servers.length) { mcp = new McpTools(mcpConfig); await mcp.initialize(application.signal); }
  messages = new DurableService({
    layout: LAYOUT, selection, modules, relay: getRelayConfig(), outbound,
    attachments: { source: (fileId, destination, options) => downloadFile(client, fileId, destination, options) },
    ...(documentEnv ? { venvDir: resolve(documentEnv) } : {}),
    auxiliary: readAuxiliaryConfig(),
    mcp,
    limits: { runTimeoutMs: RUN_TIMEOUT_MS, modelIdleMs: MODEL_IDLE_TIMEOUT_MS, modelResponseMs: MODEL_RESPONSE_TIMEOUT_MS },
    closeout: { closeoutMs: CLOSEOUT_MS, reserveMs: DELIVERY_RESERVE_MS, fallbackMs: FALLBACK_SEND_MS },
    onReport: (error) => log.error("消息服务后台错误: " + String(error)),
    onFatal: (error) => {
      log.error("会话存储发生无法确认的提交失败，立即退出，等待监督器重启: " + String(error) + "; cause: " + String(error.cause));
      process.exit(1);
    },
    onLog: (line) => log.info(line),
  });
  // Spaces with unfinished work open now: waiting controls run again and the members' workers resume their inboxes.
  const resumed = await messages.start();
  if (resumed.length) log.info(`恢复 ${resumed.length} 个空间的未完成工作`);
  application.signal.throwIfAborted();
  const service = messages;
  router = new InboundRouter({
    service, directory, outbound, signal: application.signal,
    onUnknown: () => { directory.requestScan(directoryClient, application.signal); },
    onReport: (error) => log.error("入站处理失败: " + String(error)),
  });
  const inbound = router;
  // One service stream per app: this process holds it from here until shutdown.
  stream = new StreamConnection(platform, { onEvent: (event) => inbound.handle(event) });
  stream.start();
  const scan = (trigger: "initial" | "daily") => application.track(directory.scan(trigger, directoryClient, application.signal))
    .catch(error => { if (!application.signal.aborted) log.error(`通讯录同步失败: ${String(error)}`); });
  if (directory.initializing) void scan("initial");
  // The daily scan runs at 03:00 local time.
  const scheduleDaily = () => {
    const next = new Date(); next.setHours(3, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    dailyScan = setTimeout(() => { void scan("daily"); scheduleDaily(); }, next.getTime() - Date.now());
  };
  scheduleDaily();
  server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 15, fetch: app.fetch });
  await application.track(writeFile(instanceFile, JSON.stringify({ pid: process.pid, port: server.port, token: adminToken,
    host: HOST, cwd: process.cwd(), instanceId, startedAt }), { mode: 0o600 }));
  application.signal.throwIfAborted();
  const maintain = () => {
    if (stopping) return;
    // Object cleanup keeps its own guard: lengthy stats/session maintenance must not defer it.
    if (!relayMaintenance) {
      relayMaintenance = application.track(sweepExpiredRelayObjects());
      void relayMaintenance.catch(error => log.error("外链清理失败: " + String(error)))
        .finally(() => { relayMaintenance = undefined; });
    }
    if (maintenance) return;
    maintenance = application.track(Promise.allSettled([messages!.maintain()]));
    void maintenance.then((results) => {
      for (const result of results as PromiseSettledResult<unknown>[]) {
        if (result.status === "rejected") log.error("后台维护失败: " + String(result.reason));
      }
    }).finally(() => { maintenance = undefined; });
  };
  timer = setInterval(() => { try { maintain(); } catch (error) { log.error(String(error)); } }, MAINTENANCE_INTERVAL_MS);
  maintain();
  log.info(`服务启动完成，监听地址: ${HOST}:${PORT}；程序 v${APP_VERSION}${APP_BUILD ? ` 构建 ${APP_BUILD}` : ""}，数据格式 ${DATA_VERSION}`);
} catch (error) {
  log.error("服务启动失败: " + String(error));
  await shutdown("startup failure", 1);
}
