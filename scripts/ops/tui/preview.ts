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
import type { View, ViewContext } from "./view.ts";
import { OverviewView } from "./views/overview.ts";
import { HealthView } from "./views/health.ts";
import { StatsView } from "./views/stats.ts";
import { StorageView } from "./views/storage.ts";
import { MaintainView } from "./views/maintain.ts";
import { createRelayView } from "./views/passthrough.ts";

const DAY = 86_400_000;
/** 演示数据全部相对这一刻生成，页面上的「几天前」才不会随运行时间漂移。 */
const NOW = Date.parse("2026-09-13T21:00:00+08:00");

const DEPLOYMENT: Deployment = {
  platform: "linux",
  runtime: "docker",
  port: 1011,
  domain: "bot.example.com",
  groupDataRoot: "data/groups",
  groupDataRootIsCustom: false,
} as Deployment;

const SERVICE: Service = { state: "ready", pid: 1234, latency: 12, startedAt: NOW - 3 * DAY - 5 * 3600_000 };

const GIT: GitState = {
  branch: "main", sha: "5ff99ba1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
  subject: "Fix audit findings", dirty: false, behind: 3, ahead: 0,
  // 条数要和 behind 对得上：服务部署页会把「待应用的提交（3）」和这张表并排显示。
  incoming: [
    { sha: "a1b2c3d", subject: "补上回调路由的超时" },
    { sha: "4e5f6a7", subject: "统计缓存改按 ctime 判断失效" },
    { sha: "8b9c0d1", subject: "临时文件清理预览加上占比" },
  ],
};

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
  return { input, output, cacheRead, cacheWrite, requests: 2142, missingUsage: 0, unknownCost: 0, cost };
}

