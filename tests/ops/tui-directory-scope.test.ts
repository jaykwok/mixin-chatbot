import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { DepartmentDescription, DepartmentInfo } from "../../src/integrations/open-platform/directory.ts";
import { createApp } from "../../src/server/http-app.ts";
import { App } from "../../scripts/ops/tui/app.ts";
import { shutdownTui, startQueries } from "../../scripts/ops/tui/exec.ts";
import { tempFixture } from "../helpers/temp.ts";
import { Screen, type Key } from "../../scripts/ops/tui/render/screen.ts";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import type { AppApi, ConfirmSpec, Dialog } from "../../scripts/ops/tui/view.ts";
import type { Deployment } from "../../scripts/ops/tui/platform.ts";
import { pickDirectoryScope, ScopePicker, serviceDepartments, type DepartmentSource } from "../../scripts/ops/tui/views/directory-scope.ts";
import { createDirectoryView } from "../../scripts/ops/tui/views/passthrough.ts";

const deployment: Deployment = { platform: "linux", runtime: "docker", port: 1011, dataRoot: "unused", workspaceRoot: "" };
const theme = createTheme("truecolor");
const key = (name: string, text?: string): Key => ({ name, raw: name, text, ctrl: false, shift: false });
const ctrl = (name: string): Key => ({ ...key(name), ctrl: true });
const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line)).join("\n");
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

// 1 → 总部(100) → 研发中心(110) → 平台组(111)、客户端组(112)；总部 → 市场部(120)；1 → 华东分公司(200) → 上海办(210)；1 → 华南分公司(300)。
const tree: Record<string, DepartmentInfo[]> = {
  "1": [{ id: "100", name: "总部", count: 30 }, { id: "200", name: "华东分公司", count: 12 }, { id: "300", name: "华南分公司" }],
  "100": [{ id: "110", name: "研发中心", count: 20 }, { id: "120", name: "市场部", count: 10 }],
  "110": [{ id: "111", name: "平台组", count: 8 }, { id: "112", name: "客户端组", count: 12 }],
  "200": [{ id: "210", name: "上海办", count: 12 }],
};

function fakeSource(scope?: string[], options: { described?: DepartmentDescription; failScope?: boolean; failOnce?: Set<string>; failNames?: number } = {}) {
  const calls = { children: [] as string[], describe: [] as string[][], signals: [] as (AbortSignal | undefined)[] };
  const source: DepartmentSource = {
    async scope(signal) {
      calls.signals.push(signal);
      if (options.failScope) throw new Error("本机端口 1011 无响应；服务可能没有运行");
      return scope;
    },
    async children(parent, signal) {
      calls.signals.push(signal);
      calls.children.push(parent);
      if (options.failOnce?.delete(parent)) throw new Error("读取部门失败：HTTP 500");
      return tree[parent] ?? [];
    },
    async describe(ids, signal) {
      calls.signals.push(signal);
      calls.describe.push([...ids]);
      if (options.failNames && options.failNames-- > 0) throw new Error("读取部门详情失败：部门 111：通讯录 /open/v2/dept/get：连接失败（ECONNREFUSED）");
      return options.described ?? { departments: [], unavailable: [] };
    },
  };
  return { source, calls };
}

async function open(scope?: string[], options?: Parameters<typeof fakeSource>[1]) {
  const { source, calls } = fakeSource(scope, options);
  const picker = new ScopePicker(source, () => {});
  await settle();
  const press = async (...keys: (string | Key)[]) => {
    let result: ReturnType<ScopePicker["onKey"]> = undefined;
    for (const entry of keys) { result = picker.onKey(typeof entry === "string" ? key(entry, entry === "space" ? " " : undefined) : entry); await settle(); }
    return result;
  };
  const shown = (width = 70, height = 20) => plain(picker.render(theme, width, height));
  return { picker, calls, press, shown };
}

function fits(lines: string[], width: number, height: number) {
  expect(lines.length).toBeLessThanOrEqual(height);
  for (const line of lines) expect(Bun.stringWidth(line)).toBe(width);
}

