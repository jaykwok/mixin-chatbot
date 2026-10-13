import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { App } from "../../scripts/ops/tui/app.ts";
import { SettingsView } from "../../scripts/ops/tui/views/settings.ts";
import { Screen, type Key } from "../../scripts/ops/tui/render/screen.ts";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import type { AppApi, ConfirmSpec, ViewContext } from "../../scripts/ops/tui/view.ts";
import type { Deployment } from "../../scripts/ops/tui/platform.ts";
import * as data from "../../scripts/ops/tui/data.ts";
import * as execution from "../../scripts/ops/tui/exec.ts";
import * as settings from "../../scripts/config/runtime-settings.ts";
import { waitFor } from "../helpers/tui-process.ts";
import { tempFixture } from "../helpers/temp.ts";

const deployment: Deployment = {
  platform: "linux", runtime: "docker", mode: "direct", port: 1011, domain: "",
  groupDataRoot: "unused", groupDataRootIsCustom: false,
};
const key = (name: string): Key => ({ name, raw: name, ctrl: false, shift: false });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const snapshot: settings.RuntimeSnapshot = { hash: null, values: {} };
const ctx = (width = 100, height = 25): ViewContext => ({ theme: createTheme("truecolor"), width, height, deployment });
const plain = (lines: string[]) => Bun.stripANSI(lines.join("\n"));

function stub() {
  const choices: (string | null)[] = [], answers: (string | null)[] = [], messages: string[] = [];
  const app: AppApi = {
    deployment, theme: createTheme("truecolor"), redraw() {}, toast(_status, text) { messages.push(text); }, go() {},
    ask: async () => answers.shift() ?? null, choose: async () => choices.shift() ?? null, confirm: async () => true,
    run: async () => { throw new Error("不得执行真实维护命令"); },
    runInteractive: async () => { throw new Error("不得启动交互子进程"); }, openFile: async () => {},
  };
  return { app, choices, answers, messages };
}

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; },
  });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  output.on("data", () => {});
  const screen = new Screen(output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
  return { screen, close() { screen.stop(); input.destroy(); output.destroy(); } };
}

test("设置仅加载选中项，重复选择复用在途读取；离页丢弃旧结果，重入可读取新结果", async () => {
  const { app } = stub(), view = new SettingsView();
  const tunnel = Promise.withResolvers<data.TunnelLogging>();
  const old = Promise.withResolvers<settings.RuntimeSnapshot>(), fresh = Promise.withResolvers<settings.RuntimeSnapshot>();
  let tunnelSignal: AbortSignal | undefined, runtimeSignal: AbortSignal | undefined;
  const readTunnel = spyOn(data, "loadTunnelLogging").mockImplementation((_project, signal) => { tunnelSignal = signal; return tunnel.promise; });
  const readProtocol = spyOn(data, "loadTunnelProtocol").mockResolvedValue("auto");
  const readRelay = spyOn(data, "loadRelaySummary").mockResolvedValue({ enabled: false });
  const readRuntime = spyOn(data, "loadRuntimeSettings").mockImplementationOnce((_project, signal) => {
    runtimeSignal = signal; return old.promise;
  }).mockReturnValue(fresh.promise);
  try {
    await view.refresh(app);
    expect(readRelay).toHaveBeenCalledTimes(1);
    expect(readTunnel).not.toHaveBeenCalled(); expect(readRuntime).not.toHaveBeenCalled();
    expect(readProtocol).not.toHaveBeenCalled();
    await view.onKey(key("down"), app);
    expect(readRelay).toHaveBeenCalledTimes(1);
    expect(readTunnel).toHaveBeenCalledTimes(1);
    await view.onKey(key("down"), app);
    expect(tunnelSignal?.aborted).toBe(true);
    expect(readProtocol).toHaveBeenCalledTimes(1);
    expect(readRuntime).not.toHaveBeenCalled();
    await view.onKey(key("down"), app);
    expect(readRuntime).toHaveBeenCalledTimes(1);
    await view.onKey(key("end"), app);
    expect(readRuntime).toHaveBeenCalledTimes(1);
    view.onLeave();
    expect(runtimeSignal?.aborted).toBe(true);
    const next = view.refresh(app);
    expect(readRuntime).toHaveBeenCalledTimes(2);
    old.resolve({ hash: null, values: { BOT_DEBUG: "1" } }); await tick();
    expect(view.activity()).toBe("正在读取运行参数…");
    fresh.resolve(snapshot); await next;
    expect(view.activity()).toBeNull();
    await view.onKey(key("home"), app); await view.onKey(key("end"), app);
    expect(readRuntime).toHaveBeenCalledTimes(2);
    expect(plain(view.render(ctx()))).toContain("0 项自定义");
  } finally {
    tunnel.resolve("off"); old.resolve(snapshot); fresh.resolve(snapshot);
    view.onLeave(); readTunnel.mockRestore(); readProtocol.mockRestore(); readRelay.mockRestore(); readRuntime.mockRestore();
  }
});

