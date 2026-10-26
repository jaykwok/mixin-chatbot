#!/usr/bin/env bun
// 用固定的演示数据把任意页面渲染成文本，不碰真实 data/，也不需要 TTY。
//
// 存在的理由：界面的排版错误（差一列、某块顶到边、窄窗口塌掉）在真机上要复现特定数据才看得见，
// 而这里的数据是写死的，改完布局立刻能比对同一份输入前后长什么样。截图与 docs/assets 同源。
//
//   bun run scripts/ops/tui/preview.ts                  # 全部页面，100x24
//   bun run scripts/ops/tui/preview.ts overview 120 32  # 指定页面与尺寸
//   bun run scripts/ops/tui/preview.ts --plain          # 去色，用来核对列宽

import { createTheme, type Theme } from "./render/theme.ts";
import { pad } from "./render/width.ts";
import { footer, header, navbar, subnav } from "./frame.ts";
import type { Deployment } from "./platform.ts";
import type { GitState, Health, Service, UserTmp } from "./data.ts";
import type { GroupStats, UserStats } from "../stats-admin.ts";
import type { VersionFacts } from "../version-info.ts";
import type { View, ViewContext } from "./view.ts";
import { OverviewView } from "./views/overview.ts";
import { HealthView } from "./views/health.ts";
import { StatsView } from "./views/stats.ts";
import { StorageView } from "./views/storage.ts";
import { HistoryView } from "./views/history.ts";
import type { SpaceHistory } from "../../lib/history-scan.ts";
import { MaintainView } from "./views/maintain.ts";
import { createRelayView } from "./views/passthrough.ts";

const DAY = 86_400_000;
/** 演示数据全部相对这一刻生成，页面上的「几天前」才不会随运行时间漂移。 */
const NOW = Date.parse("2026-09-13T21:00:00+08:00");

const DEPLOYMENT: Deployment = {
  platform: "linux",
  runtime: "docker",
  port: 1011,
  dataRoot: "data",
  workspaceRoot: "",
} as Deployment;

/** 演示：运行服务 1.0.0，本地已拉到 1.1.0，界面多一行说明。 */
const VERSION: VersionFacts = {
  source: "running", program: { appVersion: "1.0.0", build: "3b7c8b2a91f0" }, dataVersion: 1,
  local: { appVersion: "1.1.0", build: "91813d1c4e2a" },
};

const SERVICE: Service = {
  state: "ready", pid: 1234, latency: 12, program: { appVersion: "1.0.0", build: "3b7c8b2a91f0" }, startedAt: NOW - 3 * DAY - 5 * 3600_000,
  stream: { connected: true, connectedAt: NOW - 2 * 3600_000, reconnects: 1, lastEventAt: NOW - 60_000 },
  directory: { mappings: 214, lastCompleteAt: NOW - 18 * 3600_000, pending: { scanId: 12, count: 9 } },
  attention: { parked: { count: 1, lastAt: NOW - 40 * 60_000, space: "群 presale" } },
};

const GIT: GitState = {
  branch: "main", sha: "5ff99ba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
  subject: "Fix audit findings", dirty: false, behind: 3, ahead: 0,
  // 条数要和 behind 对得上：服务部署页会把「待应用的提交（3）」和这张表并排显示。
  incoming: [
    { sha: "a1b2c3d", subject: "Stream 重连退避加上抖动" },
    { sha: "4e5f6a7", subject: "统计缓存改按 ctime 判断失效" },
    { sha: "8b9c0d1", subject: "临时文件清理预览加上占比" },
  ],
};

function usage(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}