test("部门逐层展开，任意层级跨分支混选；已选上级之下标“已包含在上级中”，选上级时并入已单独勾选的下级", async () => {
  const { picker, calls, press, shown } = await open(undefined);
  expect(picker.note()).toBe("整个通讯录");
  expect(shown()).toContain("位置 › 全部部门");
  expect(shown()).toContain("30 人");
  // A third-level department under 总部 → 研发中心, then a first-level one in another branch.
  await press("right", "right");
  expect(shown()).toContain("位置 › 全部部门 / 总部 / 研发中心");
  await press("space");
  expect(shown()).toContain("已勾选「总部 / 研发中心 / 平台组」（含全部子部门）");
  await press("left", "left", "down", "space");
  expect(picker.note()).toBe("已选 2 个部门");
  // From the root, 总部 shows the selection below it.
  await press("up");
  expect(shown()).toMatch(/总部\s+30 人\s+含 1 个已选下级/);
  // Under a selected department everything is covered and cannot be ticked on its own.
  await press("down", "right");
  expect(shown()).toContain("上海办");
  expect(shown()).toContain("已包含在上级中");
  await press("space");
  expect(shown()).toContain("已包含在已选的「华东分公司」中；要单独选它，先取消上级");
  expect(picker.note()).toBe("已选 2 个部门");
  // Ticking 总部 takes 平台组 in; the list keeps one entry per subtree.
  await press("left", "up", "space");
  expect(shown()).toContain("原先单独勾选的 1 个下级部门并入其中");
  expect(await press("enter")).toEqual({ done: ["200", "100"] });
  // Levels already read are not read again.
  expect(calls.children).toEqual(["1", "100", "110", "200"]);
  for (const [width, height] of [[62, 16], [70, 20], [96, 40]] as const) fits(picker.render(theme, width, height), width, Math.min(height, 28));
});

test("打开时的范围补全名称和路径：已选列表按路径显示，平台拒绝的部门标出，未改动时交回原范围", async () => {
  const described: DepartmentDescription = {
    departments: [
      { id: "111", name: "平台组", count: 8, fullName: "集团|总部|研发中心|平台组", ancestors: [{ id: "100", name: "总部" }, { id: "110", name: "研发中心" }] },
      { id: "210", name: "上海办", ancestors: [{ id: "200", name: "华东分公司" }] },
    ],
    unavailable: [{ id: "999", message: "部门不属于当前组织（code=422010）" }],
  };
  const { picker, calls, press, shown } = await open(["111", "210", "999"], { described });
  expect(calls.describe).toEqual([["111", "210", "999"]]);
  expect(picker.note()).toBe("已选 3 个部门");
  expect(shown()).toContain("已选 3 个：总部 / 研发中心 / 平台组；华东分公司 / 上海办；999");
  // The chains from the details mark the branches at the root.
  expect(shown()).toMatch(/总部\s+30 人\s+含 1 个已选下级/);
  expect(shown()).toMatch(/华东分公司\s+12 人\s+含 1 个已选下级/);
  await press("tab");
  expect(shown()).toContain("与当前范围相同");
  // The row already shows the path; the platform's full_name (with the organisation's name in front) is not repeated.
  expect(shown().split("\n").map(line => line.trimEnd())).toContain("ID 111");
  await press("end");
  expect(shown()).toMatch(/999\s+平台拒绝/);
  expect(shown()).toContain("ID 999 · 需先移出，否则保存被拒：部门不属于当前组织（code=422010）");
  expect(picker.changed).toBe(false);
  expect(await press("enter")).toEqual({ done: ["111", "210", "999"] });
  // Ticking 总部 at the root folds 平台组 (known from its chain) into it.
  await press("tab", "home", "space");
  expect(picker.changed).toBe(true);
  const spec = picker.confirmation();
  expect(spec.subject).toBe("只同步 3 个部门及其子部门：华东分公司 / 上海办；999；总部");
  expect(spec.steps[0]).toBe("当前范围 3 个部门；新增 总部；移出 总部 / 研发中心 / 平台组");
  await press("tab", "end", "space");
  expect(picker.note()).toBe("已选 2 个部门");
});

test("在部门列表里取消勾选让已选列表变短后，已选列表的光标落回末项，Space 照常移出", async () => {
  const { picker, press, shown } = await open(undefined);
  await press("space", "down", "space", "down", "space");
  expect(picker.note()).toBe("已选 3 个部门");
  // The cursor sits on the third entry of the picked list, then 华南分公司 is unticked from the browse view.
  await press("tab", "end", "tab", "space");
  expect(picker.note()).toBe("已选 2 个部门");
  await press("tab");
  expect(shown()).toContain("2 / 2");
  expect(shown()).toContain("ID 200");
  await press("space");
  expect(picker.note()).toBe("已选 1 个部门");
  expect(await press("enter")).toEqual({ done: ["100"] });
});