test("外链配置项显示当前状态、桶根目录和期限，不显示凭据；读取失败只给说明", async () => {
  const { app } = stub(), view = new SettingsView();
  const enabled: data.RelaySummary = {
    enabled: true, endpoint: "https://cos.ap-chengdu.myqcloud.com", region: "ap-chengdu", bucket: "bot-1250000000", prefix: "",
    pathStyle: false, maxBytes: 2 * 1024 ** 3, expireHours: 2, cleanupGraceMinutes: 30, sessionToken: true,
  };
  const read = spyOn(data, "loadRelaySummary").mockResolvedValue(enabled);
  try {
    expect(plain(view.render(ctx()))).not.toContain("当前：");
    await view.refresh(app);
    const shown = plain(view.render(ctx(120, 30)));
    for (const text of ["当前：已启用 · 桶 bot-1250000000 · 区域 ap-chengdu", "https://cos.ap-chengdu.myqcloud.com · Virtual hosted",
      "对象路径：日期-UUID/原文件名（桶根目录）", "下载有效 2 小时，再保留 30 分钟后清理；单文件上限 2.00 GB", "使用临时 Token"]) {
      expect(shown).toContain(text);
    }
    // 窄窗口的菜单列出各项摘要。
    expect(plain(view.render(ctx(80, 24)))).toContain("已启用 · bot-1250000000");
    read.mockResolvedValue({ ...enabled, prefix: "relay/", sessionToken: false });
    await view.refresh(app);
    expect(plain(view.render(ctx(120, 30)))).toContain("对象路径：relay/日期-UUID/原文件名");
    expect(plain(view.render(ctx(120, 30)))).not.toContain("临时 Token");
    read.mockResolvedValue({ enabled: false });
    await view.refresh(app);
    expect(plain(view.render(ctx()))).toContain("当前：未启用");
    read.mockRejectedValue(new Error("relay.json 不是有效 JSON，请重新运行外链配置"));
    await view.refresh(app);
    expect(plain(view.render(ctx()))).toContain("当前：relay.json 不是有效 JSON");
    expect(plain(view.render(ctx(80, 24)))).toContain("配置无效或无法读取");
    for (const [width, height] of [[72, 15], [80, 19], [120, 30]]) {
      read.mockResolvedValue(enabled);
      await view.refresh(app);
      const lines = view.render(ctx(width, height));
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every(line => Bun.stringWidth(line) === width)).toBe(true);
    }
  } finally { view.onLeave(); read.mockRestore(); }
});

