// 三行页眉、两行页脚。方向键导航常驻，页面动作与提示共用另一行，正文保留完整宽度。

import { pad, width } from "./render/width.ts";
import { hints, status } from "./render/widgets.ts";
import { STATUS, type Theme } from "./render/theme.ts";
import * as fmt from "./render/format.ts";
import type { Deployment } from "./platform.ts";
import { describeMode } from "./platform.ts";
import type { GitState, Service } from "./data.ts";

export interface HeaderInput {
  theme: Theme;
  width: number;
  deployment: Deployment;
  service: Service | null;
  git: GitState | null;
  /** 进程已经活了多久；读不到时为空。 */
  uptime?: number;
}

/** 服务状态 → 状态名。停机中单独一档：那是个过渡态，不该显示成「已停止」。 */
function serviceStatus(service: Service | null): { name: keyof typeof STATUS; label: string } {
  if (!service) return { name: "idle", label: "未探测" };
  if (service.state === "ready") return { name: "running", label: "运行中" };
  if (service.state === "verifying") return { name: "warn", label: "只验证" };
  if (service.state === "stopping") return { name: "warn", label: "正在停机" };
  return { name: "danger", label: "未响应" };
}

/**
 * 页眉：`╭ mixin-chatbot ── ● 运行中 · 3d 14h ── Docker · 直连 · :1011 ─╮`
 *
 * 左边是「它现在怎么样」，右边是「它是怎么部署的」。宽度不够时先牺牲右边的部署信息，
 * 状态永远保留——一屏只能留一个信息的话，那个信息是它到底活着没有。
 */
export function header(input: HeaderInput): string[] {
  const { theme, width: total, deployment, service } = input;
  const { name, label } = serviceStatus(service);

  const left = ` ${theme.bold("mixin-chatbot")} ${theme.c("muted", "/ 管理台")}  ${status(theme, name, label)}`;
  const uptime = input.uptime ? theme.c("muted", ` · ${fmt.duration(input.uptime)}`) : "";
  const mode = ` ${theme.c("muted", describeMode(deployment))} ${theme.c("muted", `· :${deployment.port}`)} `;

  const head = left + uptime;
  const right = width(head) + width(mode) + 2 <= total ? mode : theme.c("muted", ` :${deployment.port} `);
  return [pad(head + " ".repeat(Math.max(1, total - width(head) - width(right))) + right, total)];
}

/**
 * 主分区取消数字前缀，当前分区使用等宽选中标记。
 */
export function navbar(
  theme: Theme,
  total: number,
  labels: { id: string; label: string }[],
  activeId: string,
  git: GitState | null
): string[] {
  const gap = total < 100 ? 1 : 2;
  let line = theme.c("accent", "← ");
  const spans: { start: number; size: number; active: boolean }[] = [];
  labels.forEach((entry) => {
    const active = entry.id === activeId;
    const text = active
      ? theme.depth === "none" ? `[${entry.label}]` : theme.invert(theme.bold(` ${entry.label} `))
      : theme.c("muted", ` ${entry.label} `);
    spans.push({ start: width(line), size: width(text), active });
    line += text + " ".repeat(gap);
  });
  line += theme.c("accent", "→");

  // 版本信息贴右：落后提交数是「该不该升级」唯一需要天天看到的数字。
  let tail = "";
  if (git) {
    const sha = theme.c("muted", fmt.shortSha(git.sha));
    const behind =
      git.behind > 0 ? ` ${theme.c("warn", `${STATUS.warn.glyph} 落后 ${git.behind}`)}` : "";
    const dirty = git.dirty ? ` ${theme.c("serious", "工作区有改动")}` : "";
    tail = `${sha}${behind}${dirty} `;
  }
  const used = width(line);
  line = width(tail) > 0 && total - used - width(tail) >= 0
    ? line + " ".repeat(total - used - width(tail)) + tail
    : pad(line, total);

  // 下划线：当前标签那一段用主色，其余用暗色，拼出一条完整的分隔线。
  let underline = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) underline += theme.c("faint", "─".repeat(span.start - cursor));
    underline += theme.c(span.active ? "accent" : "faint", "─".repeat(span.size));
    cursor = span.start + span.size;
  }
  if (cursor < total) underline += theme.c("faint", "─".repeat(total - cursor));

  return [pad(line, total), pad(underline, total)];
}

/** 子页单独占用原分隔线的位置，保持正文高度；Tab 只在当前分区内循环。 */
export function subnav(theme: Theme, total: number, pages: { id: string; label: string }[], activeId: string): string {
  const entries = pages.map(page => page.id === activeId
    ? theme.bold(theme.c("accent", "[" + page.label + "]"))
    : theme.c("muted", " " + page.label + " "));
  const tabs = "  " + entries.join("  ");
  const hint = theme.c("muted", "Tab / Shift+Tab 切换 ");
  return pad(tabs + " ".repeat(Math.max(2, total - width(tabs) - width(hint))) + hint, total);
}

/**
 * 页脚：提示消息一行 + 按键提示一行。
 *
 * 提示消息占一个固定行而不是浮层：浮层要么盖住内容，要么需要重画整屏，而固定行的成本是
 * 一行高度换来「消息不会遮住你正在看的东西」。
 */
export function footer(
  theme: Theme,
  total: number,
  toast: { status: keyof typeof STATUS; text: string } | null,
  keys: [string, string][],
  commonKeys: [string, string][]
): string[] {
  const context = toast ? pad(` ${status(theme, toast.status, toast.text)}`, total) : hints(theme, keys, total);
  return [context, hints(theme, commonKeys, total)];
}
