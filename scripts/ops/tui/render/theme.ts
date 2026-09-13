// 配色与状态符号。
//
// 两条约束决定了这里的每一个取值：
//
// 1) 只上前景色，不铺整块背景。终端底色是用户自己定的，浅色主题上铺一层深灰面板会变成
//    一块脏印子，而我们无从知道对方用的是什么底色。细边框 + 前景色在深浅终端上都成立。
//
// 2) 色值不是挑出来的，是验过的。原本凭手感选的一套（青主色 + 绿/黄/红）在校验里三项不过：
//    紫与蓝在红绿色盲下 ΔE 1.3，绿与青在正常视力下 ΔE 9.6（低于 15 的硬底线）——而「绿色
//    状态点挨着青色边框」正是总览页每一屏都有的组合。现用的是数据可视化规范里那套已验证
//    的参考色板：分类槽 1（蓝）作主色与序列色，状态色取其固定的 good/warning/serious/
//    critical 四档。
//
// 状态色在红绿色盲下本来就分不开（good 与 critical ΔE 4.1），规范对此的要求是状态必须
// 同时带符号和文字，不能只靠颜色。所以状态一律走 STATUS 表拿「符号 + 颜色」，视图里没有
// 只给颜色的入口——这条约束写进类型，比写进注释可靠。

export type ColorDepth = "truecolor" | "ansi256" | "none";

const CSI = String.fromCharCode(27) + "[";
const RESET = `${CSI}0m`;

/**
 * 终端色深探测。
 *
 * FORCE_COLOR 允许在管道里强制上色（截图、录屏用得上）；NO_COLOR 是社区约定的一票否决，
 * 优先级高于一切自动判断。Windows Terminal 不设 COLORTERM，靠 WT_SESSION 认。
 */
export function detectDepth(stream: { isTTY?: boolean } = process.stdout): ColorDepth {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.FORCE_COLOR === "0") return "none";
  if (env.FORCE_COLOR === "3") return "truecolor";
  if (env.FORCE_COLOR === "2" || env.FORCE_COLOR === "1") return "ansi256";
  if (!stream.isTTY) return "none";
  if (env.TERM === "dumb") return "none";
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "iTerm.app") {
    return "truecolor";
  }
  if ((env.TERM ?? "").includes("256")) return "ansi256";
  return env.TERM ? "ansi256" : "none";
}

type Rgb = readonly [number, number, number];

/**
 * 语义色板。名字按用途取，不按颜色取——改配色时不必回头找每一处调用。
 * x256 是 256 色终端下最接近的色号，降级时整体观感不会散。
 */
const PALETTE = {
  /** 分类槽 1（蓝）。主色，同时是所有「比大小」图形的单一序列色。 */
  accent: { rgb: [57, 135, 229], x256: 68 },
  /** 同一条蓝色梯度的浅步，用于次级强调。 */
  accentSoft: { rgb: [134, 182, 239], x256: 111 },
  ok: { rgb: [12, 163, 12], x256: 34 }, // status good
  warn: { rgb: [250, 178, 25], x256: 214 }, // status warning
  serious: { rgb: [236, 131, 90], x256: 209 }, // status serious
  danger: { rgb: [208, 59, 59], x256: 167 }, // status critical
  text: { rgb: [255, 255, 255], x256: 231 },
  /** 轴、标签一类的次要文字；规范里深浅两模式同值。 */
  muted: { rgb: [137, 135, 129], x256: 245 },
  /** 边框与分隔线。刻意压暗，但在纯黑终端上仍有 3:1，不会糊成一片。 */
  faint: { rgb: [107, 106, 102], x256: 242 },
} as const satisfies Record<string, { rgb: Rgb; x256: number }>;

export type ColorName = keyof typeof PALETTE;

function fg(color: ColorName, depth: ColorDepth): string {
  if (depth === "none") return "";
  const entry = PALETTE[color];
  if (depth === "truecolor") {
    const [r, g, b] = entry.rgb;
    return `${CSI}38;2;${r};${g};${b}m`;
  }
  return `${CSI}38;5;${entry.x256}m`;
}

/** 一套绑定了色深的上色函数；视图只管语义，不管能力探测。 */
export interface Theme {
  depth: ColorDepth;
  /** 上色；无色终端下原样返回。 */
  c(color: ColorName, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  /** 反色，用于选中行。无色终端下退回方括号标记，仍然看得出选中了哪一行。 */
  invert(text: string): string;
  underline(text: string): string;
}

/**
 * 套一层样式，并在文本内部每一处 reset 之后把它重新打开。
 *
 * 这是嵌套上色唯一的坑：选中行外面套反色，里面的进度条自己带了颜色，它结束时的 `0m`
 * 会把反色一起关掉——于是选中条从进度条那里断成两截。ANSI 没有「只关闭我这一层」的写法，
 * 所以每遇到一个内部 reset 就把外层重新打开一次。
 */
function wrapStyle(open: string, text: string): string {
  return `${open}${text.replaceAll(RESET, RESET + open)}${RESET}`;
}

export function createTheme(depth: ColorDepth = detectDepth()): Theme {
  const plain = depth === "none";
  return {
    depth,
    c: (color, text) => (plain || text === "" ? text : wrapStyle(fg(color, depth), text)),
    bold: (text) => (plain ? text : wrapStyle(`${CSI}1m`, text)),
    dim: (text) => (plain ? text : wrapStyle(`${CSI}2m`, text)),
    invert: (text) => (plain ? `[${text}]` : wrapStyle(`${CSI}7m`, text)),
    underline: (text) => (plain ? text : wrapStyle(`${CSI}4m`, text)),
  };
}

export type StatusName = "ok" | "running" | "warn" | "serious" | "danger" | "idle" | "busy";

/**
 * 状态 = 符号 + 颜色，绑在一起取。
 *
 * good 与 critical 在红绿色盲下 ΔE 只有 4.1，两个只换颜色的 ● 对相当一部分人是同一个点。
 * 符号选的是形状差异明显的一组，去掉颜色也认得出谁是谁——这同时让 NO_COLOR 和管道输出
 * 不损失信息。符号宽度统一为 1 列，表格不会因为状态不同而错位。
 */
export const STATUS: Record<StatusName, { glyph: string; color: ColorName }> = {
  ok: { glyph: "✓", color: "ok" },
  /** 「正在运行」用实心点而不是对勾：✓ 表示一项检查通过，● 表示一个东西此刻活着。 */
  running: { glyph: "●", color: "ok" },
  warn: { glyph: "!", color: "warn" },
  serious: { glyph: "▲", color: "serious" },
  danger: { glyph: "✗", color: "danger" },
  idle: { glyph: "○", color: "muted" },
  busy: { glyph: "●", color: "accent" },
};