test("外链摘要直接读取配置文件：未配置、有效、无效均不带出凭据或文件原文", async () => {
  const fixture = await tempFixture("tui-relay-summary-");
  const path = join(fixture.root, "data", "config", "relay.json");
  try {
    expect(await data.loadRelaySummary(fixture.root)).toEqual({ enabled: false });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ provider: "s3", endpoint: "https://cos.ap-chengdu.myqcloud.com", region: "ap-chengdu",
      bucket: "bot-1250000000", accessKeyId: "fixture-private-ak", secretAccessKey: "fixture-private-sk", sessionToken: "fixture-private-token" }));
    const summary = await data.loadRelaySummary(fixture.root);
    expect(summary).toEqual({ enabled: true, endpoint: "https://cos.ap-chengdu.myqcloud.com", region: "ap-chengdu", bucket: "bot-1250000000",
      prefix: "", pathStyle: false, maxBytes: 2 * 1024 ** 3, expireHours: 2, cleanupGraceMinutes: 30, sessionToken: true });
    expect(JSON.stringify(summary)).not.toContain("fixture-private");
    await writeFile(path, '{"secretAccessKey": fixture-private-sk');
    const invalid = await data.loadRelaySummary(fixture.root).then(() => "", (error: Error) => error.message);
    expect(invalid).toBe("relay.json 不是有效 JSON，请重新运行外链配置");
    await writeFile(path, JSON.stringify({ provider: "s3", endpoint: "https://bot-1250000000.cos.ap-chengdu.myqcloud.com", region: "ap-chengdu",
      bucket: "bot-1250000000", accessKeyId: "fixture-private-ak", secretAccessKey: "fixture-private-sk" }));
    const rejected = await data.loadRelaySummary(fixture.root).then(() => "", (error: Error) => error.message);
    expect(rejected).toContain("endpoint 已包含桶名");
    expect(rejected).not.toContain("fixture-private");
  } finally { await fixture.cleanup(); }
});

test("设置读取使用现有 App 动画，提示过期后仍持续转动，分类和页面导航不等待 I/O", async () => {
  const tty = terminal(), view = new SettingsView();
  const old = Promise.withResolvers<settings.RuntimeSnapshot>(), fresh = Promise.withResolvers<settings.RuntimeSnapshot>();
  const read = spyOn(data, "loadRuntimeSettings").mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise);
  const relay = spyOn(data, "loadRelaySummary").mockResolvedValue({ enabled: false });
  const render = spyOn(tty.screen, "render");
  const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => { app["service"] = { state: "unreachable" }; };
  const running = app.start();
  try {
    await tick();
    await app["handleKey"](key("a"));
    app.toast("busy", "正在读取运行参数"); app["toastState"]!.at -= 10000;
    const frames = () => new Set(render.mock.calls.flatMap(([lines]) => lines
      .filter(line => line.includes("正在读取运行参数…")).map(line => Bun.stripANSI(line))));
    await waitFor(() => frames().size >= 3, "设置页连续加载动画", 1200);
    await app["handleKey"](key("down")); await app["handleKey"](key("enter"));
    expect(plain(view.render(ctx()))).toContain("超时与退出");
    expect(app["viewBusy"]).toBe(false);
    await app["handleKey"](key("right")); expect(app["current"].id).toBe("other");
    await app["handleKey"](key("left")); expect(read).toHaveBeenCalledTimes(2);
    old.resolve(snapshot); await tick();
    expect(view.activity()).toBe("正在读取运行参数…");
    fresh.resolve(snapshot);
    await waitFor(() => view.activity() === null && !plain(render.mock.calls.at(-1)![0]).includes("正在读取"), "读取结束", 1000);
    const paints = render.mock.calls.length;
    await Bun.sleep(350);
    expect(render.mock.calls.length - paints).toBeLessThanOrEqual(1);
  } finally {
    old.resolve(snapshot); fresh.resolve(snapshot);
    await app["handleKey"](key("q")); await running;
    read.mockRestore(); relay.mockRestore(); render.mockRestore(); tty.close();
  }
});

