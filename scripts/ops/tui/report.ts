import { formatCacheRate } from "../../lib/usage.ts";
import { byName } from "../../lib/group-data.ts";
// 统计报表导出：一份自包含的静态 HTML。
//
// 为什么是静态文件而不是一个网页面板：这份东西的用途是「发给别人看」和「贴进汇报材料」。
// 静态文件双击就开、能直接当附件发走、不开端口、不需要鉴权、不用改 Cloudflare 规则。
// 在机器人进程里挂一个活的面板会带来一整套新的攻击面，而换来的只是同样这几张图。
//
// 文件里没有任何外链：CSS 内联、图形用 HTML 盒子而不是图表库、悬浮提示用纯 CSS。断网、
// 内网、别人的电脑上打开都是同一个样子。
//
// 图形的形式和配色遵循项目的数据可视化规范：
//   · 比大小的量一律单一色相（分类槽 1 的蓝），不用彩虹，不按数值改色相；
//   · token 用量那三个数量级差很远的数字做成三块数字卡，而不是硬凑一张三系列图；
//   · 每张图旁边都有可展开的表格视图，任何数值都不只存在于悬浮提示里；
//   · 文字一律用文字色，不穿数据色——浅色相当文字在浅底上读不清。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as fmt from "./render/format.ts";
import { PROJECT_DIR, describeMode, type Deployment } from "./platform.ts";
import type { GroupStats, Window } from "./data.ts";

export interface ReportInput {
  groups: GroupStats[];
  /** 当前下钻的群；有的话报表里多一节该群的明细。 */
  detail: GroupStats | null;
  window: Window;
  deployment: Deployment;
  /** 是否输出完整手机号。默认打码，与界面一致。 */
  unmasked: boolean;
  /** 输出目录；默认 backup/reports。测试用它写进自己的临时目录。 */
  dir?: string;
}

/** HTML 转义。群号可以带任意 Unicode，成员标识来自外部输入，一律当不可信文本处理。 */
function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 横向条。
 *
 * 数据端 4px 圆角、基线端见方，条厚封顶 16px 不填满行高（留出的空白就是相邻条之间的
 * 间隔，不画边框去分隔）。数值直接标在条尾，不依赖悬浮提示。
 */
function hbar(label: string, value: number, max: number, display: string, tip: string): string {
  const ratio = max > 0 ? Math.max(0.004, value / max) : 0;
  return `
        <div class="row">
          <div class="row-label" title="${esc(label)}">${esc(label)}</div>
          <div class="track">
            <div class="fill" style="width:${(ratio * 100).toFixed(2)}%" data-tip="${esc(tip)}"></div>
          </div>
          <div class="row-value">${esc(display)}</div>
        </div>`;
}

/** 纵向柱。值标在柱顶，横轴标签在下方——容器高度含轴标签，不让它被裁掉。 */
function column(label: string, value: number, max: number, display: string, tip: string): string {
  const ratio = max > 0 ? Math.max(0.004, value / max) : 0;
  return `
          <div class="col">
            <div class="col-value">${esc(display)}</div>
            <div class="col-track">
              <div class="col-fill" style="height:${(ratio * 100).toFixed(2)}%" data-tip="${esc(tip)}"></div>
            </div>
            <div class="col-label">${esc(label)}</div>
          </div>`;
}

/** 数字卡。大数字用比例数字（tabular 会让 121 在大字号下显得松散）。 */
function tile(label: string, value: string, note = ""): string {
  return `
        <div class="tile">
          <div class="tile-label">${esc(label)}</div>
          <div class="tile-value">${esc(value)}</div>
          ${note ? `<div class="tile-note">${esc(note)}</div>` : ""}
        </div>`;
}

/** 表格视图。每张图都配一份，保证任何数值都不只能靠悬浮读到。 */
function tableView(headers: string[], rows: string[][], caption: string): string {
  return `
        <details class="table-view">
          <summary>表格视图 · ${esc(caption)}</summary>
          <table>
            <thead><tr>${headers.map((head) => `<th>${esc(head)}</th>`).join("")}</tr></thead>
            <tbody>${rows
              .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
              .join("")}</tbody>
          </table>
        </details>`;
}

function describeWindow(window: Window): string {
  if (window.since === undefined && window.until === undefined) return "全部区间";
  const from = window.since === undefined ? "最早" : fmt.day(window.since);
  const to = window.until === undefined ? "至今" : fmt.day(window.until);
  return `${from} ~ ${to}`;
}

