// The demo deployment behind console-screenshots.ts, which starts this file in its scratch directory: modules read data/
// relative to the working directory when they load. The data directory gets 90 days of synthetic statistics; the real
// service writes a few synthetic chats with a faux model; the bot's HTTP app serves /health and the read channel; the
// console runs its real handler and page bundle. Only the task list of the maintain page is a fixed demo, because real
// maintenance needs a deployment. A headless Chrome or Edge renders each page through the DevTools protocol.
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appLayout } from "../../src/core/layout.ts";
import { DATA_VERSION } from "../../src/core/version.ts";
import { DurableService } from "../../src/durable/service.ts";
import { ReadChannel } from "../../src/durable/read/client.ts";
import { createApp } from "../../src/server/http-app.ts";
import { AuditLog } from "../../console/server/audit.ts";
import { Auth } from "../../console/server/auth.ts";
import { BotLink } from "../../console/server/bot.ts";
import { buildBundle } from "../../console/server/bundle.ts";
import { Exports } from "../../console/server/exports.ts";
import { guardConfig } from "../../console/server/guard.ts";
import type { Route } from "../../console/server/routes.ts";
import { startServer } from "../../console/server/server.ts";
import { statsRoutes } from "../../console/server/stats.ts";
import { serviceView } from "../../console/server/status.ts";
import { conversationRoutes, Views } from "../../console/server/views.ts";
import { probeService } from "../../console/server/data.ts";
import { versionRows } from "../../ops/tools/version-info.ts";
import type { Overview } from "../../console/ui/src/contract.ts";
import { PROJECT_PROGRESS } from "./durable.ts";
import { recordingOutbound, replyTexts } from "./recording-outbound.ts";
import { writeTestData } from "./stats-fixture.ts";

const project = resolve(import.meta.dir, "../..");
const VERSION = String(JSON.parse(await readFile(join(project, "package.json"), "utf8")).version);
/** An example build: the screenshots do not follow every commit. */
const BUILD = "a1b2c3d4e5f6";
const DAY = 24 * 3600_000;
const now = Date.now();

const MEMBERS = [
  ["13800000001", "张三"], ["13800000002", "李四"], ["13800000003", "王五"], ["13800000004", "赵六"], ["13800000005", "孙七"],
  ["13800000006", "周八"], ["13800000007", "吴九"], ["13800000008", "郑十"],
] as const;
const phone = (name: string) => MEMBERS.find(([, value]) => value === name)![0];
const SALES = "60310021", FINANCE = "60310022";
/** Relative activity of each member in each space. */
const ACTIVITY: Record<string, [string, number][]> = {
  direct: [["张三", 3], ["李四", 1.6], ["王五", 1.2], ["赵六", 0.8], ["孙七", 1], ["周八", 0.5], ["郑十", 0.3]],
  [SALES]: [["张三", 1.2], ["李四", 1.5], ["吴九", 1], ["孙七", 0.6]],
  [FINANCE]: [["王五", 1.4], ["赵六", 1.1], ["郑十", 0.7], ["周八", 0.4]],
};