function member(user: string, asks: number, files: number, days: number): UserStats {
  return {
    user, asks, files, replies: asks + 4,
    firstAt: NOW - 40 * DAY, lastAt: NOW - (asks % 3) * DAY,
    days: new Set(Array.from({ length: days }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`)),
  };
}

function group(name: string, asks: number, members: number, files: number): GroupStats {
  const users = Array.from({ length: members }, (_, i) =>
    member(`1381000${String(i).padStart(4, "0")}`, Math.max(1, Math.round(asks / members) - i * 6), Math.max(0, files - i), 13 - (i % 9))
  );
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
    return [key, { asks: 40 + ((i * 37) % 90), users: new Set(users.slice(0, 3 + (i % 6)).map(u => u.user)), files: 2 + (i % 5), images: 1 + (i % 3) }] as const;
  }));
  return {
    group: name, users, asks, replies: asks + 756,
    tools: new Map([["send_file", 186], ["web_search", 92], ["send_image", 34], ["read_file", 17]]),
    delivered: new Map([["send_file", files], ["send_image", 34]]),
    tokens: usage(186_000, 42_000, 752_000, 14_000, 3.48),
    usage: { total: usage(186_000, 42_000, 752_000, 14_000, 3.48), kinds: {}, models: new Map(), days: new Map() } as GroupStats["usage"],
    months, daily,
    days: new Set(Array.from({ length: 43 }, (_, i) => `d${i}`)),
    firstAt: NOW - 60 * DAY, lastAt: NOW - 2 * 3600_000, skipped: 0,
  };
}

const GROUPS = [
  group("售前支持群", 1386, 18, 186),
  group("技术支持群", 916, 28, 122),
  group("交付协作群", 434, 11, 57),
  group("2081562792700661761", 128, 4, 9),
  group("内部测试群", 37, 3, 2),
];

const HEALTH: Health = {
  pass: 9, warn: 2, fail: 1,
  checks: [
    { name: "容器状态", status: "pass", detail: "mixin-chatbot 运行中，已持续 3 天 5 小时", fix: "" },
    { name: "健康端点", status: "pass", detail: "127.0.0.1:1011/health 响应 12ms", fix: "" },
    { name: "隧道连通", status: "fail", detail: "cloudflared 无法解析 bot.example.com，最近一次成功在 4 小时前", fix: "先确认 Cloudflare 上的 DNS 记录仍指向本隧道，再重启隧道服务。" },
    { name: "回调路由", status: "warn", detail: "有 2 条路由指向已下线的后端", fix: "在「系统 / 回调路由」里删除或改指这两条路由。" },
    { name: "磁盘余量", status: "warn", detail: "数据盘剩余 18%，临时目录占 6.02 GB", fix: "到「数据 / 临时文件」按 30 天预览并清理。" },
    { name: "配置完整性", status: "pass", detail: "12 项必填配置齐备", fix: "" },
    { name: "会话历史", status: "pass", detail: "5 个群，最新一条 2 小时前", fix: "" },
    { name: "防火墙规则", status: "pass", detail: "仅放行隧道出口 IP", fix: "" },
  ],
};

function entry(name: string, gb: number, days: number, files: number) {
  return { name, path: `data/groups/demo/${name}`, bytes: gb * 1024 ** 3, files, newest: NOW - days * DAY };
}

function owner(group: string, dir: string, user: string, files: number, entries: UserTmp["entries"]): UserTmp {
  return {
    group, dir, user, entries, files,
    bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    newest: Math.max(...entries.map(item => item.newest)),
  };
}

const TMP: UserTmp[] = [
  owner("售前支持群", "g-presale", "13810001001", 412, [
    entry("workspace/export-2026-07.zip", 2.1, 44, 1), entry("workspace/draft.md", 1.1, 40, 1),
  ]),
  owner("技术支持群", "g-support", "13810001104", 331, [entry("tmp/build-cache", 2.8, 12, 331)]),
  owner("交付协作群", "g-delivery", "13810001207", 96, [entry("tmp/render", 1.6, 2, 96)]),
  owner("内部测试群", "g-internal", "sha256-user-" + "a".repeat(64), 58, [entry("tmp/old-run", 2.4, 61, 58)]),
];

/** 演示页面：每一项负责造好视图的内部状态，render 才有东西可画。 */
export const PAGES: Record<string, { section: string; build: () => View }> = {
  overview: {
    section: "overview",
    build: () => {
      const view = new OverviewView();
      const asks = [62, 71, 58, 88, 94, 77, 40, 33, 96, 112, 128, 103, 119, 126];
      const people = [18, 21, 17, 24, 26, 22, 12, 9, 27, 31, 36, 29, 33, 34];
      const files = [8, 11, 6, 13, 15, 9, 4, 2, 14, 17, 21, 12, 16, 18];
      const trend = Array.from({ length: 14 }, (_, i) => {
        const date = new Date(NOW - (13 - i) * DAY);
        return {
          day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
          asks: asks[i]!, people: people[i]!, files: files[i]!,
        };
      });
      Object.assign(view, {
        state: { kind: "ready", value: {
          today: { asks: 126, people: 34, files: 18, images: 7, groups: 5 },
          trend, tmp: TMP, disk: 14.8 * 1024 ** 3, git: GIT,
        } },
      });
      return view;
    },
  },
  health: { section: "monitor", build: () => Object.assign(new HealthView(), { state: { kind: "ready", value: HEALTH } }) },
  stats: { section: "stats", build: () => Object.assign(new StatsView(), { overview: { kind: "ready", value: GROUPS } }) },
  "stats-detail": { section: "stats", build: () => Object.assign(new StatsView(), { overview: { kind: "ready", value: GROUPS }, detail: GROUPS[0] }) },
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
  { id: "system", label: "系统", pages: ["服务部署", "回调路由"] },
];

/** 完整一帧：页眉、导航、正文、页脚，行数与列数都和真实终端一致。 */
export function frame(theme: Theme, page: string, columns: number, rows: number): string[] {
  const entry = PAGES[page]!;
  const view = entry.build();
  const section = SECTIONS.find(s => s.id === entry.section)!;
  const nav = navbar(theme, columns, SECTIONS, section.id, GIT);
  const chrome = [
    ...header({ theme, width: columns, deployment: DEPLOYMENT, service: SERVICE, git: GIT, uptime: NOW - SERVICE.startedAt! }),
    nav[0]!,
    section.pages.length > 1
      ? subnav(theme, columns, section.pages.map(label => ({ id: label, label })), section.pages[0]!)
      : nav[1]!,
  ];
  const keys: [string, string][] = [
    ["←→", "分区"], ...(section.pages.length > 1 ? [["Tab", "子页"]] as [string, string][] : []),
    ["Space", "操作"], ["r", "刷新"], ["?", "帮助"], ["q", "退出"],
  ];
  const tail = footer(theme, columns, null, view.hints(), keys);
  const height = Math.max(0, rows - chrome.length - tail.length);
  const ctx: ViewContext = { theme, width: columns, height, deployment: DEPLOYMENT };
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