const STYLE = `
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --plane: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --grid: #e1e0d9;
    --baseline: #c3c2b7;
    --series-1: #2a78d6;
    --track: #cde2fb;
    --border: rgba(11,11,11,0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --plane: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --grid: #2c2c2a;
      --baseline: #383835;
      --series-1: #3987e5;
      --track: #184f95;
      --border: rgba(255,255,255,0.10);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --plane: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --baseline: #383835;
    --series-1: #3987e5;
    --track: #184f95;
    --border: rgba(255,255,255,0.10);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 24px 64px;
    background: var(--plane);
    color: var(--text-primary);
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 960px; margin: 0 auto; }
  header.page { margin-bottom: 28px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
  .subtitle { color: var(--text-secondary); font-size: 13px; }
  .meta { color: var(--text-muted); font-size: 12px; margin-top: 4px; }

  section {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 22px;
    margin-bottom: 18px;
  }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
  .section-note { color: var(--text-muted); font-size: 12px; margin-bottom: 16px; }

  /* 主数字：一个视图只有一个，和正文同一个无衬线字族，比例数字。 */
  .hero { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  .hero-value { font-size: 52px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
  .hero-unit { color: var(--text-secondary); font-size: 14px; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; }
  .tile { border-left: 2px solid var(--grid); padding-left: 12px; }
  .tile-label { color: var(--text-muted); font-size: 12px; }
  .tile-value { font-size: 26px; font-weight: 600; line-height: 1.2; }
  .tile-note { color: var(--text-muted); font-size: 11px; }

  /* 横向条：标签 / 轨道 / 数值三列。轨道左侧那条竖线就是基线，1px 实线不虚线。 */
  .row { display: grid; grid-template-columns: minmax(80px, 22%) 1fr auto; align-items: center; gap: 12px; margin-bottom: 10px; }
  .row-label { color: var(--text-secondary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { border-left: 1px solid var(--baseline); padding-left: 0; height: 16px; display: flex; align-items: center; }
  .fill { background: var(--series-1); height: 16px; border-radius: 0 4px 4px 0; min-width: 2px; position: relative; }
  .row-value { color: var(--text-secondary); font-size: 13px; font-variant-numeric: tabular-nums; }

  /* 纵向柱：容器高度含轴标签，柱顶 4px 圆角、底边见方。 */
  .cols { display: flex; align-items: flex-end; gap: 10px; padding-top: 8px; border-bottom: 1px solid var(--baseline); }
  .col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .col-value { color: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .col-track { height: 128px; width: 100%; max-width: 24px; display: flex; align-items: flex-end; }
  .col-fill { background: var(--series-1); width: 100%; border-radius: 4px 4px 0 0; min-height: 2px; position: relative; }
  .col-label { color: var(--text-muted); font-size: 11px; padding-top: 4px; }
  .axis-labels { display: flex; }

  /* 悬浮提示是增强，不是唯一读数途径：同样的数字已经标在条上并列在表格里。 */
  [data-tip] { cursor: default; }
  [data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute; left: 100%; top: 50%; transform: translate(8px, -50%);
    background: var(--text-primary); color: var(--surface-1);
    font-size: 12px; white-space: nowrap; padding: 4px 8px; border-radius: 6px;
    z-index: 2; pointer-events: none;
  }
  .col-fill[data-tip]:hover::after { left: 50%; top: 0; transform: translate(-50%, -120%); }

  .table-view { margin-top: 16px; }
  .table-view summary { color: var(--text-muted); font-size: 12px; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); }
  th { color: var(--text-muted); font-weight: 500; font-size: 12px; }
  td { font-variant-numeric: tabular-nums; }
  td:first-child, th:first-child { font-variant-numeric: normal; }

  footer.page { color: var(--text-muted); font-size: 12px; line-height: 1.7; margin-top: 8px; }
  .toggle {
    position: fixed; top: 16px; right: 16px;
    background: var(--surface-1); color: var(--text-secondary);
    border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer;
  }
  @media print {
    body { background: #fff; padding: 0; }
    .toggle { display: none; }
    section { break-inside: avoid; border-color: #ddd; }
    .table-view[open] summary { display: none; }
  }
`;

/** 深浅切换：唯一的脚本，8 行，失效了也不影响任何内容的可读性。 */
const SCRIPT = `
  document.querySelector(".toggle").addEventListener("click", function () {
    var root = document.documentElement;
    var dark = getComputedStyle(root).getPropertyValue("--surface-1").trim() === "#1a1a19";
    root.setAttribute("data-theme", dark ? "light" : "dark");
  });
`;