test("名称没查成（网络、平台故障）不算平台拒绝：只提示重试，r 重读名称，勾选和保存照常", async () => {
  const described: DepartmentDescription = { departments: [{ id: "111", name: "平台组", ancestors: [{ id: "100", name: "总部" }, { id: "110", name: "研发中心" }] }],
    unavailable: [] };
  const { picker, calls, press, shown } = await open(["111", "999"], { described, failNames: 1 });
  expect(shown(100)).toContain("部门名称没读到（不影响勾选和保存；Tab 到已选列表按 r 重试）：读取部门详情失败：部门 111");
  // r is filter text in the department list.
  await press(key("r", "r"));
  expect(shown()).toContain("筛选 › r");
  await press(ctrl("u"), "tab");
  const failed = shown(100);
  expect(failed).toContain("按 r 重试");
  expect(failed).toContain("r 重读名称");
  expect(failed).not.toContain("平台拒绝");
  expect(failed).not.toContain("会拒绝");
  expect(failed).toMatch(/111\s+名称未知/);
  expect(picker.changed).toBe(false);
  await press(key("r", "r"));
  expect(calls.describe).toEqual([["111", "999"], ["111", "999"]]);
  expect(shown()).toContain("总部 / 研发中心 / 平台组");
  expect(shown()).not.toContain("r 重读名称");
  // Read once it worked: r does nothing more.
  await press(key("r", "r"));
  expect(calls.describe).toHaveLength(2);
  expect(await press("enter")).toEqual({ done: ["111", "999"] });
});

test("选择器的查询带着它的取消信号：交回结果或取消后信号中止，迟到的答复不再改动选择器", async () => {
  // Every way out of the picker aborts the signal its queries carry, before any command runs.
  for (const [scope, keys, confirms] of [[undefined, ["escape"], []], [["200"], ["enter"], []], [undefined, ["space", "enter"], [true]]] as const) {
    const flow = flowApp([...confirms]);
    const { source, calls } = fakeSource(scope ? [...scope] : undefined);
    let abortedAtRun: boolean[] = [];
    flow.app.run = async (_title, args) => { abortedAtRun = calls.signals.map(signal => signal!.aborted); flow.calls.commands.push(args); return 0; };
    const done = pickDirectoryScope(flow.app, source);
    await flow.press(...keys);
    await done;
    expect(calls.signals.length).toBeGreaterThan(0);
    expect(calls.signals.every(signal => signal?.aborted)).toBe(true);
    if (flow.calls.commands.length) expect(abortedAtRun.every(Boolean)).toBe(true);
  }
  // Answers that arrive after the close leave the picker as it was and redraw nothing.
  const answer = Promise.withResolvers<DepartmentDescription>(), children = Promise.withResolvers<DepartmentInfo[]>();
  const controller = new AbortController();
  let redraws = 0;
  const picker = new ScopePicker({ scope: async () => ["111"], children: () => children.promise, describe: () => answer.promise }, () => { redraws++; }, controller.signal);
  await settle();
  controller.abort(new Error("选择器已关闭"));
  const before = redraws, frame = plain(picker.render(theme, 70, 20));
  answer.resolve({ departments: [{ id: "111", name: "平台组" }], unavailable: [] });
  children.resolve(tree["1"]!);
  await settle();
  expect(redraws).toBe(before);
  expect(plain(picker.render(theme, 70, 20)).replace(/[⠁-⣿]/g, "")).toBe(frame.replace(/[⠁-⣿]/g, ""));
  expect(picker.label("111")).toBe("111");
});

