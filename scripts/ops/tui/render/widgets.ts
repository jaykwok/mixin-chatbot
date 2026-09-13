// 组件库。全部是纯函数：给参数，返回若干行，每行显示宽度恰好等于 width。
//
// 「每行宽度恰好等于 width」是硬约束。只要有一个组件少给一列，它右边的所有东西都会错位，
// 而终端不会报错，只会看起来很廉价。所以组件一律自己补齐，调用方不需要关心。

import { type Align, pad, truncate, width } from "./width.ts";
export { wrap } from "./width.ts";
import { STATUS, type ColorName, type StatusName, type Theme } from "./theme.ts";

/** 细圆角边框。粗框在中文界面里太吵，细线更接近现代 UI 的分隔感。 */
const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

/** 八分之一格的实心块，用来画出比字符网格更细的进度。 */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const FULL = "█";
/** 迷你折线用的高度档位。 */
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface BoxOptions {
  width: number;
  title?: string;
  /** 标题右侧的附注，右对齐贴在上边框。 */
  note?: string;
  body: string[];
  /** 边框与标题的颜色；不给则用暗色边框。 */
  accent?: ColorName;
  /** 内容区左右内边距，默认各一格。 */
  padding?: number;
}

/**
 * 带标题的圆角框。
 *
 * 标题直接嵌在上边框里（╭─ 标题 ─────╮），比另起一行做标题省一行高度——终端高度是这个
 * 界面最稀缺的资源，一屏能少占一行就多显示一条记录。
 */
export function box(theme: Theme, options: BoxOptions): string[] {
  const { width: total, title, note, body, accent, padding = 1 } = options;
  const inner = Math.max(0, total - 2 - padding * 2);
  const edge = (text: string): string => theme.c(accent ?? "faint", text);

  const lines: string[] = [];
  const titlePart = title ? ` ${truncate(title, Math.max(0, inner - 2))} ` : "";
  const notePart = note ? ` ${truncate(note, Math.max(0, inner - width(titlePart) - 4))} ` : "";
  const fillWidth = Math.max(0, total - 2 - width(titlePart) - width(notePart));
  lines.push(
    edge(BORDER.topLeft) +
      (title ? theme.c(accent ?? "muted", theme.bold(titlePart)) : "") +
      edge(BORDER.horizontal.repeat(fillWidth)) +
      (note ? theme.c("muted", notePart) : "") +
      edge(BORDER.topRight)
  );

  const gap = " ".repeat(padding);
  for (const line of body) {
    lines.push(edge(BORDER.vertical) + gap + pad(line, inner) + gap + edge(BORDER.vertical));
  }
  lines.push(edge(BORDER.bottomLeft) + edge(BORDER.horizontal.repeat(total - 2)) + edge(BORDER.bottomRight));
  return lines;
}

/**
 * 并排放置若干块。高度不齐的按最高的补空行，每块自己已经是定宽的。
 * gap 是块之间的空列数。
 */
export function columns(blocks: string[][], widths: number[], gap = 1): string[] {
  const height = Math.max(0, ...blocks.map((block) => block.length));
  const spacer = " ".repeat(gap);
  const rows: string[] = [];
  for (let row = 0; row < height; row++) {
    rows.push(
      blocks
        .map((block, index) => pad(block[row] ?? "", widths[index] ?? 0))
        .join(spacer)
    );
  }
  return rows;
}

export interface Column<T> {
  header: string;
  /** 固定列宽；不给则按 flex 分配剩余宽度。 */
  size?: number;
  /** 剩余宽度的分配权重，默认 1。 */
  flex?: number;
  align?: Align;
  render: (row: T, index: number) => string;
}

export interface TableOptions<T> {
  width: number;
  columns: Column<T>[];
  rows: T[];
  /** 选中行下标；给了就反色显示。 */
  selected?: number;
  /** 行首标记宽度（选中箭头），默认 2。传 0 表示不留。 */
  marker?: number;
  gap?: number;
}

/**
 * 表格。列宽先给固定列，剩下的按 flex 分。
 *
 * 表头用暗色不用分隔线：一条 ─── 会把本来就不高的内容区再切掉一行，而颜色对比已经足够
 * 区分表头和数据。
 */
