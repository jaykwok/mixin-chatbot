import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { App } from "../../scripts/ops/tui/app.ts";
import { Screen, type Key } from "../../scripts/ops/tui/render/screen.ts";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import { Viewport } from "../../scripts/ops/tui/render/viewport.ts";
import type { AppApi, ConfirmSpec, SelectSpec, View, ViewContext } from "../../scripts/ops/tui/view.ts";
import type { Deployment } from "../../scripts/ops/tui/platform.ts";
import { HealthView } from "../../scripts/ops/tui/views/health.ts";
import { OverviewView } from "../../scripts/ops/tui/views/overview.ts";
import { StatsView } from "../../scripts/ops/tui/views/stats.ts";
import { StorageView } from "../../scripts/ops/tui/views/storage.ts";
import { HistoryView } from "../../scripts/ops/tui/views/history.ts";
import { LogsView } from "../../scripts/ops/tui/views/logs.ts";
import { MaintainView } from "../../scripts/ops/tui/views/maintain.ts";
import { SettingsView } from "../../scripts/ops/tui/views/settings.ts";
import * as tuiData from "../../scripts/ops/tui/data.ts";
import { sweepSessionStats } from "../../src/agent/stats-ledger.ts";
import * as tuiExec from "../../scripts/ops/tui/exec.ts";
import * as tuiReport from "../../scripts/ops/tui/report.ts";
import { createRelayView, createRoutesView } from "../../scripts/ops/tui/views/passthrough.ts";
import { tempFixture } from "../helpers/temp.ts";
import { waitFor } from "../helpers/tui-process.ts";

const deployment: Deployment = {
  platform: "linux", runtime: "docker", mode: "direct", port: 1011, domain: "",
  groupDataRoot: "unused", groupDataRootIsCustom: false,
};
const key = (name: string, text?: string): Key => ({ name, raw: name, text, ctrl: false, shift: false });
const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line)).join("\n");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fakeApp(root = "unused") {
  const calls = {
    answers: [] as (string | null)[], prompts: [] as string[], confirms: [] as ConfirmSpec[],
    commands: [] as { title: string; args: string[] }[], toasts: [] as string[],
    opened: [] as string[], destinations: [] as string[],
    choices: [] as (string | null)[], menus: [] as SelectSpec[],
  };
  const app: AppApi = {
    deployment: { ...deployment, groupDataRoot: root }, theme: createTheme("truecolor"),
    redraw() {}, go(id) { calls.destinations.push(id); }, toast(_status, text) { calls.toasts.push(text); },
    async ask(label) { calls.prompts.push(label); return calls.answers.shift() ?? null; },
    async choose(spec) { calls.menus.push(spec); return calls.choices.shift() ?? null; },
    async confirm(spec) { calls.confirms.push(spec); return true; },
    async run(title, args) { calls.commands.push({ title, args }); return 0; },
    async runInteractive() { throw new Error("测试不得执行真实运维命令"); },
    async openFile(path) { calls.opened.push(path); },
  };
  return { app, calls };
}

function context(width = 80, rows = 24): ViewContext {
  return { width, height: rows - 5, theme: createTheme("truecolor"), deployment };
}

function fits(lines: string[], ctx: ViewContext) {
  expect(lines.length).toBeLessThanOrEqual(ctx.height);
  for (const line of lines) expect(Bun.stringWidth(line)).toBe(ctx.width);
}

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; return this; },
  });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let written = "";
  output.on("data", data => { written += String(data); });
  const screen = new Screen(output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
  return { input, output, screen, text: () => written, close() { screen.stop(); input.destroy(); output.destroy(); } };
}

test("左右切换主分区、Tab 切换子页并记住位置，待办可以跨分区直达", async () => {
  const tty = terminal();
  const received: string[] = [];
  const left: string[] = [];
  const page = (id: string, label: string): View => ({
    id, label, render: () => [], hints: () => [],
    onLeave() { left.push(id); },
    onKey(key) { received.push(id + ":" + key.name); return true; },
  });
  const app = new App([
    { id: "overview", label: "总览", views: [page("overview", "总览")] },
    { id: "monitor", label: "监控", views: [page("health", "体检"), page("logs", "日志")] },
    { id: "stats", label: "统计", views: [page("stats", "统计")] },
    { id: "data", label: "数据", views: [page("history", "会话"), page("storage", "临时文件"), page("relay", "外链")] },
    { id: "system", label: "系统", views: [page("maintain", "服务部署"), page("routes", "回调路由")] },
  ], { screen: tty.screen, deployment });
  tty.screen.start(event => { void app["handleKey"](event); }, () => {});
  try {
    tty.input.write("\u001b[C");
    await tick();
    expect(app["current"].id).toBe("health");
    await app["handleKey"](key("tab"));
    expect(app["current"].id).toBe("logs");
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("stats");
    await app["handleKey"](key("left"));
    expect(app["current"].id).toBe("logs");
    await app["handleKey"]({ ...key("tab"), shift: true });
    expect(app["current"].id).toBe("health");
    await app["handleKey"]({ ...key("tab"), shift: true });
    expect(app["current"].id).toBe("logs");
    await app["handleKey"](key("down"));
    expect(received).toEqual(["logs:down"]);
    app.go("storage");
    expect(app["section"].id).toBe("data");
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("maintain");
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("overview");
    await app["handleKey"](key("left"));
    expect(app["current"].id).toBe("maintain");
    await app["handleKey"](key("4"));
    expect(app["current"].id).toBe("storage");
    await app["handleKey"](key("tab"));
    expect(app["current"].id).toBe("relay");
    await app["handleKey"](key("tab"));
    expect(app["current"].id).toBe("history");
    expect(left).toContain("logs");
    expect(plain([tty.text()])).toContain("Tab");
  } finally { tty.close(); }
});