function member(user: string, asks: number, days: number): UserStats {
  return {
    user, asks,
    firstAt: NOW - 40 * DAY, lastAt: NOW - (asks % 3) * DAY,
    days: new Set(Array.from({ length: days }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`)),
  };
}

function group(name: string, asks: number, members: number): GroupStats {
  const users = Array.from({ length: members }, (_, i) =>
    member(`1381000${String(i).padStart(4, "0")}`, Math.max(1, Math.round(asks / members) - i * 6), 13 - (i % 9))
  );
  const scale = asks / 1386;
  const months = new Map([
    ["2026-05", { asks: Math.round(asks * 0.08), users: new Set(users.slice(0, 4).map(u => u.user)) }],
    ["2026-06", { asks: Math.round(asks * 0.15), users: new Set(users.slice(0, 8).map(u => u.user)) }],
    ["2026-07", { asks: Math.round(asks * 0.24), users: new Set(users.slice(0, 12).map(u => u.user)) }],
    ["2026-08", { asks: Math.round(asks * 0.31), users: new Set(users.map(u => u.user)) }],
    ["2026-09", { asks: Math.round(asks * 0.22), users: new Set(users.slice(0, 15).map(u => u.user)) }],
  ]);
  const daily = new Map(Array.from({ length: 14 }, (_, i) => {
    const date = new Date(NOW - (13 - i) * DAY);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const askers = new Set(users.slice(0, 3 + (i % 6)).map(u => u.user));
    return [key, { asks: 40 + ((i * 37) % 90), askers }] as const;
  }));
  const chat = usage(Math.round(180_000 * scale), Math.round(41_000 * scale), Math.round(752_000 * scale), Math.round(14_000 * scale));
  const route = usage(Math.round(6_000 * scale), Math.round(1_000 * scale), 0, 0);
  const tokens = usage(chat.input + route.input, chat.output + route.output, chat.cacheRead, chat.cacheWrite);
  return {
    group: name, users, asks, tokens,
    models: new Map([["deepseek/deepseek-chat", chat]]),
    tools: new Map([["document_route", route]]),
    tokenDays: new Map([...daily.keys()].map((key, i) => [key, usage(12_000 + i * 300, 3_000, 50_000, 1_000)])),
    months, daily,
    days: new Set(Array.from({ length: 43 }, (_, i) => `d${i}`)),
    firstAt: NOW - 60 * DAY, lastAt: NOW - 2 * 3600_000,
  };
}

const GROUPS = [
  group("售前支持群", 1386, 18),
  group("技术支持群", 916, 28),
  group("交付协作群", 434, 11),
  group("2081562792700661761", 128, 4),
  group("内部测试群", 37, 3),
];

const HEALTH: Health = {
  pass: 9, warn: 3, fail: 1,
  checks: [
    { name: "容器状态", status: "pass", detail: "mixin-chatbot 运行中，已持续 3 天 5 小时", fix: "" },
    { name: "健康端点", status: "pass", detail: "127.0.0.1:1011/health 响应 12ms", fix: "" },
    { name: "事件 Stream", status: "fail", detail: "未连接（断开于 4 分钟前）：凭据被拒绝", fix: "在开发者后台核对应用凭据与 Stream 订阅，然后在「系统 → 设置 → 应用机器人」重新填写。" },
    { name: "通讯录同步", status: "warn", detail: "通讯录映射：214 个；待确认撤销：9 个成员（第 12 轮）", fix: "在「系统 → 通讯录」核对后确认第 12 轮。" },
    { name: "运行状况", status: "warn", detail: "自本次启动：停住的任务 1 次（最近 群 presale，40 分钟前）",
      fix: "在「监控 → 日志」中查看对应记录（Durable 报告、交付超时放弃、统计累计值回退等）；停住的任务由成员用 /status 查看、/stop 或 /clear 结束。" },
    { name: "磁盘余量", status: "warn", detail: "数据盘剩余 18%，临时目录占 6.02 GB", fix: "到「数据 / 临时文件」按 30 天预览并清理。" },
    { name: "配置完整性", status: "pass", detail: "12 项必填配置齐备", fix: "" },
    { name: "会话历史", status: "pass", detail: "5 个群，最新一条 2 小时前", fix: "" },
    { name: "应用凭据", status: "pass", detail: "已配置（不显示凭据）", fix: "" },
  ],
};

function entry(name: string, gb: number, days: number, files: number) {
  return { name, path: `data/tmp/groups/demo/${name}`, bytes: gb * 1024 ** 3, files, newest: NOW - days * DAY };
}

function owner(space: string, dir: string, user: string, files: number, entries: UserTmp["entries"]): UserTmp {
  return {
    space, dir, user, entries, files,
    bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    newest: Math.max(...entries.map(item => item.newest)),
  };
}

const TMP: UserTmp[] = [
  owner("groups/presale", "g-presale", "13810001001", 412, [
    entry("tasks/msg-5f0c2a1e-7d0b-4c55-9a51-2f7d1c0e9b31", 2.1, 44, 1), entry("received", 1.1, 40, 1),
  ]),
  owner("direct", "d-support", "13810001104", 331, [entry("tasks/msg-0b6c1f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", 2.8, 12, 331)]),
  owner("groups/delivery", "g-delivery", "13810001207", 96, [entry("codemode", 1.6, 2, 96)]),
  owner("groups/internal", "g-internal", "sha256-user-" + "a".repeat(64), 58, [entry(".isolated-work", 2.4, 61, 58)]),
];

function space(name: string, mb: number, hours: number): SpaceHistory {
  const bytes = mb * 1024 ** 2;
  return { space: name, dir: `data/conversations/${name}`, bytes, database: { bytes, modified: NOW - hours * 3600_000 } };
}

const HISTORY: SpaceHistory[] = [
  space("groups/presale", 412, 2), space("groups/support", 268, 5), space("direct", 133, 1), space("groups/delivery", 64, 30),
];

/** 演示页面：每一项负责造好视图的内部状态，render 才有东西可画。 */
export const PAGES: Record<string, { section: string; build: () => View }> = {
  overview: {
    section: "overview",
    build: () => {
      const view = new OverviewView();
      const asks = [62, 71, 58, 88, 94, 77, 40, 33, 96, 112, 128, 103, 119, 126];
      const people = [18, 21, 17, 24, 26, 22, 12, 9, 27, 31, 36, 29, 33, 34];
      const tokens = [8, 11, 6, 13, 15, 9, 4, 2, 14, 17, 21, 12, 16, 18].map(value => value * 61_000);
      const trend = Array.from({ length: 14 }, (_, i) => {
        const date = new Date(NOW - (13 - i) * DAY);
        return {
          day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
          asks: asks[i]!, people: people[i]!, tokens: tokens[i]!,
        };
      });
      Object.assign(view, {
        state: { kind: "ready", value: {
          today: { asks: 126, people: 34, tokens: 1_098_000, groups: 5 },
          trend, tmp: TMP, disk: 14.8 * 1024 ** 3, git: GIT, service: SERVICE, version: VERSION,
        } },
      });
      return view;
    },
  },
  health: { section: "monitor", build: () => Object.assign(new HealthView(), { state: { kind: "ready", value: HEALTH } }) },
  stats: { section: "stats", build: () => Object.assign(new StatsView(), { overview: { kind: "ready", value: GROUPS } }) },
  "stats-detail": { section: "stats", build: () => Object.assign(new StatsView(), { overview: { kind: "ready", value: GROUPS }, detail: GROUPS[0] }) },
  history: { section: "data", build: () => Object.assign(new HistoryView(), { state: { kind: "ready", value: HISTORY } }) },
  "history-detail": { section: "data", build: () => Object.assign(new HistoryView(), { state: { kind: "ready", value: HISTORY }, expanded: true,
    members: { kind: "ready", value: [...GROUPS[0]!.users].sort((a, b) => b.lastAt - a.lastAt) } }) },
  storage: { section: "data", build: () => Object.assign(new StorageView(), { state: { kind: "ready", value: TMP } }) },
  // 停在「升级」而不是默认的「启动」：它的影响预览最长（步骤 + 恢复说明 + 待应用提交），
  // 右栏塞满才看得出换行和滚动有没有问题，也是这一页最值得展示的样子。
  maintain: { section: "system", build: () => Object.assign(new MaintainView(), { platform: "linux", selected: 3, state: { kind: "ready", value: GIT } }) },
  relay: { section: "data", build: () => createRelayView() },
};

const SECTIONS = [
  { id: "overview", label: "总览", pages: ["总览"] },
  { id: "monitor", label: "监控", pages: ["体检", "日志"] },
  { id: "stats", label: "统计", pages: ["统计"] },
  { id: "data", label: "数据", pages: ["会话", "临时文件", "外链"] },
  { id: "system", label: "系统", pages: ["服务部署", "通讯录", "设置"] },
];

/**
 * 完整一帧：页眉、导航、正文、页脚，行数与列数都和真实终端一致。
 *
 * 渲染期间把时钟拨到 NOW：页面里的「几天前」「最后活动」都按 Date.now() 算，不拨的话演示数据会随运行日期变旧。
 */
export function frame(theme: Theme, page: string, columns: number, rows: number): string[] {
  const clock = Date.now;
  Date.now = () => NOW;
  try { return render(theme, page, columns, rows); } finally { Date.now = clock; }
}

function render(theme: Theme, page: string, columns: number, rows: number): string[] {
  const entry = PAGES[page]!;
  const view = entry.build();
  const section = SECTIONS.find(s => s.id === entry.section)!;
  const nav = navbar(theme, columns, SECTIONS, section.id, GIT);
  const chrome = [
    ...header({ theme, width: columns, deployment: DEPLOYMENT, service: SERVICE, git: GIT, uptime: NOW - SERVICE.startedAt! }),
    nav[0]!,
    section.pages.length > 1
      ? subnav(theme, columns, section.pages.map(label => ({ id: label, label })), section.pages.find(label => label === view.label) ?? section.pages[0]!)
      : nav[1]!,
  ];
  const keys: [string, string][] = [
    ["←→", "分区"], ...(section.pages.length > 1 ? [["Tab", "子页"]] as [string, string][] : []),
    ["Space", "操作"], ["r", "刷新"], ["?", "帮助"], ["q", "退出"],
  ];
  const tail = footer(theme, columns, null, view.hints(), keys);
  const height = Math.max(0, rows - chrome.length - tail.length);
  const ctx: ViewContext = { theme, width: columns, height, deployment: DEPLOYMENT, service: SERVICE };
  const body = view.render(ctx).slice(0, height);
  while (body.length < height) body.push(pad("", columns));
  return [...chrome, ...body, ...tail];
}

// 只有直接运行时才打印；被 import 时（截图脚本）只取上面的演示数据和 frame()。
if (import.meta.main) {
  const args = process.argv.slice(2);
  const plain = args.includes("--plain");
  const rest = args.filter(arg => !arg.startsWith("--"));
  const pages = rest[0] && PAGES[rest[0]] ? [rest[0]] : Object.keys(PAGES);
  const columns = Number(rest[1] ?? 100);
  const rows = Number(rest[2] ?? 24);
  const theme = createTheme(plain ? "none" : "truecolor");

  for (const page of pages) {
    const ruler = "─".repeat(columns);
    console.log(`\n┌${ruler}┐   ${page}  ${columns}×${rows}`);
    for (const line of frame(theme, page, columns, rows)) console.log(`│${line}│`);
    console.log(`└${ruler}┘`);
  }
}
