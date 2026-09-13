// 页眉、导航、页脚。三行页眉两行页脚，剩下全给正文。
//
// 终端高度是这个界面最稀缺的资源：80×24 下每多一行装饰就少一条记录。所以状态、模式、端口、
// 域名和版本全部压在同一条页眉里，导航用横向标签而不是左侧栏（左栏在 72 列下要吃掉五分之一
// 的宽度，而这些标签只有两个字）。

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

  const left = ` ${theme.bold("mixin-chatbot")}  ${status(theme, name, label)}`;
  const uptime = input.uptime ? theme.c("muted", ` · ${fmt.duration(input.uptime)}`) : "";
  const right = ` ${theme.c("muted", describeMode(deployment))} ${theme.c("muted", `· :${deployment.port}`)} `;

  const head = left + uptime;
  const fill = Math.max(0, total - 2 - width(head) - width(right));
  const line =
    theme.c("faint", "╭") + head + theme.c("faint", "─".repeat(fill)) + right + theme.c("faint", "╮");
  return [pad(line, total)];
}

/**
 * 导航：横向标签 + 一条下划线，当前页那一段染成主色。
 *
 * 用下划线标记当前页而不是给标签整体反色：反色在窄终端里会变成一块很重的色块，而下划线
 * 只占已经必须存在的那条分隔线，等于零额外高度。
 */
export function navbar(
  theme: Theme,
  total: number,
  labels: { id: string; label: string }[],
  activeId: string,
  git: GitState | null
): string[] {
  const gap = total < 80 ? 1 : 2;
  let line = " ";
  const spans: { start: number; size: number; active: boolean }[] = [];
  labels.forEach((entry, index) => {
    const active = entry.id === activeId;
    const label = active && theme.depth === "none" ? `[${entry.label}]` : entry.label;
    const text = `${theme.c("muted", String(index + 1))} ${active ? theme.bold(theme.c("accent", label)) : theme.c("muted", label)}`;
    spans.push({ start: width(line), size: width(text), active });
    line += text + " ".repeat(gap);
  });

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
  keys: [string, string][]
): string[] {
  const message = toast ? ` ${status(theme, toast.status, toast.text)}` : "";
  return [pad(message, total), hints(theme, keys, total)];
}