function overviewSection(input: ReportInput): string {
  const { groups } = input;
  const asks = groups.reduce((sum, group) => sum + group.asks, 0);
  const people = groups.reduce((sum, group) => sum + group.users.length, 0);
  const files = groups.reduce((sum, group) => sum + (group.delivered.get("send_file") ?? 0), 0);
  const images = groups.reduce((sum, group) => sum + (group.delivered.get("send_image") ?? 0), 0);
  const days = new Set(groups.flatMap((group) => [...group.days])).size;
  const max = Math.max(0, ...groups.map((group) => group.asks));

  return `
      <section>
        <div class="hero">
          <div class="hero-value">${fmt.grouped(asks)}</div>
          <div class="hero-unit">次提问</div>
        </div>
        <div class="section-note">${esc(describeWindow(input.window))}</div>
        <div class="tiles">
          ${tile("使用群数", String(groups.length))}
          ${tile("成员人次", String(people), "同一人出现在两个群算两次")}
          ${tile("已送附件", String(files), images > 0 ? `另有 ${images} 张图片` : "")}
          ${tile("活跃天数", String(days))}
        </div>
      </section>

      <section>
        <h2>各群提问次数</h2>
        <div class="section-note">按提问次数从多到少。</div>
        ${groups
          .map((group) =>
            hbar(
              group.group,
              group.asks,
              max,
              fmt.grouped(group.asks),
              `${group.group}：${group.asks} 次提问 · ${group.users.length} 人`
            )
          )
          .join("")}
        ${tableView(
          ["群", "人数", "提问", "处理轮次", "附件", "活跃天数", "首次", "最后"],
          groups.map((group) => [
            group.group,
            String(group.users.length),
            String(group.asks),
            String(group.replies),
            String(group.delivered.get("send_file") ?? 0),
            String(group.days.size),
            fmt.day(group.firstAt),
            fmt.day(group.lastAt),
          ]),
          "各群汇总"
        )}
      </section>`;
}