test("空格操作菜单共用原确认通道，方向键在弹窗内选择而不会切换分区", async () => {
  const tty = terminal();
  let executions = 0;
  const view: View = {
    id: "one", label: "数据", render: () => [], hints: () => [],
    actions: () => [{ value: "c", label: "清理当前成员", danger: true }],
    async onKey(key, app) {
      if (key.name !== "c") return false;
      if (await app.confirm({ title: "清理", subject: "当前群 / 当前成员", steps: ["归档选中范围"], danger: true })) executions++;
      return true;
    },
  };
  const app = new App([view, { id: "two", label: "其他", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    for (const accept of [false, true]) {
      const menu = app["handleKey"](key(accept ? "f2" : "space"));
      expect(app["modal"]?.kind).toBe("select");
      await app["handleKey"](key("right"));
      expect(app["current"].id).toBe("one");
      await app["handleKey"](key("enter"));
      await tick();
      expect(app["modal"]?.kind).toBe("confirm");
      if (accept) await app["handleKey"](key("right"));
      await app["handleKey"](key("enter"));
      await menu;
      expect(executions).toBe(accept ? 1 : 0);
      expect(app["current"].id).toBe("one");
    }
  } finally { tty.close(); }
});

test("连续切换复用正在运行的体检，只有显式刷新才追加一次读取", async () => {
  const tty = terminal();
  const finishes: (() => void)[] = [];
  let reads = 0;
  const slow: View = {
    id: "slow", label: "体检", render: () => [], hints: () => [],
    refresh: () => { reads++; return new Promise(resolve => { finishes.push(resolve); }); },
  };
  const app = new App([{ id: "home", label: "总览", render: () => [], hints: () => [] }, slow], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    for (let i = 0; i < 10; i++) {
      app.go("home");
      app.go("slow");
    }
    expect(reads).toBe(1);
    finishes.shift()!();
    await tick();
    expect(reads).toBe(1);
    expect(app["refreshes"].size).toBe(0);

    const refresh = app["refreshView"](slow, true);
    for (let i = 0; i < 10; i++) void app["refreshView"](slow, true);
    expect(reads).toBe(2);
    finishes.shift()!();
    await tick();
    expect(reads).toBe(3);
    finishes.shift()!();
    await refresh;
    expect(app["refreshes"].size).toBe(0);
  } finally { finishes.forEach(finish => finish()); tty.close(); }
});

test.each(["已完成", "新检查期间返回", "新检查之后返回", "新检查之后报错"] as const)("部署或修复返回后丢弃旧体检（%s），重入时懒加载最新结果", async timing => {
  for (const interactive of [true, false]) {
    const tty = terminal();
    const view = new HealthView();
    const old = Promise.withResolvers<tuiData.Health>();
    const fresh = Promise.withResolvers<tuiData.Health>();
    const missing: tuiData.Health = { pass: 0, warn: 0, fail: 1, checks: [
      { name: "本地机器人健康", status: "fail", detail: "首次部署前实例不存在", fix: "请部署" },
    ] };
    const healthy: tuiData.Health = { pass: 1, warn: 0, fail: 0, checks: [
      { name: "本地机器人健康", status: "pass", detail: "就绪且实例身份匹配", fix: "" },
    ] };
    const signals: (AbortSignal | undefined)[] = [];
    const read = spyOn(tuiData, "loadHealth").mockImplementation((_deployment, signal?: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? old.promise : fresh.promise;
    });
    const app = new App([
      { id: "home", label: "总览", render: () => [], hints: () => [] }, view,
      { id: "system", label: "系统", render: () => [], hints: () => [] },
    ], { screen: tty.screen, deployment: { ...deployment, platform: "windows" } });
    app["refreshChrome"] = async () => {};
    // 只模拟外部操作结束，实际运行返回后的刷新和导航；不执行部署或修复。
    const suspend = spyOn(tty.screen, "suspend").mockResolvedValue(undefined);
    const stream = spyOn(tuiExec, "stream").mockReturnValue({ done: Promise.resolve(0), cancel() {} });
    tty.screen.start(() => {}, () => {});
    try {
      app.go("health");
      const oldJob = app["refreshes"].get(view)!.promise;
      if (timing === "已完成") {
        old.resolve(missing);
        await oldJob;
        expect(plain(view.render(context()))).toContain("首次部署前实例不存在");
      } else {
        app["refreshCurrent"](); // 连先前排队的手动刷新也应失效。
      }
      app.go("system");
      if (interactive) await app.runInteractive("首次部署", ["deploy"]);
      else {
        await app.run("修复", ["doctor", "-Repair"]);
        await app["handleKey"](key("enter"));
      }
      expect(read).toHaveBeenCalledTimes(1); // 隐藏的体检页不提前运行 doctor。
      app.go("health");
      expect(read).toHaveBeenCalledTimes(2);
      expect(plain(view.render(context()))).not.toContain("首次部署前实例不存在");
      expect(plain(view.render(context()))).toContain("正在读取");
      const freshJob = app["refreshes"].get(view)!;
      if (timing !== "已完成") expect(signals[0]?.aborted).toBe(true);
      if (timing === "新检查期间返回") {
        old.resolve(missing);
        await oldJob;
        expect(app["refreshes"].get(view)).toBe(freshJob);
        expect(plain(view.render(context()))).not.toContain("首次部署前实例不存在");
        expect(app["toastState"]?.text).not.toContain("已刷新");
      }
      app.go("system");
      app.go("health");
      expect(read).toHaveBeenCalledTimes(2);
      fresh.resolve(healthy);
      await freshJob.promise;
      if (timing === "新检查之后返回") {
        old.resolve(missing);
        await oldJob;
      } else if (timing === "新检查之后报错") {
        old.reject(new Error("已过期的体检失败"));
        await oldJob;
      }
      expect(view["state"]).toEqual({ kind: "ready", value: healthy });
      expect(app["refreshes"].size).toBe(0);
    } finally {
      old.resolve(missing); fresh.resolve(healthy); await tick();
      read.mockRestore(); suspend.mockRestore(); stream.mockRestore(); tty.close();
    }
  }
});

test("没有运行时长或提示消息时，初次加载仍持续动画、可导航，完成后停止快速重绘", async () => {
  const tty = terminal();
  const view = new HealthView();
  const result = Promise.withResolvers<tuiData.Health>();
  const read = spyOn(tuiData, "loadHealth").mockReturnValue(result.promise);
  const render = spyOn(tty.screen, "render");
  const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }],
    { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => { app["service"] = { state: "unreachable" }; };
  const running = app.start();
  try {
    const frames = () => new Set(render.mock.calls.flatMap(([lines]) => lines
      .filter(line => line.includes("正在读取…")).map(line => Bun.stripANSI(line))));
    expect(app["toastState"]).toBeNull();
    await waitFor(() => frames().size >= 3, "加载动画连续更新", 1200);
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("other");
    await app["handleKey"](key("left"));
    expect(read).toHaveBeenCalledTimes(1);
    result.resolve({ pass: 0, warn: 0, fail: 0, checks: [] });
    await waitFor(() => !plain(render.mock.calls.at(-1)![0]).includes("正在读取"), "体检完成后的界面", 1000);
    const paints = render.mock.calls.length;
    await Bun.sleep(350);
    expect(render.mock.calls.length - paints).toBeLessThanOrEqual(1);
  } finally {
    result.resolve({ pass: 0, warn: 0, fail: 0, checks: [] });
    await app["handleKey"](key("q")); await running;
    read.mockRestore(); render.mockRestore(); tty.close();
  }
});

test("统计日期在后台读取时，提示过期后仍持续显示动画", async () => {
  const tty = terminal();
  const view = new StatsView();
  const result = Promise.withResolvers<tuiData.GroupStats[]>();
  const read = spyOn(tuiData, "loadStatsOverview").mockResolvedValueOnce([]).mockReturnValue(result.promise);
  const app = new App([view], { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => { app["service"] = { state: "unreachable" }; };
  const choose = spyOn(app, "choose").mockResolvedValue("today");
  const render = spyOn(tty.screen, "render");
  const running = app.start();
  try {
    await tick();
    await app["handleKey"](key("w"));
    expect(app["refreshes"].size).toBe(0); // 日期变化不经过 App 的页面刷新队列。
    app["toastState"]!.at -= 10_000;
    const frames = () => new Set(render.mock.calls.flatMap(([lines]) => lines
      .filter(line => line.includes("正在读取统计…")).map(line => Bun.stripANSI(line))));
    await waitFor(() => frames().size >= 3, "提示过期后的统计加载动画", 1200);
    result.resolve([]);
    await waitFor(() => !plain(render.mock.calls.at(-1)![0]).includes("正在读取"), "统计完成后的界面", 1000);
  } finally {
    result.resolve([]); await app["handleKey"](key("q")); await running;
    read.mockRestore(); choose.mockRestore(); render.mockRestore(); tty.close();
  }
});

test("回到已取消初次读取的日志页会恢复加载和跟随", async () => {
  const tty = terminal();
  const logs = new LogsView();
  const finishes: ((lines: tuiData.LogLine[]) => void)[] = [];
  const read = spyOn(tuiData, "loadLogTail").mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const app = new App([{ id: "home", label: "总览", render: () => [], hints: () => [] }, logs], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    app.go("logs");
    app.go("home");
    app.go("logs");
    expect(read).toHaveBeenCalledTimes(1);
    finishes.shift()!([{ text: "已取消的读取", level: "info" }]);
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    finishes.shift()!([{ text: "恢复后的日志", level: "info" }]);
    await tick();
    expect(plain(logs.render(context()))).toContain("恢复后的日志");
    expect(logs["timer"]).not.toBeNull();
    app.go("home");
    expect(logs["timer"]).toBeNull();
  } finally { finishes.forEach(finish => finish([])); logs.onLeave(); read.mockRestore(); tty.close(); }
});

test("页眉的服务状态无需等待 Git 查询完成", async () => {
  const tty = terminal();
  const app = new App([{ id: "home", label: "总览", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  let finish!: (value: null) => void;
  const service = spyOn(tuiData, "probeService").mockResolvedValue({ state: "ready", pid: 42, latency: 1 });
  const git = spyOn(tuiData, "loadGit").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    const refresh = app["refreshChrome"]();
    await tick();
    expect(app["service"]?.state).toBe("ready");
    finish(null);
    await refresh;
  } finally { service.mockRestore(); git.mockRestore(); tty.close(); }
});

test("总览逐项显示指标，慢磁盘和 Git 不挡住统计、导航或选中事项", async () => {
  const { app, calls } = fakeApp();
  const view = new OverviewView();
  let diskDone!: (bytes: number) => void;
  let gitDone!: (value: tuiData.GitState | null) => void;
  const recent = spyOn(tuiData, "loadRecentStats").mockResolvedValue({
    today: { asks: 12, people: 3, files: 2, images: 1, groups: 1 }, trend: [],
  });
  const tmp = spyOn(tuiData, "loadTmp").mockResolvedValue([]);
  const disk = spyOn(tuiData, "loadDiskUsage").mockImplementation(() => new Promise(resolve => { diskDone = resolve; }));
  const git = spyOn(tuiData, "loadGit").mockImplementation(() => new Promise(resolve => { gitDone = resolve; }));
  try {
    const refresh = view.refresh(app);
    expect(plain(view.render(context()))).toContain("读取中");
    expect(plain(view.render(context()))).not.toContain("0 次");
    await tick();
    for (const [columns, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(columns, rows)), context(columns, rows));
    expect(plain(view.render(context()))).toContain("12 次");
    expect(plain(view.render(context()))).toContain("版本读取中");
    view.onKey(key("down"), app); // 常用入口中的日志。
    diskDone(4096);
    gitDone({ branch: "main", sha: "abcdef12345", subject: "fixture", dirty: true, behind: 0, ahead: 0, incoming: [] });
    await refresh;
    view.onKey(key("enter"), app);
    expect(calls.destinations).toEqual(["logs"]);
    expect(plain(view.render(context()))).toContain("abcdef1");

    recent.mockRejectedValueOnce(new Error("fixture stats failed"));
    const retry = view.refresh(app);
    await tick();
    expect(plain(view.render(context()))).toContain("12 次");
    expect(plain(view.render(context()))).toContain("统计读取失败");
    diskDone(8192);
    gitDone(null);
    await retry;
  } finally { recent.mockRestore(); tmp.mockRestore(); disk.mockRestore(); git.mockRestore(); }
});

test("初次读取尚未完成也可以退出，终端立即恢复", async () => {
  const tty = terminal();
  let finish!: () => void;
  const app = new App([{
    id: "slow", label: "总览", render: () => [], hints: () => [],
    refresh: () => new Promise(resolve => { finish = resolve; }),
  }], { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => {};
  const running = app.start();
  try {
    await app["handleKey"](key("q"));
    await running;
    expect(tty.screen.isActive).toBe(false);
    expect(tty.input.isRaw).toBe(false);
  } finally { finish(); tty.close(); }
});

test("后台查询未完成时 q 仍可退出", async () => {
  const tty = terminal();
  let finish!: (handled: boolean) => void;
  const app = new App([{
    id: "query", label: "日志", render: () => [], hints: () => [],
    onKey: () => new Promise(resolve => { finish = resolve; }),
  }], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    const query = app["handleKey"](key("t"));
    await app["handleKey"](key("q"));
    expect(app["quit"]).toBe(true);
    finish(true);
    await query;
  } finally { finish(true); tty.close(); }
});

test("选择菜单支持中文筛选、取消和长列表，禁用项不会被执行", async () => {
  const tty = terminal();
  const app = new App([{ id: "fixture", label: "测试", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    const selection = app.choose({ title: "操作", choices: [
      { value: "restart", label: "重启服务" },
      { value: "stop", label: "停止服务", disabled: true, description: "正在刷新，请稍后" },
    ] });
    for (const text of "停止") await app["handleKey"](key(text, text));
    await app["handleKey"](key("enter"));
    expect(app["modal"]?.kind).toBe("select");
    expect(plain(app["renderModal"](72, 20))).toContain("不可用");
    await app["handleKey"]({ ...key("u"), ctrl: true });
    for (const text of "重启") await app["handleKey"](key(text, text));
    await app["handleKey"](key("enter"));
    expect(await selection).toBe("restart");

    const long = app.choose({ title: "长列表", description: "范围说明".repeat(60),
      choices: Array.from({ length: 60 }, (_, index) => ({
        value: String(index), label: "选项 " + index, description: "选项说明".repeat(80),
      })),
    });
    await app["handleKey"](key("end"));
    const frame = app["renderModal"](72, 20);
    expect(frame.length).toBeLessThanOrEqual(20);
    for (const line of frame) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(72);
    expect(plain(frame)).toContain("选项 59");
    expect(plain(frame)).toContain("Esc 取消");
    await app["handleKey"](key("escape"));
    expect(await long).toBeNull();
  } finally { tty.close(); }
});

test("终端交接期间不吃键或重绘，成功与异常退出都恢复原始模式和键盘", async () => {
  const tty = terminal();
  const keys: string[] = [];
  tty.screen.start(key => keys.push(key.name), () => {});
  try {
    for (const fails of [false, true]) {
      const operation = tty.screen.suspend(async () => {
        expect(tty.screen.isActive).toBe(false);
        expect(tty.input.isRaw).toBe(false);
        expect(tty.input.isPaused()).toBe(true);
        const before = tty.text();
        tty.screen.render(["不该出现"]);
        tty.input.emit("keypress", "q", { name: "q" });
        expect(tty.text()).toBe(before);
        if (fails) throw new Error("fixture child failed");
      });
      if (fails) await expect(operation).rejects.toThrow("fixture child failed");
      else await operation;
      expect(tty.screen.isActive).toBe(true);
      expect(tty.input.isRaw).toBe(true);
      expect(tty.input.isPaused()).toBe(false);
      tty.input.write("j");
      await tick();
    }
    expect(keys).toEqual(["j", "j"]);
    expect(tty.input.listenerCount("keypress")).toBe(1);
  } finally { tty.close(); }
});

test("输入框区分空白与取消，支持中文、空格和大小写确认词", async () => {
  const tty = terminal();
  const app = new App([new OverviewView()], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    const blank = app.ask("留空不限");
    await app["handleKey"](key("enter"));
    expect(await blank).toBe("");
    const cancelled = app.ask("Esc 取消", "2026-09-01");
    await app["handleKey"](key("escape"));
    expect(await cancelled).toBeNull();
    const confirm = app.confirm({ title: "确认", subject: "fixture", steps: [], typeToConfirm: "确认 Ab" });
    for (const text of "确认 Ab") await app["handleKey"](key(text === " " ? "space" : text, text));
    await app["handleKey"](key("enter"));
    expect(await confirm).toBe(true);
  } finally { tty.close(); }
});

test("子进程启动失败会结束执行面板，仍可按回车返回", async () => {
  const tty = terminal();
  const app = new App([{ id: "fixture", label: "测试", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => {};
  tty.screen.start(() => {}, () => {});
  const spawn = spyOn(Bun, "spawn").mockImplementationOnce(() => { throw new Error("fixture spawn failed"); });
  try {
    expect(await app.run("启动失败测试", ["fixture-only"])).toBe(1);
    expect(plain(app["renderAction"](80, 24))).toContain("fixture spawn failed");
    await app["handleKey"](key("enter"));
    expect(app["action"]).toBeNull();
  } finally { spawn.mockRestore(); tty.close(); }
});

test("完成的执行面板按方向键回看而不关闭，长输出首尾可达；确认控制键固定可见", async () => {
  const tty = terminal();
  const app = new App([new OverviewView()], { screen: tty.screen, deployment });
  tty.screen.start(() => {}, () => {});
  try {
    app["action"] = {
      title: "测试输出", lines: Array.from({ length: 800 }, (_, i) => `第 ${i} 行 ` + "完整输出".repeat(18)),
      done: true, code: 0, cancel() {}, startedAt: Date.now(), scroll: new Viewport(true),
    };
    expect(plain(app["renderAction"](80, 24))).toContain("第 799 行");
    await app["handleKey"](key("home"));
    expect(plain(app["renderAction"](80, 24))).toContain("第 0 行");
    await app["handleKey"](key("down"));
    expect(app["action"]).not.toBeNull();
    await app["handleKey"](key("end"));
    expect(plain(app["renderAction"](80, 24))).toContain("第 799 行");
    await app["handleKey"](key("enter"));
    expect(app["action"]).toBeNull();
    const confirmation = app.confirm({ title: "清理", subject: "范围说明".repeat(40), steps: Array(20).fill("步骤详情"), danger: true });
    const frame = app["renderModal"](72, 20);
    expect(frame.length).toBeLessThanOrEqual(20);
    expect(plain(frame)).toContain("Esc 取消");
    await app["handleKey"](key("end"));
    expect(plain(app["renderModal"](72, 20))).toContain("20. 步骤详情");
    await app["handleKey"](key("escape"));
    expect(await confirmation).toBe(false);
  } finally { tty.close(); }
});

test("总览的待办与常用入口可直接进入具体功能", () => {
  const view = new OverviewView();
  const { app, calls } = fakeApp();
  Object.assign(view, { state: { kind: "ready", value: {
    today: { asks: 0, people: 0, files: 0, images: 0, groups: 0 }, trend: [], disk: 0,
    git: { branch: "main", sha: "123456789", dirty: true, ahead: 0, behind: 0 },
    tmp: [{ bytes: 10, entries: [{ newest: 0, bytes: 10 }] }],
  } } });
  for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
  // 告警在前（未提交改动 danger 排在陈旧 tmp warn 前面），常用入口固定在后，回车都是「去处理」。
  view.onKey(key("enter"), app);
  view.onKey(key("down"), app);
  view.onKey(key("enter"), app);
  view.onKey(key("end"), app);
  view.onKey(key("enter"), app);
  expect(calls.destinations).toEqual(["maintain", "storage", "maintain"]);
  const shown = plain(view.render(context()));
  expect(shown).toContain("查看运行日志");
  // 分隔线右端只数需要关注的条数，不把四个常驻入口算进去。
  expect(shown).toContain("2 项待关注");
  view.onKey(key("health"), app);
  expect(calls.destinations.at(-1)).toBe("health");
  const maintain = new MaintainView();
  Object.assign(maintain, { platform: "windows", state: { kind: "ready", value: {
    sha: "123456789", behind: 24, incoming: Array.from({ length: 24 }, (_, i) => ({ sha: String(i), subject: "待应用更新" })),
  } } });
  fits(maintain.render(context(72, 20)), context(72, 20));
});

test("健康页可展开完整结果和建议，窄窗口不会遮住分页或底部内容", async () => {
  const view = new HealthView();
  const { app } = fakeApp();
  Object.assign(view, { state: { kind: "ready", value: { pass: 0, warn: 0, fail: 22,
    checks: Array.from({ length: 22 }, (_, index) => ({ name: `检查 ${index}`, status: "fail",
      detail: "完整诊断内容".repeat(200), fix: "修复建议".repeat(100) + "建议末尾" })),
  } } });
  for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
  expect(view.hints()).toContainEqual(["f", "重建修复"]);
  await view.onKey(key("enter"), app);
  fits(view.render(context()), context());
  expect(plain(view.render(context()))).toContain("完整诊断内容");
  await view.onKey(key("end"), app);
  expect(plain(view.render(context()))).toContain("建议末尾");
  await view.onKey(key("escape"), app);
  expect(plain(view.render(context()))).toContain("检查项");
});

test("维护页在两个平台均可完成部署、升级、重启和修复，交互向导使用终端交接", async () => {
  const check = spyOn(tuiData, "loadUpgrade").mockResolvedValue({ targetSha: "987654321", git: {
    branch: "main", sha: "123456789", subject: "fixture", ahead: 0, behind: 1, dirty: false, incoming: [{ sha: "987654321", subject: "fixture" }],
  } });
  try {
  for (const platform of ["windows", "linux"] as const) {
    const { app, calls } = fakeApp();
    app.deployment.platform = platform;
    app.deployment.runtime = platform === "windows" ? "scheduled-task" : "docker";
    const interactive: string[][] = [];
    app.runInteractive = async (title, args) => { interactive.push(args); calls.commands.push({ title, args }); return 0; };
    const view = new MaintainView();
    Object.assign(view, { platform, state: { kind: "ready", value: { sha: "123456789", behind: 1, dirty: false, incoming: [{ sha: "987654321", subject: "fixture" }] } } });
    const expected = [["start"], ["restart"], ["stop"], ["update"], ["deploy"],
      platform === "windows" ? ["doctor", "-Repair"] : ["deploy"], ...(platform === "windows" ? [["repair-tunnel"]] : []), ["uninstall"]];
    for (let i = 0; i < expected.length; i++) {
      fits(view.render(context(72, 20)), context(72, 20));
      await view.onKey(key("enter"), app);
      await view.onKey(key("down"), app);
    }
    expect(calls.commands.map(call => call.args)).toEqual(expected);
    expect(interactive).toEqual([["update"], ["deploy"], ...(platform === "linux" ? [["deploy"]] : []), ["uninstall"]]);
    expect(calls.confirms.at(-1)?.typeToConfirm).toBe("卸载");
    const health = new HealthView();
    Object.assign(health, { platform, state: { kind: "ready", value: { pass: 0, warn: 0, fail: 1, checks: [{ name: "fixture", status: "fail", detail: "fixture" }] } } });
    await health.onKey(key("f"), app);
    expect(calls.commands.at(-1)?.args).toEqual(platform === "windows" ? ["doctor", "-Repair"] : ["deploy"]);
  }
  } finally { check.mockRestore(); }
});

test.each([
  { args: ["doctor", "-Repair"], readOnly: false },
  { args: ["routes", "list"], readOnly: true },
  { args: ["routes", "reset", "fixture", "--group", "group"], readOnly: false },
])("执行面板收到 Esc：只读列表可中止，维护写入等待完成（%j）", async ({ args, readOnly }) => {
  const tty = terminal();
  const app = new App([{ id: "fixture", label: "测试", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  app["refreshChrome"] = async () => {};
  tty.screen.start(() => {}, () => {});
  let killed = false, finish!: (code: number) => void, output!: ReadableStreamDefaultController<Uint8Array>;
  const child = { exited: new Promise<number>(resolve => { finish = resolve; }),
    stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    kill() { killed = true; finish(143); } };
  const spawn = spyOn(Bun, "spawn").mockImplementationOnce(() => child as ReturnType<typeof Bun.spawn>);
  try {
    const done = app.run("测试命令", [...args]);
    await app["handleKey"](key("escape"));
    expect(killed).toBe(readOnly);
    output.enqueue(new TextEncoder().encode("MAINTENANCE_DONE\n")); output.close(); finish(0);
    expect(await done).toBe(readOnly ? 143 : 0);
    expect(plain(app["renderAction"](80, 24))).toContain("MAINTENANCE_DONE");
  } finally { spawn.mockRestore(); finish(0); tty.close(); }
});

async function history(root: string, group: string, user: string, days = ["2026-09-12"]) {
  const dir = join(root, group, "users", user);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.jsonl"), days.flatMap(day => [
    { type: "message", timestamp: day + "T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "统计" }] } },
    { type: "message", timestamp: day + "T12:01:00Z", message: { role: "assistant", content: [{ type: "toolCall", name: "fixture_tool" }] } },
  ]).map(line => JSON.stringify(line)).join("\n") + "\n");
  // 统计页读的是账本，不是会话文件本身。
  await sweepSessionStats(root, { force: true });
}

test("统计、会话和临时文件刷新保留列表，切换数据根后清除旧范围", async () => {
  const fixture = await tempFixture("tui-refresh-scope-");
  const finishes: (() => void)[] = [];
  const mocks: { mockRestore(): void }[] = [];
  try {
    await history(fixture.root, "old-group", "13812345678");
    const tmp = join(fixture.root, "old-group", "users", "13812345678", "tmp");
    await mkdir(tmp);
    await writeFile(join(tmp, "sample.txt"), "fixture");
    const { app, calls } = fakeApp(fixture.root);
    const stats = new StatsView();
    const views = [stats, new HistoryView(), new StorageView()];
    for (const view of views) await view.refresh(app);
    const statsValue = await tuiData.loadStatsOverview(fixture.root);
    const historyValue = await tuiData.loadHistory(fixture.root);
    const tmpValue = await tuiData.loadTmp(fixture.root);
    let empty = false;
    mocks.push(
      spyOn(tuiData, "loadStatsOverview").mockImplementation(() => new Promise(resolve => { finishes.push(() => resolve(empty ? [] : statsValue)); })),
      spyOn(tuiData, "loadHistory").mockImplementation(() => new Promise(resolve => { finishes.push(() => resolve(empty ? [] : historyValue)); })),
      spyOn(tuiData, "loadTmp").mockImplementation(() => new Promise(resolve => { finishes.push(() => resolve(empty ? [] : tmpValue)); })),
    );
    for (const view of views) {
      const refresh = view.refresh(app);
      expect(plain(view.render(context()))).toContain("old-group");
      expect(plain(view.render(context()))).not.toContain("正在读取");
      finishes.shift()!();
      await refresh;
    }
    calls.choices.push("today");
    const window = stats.onKey(key("w"), app);
    await tick();
    expect(plain(stats.render(context()))).toContain("正在读取");
    expect(plain(stats.render(context()))).not.toContain("old-group");
    finishes.shift()!();
    await window;

    app.deployment.groupDataRoot = join(fixture.root, "new-root");
    empty = true;
    for (const view of views) {
      calls.answers.push("old-group");
      await view.onKey(key("/"), app);
      const filter = view instanceof StatsView ? view["filter"] : view instanceof HistoryView ? view["filter"] : view["filter"];
      expect(filter.value).toBe("old-group");
      const refresh = view.refresh(app);
      expect(filter.value).toBe("");
      expect(plain(view.render(context()))).toContain("正在读取");
      expect(plain(view.render(context()))).not.toContain("old-group");
      finishes.shift()!();
      await refresh;
    }
  } finally { finishes.forEach(finish => finish()); mocks.forEach(mock => mock.mockRestore()); await fixture.cleanup(); }
});

test("选中升级先联网，后台检查不阻塞导航，预览与确认显示最新目标提交", async () => {
  const { app, calls } = fakeApp();
  app.runInteractive = async (title, args) => { calls.commands.push({ title, args }); return 0; };
  const view = new MaintainView();
  const cached: tuiData.GitState = { branch: "main", sha: "1111111", subject: "installed", dirty: false, ahead: 0, behind: 1,
    incoming: [{ sha: "2222222", subject: "previous update" }] };
  const fresh: tuiData.UpgradeState = { targetSha: "3333333", git: { ...cached, behind: 2,
    incoming: [{ sha: "3333333", subject: "newest update" }, ...cached.incoming] } };
  const check = Promise.withResolvers<tuiData.UpgradeState | null>();
  const local = spyOn(tuiData, "loadGit").mockResolvedValue(cached);
  const remote = spyOn(tuiData, "loadUpgrade").mockReturnValue(check.promise);
  try {
    await view.refresh(app);
    expect(remote).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) await view.onKey(key("down"), app);
    const pending = view.refresh(app);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(view.activity()).toContain("最新提交");
    expect(plain(view.render(context()))).not.toContain("previous update");
    await view.onKey(key("enter"), app);
    expect(calls.confirms).toHaveLength(0);
    expect(calls.commands).toHaveLength(0);
    check.resolve(fresh); await pending;
    for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
    const preview = plain(view.render(context(120, 35)));
    expect(preview).toContain("3333333");
    expect(preview).toContain("1111111");
    expect(preview).toContain("newest update");
    expect(preview).not.toContain("上次同步");
    await view.onKey(key("enter"), app);
    expect(calls.confirms.at(-1)?.subject).toBe("1111111 → 3333333，共 2 个提交");
    expect(calls.commands.at(-1)?.args).toEqual(["update"]);
  } finally { view.onLeave(); check.resolve(fresh); local.mockRestore(); remote.mockRestore(); }
});

test("升级检查失败后拒绝确认，离开取消旧检查，重入和刷新获取新版本", async () => {
  const { app, calls } = fakeApp();
  const view = new MaintainView();
  const git: tuiData.GitState = { branch: "main", sha: "1111111", subject: "installed", dirty: false, ahead: 0, behind: 0, incoming: [] };
  const local = spyOn(tuiData, "loadGit").mockResolvedValue(git);
  const old = Promise.withResolvers<tuiData.UpgradeState | null>();
  let signal: AbortSignal | undefined;
  const remote = spyOn(tuiData, "loadUpgrade").mockImplementationOnce(value => { signal = value; return old.promise; });
  try {
    await view.refresh(app);
    await view.onKey(key("update"), app);
    const pending = view.refresh(app);
    await view.onKey(key("home"), app);
    expect(signal?.aborted).toBe(true);
    remote.mockRejectedValueOnce(new Error("network unavailable"));
    await view.onKey(key("update"), app);
    expect(view["upgrade"].state.kind).toBe("error");
    old.resolve({ git, targetSha: "2222222" }); await pending;
    expect(view["upgrade"].state.kind).toBe("error");
    expect(plain(view.render(context(120, 35)))).toContain("network unavailable");
    await view.onKey(key("enter"), app);
    expect(calls.confirms).toHaveLength(0);
    expect(calls.commands).toHaveLength(0);
    remote.mockResolvedValue({ git, targetSha: "3333333" });
    await view.refresh(app);
    expect(plain(view.render(context()))).toContain("3333333");
    view.invalidate();
    expect(view["upgrade"].state.kind).toBe("idle");
    remote.mockResolvedValue({ git: { ...git, sha: "3333333" }, targetSha: "4444444" });
    await view.refresh(app);
    expect(view.actions().find(action => action.value === "update")?.disabled).toBe(false);
    expect(plain(view.render(context()))).toContain("当前 3333333 → origin/main 4444444");
  } finally { view.onLeave(); old.resolve(null); local.mockRestore(); remote.mockRestore(); }
});

test("维护页保留版本预览，刷新期间只暂停升级操作", async () => {
  const view = new MaintainView();
  const { app, calls } = fakeApp();
  const value: tuiData.GitState = { branch: "main", sha: "abcdef1234", subject: "fixture", dirty: false, ahead: 0, behind: 0, incoming: [] };
  const git = spyOn(tuiData, "loadGit").mockResolvedValue(value);
  let finish!: (value: tuiData.GitState) => void;
  try {
    await view.refresh(app);
    git.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const refresh = view.refresh(app);
    expect(plain(view.render(context()))).toContain("abcdef1");
    expect(view.actions().find(action => action.value === "update")?.disabled).toBe(true);
    expect(view.actions().filter(action => action.value !== "update").every(action => !action.disabled)).toBe(true);
    await view.onKey(key("update"), app);
    expect(calls.commands).toHaveLength(0);
    finish(value);
    await refresh;
    expect(view.actions().some(action => !action.disabled)).toBe(true);
  } finally { git.mockRestore(); }
});

test("维护页版本读取失败时禁用升级，服务操作仍可用，并允许刷新恢复", async () => {
  const { app, calls } = fakeApp();
  const value: tuiData.GitState = { branch: "main", sha: "abcdef1234", subject: "fixture", dirty: false, ahead: 0, behind: 3, incoming: [] };
  const git = spyOn(tuiData, "loadGit");
  try {
    for (const previous of [false, true]) {
      const view = new MaintainView();
      if (previous) { git.mockResolvedValueOnce(value); await view.refresh(app); }
      git.mockRejectedValueOnce(new Error("fixture worker failed"));
      await view.refresh(app);
      expect(plain(view.render(context()))).toContain("版本读取失败");
      expect(plain(view.render(context()))).not.toContain("abcdef1");
      expect(plain(view.render(context()))).not.toContain("非 git 部署");
      expect(view.actions().find(action => action.value === "update")?.disabled).toBe(true);
      const before = calls.commands.length;
      await view.onKey(key("update"), app);
      expect(calls.commands).toHaveLength(before);
      expect(calls.confirms).toHaveLength(0);
      await view.onKey(key("start"), app);
      expect(calls.commands.at(-1)?.args).toEqual(["start"]);
      git.mockResolvedValueOnce(value);
      await view.refresh(app);
      expect(view.actions().some(action => !action.disabled)).toBe(true);
      expect(plain(view.render(context()))).toContain("abcdef1");
    }
  } finally { git.mockRestore(); }
});

test("菜单刷新不占用按键，上一页的慢查询也不阻止刷新新页面", async () => {
  const tty = terminal();
  const pending = Promise.withResolvers<void>();
  let reads = 0;
  const first: View = { id: "first", label: "体检", render: () => [], hints: () => [], refresh: () => pending.promise };
  const second: View = { id: "second", label: "统计", render: () => [], hints: () => [], async refresh() { reads++; } };
  const app = new App([first, second], { screen: tty.screen, deployment });
  app["refreshChrome"] = () => pending.promise;
  const choose = spyOn(app, "choose").mockResolvedValue("@refresh");
  tty.screen.start(() => {}, () => {});
  const refresh = app["handleKey"](key("space"));
  try {
    await tick();
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("second");
    await tick();
    const again = app["handleKey"](key("r"));
    await tick();
    expect(reads).toBe(2);
    await app["handleKey"](key("?"));
    expect(app["modal"]?.kind).toBe("help");
    pending.resolve();
    await again;
  } finally { pending.resolve(); await refresh; await tick(); choose.mockRestore(); tty.close(); }
});

test("统计切换日期在后台加载，仍可改日期和切页，过期结果不能覆盖新范围", async () => {
  for (const dateKey of ["w", "d"]) {
    const tty = terminal();
    const view = new StatsView();
    const first = Promise.withResolvers<tuiData.GroupStats[]>();
    const second = Promise.withResolvers<tuiData.GroupStats[]>();
    const read = spyOn(tuiData, "loadStatsOverview").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
    const choose = spyOn(app, "choose").mockResolvedValueOnce("today").mockResolvedValueOnce("7");
    const ask = spyOn(app, "ask").mockResolvedValueOnce("2026-08-01").mockResolvedValueOnce("2026-08-31")
      .mockResolvedValueOnce("2026-09-01").mockResolvedValueOnce("2026-09-12");
    tty.screen.start(() => {}, () => {});
    const change = app["handleKey"](key(dateKey));
    try {
      await tick();
      expect(plain(view.render(context()))).toContain("正在读取");
      const next = app["handleKey"](key(dateKey));
      await tick();
      expect(read).toHaveBeenCalledTimes(2);
      const selected = { ...view["window"] };
      await app["handleKey"](key("right"));
      expect(app["current"].id).toBe("other");
      second.resolve([]);
      await tick();
      first.reject(new Error("旧范围读取失败"));
      await change;
      await next;
      await tick();
      expect(view["window"]).toEqual(selected);
      expect(view["overview"]).toEqual({ kind: "ready", value: [] });
    } finally {
      first.resolve([]); second.resolve([]); await change; await tick();
      read.mockRestore(); choose.mockRestore(); ask.mockRestore(); tty.close();
    }
  }
});

test("报表写入和打开浏览器不阻止导航，也不重复启动同一操作", async () => {
  const tty = terminal();
  const view = new StatsView();
  view["overview"] = { kind: "ready", value: [] };
  const saved = Promise.withResolvers<string>();
  const opened = Promise.withResolvers<void>();
  const write = spyOn(tuiReport, "writeReport").mockReturnValue(saved.promise);
  const read = spyOn(tuiData, "loadStatsOverview").mockResolvedValue([]);
  const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  const open = spyOn(app, "openFile").mockReturnValue(opened.promise);
  tty.screen.start(() => {}, () => {});
  const exporting = app["handleKey"](key("e"));
  try {
    await tick();
    expect(view.actions().find(action => action.value === "e")?.disabled).toBe(true);
    await app["handleKey"](key("e"));
    expect(write).toHaveBeenCalledTimes(1);
    app["toastState"] = null;
    app.redraw(); await tick();
    expect(plain([tty.text()])).toContain("正在导出报表…");
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("other");
    saved.resolve("fixture-report.html");
    await tick();
    await app["handleKey"](key("left"));
    const opening = app["handleKey"](key("o"));
    await tick();
    await app["handleKey"](key("o"));
    expect(open).toHaveBeenCalledTimes(1);
    app["toastState"] = null;
    app.redraw(); await tick();
    expect(plain([tty.text()])).toContain("正在打开报表…");
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("other");
    opened.resolve();
    await opening;
  } finally {
    saved.resolve("fixture-report.html"); opened.resolve(); await exporting; await tick();
    write.mockRestore(); read.mockRestore(); open.mockRestore(); tty.close();
  }
});

test("日志任务扫描不阻止翻阅或切页，离页会取消查询并忽略迟到的结果", async () => {
  const tty = terminal();
  const view = new LogsView();
  const result = Promise.withResolvers<tuiExec.RunResult>();
  const capture = spyOn(tuiExec, "capture").mockReturnValue(result.promise);
  const tail = spyOn(tuiData, "loadLogTail").mockResolvedValue([]);
  const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }], { screen: tty.screen, deployment });
  const ask = spyOn(app, "ask").mockResolvedValue("1234abcd");
  const toast = spyOn(app, "toast");
  tty.screen.start(() => {}, () => {});
  const lookup = app["handleKey"](key("t"));
  try {
    await tick();
    const signal = capture.mock.calls[0]?.[2]?.signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    await view.refresh(app);
    expect(signal?.aborted).toBe(false);
    await app["handleKey"](key("t"));
    expect(capture).toHaveBeenCalledTimes(1);
    app["toastState"] = null;
    app.redraw(); await tick();
    expect(plain([tty.text()])).toContain("正在扫描任务日志…");
    await app["handleKey"](key("home"));
    expect(view["follow"]).toBe(false);
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("other");
    expect(signal?.aborted).toBe(true);
    result.resolve({ code: 0, stdout: "结果目录：fixture-result", stderr: "", timedOut: false });
    await lookup;
    await tick();
    expect(toast.mock.calls.some(([, text]) => text.includes("fixture-result"))).toBe(false);
    expect(view["timer"]).toBeNull();
  } finally {
    result.resolve({ code: 2, stdout: "", stderr: "", timedOut: false }); await lookup; await tick();
    view.onLeave(); capture.mockRestore(); tail.mockRestore(); ask.mockRestore(); toast.mockRestore(); tty.close();
  }
});

test("后台日志查询失败或超时后可重试，成功时显示结果目录", async () => {
  const view = new LogsView();
  const { app, calls } = fakeApp();
  const capture = spyOn(tuiExec, "capture").mockRejectedValueOnce(new Error("fixture query failure"))
    .mockResolvedValueOnce({ code: 124, stdout: "", stderr: "", timedOut: true })
    .mockResolvedValueOnce({ code: 0, stdout: "结果目录：fixture-result", stderr: "", timedOut: false });
  try {
    for (const expected of ["fixture query failure", "扫描超时", "结果目录：fixture-result"]) {
      calls.answers.push("1234abcd");
      await view.onKey(key("t"), app);
      await tick();
      expect(calls.toasts.at(-1)).toContain(expected);
      expect(view.actions().find(action => action.value === "t")?.disabled).toBe(false);
    }
  } finally { view.onLeave(); capture.mockRestore(); }
});

test("进入系统页时慢版本查询不隐藏菜单、不吞方向键，也不阻止服务操作", async () => {
  const tty = terminal();
  const view = new MaintainView();
  const commands: string[][] = [];
  const app = new App([
    { id: "home", label: "总览", render: () => [], hints: () => [] },
    { id: "system", label: "系统", views: [view] },
  ], { screen: tty.screen, deployment });
  app.run = async (_title, args) => { commands.push(args); return 0; };
  let finish!: (value: null) => void;
  const pending = new Promise<null>(resolve => { finish = resolve; });
  const git = spyOn(tuiData, "loadGit").mockReturnValue(pending);
  tty.screen.start(() => {}, () => {});
  try {
    await app["handleKey"](key("right"));
    expect(plain(view.render(context()))).toContain("服务与部署");
    expect(plain(view.render(context()))).toContain("版本读取中");
    await app["handleKey"](key("down"));
    expect(plain(view.render(context()))).toContain("2 / 7");
    await app["handleKey"](key("update"));
    expect(commands).toEqual([]);
    await app["handleKey"](key("home"));
    await app["handleKey"](key("enter"));
    expect(commands).toEqual([["start"]]);
    for (const [columns, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(columns, rows)), context(columns, rows));
    await app["handleKey"](key("left"));
    expect(app["current"].id).toBe("home");
  } finally { finish(null); await tick(); git.mockRestore(); tty.close(); }
});

test("慢体检不阻止修复入口，未确认时不执行维护且仍可切页", async () => {
  const tty = terminal();
  const view = new HealthView();
  const result = Promise.withResolvers<tuiData.Health>();
  const read = spyOn(tuiData, "loadHealth").mockReturnValue(result.promise);
  const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [] }],
    { screen: tty.screen, deployment: { ...deployment, platform: "windows" } });
  const confirm = spyOn(app, "confirm").mockResolvedValue(false);
  const run = spyOn(app, "run").mockImplementation(async () => { throw new Error("取消后不应执行维护"); });
  tty.screen.start(() => {}, () => {});
  const refresh = app["refreshView"](view);
  try {
    expect(view.actions().find(action => action.value === "f")?.disabled).toBeFalsy();
    expect(view.actions().find(action => action.value === "enter")?.disabled).toBe(true);
    await app["handleKey"](key("f"));
    expect(confirm.mock.calls[0]?.[0].title).toBe("自动修复");
    expect(run).not.toHaveBeenCalled();
    await app["handleKey"](key("right"));
    expect(app["current"].id).toBe("other");
  } finally {
    result.resolve({ pass: 0, warn: 0, fail: 0, checks: [] }); await refresh;
    read.mockRestore(); confirm.mockRestore(); run.mockRestore(); tty.close();
  }
});

test("交互操作和执行面板完成后，后台刷新不再锁住导航与后续按键", async () => {
  for (const interactive of [false, true]) {
    const tty = terminal();
    let finishChrome!: () => void, finishView!: () => void;
    const chrome = new Promise<void>(resolve => { finishChrome = resolve; });
    const refresh = new Promise<void>(resolve => { finishView = resolve; });
    let completed = false, received = false;
    const view: View = {
      id: "maintain", label: "服务部署", render: () => [], hints: () => [], refresh: () => refresh,
      async onKey(key, app) {
        if (key.name !== "enter") return false;
        if (interactive) await app.runInteractive("升级", ["update"]);
        else await app.run("修复", ["doctor", "-Repair"]);
        completed = true;
        return true;
      },
    };
    const app = new App([view, { id: "other", label: "其他", render: () => [], hints: () => [], onKey() { received = true; return true; } }],
      { screen: tty.screen, deployment });
    app["refreshChrome"] = () => chrome;
    // 外部维护与终端交接已有独立测试；这里验证返回后的真实刷新和按键分发。
    const suspend = spyOn(tty.screen, "suspend").mockResolvedValue(undefined);
    const spawn = spyOn(Bun, "spawn").mockImplementationOnce(() => ({
      exited: Promise.resolve(0), kill() {},
      stdout: new ReadableStream({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    }) as ReturnType<typeof Bun.spawn>);
    tty.screen.start(() => {}, () => {});
    const operation = app["handleKey"](key("enter"));
    try {
      await tick();
      expect(completed).toBe(true);
      if (!interactive) await app["handleKey"](key("enter"));
      await app["handleKey"](key("right"));
      expect(app["current"].id).toBe("other");
      await app["handleKey"](key("down"));
      expect(received).toBe(true);
    } finally {
      finishChrome(); finishView(); await operation; await tick();
      suspend.mockRestore(); spawn.mockRestore(); tty.close();
    }
  }
});

test("统计在 80×24 先显示成员，所有成员与月度、工具均可滚到；报表路径保留且显号离页重置", async () => {
  const fixture = await tempFixture("tui-stats-view-");
  try {
    for (let i = 0; i < 24; i++) await history(fixture.root, "g1", String(13812345678 + i));
    const view = new StatsView(join(fixture.root, "reports"));
    const { app, calls } = fakeApp(fixture.root);
    await view.refresh(app);
    await view.onKey(key("enter"), app);
    for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
    expect(plain(view.render(context()))).toContain("138****5678");
    const seen: string[] = [];
    for (let i = 0; i < 45; i++) {
      seen.push(plain(view.render(context())));
      await view.onKey(key("down"), app);
    }
    for (let i = 0; i < 24; i++) expect(seen.join("\n")).toContain("138****" + String(13812345678 + i).slice(-4));
    expect(seen.join("\n")).toContain("按月");
    expect(seen.join("\n")).toContain("fixture_tool");
    await view.onKey(key("home"), app);
    await view.onKey(key("m"), app);
    expect(plain(view.render(context()))).toContain("13812345678");
    await view.onKey(key("e"), app);
    await waitFor(() => view["lastReport"] !== null, "统计报表保存", 2000);
    await view.onKey(key("o"), app);
    const report = calls.opened[0]!;
    expect(report.startsWith(fixture.root)).toBe(true);
    expect(await Bun.file(report).text()).toContain("13812345678");
    view.onLeave();
    expect(plain(view.render(context()))).toContain("138****5678");
    expect(plain(view.render(context()))).toContain("最近报表");
    fits(view.render(context(72, 20)), context(72, 20));
    await view.onKey(key("escape"), app);
    await view.onKey(key("enter"), app);
    expect(plain(view.render(context()))).not.toContain("13812345678");
  } finally { await fixture.cleanup(); }
});

test("日期仅设上限有效，取消第二次输入保留原区间，非法日期不改筛选", async () => {
  const fixture = await tempFixture("tui-date-view-");
  try {
    await history(fixture.root, "g1", "13812345678", ["2026-08-12", "2026-09-12"]);
    const view = new StatsView();
    const { app, calls } = fakeApp(fixture.root);
    await view.refresh(app);
    calls.answers.push("", "2026-08-31");
    await view.onKey(key("d"), app);
    await waitFor(() => view["overview"].kind !== "loading", "统计日期范围加载", 2000);
    expect(plain(view.render(context()))).toContain("最早 ~ 2026-08-31");
    expect(plain(view.render(context()))).toContain("1 次提问");
    calls.answers.push("2026-08-01", null);
    await view.onKey(key("d"), app);
    expect(plain(view.render(context()))).toContain("最早 ~ 2026-08-31");
    calls.answers.push("2026-02-30");
    await view.onKey(key("d"), app);
    expect(plain(view.render(context()))).toContain("最早 ~ 2026-08-31");
    expect(calls.toasts.at(-1)).toContain("日期");
  } finally { await fixture.cleanup(); }
});

test("存储清当前会同时传群与成员，清所有则明确显示范围", async () => {
  const fixture = await tempFixture("tui-storage-view-");
  try {
    for (const group of ["g1", "g2"]) {
      const dir = join(fixture.root, group, "users", "13812345678", "tmp");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sample.txt"), "fixture");
    }
    const view = new StorageView();
    const { app, calls } = fakeApp(fixture.root);
    await view.refresh(app);
    calls.choices.push("0");
    await view.onKey(key("d"), app);
    fits(view.render(context(72, 20)), context(72, 20));
    // 两行清理预览各自说清范围：一行是选中成员，一行是全部，且明说忽略筛选。
    expect(plain(view.render(context()))).toContain("p 当前");
    expect(plain(view.render(context()))).toContain("a 全部");
    expect(plain(view.render(context()))).toContain("所有群与成员，忽略筛选");
    await view.onKey(key("p"), app);
    expect(calls.commands[0]!.args).toEqual(["tmp-purge", "--all", "--group", "g1", "--user", "13812345678", "--storage-segment"]);
    expect(calls.confirms[0]!.subject).toContain("群 g1");
    await view.onKey(key("a"), app);
    expect(calls.commands[1]!.args).toEqual(["tmp-purge", "--all"]);
    expect(calls.confirms[1]!.subject).toContain("所有群的所有成员");
  } finally { await fixture.cleanup(); }
});

test("筛选临时文件后只清选中成员，全量清理仍明确覆盖所有群，详情可滚到最后一个文件", async () => {
  const fixture = await tempFixture("tui-storage-filter-");
  try {
    for (const [group, count] of [["支持 一群", 3], ["支持 二群", 32]] as const) {
      const dir = join(fixture.root, group, "users", "13812345678", "tmp");
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < count; i++) await writeFile(join(dir, `file-${String(i).padStart(2, "0")}.txt`), "fixture");
    }
    const view = new StorageView();
    const { app, calls } = fakeApp(fixture.root);
    await view.refresh(app);
    calls.choices.push(null, "0");
    await view.onKey(key("d"), app);
    expect(plain(view.render(context()))).toContain("30 天未改动");
    await view.onKey(key("d"), app);
    calls.answers.push("支持 二群", null);
    await view.onKey(key("/"), app);
    await view.onKey(key("/"), app);
    expect(plain(view.render(context()))).toContain("1 / 2");
    expect(plain(view.render(context()))).not.toContain("支持 一群");
    await view.onKey(key("p"), app);
    expect(calls.commands[0]!.args).toEqual(["tmp-purge", "--all", "--group", "支持 二群", "--user", "13812345678", "--storage-segment"]);
    await view.onKey(key("a"), app);
    expect(calls.commands[1]!.args).toEqual(["tmp-purge", "--all"]);
    expect(calls.confirms[1]!.subject).toContain("不受列表筛选影响");
    expect(calls.confirms[1]!.subject).toContain("35 个条目");
    await view.onKey(key("enter"), app);
    view.render(context());
    await view.onKey(key("end"), app);
    expect(plain(view.render(context()))).toContain("file-31.txt");
    for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
    await view.onKey(key("escape"), app);
    expect(plain(view.render(context()))).toContain("1 / 2");
    await view.onKey(key("escape"), app);
    expect(plain(view.render(context()))).toContain("支持 一群");
    calls.answers.push("没有这个群");
    await view.onKey(key("/"), app);
    await view.onKey(key("p"), app);
    expect(calls.commands).toHaveLength(2);
    expect(plain(view.render(context()))).toContain("没有匹配");
  } finally { await fixture.cleanup(); }
});

test("群筛选控制统计导出范围，常用日期可选，会话全部成员可达且清理目标正确", async () => {
  const fixture = await tempFixture("tui-groups-filter-");
  try {
    await history(fixture.root, "other-group", "13912345678");
    for (let i = 0; i < 24; i++) await history(fixture.root, "support-group", String(13812345678 + i));
    const { app, calls } = fakeApp(fixture.root);
    const stats = new StatsView(join(fixture.root, "reports"));
    await stats.refresh(app);
    calls.answers.push("support-group", null);
    await stats.onKey(key("/"), app);
    await stats.onKey(key("/"), app);
    expect(plain(stats.render(context()))).not.toContain("other-group");
    await stats.onKey(key("e"), app);
    await waitFor(() => stats["lastReport"] !== null, "筛选后的报表保存", 2000);
    await stats.onKey(key("o"), app);
    const report = await Bun.file(calls.opened[0]!).text();
    expect(report).toContain("support-group");
    expect(report).not.toContain("other-group");
    calls.choices.push("7");
    await stats.onKey(key("w"), app);
    await waitFor(() => stats["overview"].kind !== "loading", "统计日期范围加载", 2000);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    expect(stats["window"].since).toBe(start.getTime());
    const selectedWindow = { ...stats["window"] };
    calls.choices.push(null);
    await stats.onKey(key("w"), app);
    expect(stats["window"]).toEqual(selectedWindow);

    const sessions = new HistoryView();
    await sessions.refresh(app);
    calls.answers.push("support-group");
    await sessions.onKey(key("/"), app);
    await sessions.onKey(key("enter"), app);
    sessions.render(context());
    await sessions.onKey(key("end"), app);
    expect(plain(sessions.render(context()))).toContain("138****5701");
    for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(sessions.render(context(width, rows)), context(width, rows));
    await sessions.onKey(key("c"), app);
    expect(calls.commands.at(-1)?.args).toEqual(["history-clear", "support-group", "--storage-segment"]);
    await sessions.onKey(key("escape"), app);
    expect(plain(sessions.render(context()))).not.toContain("other-group");
    await sessions.onKey(key("escape"), app);
    expect(plain(sessions.render(context()))).toContain("other-group");
  } finally { await fixture.cleanup(); }
});

test("日志搜索与级别筛选可叠加，Home/End 首尾可达并恢复跟随", async () => {
  const view = new LogsView();
  const { app, calls } = fakeApp();
  Object.assign(view, { state: { kind: "ready", value: Array.from({ length: 200 }, (_, index) => ({
    level: index % 2 === 0 ? "error" : "info", text: `record-${index} ${index % 2 === 0 ? "a1b2c3d4" : "other-task"}`,
  })) } });
  view.render(context());
  await view.onKey(key("home"), app);
  expect(plain(view.render(context()))).toContain("record-0 ");
  expect(plain(view.render(context()))).toContain("已暂停");
  calls.answers.push("a1b2c3d4");
  await view.onKey(key("/"), app);
  calls.choices.push("2");
  await view.onKey(key("l"), app);
  await view.onKey(key("end"), app);
  const output = plain(view.render(context()));
  expect(output).toContain("record-198 ");
  expect(output).not.toContain("other-task");
  expect(output).toContain("跟随中");
  expect(output).toContain("100 条");
  for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
  calls.answers.push("missing-task");
  await view.onKey(key("/"), app);
  fits(view.render(context(72, 20)), context(72, 20));
  expect(plain(view.render(context()))).toContain("没有记录");
});

test("快速离开日志页后，未完成的加载不会重新启动后台轮询", async () => {
  const view = new LogsView();
  const { app } = fakeApp();
  let finish!: (lines: tuiData.LogLine[]) => void;
  const load = spyOn(tuiData, "loadLogTail").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    const refresh = view.refresh(app);
    view.onLeave();
    finish([{ text: "late result", level: "info" }]);
    await refresh;
    expect(view["timer"]).toBeNull();
    expect(view["state"].kind).not.toBe("ready");
  } finally { view.onLeave(); load.mockRestore(); }
});

test("日志设置只显示关闭和开启，取消或选择当前值不执行；失败后显示恢复的设置", async () => {
  const { app, calls } = fakeApp();
  const view = new SettingsView();
  let saved: tuiData.TunnelLogging = "off";
  const read = spyOn(tuiData, "loadTunnelLogging").mockImplementation(async () => saved);
  const confirm = spyOn(app, "confirm").mockResolvedValue(false);
  const run = spyOn(app, "run").mockImplementation(async (_title, args) => { saved = args[1] as tuiData.TunnelLogging; return 0; });
  try {
    await view.onKey(key("down"), app);
    await view.refresh(app);
    calls.choices.push(null, "off", "on");
    for (let i = 0; i < 3; i++) await view.onKey(key("l"), app);
    expect(calls.menus[0]!.choices.map(choice => choice.label)).toEqual(["关闭", "开启"]);
    expect(calls.menus[0]!.initial).toBe("off");
    expect(run).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    calls.choices.push("on");
    await view.onKey(key("l"), app);
    expect(run.mock.calls.at(-1)?.[1]).toEqual(["tunnel-logging", "on"]);
    expect(view["state"]).toEqual({ kind: "ready", value: "on" });
    run.mockResolvedValue(1);
    calls.choices.push("off");
    await view.onKey(key("l"), app);
    expect(view["state"]).toEqual({ kind: "ready", value: "on" });
    await view.onKey(key("home"), app);
    await view.onKey(key("down"), app);
    expect(plain(view.render(context(120, 35)))).not.toMatch(/debug/i);
    await view.onKey(key("v"), app);
    expect(calls.destinations).toEqual(["tunnel-logs"]);
    expect(createRelayView().actions!().map(action => action.label)).not.toContain("配置外链");
  } finally { read.mockRestore(); confirm.mockRestore(); run.mockRestore(); }
});

test("连接模式默认自动，三种选择可保存；取消、原值和恢复后的失败都正确显示", async () => {
  const { app, calls } = fakeApp();
  const view = new SettingsView();
  let saved: tuiData.TunnelProtocol = "auto";
  const read = spyOn(tuiData, "loadTunnelProtocol").mockImplementation(async () => saved);
  const confirm = spyOn(app, "confirm").mockResolvedValue(false);
  const run = spyOn(app, "run").mockImplementation(async (_title, args) => { saved = args[1] as tuiData.TunnelProtocol; return 0; });
  try {
    await view.onKey(key("p"), app);
    await view.refresh(app);
    calls.choices.push(null, "auto", "http2");
    for (let i = 0; i < 3; i++) await view.onKey(key("enter"), app);
    expect(calls.menus[0]!.choices.map(choice => choice.value)).toEqual(["auto", "http2", "quic"]);
    expect(calls.menus[0]!.initial).toBe("auto");
    expect(run).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    for (const mode of ["http2", "quic", "auto"] as const) {
      calls.choices.push(mode);
      await view.onKey(key("enter"), app);
      expect(run.mock.calls.at(-1)?.[1]).toEqual(["tunnel-protocol", mode]);
      expect(view["protocol"].state).toEqual({ kind: "ready", value: mode });
    }
    run.mockResolvedValue(1);
    calls.choices.push("http2");
    await view.onKey(key("enter"), app);
    expect(view["protocol"].state).toEqual({ kind: "ready", value: "auto" });
    for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) {
      const ctx = context(width, rows);
      fits(view.render(ctx), ctx);
      expect(plain(view.render(ctx))).toContain("Cloudflared 连接模式");
    }
  } finally { view.onLeave(); read.mockRestore(); confirm.mockRestore(); run.mockRestore(); }
});

test("离开连接模式时取消加载，迟到的结果不能覆盖状态；读取错误可重试", async () => {
  const { app } = fakeApp();
  const view = new SettingsView();
  let finish!: (value: tuiData.TunnelProtocol) => void;
  const read = spyOn(tuiData, "loadTunnelProtocol").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    await view.onKey(key("p"), app);
    const loading = view.refresh(app);
    expect(view.activity()).toContain("连接模式");
    await view.onKey(key("home"), app);
    finish("quic"); await loading;
    expect(view["protocol"].state.kind).toBe("idle");
    read.mockRejectedValueOnce(new Error("invalid preference"));
    await view.onKey(key("p"), app);
    expect(view["protocol"].state.kind).toBe("error");
    expect(plain(view.render(context(120, 35)))).toContain("invalid preference");
    read.mockResolvedValue("auto");
    await view.refresh(app);
    expect(view["protocol"].state).toEqual({ kind: "ready", value: "auto" });
  } finally { view.onLeave(); read.mockRestore(); }
});

test("隧道日志复用跟随搜索和级别筛选，读取独立文件，任务查询只用于机器人日志", async () => {
  const { app, calls } = fakeApp();
  const view = new LogsView("cloudflared");
  const read = spyOn(tuiData, "loadLogTail").mockResolvedValue([
    { level: "debug", text: "request fixture-ray" }, { level: "info", text: "connected" },
    { level: "warn", text: "retrying" }, { level: "error", text: "refused" },
  ]);
  try {
    await view.refresh(app);
    expect(read.mock.calls[0]![2]).toEndWith(join("logs", "cloudflared.log"));
    expect(plain(view.render(context()))).toContain("request fixture-ray");
    expect(view.actions().some(action => action.value === "t")).toBe(false);
    await view.onKey(key("t"), app);
    expect(calls.prompts).toEqual([]);
    calls.choices.push("1");
    await view.onKey(key("l"), app);
    const filtered = plain(view.render(context()));
    expect(filtered).toContain("retrying");
    expect(filtered).toContain("refused");
    expect(filtered).not.toContain("fixture-ray");
    calls.choices.push("0");
    await view.onKey(key("l"), app);
    calls.answers.push("fixture-ray");
    await view.onKey(key("/"), app);
    expect(plain(view.render(context()))).not.toContain("retrying");
    await view.onKey(key("o"), app);
    expect(calls.destinations).toEqual(["settings"]);
  } finally { view.onLeave(); read.mockRestore(); }
  expect(view["timer"]).toBeNull();
});

test("操作预览在宽窄窗口及无色终端都完整容纳菜单，最后一项始终可达", async () => {
  const { app } = fakeApp();
  for (const view of [new MaintainView(), new SettingsView(), createRelayView(), createRoutesView()]) {
    if (view instanceof MaintainView) view["state"] = { kind: "ready", value: null };
    await view.onKey!(key("end"), app);
    for (const [width, rows] of [[72, 20], [80, 24], [96, 20], [100, 24], [120, 35]]) {
      for (const depth of ["truecolor", "ansi256", "none"] as const) {
        const ctx = { ...context(width, rows), theme: createTheme(depth) };
        const frame = view.render(ctx);
        fits(frame, ctx);
        expect(plain(frame)).toContain(view.id === "maintain" ? "卸载" : view.id === "settings" ? "Cloudflared 日志"
          : view.id === "relay" ? "清理全部外链" : "移除废弃绑定");
      }
    }
  }
});

test("外链配置在两个平台接管真实终端，不通过普通弹窗或命令参数传递凭据", async () => {
  const settings = spyOn(tuiData, "loadTunnelLogging").mockResolvedValue("off");
  try {
    for (const platform of ["windows", "linux"] as const) {
      const { app, calls } = fakeApp();
      app.deployment.platform = platform;
      const interactive: string[][] = [];
      app.runInteractive = async (_title, args) => { interactive.push(args); return 0; };
      const view = new SettingsView();
      expect(plain(view.render(context(120, 35)))).toContain("保存前预览并确认");
      await view.onKey!(key("enter"), app);
      expect(interactive).toEqual([["relay-configure"]]);
      expect(calls.commands).toHaveLength(0);
      expect(calls.prompts).toHaveLength(0);
      expect(calls.confirms).toHaveLength(0);
      expect(calls.toasts).toEqual(["外链配置向导已结束"]);
    }
  } finally { settings.mockRestore(); }
});

test("必填输入为空会停止，路由群名中的空格完整传递", async () => {
  const { app, calls } = fakeApp();
  const relay = createRelayView();
  await relay.onKey!(key("down"), app);
  calls.answers.push(" ");
  await relay.onKey!(key("enter"), app);
  calls.answers.push("--all");
  await relay.onKey!(key("enter"), app);
  expect(calls.commands).toHaveLength(0);
  expect(calls.confirms).toHaveLength(0);
  const routes = createRoutesView();
  await routes.onKey!(key("down"), app);
  calls.answers.push("abcdef123456", "技术 支持群");
  await routes.onKey!(key("enter"), app);
  expect(calls.commands[0]!.args).toEqual(["routes", "reset", "abcdef123456", "--group", "技术 支持群"]);
});