export function table<T>(theme: Theme, options: TableOptions<T>): string[] {
  const { width: total, columns: specs, rows, selected, marker = 2, gap = 2 } = options;
  const spacing = gap * Math.max(0, specs.length - 1);
  const fixed = specs.reduce((sum, spec) => sum + (spec.size ?? 0), 0);
  const flexTotal = specs.reduce((sum, spec) => sum + (spec.size ? 0 : (spec.flex ?? 1)), 0);
  let remaining = Math.max(0, total - marker - fixed - spacing);

  const sizes = specs.map((spec) => {
    if (spec.size) return spec.size;
    const share = flexTotal > 0 ? Math.floor((remaining * (spec.flex ?? 1)) / flexTotal) : 0;
    return share;
  });
  // 整除的余数补给最后一个弹性列，保证各列加起来正好填满。
  const used = sizes.reduce((sum, size) => sum + size, 0);
  const lastFlex = specs.map((spec, index) => (spec.size ? -1 : index)).filter((index) => index >= 0).pop();
  if (lastFlex !== undefined) sizes[lastFlex] = (sizes[lastFlex] ?? 0) + (total - marker - spacing - used);

  const spacer = " ".repeat(gap);
  const lines: string[] = [];
  lines.push(
    " ".repeat(marker) +
      theme.c(
        "muted",
        specs.map((spec, index) => pad(spec.header, sizes[index]!, spec.align)).join(spacer)
      )
  );

  rows.forEach((row, index) => {
    const cells = specs
      .map((spec, column) => pad(spec.render(row, index), sizes[column]!, spec.align))
      .join(spacer);
    if (index === selected) {
      // 反色要铺满整行宽度，否则选中条会在文字结束处断掉，看起来像渲染坏了。
      const marked = marker > 0 ? `${pad("▸", marker)}${cells}` : cells;
      // 无色时已有箭头就足够标识选择；再包方括号会挤掉末列并让整行错一列。
      lines.push(theme.depth === "none" && marker > 0
        ? pad(marked, total)
        : theme.invert(pad(marked, total - (theme.depth === "none" ? 2 : 0))));
    } else {
      lines.push(" ".repeat(marker) + cells);
    }
  });
  return lines;
}

/**
 * 横向条形图。用八分之一块做亚字符精度——同样的宽度里，分辨率高 8 倍，
 * 相邻两个月的差异不会因为取整看起来一样长。
 */
export function bar(theme: Theme, value: number, max: number, size: number, color: ColorName = "accent"): string {
  if (size <= 0) return "";
  if (!(max > 0) || !(value > 0)) return theme.c("faint", "─".repeat(size));
  const exact = Math.min(1, value / max) * size;
  const full = Math.floor(exact);
  const rest = Math.round((exact - full) * 8);
  const head = FULL.repeat(full) + (full < size ? EIGHTHS[rest] ?? "" : "");
  return theme.c(color, head) + " ".repeat(Math.max(0, size - width(head)));
}

/** 迷你趋势线。值全为 0 时画基线，不画成一排满格。 */
export function sparkline(theme: Theme, values: number[], color: ColorName = "accent"): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return theme.c("faint", "▁".repeat(values.length));
  return theme.c(
    color,
    values.map((value) => SPARK[Math.min(7, Math.max(0, Math.round((value / max) * 7)))]!).join("")
  );
}

/**
 * 状态符号。界面里每一处状态都从这里取符号和颜色。
 *
 * 没有「只给颜色」的出口是故意的。good 和 critical 在红绿色盲下几乎同色，只换颜色的圆点
 * 对一部分人就是同一个点；符号自带形状差异，去掉颜色也读得出来。表格里它固定占一列，
 * 所以状态变化不会让后面的列跟着错位。
 */
export function mark(theme: Theme, name: StatusName): string {
  const { glyph, color } = STATUS[name];
  return theme.c(color, glyph);
}

/** 状态标记：符号 + 同色文字。用于页眉、提示行这类单行状态。 */
export function status(theme: Theme, name: StatusName, text: string): string {
  return `${mark(theme, name)} ${theme.c(STATUS[name].color, text)}`;
}

/** 键名 + 说明 的底部提示条。 */
export function hints(theme: Theme, pairs: [string, string][], size: number): string {
  const parts = pairs.map(([key, label]) => `${theme.bold(key)} ${theme.c("muted", label)}`);
  const text = parts.join(width(parts.join("   ")) + 1 <= size ? "   " : " ");
  return pad(` ${text}`, size);
}

/** 键值对列表，键左对齐定宽，值跟在后面。 */
export function fields(theme: Theme, pairs: [string, string][], size: number, keySize = 10): string[] {
  return pairs.map(([key, value]) =>
    pad(theme.c("muted", pad(key, keySize)) + pad(value, Math.max(0, size - keySize)), size)
  );
}
