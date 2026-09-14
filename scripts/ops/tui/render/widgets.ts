// 组件库：给参数，返回若干行，每行显示宽度恰好等于 width。
//
// 「每行宽度恰好等于 width」是硬约束。只要有一个组件少给一列，它右边的所有东西都会错位，
// 而终端不会报错，只会看起来很廉价。所以组件一律自己补齐，调用方不需要关心。
//
// 分组有两套手段，按噪音从低到高排：留白 → rule（一条带标题的细线）→ box（四面边框）。
// 默认用前两种。box 的四条边要吃掉两行高度和四列宽度，只有需要把内容和周围隔开时才值得，
// 比如浮层、确认框——终端高度是这个界面最稀缺的资源。

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
/**
 * 仪表轨道用的浅色块。
 *
 * 轨道和填充必须是两个不同的字符，不能只靠颜色分：NO_COLOR 的终端、色觉障碍和黑白截图下，
 * 两段同为 █ 的仪表读起来永远是「满的」。密度不同的方块在没有颜色时照样分得出来。
 */
const TRACK = "░";
/** 迷你折线用的高度档位。 */
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 100;

/**
 * 带标题的分区细线：`── 待处理 ───────────────── 2 项待关注 ──`
 *
 * 这是 box 的低噪音替身，也是布局的默认手段。同样是「把这一段和上一段分开」，它只花一行高度、
 * 零列宽度，正文还能用满整个终端宽度；box 要花两行高度和四列宽度。
 */
export function rule(theme: Theme, total: number, label?: string, note?: string, accent: ColorName = "faint"): string {
  const line = (size: number): string => theme.c("faint", BORDER.horizontal.repeat(Math.max(0, size)));
  if (!label) return pad(line(total), total);
  const title = ` ${truncate(label, Math.max(0, total - 8))} `;
  const tail = note ? ` ${truncate(note, Math.max(0, total - width(title) - 8))} ` : "";
  const fill = Math.max(0, total - 2 - width(title) - width(tail) - 2);
  return pad(
    line(2) + theme.bold(theme.c(accent, title)) + line(fill) + (tail ? theme.c("muted", tail) : "") + line(2),
    total
  );
}

export interface BoxOptions {
  width: number;
  title?: string;
  /** 标题右侧的附注，右对齐贴在上边框。 */
  note?: string;
  body: string[];
  /** 边框与标题的颜色；不给则用暗色边框配主文字标题。 */
  accent?: ColorName;
  /** 内容区左右内边距，默认各一格。 */
  padding?: number;
}

/**
 * 带标题的圆角框。留给浮层、确认框和执行面板——需要把内容从背景里「抬起来」的场合。
 *
 * 标题直接嵌在上边框里（╭─ 标题 ─────╮），比另起一行做标题省一行高度。
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
      // 不指定 accent 时标题只加粗、不上色：主色是数据的颜色，标题抢过去会和图表里的值打架。
      (title ? theme.bold(accent ? theme.c(accent, titlePart) : titlePart) : "") +
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

interface Column<T> {
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
  const headers = specs.map((spec, index) => pad(spec.header, sizes[index]!, spec.align)).join(spacer);
  // 表头全空时不占那一行：窄窗口里一行高度比一排空标签值钱。
  if (specs.some((spec) => spec.header !== "")) {
    lines.push(" ".repeat(marker) + theme.c("muted", headers));
  }

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
 * 横向条形图：比较量级，不画轨道。
 *
 * 用八分之一块做亚字符精度——同样的宽度里，分辨率高 8 倍，相邻两个月的差异不会因为取整
 * 看起来一样长。没有轨道是刻意的：轨道意味着「有个上限」，而这里的基准只是当前最大值，
 * 画上轨道会让人以为那条线是容量。要表达占比请用 meter。
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

/**
 * 仪表：一个值占整体的比例，带轨道。
 *
 * 和 bar 的区别是语义而不是外观——meter 有分母。轨道一直画满，填充盖在上面，于是「还剩多少」
 * 和「已用多少」在同一条线上同时读得到。
 *
 * segments 支持把填充分成几段（比如总占用里可清理的那部分），段与段之间不描边：相邻两段
 * 靠颜色和顺序区分，描边只会添一层不是数据的墨。
 */