test("管理台退出时取消选择器在途的请求：服务那边的查询随即中止，不留连接拖住进程", async () => {
  const fixture = await tempFixture("picker-exit-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = Date.now();
  const received = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<number>();
  const service = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    health: () => ({ directory: { scope: ["100"], mappings: 0 } }), listDepartments: async () => [],
    describeDepartments: (_ids, signal) => new Promise<never>((_resolve, reject) => {
      received.resolve();
      signal.addEventListener("abort", () => { cancelled.resolve(Date.now()); reject(signal.reason); }, { once: true });
    }) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    const file = join(fixture.root, "instance.json");
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const app = { ...flowApp([]).app, dialog: () => new Promise<never>(() => {}) };
    void pickDirectoryScope(app, serviceDepartments(file));
    await received.promise;
    const exitAt = Date.now();
    await shutdownTui();
    expect(await Promise.race([cancelled.promise, Bun.sleep(3000).then(() => -1)])).toBeGreaterThanOrEqual(exitAt);
  } finally { startQueries(); await server.stop(true); await fixture.cleanup(); }
});

test("当前范围读不到时只能关闭；子部门读取失败可以重试；筛选只作用于本层，Esc 先清筛选", async () => {
  const failed = await open(undefined, { failScope: true });
  expect(failed.shown()).toContain("当前范围读取失败：本机端口 1011 无响应");
  await failed.press("space");
  expect(failed.shown()).toContain("当前范围读取失败，不能修改");
  expect(await failed.press("enter")).toBeUndefined();
  expect(failed.shown()).toContain("不能保存");
  expect(await failed.press("escape")).toEqual({ done: null });

  const { calls, press, shown } = await open(undefined, { failOnce: new Set(["1"]) });
  expect(shown()).toContain("读取失败：读取部门失败：HTTP 500");
  expect(shown()).toContain("按 → 重试");
  await press("right");
  expect(shown()).toContain("华东分公司");
  expect(calls.children).toEqual(["1", "1"]);
  // Typed text filters by name or ID; q and j are text here, not quit or move keys.
  await press(key("华", "华"));
  expect(shown()).not.toContain("总部");
  expect(shown()).toContain("华南分公司");
  await press(key("q", "q"));
  expect(shown()).toContain("没有匹配的部门");
  await press("backspace", ctrl("u"), key("3", "3"));
  expect(shown()).toContain("华南分公司");
  expect(shown()).not.toContain("华东分公司");
  expect(await press("escape")).toBeUndefined();
  expect(shown()).toContain("总部");
  expect(await press("escape")).toEqual({ done: null });
});

test("最多 200 个部门；Esc 放弃改动前提醒一次，Ctrl+C 直接关闭", async () => {
  const full = Array.from({ length: 200 }, (_, index) => `d${index}`);
  const { picker, press, shown } = await open(full);
  await press("space");
  expect(shown()).toContain("最多选 200 个部门");
  expect(picker.note()).toBe("已选 200 个部门");
  await press("tab", "space");
  expect(picker.note()).toBe("已选 199 个部门");
  expect(await press("escape")).toBeUndefined();
  expect(shown()).toContain("勾选有改动：再按 Esc 放弃，按 Enter 保存");
  // Another key in between asks again.
  await press("down");
  expect(await press("escape")).toBeUndefined();
  expect(await press("escape")).toEqual({ done: null });
  expect(await press(ctrl("c"))).toEqual({ done: null });
});

/** A fake shell that hands the picker keys and records confirms, runs and toasts. */
function flowApp(confirms: boolean[]) {
  const calls = { confirms: [] as ConfirmSpec[], commands: [] as string[][], toasts: [] as string[], dialogs: 0 };
  let current: { dialog: Dialog<unknown>; resolve: (value: unknown) => void } | null = null;
  const app: AppApi = {
    deployment, theme, redraw() {}, go() {}, toast(_status, text) { calls.toasts.push(text); },
    async ask() { return null; }, async choose() { return null; }, async runInteractive() { throw new Error("不得启动交互子进程"); }, async openFile() {},
    dialog<T>(dialog: Dialog<T>) {
      calls.dialogs++;
      return new Promise<T>(resolve => { current = { dialog, resolve: resolve as (value: unknown) => void }; });
    },
    async confirm(spec) { calls.confirms.push(spec); return confirms.shift() ?? false; },
    async run(_title, args) { calls.commands.push(args); return 0; },
  };
  const press = async (...names: (string | Key)[]) => {
    for (const name of names) {
      await settle();
      const open = current!;
      const result = open.dialog.onKey(typeof name === "string" ? key(name, name === "space" ? " " : undefined) : name);
      if (result) { current = null; open.resolve(result.done); }
    }
    await settle();
  };
  return { app, calls, press };
}

