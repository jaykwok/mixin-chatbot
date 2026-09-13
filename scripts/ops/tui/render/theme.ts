// 按终端色深输出前景色，不设置面板背景。
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
 * x256 是 256 色终端使用的备用色号。
 */
const PALETTE = {
  /** 主色，同时用于图表的数据序列。 */
  accent: { rgb: [57, 135, 229], x256: 68 },
  /** 同一条蓝色梯度的浅步，用于次级强调。 */
  accentSoft: { rgb: [134, 182, 239], x256: 111 },
  ok: { rgb: [12, 163, 12], x256: 34 },
  warn: { rgb: [250, 178, 25], x256: 214 },
  serious: { rgb: [236, 131, 90], x256: 209 },
  danger: { rgb: [208, 59, 59], x256: 167 },
  text: { rgb: [255, 255, 255], x256: 231 },
  /** 轴、标签等次要文字。 */
  muted: { rgb: [137, 135, 129], x256: 245 },
  /** 边框与分隔线。 */
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

/** 状态同时使用颜色和单列符号，NO_COLOR 下仍可区分结果且保持表格对齐。 */
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