test("保存日志设置复用全局刷新，不再重复读取，也不加载未选中的运行参数", async () => {
  const tty = terminal(), view = new SettingsView();
  let saved: data.TunnelLogging = "off";
  const read = spyOn(data, "loadTunnelLogging").mockImplementation(async () => saved);
  const runtime = spyOn(data, "loadRuntimeSettings").mockResolvedValue(snapshot);
  const stream = spyOn(execution, "stream").mockImplementation(() => {
    saved = "on"; return { done: Promise.resolve(0), cancel() {} };
  });
  const app = new App([view], { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => {};
  app.choose = async () => "on"; app.confirm = async () => true;
  tty.screen.start(() => {}, () => {});
  try {
    await app["handleKey"](key("down"));
    await app["handleKey"](key("enter"));
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(runtime).not.toHaveBeenCalled();
    expect(plain(view.render(ctx()))).toContain("当前：开启");
  } finally { view.onLeave(); read.mockRestore(); runtime.mockRestore(); stream.mockRestore(); tty.close(); }
});

test("运行参数在 TUI 校验和预览，确认前不写草稿；保存通过运维执行面板并显示后台活动", async () => {
  const { app, choices, answers, messages } = stub(), view = new SettingsView();
  const read = spyOn(data, "loadRuntimeSettings").mockResolvedValue(snapshot);
  const confirm = spyOn(app, "confirm").mockResolvedValue(false);
  const draft = Promise.withResolvers<string>();
  const write = spyOn(settings, "writeRuntimeDraft").mockReturnValue(draft.promise);
  const discard = spyOn(settings, "discardRuntimeDraft").mockResolvedValue();
  const run = spyOn(app, "run").mockImplementation(async () => {
    read.mockResolvedValue({ hash: "a".repeat(64), values: { BOT_MAX_ACTIVE_REQUESTS: "64" } }); return 0;
  });
  try {
    await view.onKey(key("a"), app); await view.refresh(app);
    await view.onKey(key("enter"), app); // 并发与附件
    choices.push("edit"); answers.push("0");
    await view.onKey(key("enter"), app);
    expect(view.hasUnsavedChanges()).toBe(false);
    expect(messages.at(-1)).toContain("1-1000");
    choices.push("edit"); answers.push("64");
    await view.onKey(key("enter"), app);
    expect(view.hasUnsavedChanges()).toBe(true);
    expect(plain(view.render(ctx()))).toContain("64（待保存）");
    view.invalidate(); await view.refresh(app);
    expect(view.hasUnsavedChanges()).toBe(true);
    await view.onKey(key("s"), app);
    expect(confirm.mock.calls[0]![0].steps[0]).toContain("32 → 64");
    expect(write).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    const saving = view.onKey(key("s"), app); await tick();
    expect(view.activity()).toBe("正在保存运行参数…");
    draft.resolve(join("unused", ".runtime-draft-11111111-1111-1111-1111-111111111111.json"));
    await saving;
    expect(write.mock.calls[0]!.slice(0, 2)).toEqual([snapshot, { BOT_MAX_ACTIVE_REQUESTS: "64" }]);
    expect(run.mock.calls[0]![1]).toEqual(["runtime-configure", ".runtime-draft-11111111-1111-1111-1111-111111111111.json"]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(view.hasUnsavedChanges()).toBe(false);
    await view.refresh(app);
    expect(plain(view.render(ctx()))).toContain("64（已保存）");
  } finally {
    draft.resolve("unused"); read.mockRestore(); confirm.mockRestore(); write.mockRestore(); discard.mockRestore(); run.mockRestore();
  }
});

test("文档模块开关默认开启，选择关闭后只保存对应运行参数", async () => {
  const { app, choices } = stub(), view = new SettingsView();
  const read = spyOn(data, "loadRuntimeSettings").mockResolvedValue(snapshot);
  const write = spyOn(settings, "writeRuntimeDraft").mockResolvedValue("module-draft");
  const discard = spyOn(settings, "discardRuntimeDraft").mockResolvedValue();
  const run = spyOn(app, "run").mockResolvedValue(0);
  try {
    await view.onKey(key("a"), app); await view.refresh(app);
    await view.onKey(key("end"), app); await view.onKey(key("enter"), app);
    expect(plain(view.render(ctx()))).toContain("文档加工模块");
    expect(plain(view.render(ctx()))).toContain("开启（默认）");
    await view.onKey(key("down"), app);
    expect(plain(view.render(ctx()))).toContain("共享文档环境覆盖");
    expect(plain(view.render(ctx()))).toContain("每群独立 venv（默认）");
    await view.onKey(key("up"), app);
    choices.push("edit", "0");
    await view.onKey(key("enter"), app);
    expect(plain(view.render(ctx()))).toContain("关闭（待保存）");
    await view.onKey(key("s"), app);
    expect(write.mock.calls[0]!.slice(0, 2)).toEqual([snapshot, { BOT_DOCUMENT_WORK_ENABLED: "0" }]);
  } finally { view.onLeave(); read.mockRestore(); write.mockRestore(); discard.mockRestore(); run.mockRestore(); }
});

test("默认 PPT/Word 模板按扩展名校验，留空恢复内置版式", async () => {
  const { app, choices, answers, messages } = stub(), view = new SettingsView();
  const saved = { hash: null, values: { BOT_DOCUMENT_DOCX_TEMPLATE: "公司.dotx" } };
  const read = spyOn(data, "loadRuntimeSettings").mockResolvedValue(saved);
  const write = spyOn(settings, "writeRuntimeDraft").mockResolvedValue("template-draft");
  const discard = spyOn(settings, "discardRuntimeDraft").mockResolvedValue();
  const run = spyOn(app, "run").mockResolvedValue(0);
  try {
    await view.onKey(key("a"), app); await view.refresh(app);
    await view.onKey(key("end"), app); await view.onKey(key("enter"), app);
    await view.onKey(key("down"), app); await view.onKey(key("down"), app);
    expect(plain(view.render(ctx()))).toContain("默认 PPT 模板");
    expect(plain(view.render(ctx()))).toContain("内置版式（默认）");
    choices.push("edit"); answers.push("默认.dotx");
    await view.onKey(key("enter"), app);
    expect(messages.at(-1)).toContain(".pptx 或 .potx");
    expect(view.hasUnsavedChanges()).toBe(false);
    choices.push("edit"); answers.push("模板/默认.potx");
    await view.onKey(key("enter"), app);
    expect(plain(view.render(ctx()))).toContain("模板/默认.potx（待保存）");
    await view.onKey(key("down"), app);
    expect(plain(view.render(ctx()))).toContain("默认 Word 模板");
    expect(plain(view.render(ctx()))).toContain("公司.dotx（已保存）");
    choices.push("edit"); answers.push("  ");
    await view.onKey(key("enter"), app);
    expect(plain(view.render(ctx()))).toContain("内置版式（待保存）");
    await view.onKey(key("s"), app);
    expect(write.mock.calls[0]!.slice(0, 2)).toEqual([saved, { BOT_DOCUMENT_PPTX_TEMPLATE: "模板/默认.potx", BOT_DOCUMENT_DOCX_TEMPLATE: null }]);
  } finally { view.onLeave(); read.mockRestore(); write.mockRestore(); discard.mockRestore(); run.mockRestore(); }
});

test("分类、默认值和开关在宽窄窗口完整可达；退出 TUI 前提醒未保存草稿", async () => {
  const { app, choices } = stub(), view = new SettingsView(), tty = terminal();
  const read = spyOn(data, "loadRuntimeSettings").mockResolvedValue({ hash: null, values: { BOT_DEBUG: "1" } });
  try {
    await view.onKey(key("a"), app); await view.refresh(app);
    await view.onKey(key("end"), app); await view.onKey(key("enter"), app);
    await view.onKey(key("end"), app);
    for (const [width, height] of [[72, 15], [80, 19], [96, 15], [120, 30]]) {
      const context = ctx(width, height), lines = view.render(context);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every(line => Bun.stringWidth(line) === width)).toBe(true);
      expect(plain(lines)).toContain("机器人详细日志");
    }
    choices.push("default");
    await view.onKey(key("enter"), app);
    expect(plain(view.render(ctx()))).toContain("关闭（待保存）");
    expect(view.hasUnsavedChanges()).toBe(true);
    await view.onKey(key("escape"), app); await view.onKey(key("escape"), app);
    expect(plain(view.render(ctx()))).toContain("1 项待保存");
    const realApp = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
    const confirmations: ConfirmSpec[] = [];
    realApp.confirm = async spec => { confirmations.push(spec); return confirmations.length > 1; };
    tty.screen.start(() => {}, () => {});
    realApp.go("other");
    await realApp["handleKey"](key("q"));
    expect(realApp["quit"]).toBe(false);
    await realApp["handleKey"]({ ...key("c"), ctrl: true });
    expect(realApp["quit"]).toBe(true);
    expect(confirmations[0]!.subject).toContain("尚未保存");
  } finally { read.mockRestore(); tty.close(); }
});