test("选择器交回范围后照常确认再执行 directory-scope；确认框里取消回到选择器且保留勾选，未改动或取消不执行", async () => {
  const unchanged = flowApp([]);
  const first = pickDirectoryScope(unchanged.app, fakeSource(["200"]).source);
  await unchanged.press("enter");
  await first;
  expect(unchanged.calls.toasts).toEqual(["同步范围没有变化，未重新同步"]);
  expect([unchanged.calls.confirms, unchanged.calls.commands]).toEqual([[], []]);

  const flow = flowApp([false, true]);
  const picked = pickDirectoryScope(flow.app, fakeSource(undefined).source);
  await flow.press("down", "space", "enter");
  expect(flow.calls.confirms[0]).toMatchObject({ title: "设置同步范围", danger: true, subject: "只同步 1 个部门及其子部门：华东分公司" });
  expect(flow.calls.confirms[0]!.steps.slice(0, 2)).toEqual(["当前同步整个通讯录", "服务先向平台核对每个部门，任何一个不存在、无权读取或没核对成都不改"]);
  // Declined: the picker comes back with the ticks kept, and a second tick goes into the next confirmation.
  expect(flow.calls.dialogs).toBe(2);
  await flow.press("right", "space", "left", "up", "right", "right", "space", "enter");
  await picked;
  expect(flow.calls.confirms[1]!.subject).toBe("只同步 2 个部门及其子部门：华东分公司；总部 / 研发中心 / 平台组");
  expect(flow.calls.commands).toEqual([["directory-scope", "200,111"]]);
  expect(flow.calls.toasts.at(-1)).toBe("设置同步范围完成");

  // Removing the last department goes back to the whole directory.
  const whole = flowApp([true]);
  const cleared = pickDirectoryScope(whole.app, fakeSource(["200"]).source);
  await whole.press("tab", "space", "enter");
  await cleared;
  expect(whole.calls.confirms[0]!.subject).toBe("同步整个通讯录");
  expect(whole.calls.confirms[0]!.steps[0]).toBe("当前范围 1 个部门");
  expect(whole.calls.commands).toEqual([["directory-scope"]]);

  const cancelled = flowApp([]);
  const dropped = pickDirectoryScope(cancelled.app, fakeSource(undefined).source);
  await cancelled.press("space", "escape", "escape");
  await dropped;
  expect(cancelled.calls.toasts).toEqual(["已取消，同步范围未改"]);
  expect([cancelled.calls.confirms, cancelled.calls.commands]).toEqual([[], []]);
});

test("通讯录菜单把选择器列为修改操作，手动填写保留为另一项", () => {
  const view = createDirectoryView();
  const labels = view.actions!().map(action => [action.label, action.danger]);
  expect(labels).toEqual([["查看 Stream 与同步状态", false], ["选择同步范围", true], ["确认暂停的撤销", true], ["列出部门", false], ["手动设置同步范围", true]]);
  const shown = plain(view.render({ width: 100, height: 24, theme, deployment }));
  expect(shown).toContain("逐层展开部门并勾选");
});

test("管理台的自定义浮层接管全部按键：q 是筛选文字而不是退出，Ctrl+C 只关浮层；框不超出终端", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; } });
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  output.on("data", () => {});
  const screen = new Screen(output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
  const app = new App([{ id: "fixture", label: "测试", render: () => [], hints: () => [] }], { screen, deployment });
  screen.start(() => {}, () => {});
  try {
    const picker = new ScopePicker(fakeSource(undefined).source, () => app.redraw());
    const result = app.dialog(picker);
    await settle();
    expect(app["modal"]?.kind).toBe("dialog");
    for (const [columns, rows] of [[72, 20], [80, 24], [140, 50]] as const) {
      const frame = app["renderModal"](columns, rows);
      expect(frame.length).toBeLessThanOrEqual(rows);
      for (const line of frame) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(plain(frame)).toContain("选择同步范围");
      expect(plain(frame)).toContain("整个通讯录");
    }
    await app["handleKey"](key("q", "q"));
    expect(app["quit"]).toBe(false);
    expect(plain(app["renderModal"](80, 24))).toContain("筛选 › q");
    await app["handleKey"](ctrl("c"));
    expect(await result).toBeNull();
    expect(app["modal"]).toBeNull();
    expect(app["quit"]).toBe(false);
  } finally { screen.stop(); input.destroy(); output.destroy(); }
});
