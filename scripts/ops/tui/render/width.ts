// 宽度交给 Bun；只维护 ANSI 样式与可见字符的切分，不再维护 Unicode 区段表。
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
const SGR = /^\u001b\[[0-9;:]*m$/;
const RESET = "\u001b[0m";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function width(text: string): number { return Bun.stringWidth(text); }

/** 样式序列作为一个 token；可见文本按字素切分，避免拆开组合符号或 emoji。 */
function* tokens(text: string): Generator<string> {
  let offset = 0;
  const plain = function* (part: string) {
    for (const { segment } of graphemes.segment(part.replace(/\t/g, "    ").replace(/[\u0000-\u001f\u007f-\u009f]/g, ""))) yield segment;
  };
  for (const match of text.matchAll(ANSI)) {
    yield* plain(text.slice(offset, match.index));
    // 输出区只接受颜色/样式，日志里的光标移动不能改写整个屏幕。
    if (SGR.test(match[0])) yield match[0];
    offset = match.index! + match[0].length;
  }
  yield* plain(text.slice(offset));
}

export function truncate(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  const parts = [...tokens(text)];
  const total = parts.reduce((sum, part) => sum + width(part), 0);
  const tail = total > max ? ellipsis : "";
  const limit = Math.max(0, max - width(tail));
  let used = 0;
  let out = "";
  let styled = false;
  for (const part of parts) {
    if (SGR.test(part)) {
      out += part;
      styled = true;
    } else {
      const size = width(part);
      if (used + size > limit) break;
      out += part;
      used += size;
    }
  }
  return out + (width(tail) <= max ? tail : "") + (styled ? RESET : "");
}

export type Align = "left" | "right" | "center";

export function pad(text: string, size: number, align: Align = "left"): string {
  if (size <= 0) return "";
  const clipped = truncate(text, size);
  const gap = Math.max(0, size - width(clipped));
  if (align === "right") return " ".repeat(gap) + clipped;
  if (align === "center") {
    const left = gap >> 1;
    return " ".repeat(left) + clipped + " ".repeat(gap - left);
  }
  return clipped + " ".repeat(gap);
}

/** 按显示列折行；每行独立闭合样式，下一行恢复样式，适用于滚动输出。 */
export function wrap(text: string, size: number): string[] {
  if (size <= 0) return [];
  const lines: string[] = [];
  let style = "";
  for (const paragraph of text.split(/\r?\n/)) {
    let line = style;
    let used = 0;
    for (const part of tokens(paragraph)) {
      if (SGR.test(part)) {
        style = part === RESET || part === "\u001b[m" ? "" : style + part;
        line += part;
        continue;
      }
      const columns = width(part);
      if (used + columns > size && used > 0) {
        lines.push(line + (style ? RESET : ""));
        line = style;
        used = 0;
      }
      if (columns <= size) { line += part; used += columns; }
    }
    lines.push(line + (style ? RESET : ""));
  }
  return lines;
}