export function meter(
  theme: Theme,
  segments: { value: number; color: ColorName }[],
  total: number,
  size: number
): string {
  if (size <= 0) return "";
  if (!(total > 0)) return theme.c("track", TRACK.repeat(size));
  let used = 0;
  let out = "";
  for (const segment of segments) {
    if (!(segment.value > 0)) continue;
    const cells = Math.round((Math.min(segment.value, total) / total) * size);
    const room = Math.min(cells, size - used);
    if (room <= 0) continue;
    out += theme.c(segment.color, FULL.repeat(room));
    used += room;
  }
  return out + theme.c("track", TRACK.repeat(Math.max(0, size - used)));
}

/**
 * 迷你趋势线。最后一个点用主色，其余用次级色——一眼能看出「现在」落在这段趋势的哪里。
 * 值全为 0 时画基线，不画成一排满格。
 */
export function sparkline(theme: Theme, values: number[], color: ColorName = "accent"): string {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  if (clean.length === 0) return "";
  const max = Math.max(...clean);
  if (max <= 0) return theme.c("faint", "▁".repeat(clean.length));
  const glyphs = clean.map((value) => SPARK[Math.min(7, Math.max(0, Math.round((value / max) * 7)))]!);
  return theme.c("track", glyphs.slice(0, -1).join("")) + theme.c(color, glyphs.at(-1)!);
}

/** 自下而上填充的竖直块，用来在字符网格里做出八分之一行的精度。 */
const VERTICAL = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface ChartOptions {
  width: number;
  /** 绘图区行数，不含底部的轴与刻度标签。 */
  height: number;
  values: number[];
  /** 与 values 等长；只有首、中、末三个会真的画出来。 */
  labels?: string[];
  color?: ColorName;
}

/**
 * 竖直柱状趋势图。
 *
 * 每根柱子用竖直块字符按八分之一行填充，所以 5 行高实际有 40 级分辨率——同样的高度里，
 * 火花线只有 8 级。相邻柱子之间留一列空隙而不是描边：白色负空间是分隔的手段，
 * 描边会添一层不属于数据的墨。
 *
 * 刻度只标 0 和最大值两个整数，标签只标首、中、末三天：轴负责给出量级，
 * 每根柱子都标数字反而没人看。
 */
/**
 * 柱子占格位的比例上限。
 *
 * 柱子永远不撑满自己的格位，留下的空隙就是分隔相邻柱子的手段——这比给每根柱子描边干净，
 * 描边会添一层不属于数据的墨。按比例而不是按固定列数留白：宽终端上柱子跟着变粗，
 * 图表铺满整行，而不是在右边留下半屏空白。
 */
const THICK_RATIO = 0.7;

export function columnChart(theme: Theme, options: ChartOptions): string[] {
  const { width: total, height, values, labels, color = "accent" } = options;
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  if (clean.length === 0 || height < 1) return [pad("", total)];
  const peak = Math.max(0, ...clean);

  // 左边留一列装订线，然后是刻度数字、轴符号，剩下的全给绘图区。
  const axisSize = width(String(peak));
  const plot = Math.max(1, total - axisSize - 3);
  const slot = Math.max(1, Math.floor(plot / clean.length));
  const thick = Math.max(1, slot > 1 ? Math.floor(slot * THICK_RATIO) : 1);
  const shown = clean.slice(-Math.max(1, Math.floor(plot / slot)));
  const span = shown.length * slot - (slot - thick);

  const tick = (label: string): string =>
    theme.c("muted", pad(label, axisSize, "right"));

  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    const fromBottom = height - row;
    let line = "";
    for (const value of shown) {
      const filled = peak > 0 ? (value / peak) * height : 0;
      let level = Math.max(0, Math.min(8, Math.round((filled - (fromBottom - 1)) * 8)));
      // 有值的那天不能画成空白：再小也顶一格，否则「那天没人用」和「那天用得少」看起来一样。
      if (level === 0 && value > 0 && fromBottom === 1) level = 1;
      line += (level > 0 ? theme.c(color, VERTICAL[level]!.repeat(thick)) : " ".repeat(thick)) +
        " ".repeat(slot - thick);
    }
    // 刻度只标峰值一个数：轴负责给出量级，每根柱子都标数字反而没人看。
    lines.push(pad(" " + tick(row === 0 ? String(peak) : "") + theme.c("faint", " │") + line, total));
  }

  // 零刻度标在基线上，不标在最后一行数据上——最后一行代表的是 0 到 peak/height，不是 0。
  lines.push(pad(" " + tick("0") + theme.c("faint", " └" + "─".repeat(span)), total));

  if (labels?.length) {
    const anchors = [0, Math.floor((shown.length - 1) / 2), shown.length - 1];
    const marks = [...new Set(anchors)].map((index) => ({
      // 标签居中对齐到它那根柱子；只标首、中、末三天，中间的交给轴。
      at: index * slot + Math.floor((thick - 1) / 2),
      text: labels.at(index - shown.length) ?? "",
    }));
    let line = "";
    for (const { at, text } of marks) {
      const start = Math.max(width(line), Math.min(at - Math.floor(width(text) / 2), span - width(text)));
      if (start + width(text) > span && width(line) > 0) continue;
      line += " ".repeat(Math.max(0, start - width(line))) + text;
    }
    lines.push(pad(" ".repeat(axisSize + 3) + theme.c("muted", line), total));
  }
  return lines;
}