/** Deterministic, so a rerun draws the same history. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 90 days of asks and token usage before today, growing slowly, quiet at weekends. */
async function writeHistory(root: string) {
  const draw = random(20261103);
  const between = (low: number, high: number) => Math.round(low + draw() * (high - low));
  for (const [space, members] of Object.entries(ACTIVITY)) {
    for (const [name, weight] of members) {
      const lines: unknown[] = [{ type: "model_change", provider: "deepseek", modelId: "deepseek-chat" }];
      for (let back = 90; back >= 1; back--) {
        const day = new Date(now - back * DAY); day.setHours(0, 0, 0, 0);
        const weekend = day.getDay() === 0 || day.getDay() === 6;
        const asks = Math.floor(weight * (weekend ? 0.25 : 1) * (1 + 0.6 * (1 - back / 90)) * (0.4 + draw() * 1.6));
        for (let index = 0; index < asks; index++) {
          const at = day.getTime() + between(9 * 3600_000, 19 * 3600_000);
          const stamp = (offset: number) => new Date(at + offset).toISOString();
          lines.push({ type: "message", timestamp: stamp(0), message: { role: "user", content: [{ type: "text", text: "示例提问" }] } });
          lines.push({ type: "message", timestamp: stamp(20_000), message: { role: "assistant", provider: "deepseek", model: "deepseek-chat",
            usage: { input: between(6_000, 28_000), output: between(400, 2_800), cacheRead: between(20_000, 110_000), cacheWrite: 0 } } });
          if (draw() < 0.12) lines.push({ type: "message", timestamp: stamp(10_000), message: { role: "toolResult", toolName: "document_route",
            usage: { input: between(1_500, 4_000), output: between(20, 60), cacheRead: 0, cacheWrite: 0 } } });
          if (draw() < 0.05) lines.push({ type: "message", timestamp: stamp(15_000), message: { role: "toolResult", toolName: "generate_image",
            usage: { input: between(200, 800), output: between(1_000, 4_500), cacheRead: 0, cacheWrite: 0 } } });
        }
      }
      await writeTestData(join(root, space, "users", phone(name), "stats.records"), lines.map(line => JSON.stringify(line)).join("\n"));
    }
  }
}

/** One browser tab over the DevTools protocol: navigate, wait for the page, click by text, capture. */
class Page {
  #id = 0;
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private constructor(private readonly socket: WebSocket, private height = 900) {
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const waiter = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`)); else waiter.resolve(message.result);
    });
  }

  static async open(profile: string): Promise<Page> {
    const deadline = Date.now() + 20_000;
    let port = "";
    while (!port) {
      if (Date.now() > deadline) throw new Error("浏览器没有打开调试端口");
      port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(text => text.split("\n")[0]!.trim(), () => "");
      if (!port) await Bun.sleep(100);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const socket = new WebSocket(targets.find(target => target.type === "page")!.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const page = new Page(socket);
    await page.send("Page.enable");
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`页面脚本出错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }

  async viewport(height: number) {
    this.height = height;
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1280, height, deviceScaleFactor: 1.5, mobile: false });
  }

  async go(url: string) {
    await this.send("Page.navigate", { url });
    await Bun.sleep(300);
  }

  async until(expression: string, label: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await this.evaluate(`Boolean(${expression})`))) {
      if (Date.now() > deadline) throw new Error(`等待“${label}”超时；页面文字：${String(await this.evaluate("document.body.innerText")).slice(0, 600)}`);
      await Bun.sleep(100);
    }
  }

  async click(selector: string, text: string) {
    const clicked = await this.evaluate(`(() => { const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.innerText.includes(${JSON.stringify(text)}));
      if (!target) return false; target.click(); return true; })()`);
    if (!clicked) throw new Error(`找不到可点击的“${text}”（${selector}）`);
  }

  /** `height`: a taller viewport for this capture, or "full" for the whole document. */
  async shoot(path: string, height?: number | "full") {
    const base = this.height;
    if (height !== undefined) await this.viewport(height === "full" ? Number(await this.evaluate("document.documentElement.scrollHeight")) : height);
    // Let charts and the layout settle at the new size, then drop the focus ring of the last click.
    await this.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()");
    await Bun.sleep(800);
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, Buffer.from(shot.data, "base64"));
    if (height !== undefined) await this.viewport(base);
  }

  async close() {
    // The browser may close the socket before it answers.
    await Promise.race([this.send("Browser.close").catch(() => {}), Bun.sleep(3_000)]);
    this.socket.close();
  }
}

// ─── Demo deployment ───────────────────────────────────────────────────────