function detailSection(input: ReportInput, stats: GroupStats): string {
  const months = [...stats.months].sort((a, b) => a[0].localeCompare(b[0]));
  const monthMax = Math.max(0, ...months.map(([, data]) => data.asks));
  const members = stats.users;
  const memberMax = Math.max(0, ...members.map((user) => user.asks));
  const name = (user: string): string => (input.unmasked ? user : fmt.maskUser(user));

  const tools = [...stats.tools].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]));
  const toolMax = Math.max(0, ...tools.map(([, count]) => count));

  return `
      <section>
        <h2>群 ${esc(stats.group)} · 概况</h2>
        <div class="section-note">${esc(fmt.day(stats.firstAt))} ~ ${esc(fmt.day(stats.lastAt))} · ${esc(describeWindow(input.window))}</div>
        <div class="tiles">
          ${tile("使用人数", `${members.length} 人`)}
          ${tile("提问次数", fmt.grouped(stats.asks), members.length > 0 ? `人均 ${(stats.asks / members.length).toFixed(1)} 次` : "")}
          ${tile("活跃天数", `${stats.days.size} 天`)}
          ${tile("处理轮次", fmt.grouped(stats.replies))}
        </div>
      </section>

      <section>
        <h2>模型用量</h2>
        <div class="section-note">当前区间内记录的 token 用量，包含历史压缩与分支摘要。费用是 SDK 按配置价格估算，不代表 Coding Plan 实际账单或套餐配额；未知项不视为免费。</div>
        <div class="tiles">
          ${tile("输入", fmt.count(stats.tokens.input), "token")}
          ${tile("输出", fmt.count(stats.tokens.output), "token")}
          ${tile("缓存命中", fmt.count(stats.tokens.cacheRead), "token")}
          ${tile("缓存写入", fmt.count(stats.tokens.cacheWrite), "token")}
          ${tile("加权缓存读率", formatCacheRate(stats.tokens), "cacheRead / (input + cacheRead + cacheWrite)")}
          ${tile("已知估算费用", "$" + stats.tokens.cost.toFixed(6), "费用未知 " + stats.tokens.unknownCost + " 条；用量不完整 " + stats.tokens.missingUsage + " 条")}
        </div>
      </section>
      <section><h2>模型与压缩用量</h2>
        ${tableView(["类型", "调用", "输入", "输出", "缓存读", "缓存写", "估算费用"], Object.entries(stats.usage.kinds).map(([kind, u]) => [kind, String(u.requests), String(u.input), String(u.output), String(u.cacheRead), String(u.cacheWrite), "$" + u.cost.toFixed(6)]), "类型用量")}
        ${tableView(["provider / model", "调用", "加权缓存读率", "估算费用", "未知费用"], [...stats.usage.models].map(([key, u]) => [JSON.parse(key).join(" / "), String(u.requests), formatCacheRate(u), "$" + u.cost.toFixed(6), String(u.unknownCost)]), "模型用量")}
        ${tableView(["日期", "调用", "加权缓存读率", "缓存写", "估算费用"], [...stats.usage.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, u]) => [day, String(u.requests), formatCacheRate(u), String(u.cacheWrite), "$" + u.cost.toFixed(6)]), "每日用量")}
      </section>
${
  months.length > 0
    ? `
      <section>
        <h2>按月提问</h2>
        <div class="section-note">数值标在柱顶；横轴为自然月。</div>
        <div class="cols">
          ${months
            .map(([month, data]) =>
              column(month.slice(2), data.asks, monthMax, fmt.grouped(data.asks), `${month}：${data.asks} 次 · ${data.users.size} 人`)
            )
            .join("")}
        </div>
        ${tableView(
          ["月份", "提问", "人数"],
          months.map(([month, data]) => [month, String(data.asks), String(data.users.size)]),
          "按月"
        )}
      </section>`
    : ""
}
      <section>
        <h2>成员</h2>
        <div class="section-note">${input.unmasked ? "含完整手机号，注意分发范围。" : "手机号已打码（保留前三后四）。"}</div>
        ${members
          .slice(0, 20)
          .map((user) =>
            hbar(
              name(user.user),
              user.asks,
              memberMax,
              fmt.grouped(user.asks),
              `${name(user.user)}：${user.asks} 次提问 · ${user.days.size} 天活跃`
            )
          )
          .join("")}
        ${members.length > 20 ? `<div class="section-note">图中仅列前 20 位，完整名单见下方表格。</div>` : ""}
        ${tableView(
          ["成员", "提问", "已确认附件", "活跃天数", "首次", "最后"],
          members.map((user) => [
            name(user.user),
            String(user.asks),
            String(user.files),
            String(user.days.size),
            fmt.day(user.firstAt),
            fmt.day(user.lastAt),
          ]),
          "按成员"
        )}
      </section>
${
  tools.length > 0
    ? `
      <section>
        <h2>工具调用</h2>
        <div class="section-note">合计 ${tools.reduce((sum, [, count]) => sum + count, 0)} 次。</div>
        ${tools
          .slice(0, 10)
          .map(([tool, count]) => hbar(tool, count, toolMax, fmt.grouped(count), `${tool}：${count} 次`))
          .join("")}
        ${tableView(["工具", "调用次数"], tools.map(([tool, count]) => [tool, String(count)]), "工具调用")}
      </section>`
    : ""
}`;
}

/**
 * 生成报表并返回文件路径。
 *
 * 落在 backup/reports 下：backup/ 已经在 .gitignore 里，报表含群号和使用情况，不该被顺手
 * 提交进仓库。文件名带时间戳，同一天导出多次不会互相覆盖。
 */
export async function writeReport(input: ReportInput): Promise<string> {
  const dir = input.dir ?? join(PROJECT_DIR, "backup", "reports");
  await mkdir(dir, { recursive: true });
  const now = new Date();
  const stamp = `${fmt.day(now.getTime())}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const path = join(dir, `stat-${stamp}-${crypto.randomUUID().slice(0, 8)}.html`);

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mixin-chatbot 使用统计 ${esc(stamp)}</title>
<style>${STYLE}</style>
</head>
<body>
<button class="toggle" type="button">深/浅</button>
<main>
  <header class="page">
    <h1>mixin-chatbot 使用统计</h1>
    <div class="subtitle">${esc(describeWindow(input.window))}</div>
    <div class="meta">导出于 ${esc(fmt.day(now.getTime()))} ${esc(fmt.clock(now.getTime()))} · ${esc(describeMode(input.deployment))}</div>
  </header>
${overviewSection(input)}
${input.detail ? detailSection(input, input.detail) : ""}
  <footer class="page">
    统计口径：一条发给机器人的消息算一次提问（含干活途中的插话），/help /clear 等指令不计入。<br>
    数据来自保留的 session.jsonl；已归档的历史不计入。附件数只算带 fileId 的成功工具结果，生成链接不等于送达。<br>
    成员人次按群相加，同一个成员出现在两个群会计算两次。
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
  await writeFile(path, html, { flag: "wx" });
  return path;
}
