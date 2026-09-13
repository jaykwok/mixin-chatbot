// 设计令牌。按终端色深输出前景色，不设置面板背景。
// 状态使用 STATUS 中的符号与颜色，无色终端仍保留符号。

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
 *
 * 两套色值都跑过配色校验（深色终端底，全对比）：真彩下最差配对 CVD ΔE 8.4、对比度全部 ≥3:1；
 * 256 色回退最差 CVD ΔE 7.8，落在需要「第二编码」的区间——这正是 STATUS 里每档都配一个
 * 独占符号的原因，颜色从来不是唯一的区分手段。
 *
 * 严重度三档（warn / serious / danger）落在同一条黄—橙—红色相弧上，正常视觉最差配对 ΔE 13.3，
 * 到不了 15：一条语义上必须连续的严重度阶梯，本来就没法在色相上拉开到互不相干。符号 + 文字
 * 承担区分，色相只负责「越往后越糟」这个方向感。
 */
const PALETTE = {
  /** 主色，同时用于图表的数据序列。 */
  accent: { rgb: [78, 155, 240], x256: 75 },
  /**
   * 进度条、仪表的未填充轨道：主色同色相的暗步。
   *
   * 不复用 faint：那是边框的墨色，轨道穿上它以后整条仪表看起来像一段装饰线而不是一个值。
   * 这一步对底色 1.9:1（够退让），对填充色 3.1:1（够看出填到哪），两个数都比 faint 合适。
   * 256 色下退回中性灰，色相丢了，但「轨道」这个角色还在。
   */
  track: { rgb: [45, 74, 110], x256: 239 },
  ok: { rgb: [79, 214, 156], x256: 79 },
  warn: { rgb: [245, 196, 81], x256: 221 },
  serious: { rgb: [255, 138, 61], x256: 209 },
  danger: { rgb: [242, 96, 122], x256: 204 },
  /**
   * 次级文字：标签、轴、说明。
   *
   * 没有「主文字色」这一档，是有意的：主文字一律不上色，用终端自己的默认前景色，靠 bold 取得
   * 层级。任何写死的浅色都只对深色底成立——近白色的 #E2E8F0 对白底只有 1.23:1，等于看不见，
   * 而界面里最该被读到的就是那些数值。默认前景色是唯一对深浅两种背景都正确的选择。
   */
  muted: { rgb: [148, 163, 184], x256: 248 },
  /** 边框与分隔线，比背景只高一步。 */
  faint: { rgb: [71, 85, 105], x256: 240 },
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

/** 内层 RESET 会同时清除外层样式；在每处 RESET 后重新应用外层样式，保持嵌套显示。 */
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
 * 状态同时使用颜色和单列符号。
 *
 * 符号不是装饰：严重度三档在色相上拉不开（见 PALETTE 注释），NO_COLOR、色觉障碍和黑白截图
 * 三种情况下，能区分它们的只剩这个符号。所以每档必须独占一个符号，且一律占一列，
 * 否则表格会因为状态不同而错位。
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
