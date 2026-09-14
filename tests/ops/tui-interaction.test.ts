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
import * as tuiData from "../../scripts/ops/tui/data.ts";
import { createRelayView, createRoutesView } from "../../scripts/ops/tui/views/passthrough.ts";
import { tempFixture } from "../helpers/temp.ts";

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
      frame: 0, done: true, code: 0, cancel() {}, startedAt: Date.now(), scroll: new Viewport(true),
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
});

test("自动修复的执行面板收到 Esc 后等待维护完成", async () => {
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
    const done = app.run("自动修复", ["doctor", "-Repair"]);
    await app["handleKey"](key("escape"));
    expect(killed).toBe(false);
    output.enqueue(new TextEncoder().encode("MAINTENANCE_DONE\n")); output.close(); finish(0);
    expect(await done).toBe(0);
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

test("维护页保留版本预览，但新版本查询结束前不能执行操作", async () => {
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
    expect(view.actions().every(action => action.disabled)).toBe(true);
    await view.onKey(key("enter"), app);
    expect(calls.commands).toHaveLength(0);
    finish(value);
    await refresh;
    expect(view.actions().some(action => !action.disabled)).toBe(true);
  } finally { git.mockRestore(); }
});

test("维护页首次或再次读取失败时显示错误、禁用执行，并允许刷新恢复", async () => {
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
      expect(view.actions().every(action => action.disabled)).toBe(true);
      for (const name of ["enter", "update", "start"]) await view.onKey(key(name), app);
      expect(calls.commands).toHaveLength(0);
      expect(calls.confirms).toHaveLength(0);
      git.mockResolvedValueOnce(value);
      await view.refresh(app);
      expect(view.actions().some(action => !action.disabled)).toBe(true);
      expect(plain(view.render(context()))).toContain("abcdef1");
    }
  } finally { git.mockRestore(); }
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
    await stats.onKey(key("o"), app);
    const report = await Bun.file(calls.opened[0]!).text();
    expect(report).toContain("support-group");
    expect(report).not.toContain("other-group");
    calls.choices.push("7");
    await stats.onKey(key("w"), app);
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

test("操作预览在宽窄窗口及无色终端都完整容纳菜单，最后一项始终可达", async () => {
  const { app } = fakeApp();
  for (const view of [new MaintainView(), createRelayView(), createRoutesView()]) {
    if (view instanceof MaintainView) view["state"] = { kind: "ready", value: null };
    await view.onKey!(key("end"), app);
    for (const [width, rows] of [[72, 20], [80, 24], [96, 20], [100, 24], [120, 35]]) {
      for (const depth of ["truecolor", "ansi256", "none"] as const) {
        const ctx = { ...context(width, rows), theme: createTheme(depth) };
        const frame = view.render(ctx);
        fits(frame, ctx);
        expect(plain(frame)).toContain(view.id === "maintain" ? "卸载" : view.id === "relay" ? "清理全部外链" : "移除废弃绑定");
      }
    }
  }
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