/** 指标块第三行的图形宽度下限与上限：窄于下限就不画，宽于上限也不再拉长。 */
const MIN_GRAPH = 10;
const MAX_GRAPH = 14;

export interface TileOptions {
  width: number;
  /** 指标名，次级文字。 */
  label: string;
  /** 指标值，主文字加粗。数字不上主色——主色是数据图形的颜色，值本身靠字重取得层级。 */
  value: string;
  /**
   * 相对某个具名周期的变化，带方向符号；不给则不显示。
   *
   * status 只在「涨跌本身有好坏」时才给。用量涨了既不好也不坏，那种情况留空走次级色——
   * 红绿在这个界面里是「出没出问题」的意思，借去表示「涨没涨」会让两种含义互相污染。
   */
  delta?: { text: string; status?: StatusName };
  /** 第三行：趋势线或仪表，二选一，都不给就留空行保持四块等高。 */
  trend?: number[];
  meter?: { segments: { value: number; color: ColorName }[]; total: number };
  /** 第三行右侧的注解，如「峰值 128」。 */
  foot?: string;
}

/**
 * 指标块：标签 / 值 / 趋势，三行，无边框。
 *
 * 不套框是有意的：四个指标并排时，八条竖边框比它们框住的数字还显眼。留白已经足够分组，
 * 省下的两行高度给了下面的待办列表。
 */
export function tile(theme: Theme, options: TileOptions): string[] {
  const { width: size, label, value, delta, trend, foot } = options;
  const head = theme.c("muted", truncate(label, size));
  const shown = theme.bold(value);
  const tail = delta ? " " + theme.c(delta.status ? STATUS[delta.status].color : "muted", delta.text) : "";

  // 第三行是「图形 + 注解」，窄格位下放不下两样。谁让位取决于图形是哪一种：
  //
  // 仪表让位。一条没有说明的彩色进度条不知道在量什么，语义全压在颜色上；而那行注解
  // （「tmp 10.0 GB」）本身就是完整信息，单独留着仍然读得懂。
  // 趋势线不让位。它是上面那个值自己的历史，标签已经在第一行了；反倒是砍短它更糟——
  // 半截趋势线看起来像完整的一段，读的人不会知道自己只看到了后七天。
  const wanted = foot ? width(foot) + 1 : 0;
  const fits = foot !== undefined && size - wanted >= MIN_GRAPH;
  const note = foot && (fits || options.meter) ? theme.c("muted", truncate(foot, size)) : "";
  const room = Math.max(0, size - (note ? wanted : 0));
  const graph = options.meter
    ? (room >= MIN_GRAPH ? meter(theme, options.meter.segments, options.meter.total, Math.min(room, MAX_GRAPH)) : "")
    : trend?.length
      ? sparkline(theme, trend.slice(-Math.min(room, MAX_GRAPH)))
      : "";
  // 有图形时注解贴右，和图形分列两端；没有图形时注解顶左，否则它会孤零零地挂在右边，
  // 和这一栏其余左对齐的内容对不上。
  const spacing = Math.max(0, size - width(graph) - width(note));
  const third = graph ? graph + " ".repeat(spacing) + note : note;

  return [pad(head, size), pad(shown + tail, size), pad(third, size)];
}

/** 从统一状态表取得符号和颜色；无色终端保留符号。 */
export function mark(theme: Theme, name: StatusName): string {
  const { glyph, color } = STATUS[name];
  return theme.c(color, glyph);
}

/** 页面加载、后台查询和执行面板共用时钟，无需逐页维护帧号。 */
export function spinner(theme: Theme): string {
  const frame = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER.length;
  return theme.c(STATUS.busy.color, SPINNER[frame]!);
}

/** 状态标记：符号 + 同色文字。用于页眉、提示行这类单行状态。 */
export function status(theme: Theme, name: StatusName, text: string): string {
  return `${name === "busy" ? spinner(theme) : mark(theme, name)} ${theme.c(STATUS[name].color, text)}`;
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