// The launcher starts this file in its scratch directory tmp/console-shots-*; anywhere else data/ could be the real one.
const work = process.cwd();
if (!/^console-shots-[^/\\]+$/.test(relative(join(project, "tmp"), work))) throw new Error("请用 tests/helpers/console-screenshots.ts 运行，演示部署只在它创建的临时目录中运行");
const { values } = parseArgs({ options: { out: { type: "string" }, browser: { type: "string" } } });
const outDir = resolve(values.out!);
const root = join(work, "data");
const layout = appLayout(root);
const statePath = join(root, "state", "agent.sqlite");
const instanceFile = join(root, "state", "instance.json");
const cleanups: (() => Promise<unknown> | unknown)[] = [];

try {
  await writeHistory(root);

  const faux = fauxProvider({ provider: "deepseek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }], tokenSize: { min: 40, max: 120 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const out = recordingOutbound();
  const service = new DurableService({
    layout, modules: [], relay: null, materials: false, outbound: out.outbound, onReport: () => {},
    selection: { runtime: models as never, settings: undefined as never, model: { ...model, contextWindow: 128000 } as never,
      ref: { provider: model.provider, modelId: model.id }, thinkingLevel: "off",
      harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, progress: PROJECT_PROGRESS } },
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
  });
  cleanups.push(() => service.close());
  const ask = async (space: string, name: string, text: string, answers: Parameters<typeof faux.setResponses>[0]) => {
    faux.setResponses(answers);
    const before = replyTexts(out.sent).length, deadline = Date.now() + 30_000;
    await service.admit(out.message(space, phone(name), text));
    while (replyTexts(out.sent).length <= before) {
      if (Date.now() > deadline) throw new Error(`演示提问没有得到回答：${text}`);
      await Bun.sleep(20);
    }
  };

  await ask("direct", "张三", "帮我把这周的销售周报整理成三条要点：华东回款 157.9 万，华南新签 3 家客户，库存周转天数从 42 天降到 37 天。", [fauxAssistantMessage(
    "## 本周销售要点\n\n1. **回款**：华东区回款 157.9 万元，继续领跑各区域。\n2. **新客户**：华南新签 3 家客户，建议下周安排首单交付回访。\n" +
    "3. **库存**：周转天数由 42 天降到 37 天，缩短 5 天。\n\n需要的话，我可以按公司周报模板生成 Word 文档。")]);
  await ask("direct", "张三", "华东区一到三月回款分别是 128.6、142.3、157.9 万，帮我算一下环比。", [
    fauxAssistantMessage([fauxToolCall("bash", { command: "awk 'BEGIN { a = 128.6; b = 142.3; c = 157.9; printf \"Feb %+.1f%%\\nMar %+.1f%%\\n\", (b - a) / a * 100, (c - b) / b * 100 }'" })],
      { stopReason: "toolUse" }),
    fauxAssistantMessage("| 月份 | 回款（万元） | 环比 |\n| --- | ---: | ---: |\n| 1 月 | 128.6 | — |\n| 2 月 | 142.3 | +10.7% |\n| 3 月 | 157.9 | +11.0% |\n\n" +
      "两个月都保持了 10% 以上的环比增长，3 月略快于 2 月。")]);
  await ask("direct", "李四", "明天上午十点的会议纪要模板发我一份。", [fauxAssistantMessage(
    "会议纪要可以按这个结构填写：\n\n- **会议主题**\n- **时间 / 地点 / 参会人**\n- **讨论要点**\n- **决议事项**（负责人、截止时间）\n- **待跟进问题**")]);
  await ask(SALES, "李四", "下周一的客户拜访名单整理好了吗？按城市分一下。", [fauxAssistantMessage(
    "已按城市分组：\n\n- **上海**：华信科技、远景物流\n- **杭州**：青禾食品\n- **苏州**：恒通电子、明德医疗\n\n共 5 家，上海两家可以安排在同一天上午。")]);
  await ask(SALES, "吴九", "报价单模板在共享资料哪个目录？", [fauxAssistantMessage(
    "在共享资料的 `销售/模板` 目录下，最新版本是 **报价单模板-2026版.xlsx**。填写前先另存一份，不要直接改模板。")]);
  await ask(FINANCE, "王五", "差旅报销的住宿标准是多少？", [fauxAssistantMessage(
    "按公司差旅制度（2026 版）：\n\n| 城市类别 | 住宿上限（元/晚） |\n| --- | ---: |\n| 一线城市 | 600 |\n| 省会城市 | 450 |\n| 其他城市 | 350 |\n\n超出部分需要部门负责人审批。")]);
  await ask(FINANCE, "赵六", "帮我写一段催款邮件，语气客气一些。", [fauxAssistantMessage(
    "**主题**：关于 3 月账款的温馨提醒\n\n您好！感谢贵司一直以来的支持。我司 3 月开具的发票（金额 12.8 万元）已到约定付款日，烦请在方便时安排付款。如已支付，请忽略此邮件。\n\n祝工作顺利！")]);

  const names = new Database(statePath, { create: true, strict: true });
  names.exec("CREATE TABLE IF NOT EXISTS member_directory (phone TEXT PRIMARY KEY, im_user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_verified_at INTEGER NOT NULL) STRICT");
  for (const [number, name] of MEMBERS) names.query("INSERT OR REPLACE INTO member_directory VALUES (?, ?, ?, ?)").run(number, `im-${number}`, name, now);
  names.close();

  const channel = new ReadChannel({ conversations: layout.conversations, state: statePath });
  cleanups.push(() => channel.close());
  const token = `admin-${crypto.randomUUID()}`, instanceId = crypto.randomUUID(), startedAt = now - 3 * DAY - 5 * 3600_000;
  const health = () => ({
    stream: { connected: true, connectedAt: startedAt + 2_000, reconnects: 0, lastEventAt: Date.now() - 90_000 },
    directory: { mappings: MEMBERS.length, scope: { kind: "all" }, state: "effective", effective: { scope: { kind: "all" }, since: startedAt + 60_000 },
      lastCompleteAt: Date.now() - 2 * 3600_000 },
  });
  const app = createApp({ isStopping: () => false, adminToken: token, instanceId, startedAt, shutdown: () => {}, health, read: channel });
  const bot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  cleanups.push(() => bot.stop(true));
  await writeFile(instanceFile, JSON.stringify({ pid: process.pid, port: bot.port, token, host: "127.0.0.1", instanceId, startedAt }));

  // ─── Console ─────────────────────────────────────────────────────────────

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!; probe.stop(true);
  const auth = new Auth(), views = new Views(), audit = new AuditLog(join(work, "console", "audit"));
  const linked = new BotLink({ instanceFile });
  const exporter = new Exports({ bot: linked, audit, views, root });
  auth.onEnd(label => views.end(label));
  auth.onEnd(label => exporter.end(label));
  const program = { appVersion: VERSION, build: BUILD };
  const consoleStarted = now - 4 * 60_000;
  const overview = async (): Promise<Overview> => ({
    checkedAt: Date.now(),
    console: { version: VERSION, build: BUILD, hostname: "mixin-bot", platform: "linux", port: 10001, pid: process.pid, startedAt: consoleStarted },
    deployment: { platform: "linux", runtime: "docker", mode: "Docker", port: 3000, dataRoot: "/opt/mixin-bot/data", workspaceRoot: "/opt/mixin-bot/data/workspace" },
    deploymentError: null, recovery: null, pending: null,
    service: serviceView(await probeService(bot.port!, instanceFile)),
    versions: versionRows({ source: "running", program, dataVersion: DATA_VERSION, local: program }),
  });
  const server = startServer({ port, guard: guardConfig(port), bundle: await buildBundle(), auth, instanceId: crypto.randomUUID(), overview,
    routes: { ...conversationRoutes({ bot: linked, audit, views }), ...statsRoutes({ bot: linked, audit, views, root }), ...exporter.routes(), ...demoTasks() },
    download: (ticket, context) => exporter.download(ticket, context) });
  cleanups.push(() => server.stop(true));

  // ─── Browser ─────────────────────────────────────────────────────────────

  const profile = join(work, "browser");
  const browser = Bun.spawn([values.browser!, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--hide-scrollbars", "--force-color-profile=srgb", "--lang=zh-CN", "about:blank"],
  { cwd: project, stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => { if (!(await Promise.race([browser.exited.then(() => true), Bun.sleep(5_000).then(() => false)]))) browser.kill(); await browser.exited; });
  const page = await Page.open(profile);
  cleanups.push(() => page.close());
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.viewport(900);
  await page.go(`http://127.0.0.1:${port}/#login=${auth.issueToken().token}`);
  await page.until("document.querySelector('.sidebar') !== null", "登录");

  await page.go(`http://127.0.0.1:${port}/#/overview`);
  await page.until("document.body.innerText.includes('已连接') && document.body.innerText.includes('数据格式')", "总览");
  await page.shoot(join(outDir, "console-overview.png"));

  await page.go(`http://127.0.0.1:${port}/#/stats`);
  await page.until("document.body.innerText.includes('张三') && document.querySelectorAll('svg').length > 2", "统计");
  await page.shoot(join(outDir, "console-stats.png"), 1440);

  await page.go(`http://127.0.0.1:${port}/#/conversations`);
  await page.until("[...document.querySelectorAll('.space-card')].some(card => !card.disabled && card.innerText.includes('单聊'))", "会话空间");
  await page.click(".space-card", "单聊");
  await page.until("[...document.querySelectorAll('.member-row')].some(row => row.innerText.includes('张三'))", "成员列表");
  await page.click(".member-row", "张三");
  await page.until("document.body.innerText.includes('环比') && document.body.innerText.includes('Mar')", "会话内容");
  await page.shoot(join(outDir, "console-conversations.png"));

  await page.go(`http://127.0.0.1:${port}/#/maintain`);
  await page.until("document.body.innerText.includes('没有未完成的部署或升级') && document.querySelectorAll('.task-list button').length >= 3", "维护");
  await page.click(".task-list button", "重启");
  await page.until("document.body.innerText.includes('机器人运行中（实例身份与就绪检查通过）')", "任务详情");
  await page.shoot(join(outDir, "console-maintain.png"), "full");
} finally {
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { console.error(`清理失败：${String(error)}`); } }
}

/** The maintain page's task list: a fixed demo of finished tasks; the restart's lines are what the executor and the service core print. */
function demoTasks(): Record<string, Route> {
  const at = (back: number) => now - back;
  const tasks = [
    { id: crypto.randomUUID(), operation: "restart", state: "succeeded", needsRecovery: false, createdAt: at(25 * 60_000),
      result: { message: "机器人运行中（实例身份与就绪检查通过）", finalState: "running", outcome: "success", exitCode: 0 } },
    { id: crypto.randomUUID(), operation: "history-compact", state: "succeeded", needsRecovery: false, createdAt: at(DAY + 3 * 3600_000),
      result: { message: "会话压缩完成", finalState: "running", outcome: "success", exitCode: 0 } },
    { id: crypto.randomUUID(), operation: "update", state: "succeeded", needsRecovery: false, createdAt: at(3 * DAY + 5 * 3600_000 + 120_000),
      result: { message: `已升级到 v${VERSION}`, finalState: "running", outcome: "success", exitCode: 0 } },
  ];
  const events = (id: string) => {
    const task = tasks.find(item => item.id === id)!;
    return [["phase", "已接单，正在核对计划"], ["phase", "正在执行"], ["phase", task.result.message]]
      .map(([kind, text], index) => ({ seq: index + 1, at: task.createdAt + index * 4_000, kind, text }));
  };
  const find = (params: Record<string, string> | undefined) => tasks.find(task => task.id === params?.id) ?? (() => { throw new Error("没有这个任务"); })();
  return {
    "GET /api/tasks": { run: async () => ({ tasks }) },
    "GET /api/lifecycle": { run: async () => ({ pending: null }) },
    "GET /api/tasks/:id": { run: async ({ params }) => find(params) },
    "GET /api/tasks/:id/events": { run: async ({ params }) => {
      const body = events(find(params).id).map(event => `id: ${event.seq}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } });
    } },
  };
}
