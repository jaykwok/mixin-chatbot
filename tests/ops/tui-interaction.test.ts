import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { App } from "../../scripts/ops/tui/app.ts";
import { Screen, type Key } from "../../scripts/ops/tui/render/screen.ts";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import { Viewport } from "../../scripts/ops/tui/render/viewport.ts";
import type { AppApi, ConfirmSpec, ViewContext } from "../../scripts/ops/tui/view.ts";
import type { Deployment } from "../../scripts/ops/tui/platform.ts";
import { HealthView } from "../../scripts/ops/tui/views/health.ts";
import { OverviewView } from "../../scripts/ops/tui/views/overview.ts";
import { StatsView } from "../../scripts/ops/tui/views/stats.ts";
import { StorageView } from "../../scripts/ops/tui/views/storage.ts";
import { MaintainView } from "../../scripts/ops/tui/views/maintain.ts";
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
  };
  const app: AppApi = {
    deployment: { ...deployment, groupDataRoot: root }, theme: createTheme("truecolor"),
    redraw() {}, go(id) { calls.destinations.push(id); }, toast(_status, text) { calls.toasts.push(text); },
    async ask(label) { calls.prompts.push(label); return calls.answers.shift() ?? null; },
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

test("总览的待办可选择并跳转到维护、存储、健康", () => {
  const view = new OverviewView();
  const { app, calls } = fakeApp();
  Object.assign(view, { state: { kind: "ready", value: {
    today: { asks: 0, people: 0, files: 0, images: 0, groups: 0 }, trend: [], disk: 0,
    git: { branch: "main", sha: "123456789", dirty: true, ahead: 0, behind: 0 },
    tmp: [{ bytes: 10, entries: [{ newest: 0, bytes: 10 }] }],
  } } });
  for (const [width, rows] of [[72, 20], [80, 24], [120, 35]]) fits(view.render(context(width, rows)), context(width, rows));
  view.onKey(key("enter"), app);
  view.onKey(key("down"), app);
  view.onKey(key("enter"), app);
  view.onKey(key("end"), app);
  view.onKey(key("enter"), app);
  expect(calls.destinations).toEqual(["maintain", "storage", "health"]);
  const maintain = new MaintainView();
  Object.assign(maintain, { platform: "windows", state: { kind: "ready", value: {
    behind: 24, incoming: Array.from({ length: 24 }, (_, i) => ({ sha: String(i), subject: "待应用更新" })),
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
    const expected = [["deploy"], ["update"], ["restart"], platform === "windows" ? ["doctor", "-Repair"] : ["deploy"],
      ["stop"], ["start"], ...(platform === "windows" ? [["repair-tunnel"]] : []), ["uninstall"]];
    for (let i = 0; i < expected.length; i++) {
      fits(view.render(context(72, 20)), context(72, 20));
      await view.onKey(key("enter"), app);
      await view.onKey(key("down"), app);
    }
    expect(calls.commands.map(call => call.args)).toEqual(expected);
    expect(interactive).toEqual([["deploy"], ["update"], ...(platform === "linux" ? [["deploy"]] : []), ["uninstall"]]);
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
    for (let i = 0; i < 4; i++) await view.onKey(key("right"), app);
    fits(view.render(context(72, 20)), context(72, 20));
    expect(plain(view.render(context()))).toContain("p 当前");
    expect(plain(view.render(context()))).toContain("a 所有群与成员");
    await view.onKey(key("p"), app);
    expect(calls.commands[0]!.args).toEqual(["tmp-purge", "--all", "--group", "g1", "--user", "13812345678", "--storage-segment"]);
    expect(calls.confirms[0]!.subject).toContain("群 g1");
    await view.onKey(key("a"), app);
    expect(calls.commands[1]!.args).toEqual(["tmp-purge", "--all"]);
    expect(calls.confirms[1]!.subject).toContain("所有群的所有成员");
  } finally { await fixture.cleanup(); }
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
