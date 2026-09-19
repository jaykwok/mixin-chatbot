// Markdown is the model-facing content format for new documents. This module turns it
// into a small block model that document_ops.py renders with the template's styles.
import { Lexer, type Token, type Tokens } from "marked";

export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string; }
export interface ListItem { runs: Run[]; level: number; ordered: boolean; }
export type Block =
  | { type: "heading"; level: number; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; items: ListItem[] }
  | { type: "table"; header: Run[][]; rows: Run[][][]; align: ("left" | "center" | "right" | null)[] }
  | { type: "image"; path: string; alt: string; width?: string }
  | { type: "quote"; paragraphs: Run[][] }
  | { type: "code"; text: string; lang?: string }
  | { type: "pagebreak" }
  | { type: "note"; text: string }
  | { type: "layout"; mode: LayoutMode };
export type LayoutMode = "cards" | "timeline" | "flow" | "layers" | "pyramid" | "cycle" | "stats" | "plain";
export interface ParsedMarkdown { blocks: Block[]; images: string[]; warnings: string[]; }

const MAX_CONTENT = 200000;

function stripTags(html: string): string { return html.replace(/<[^>]*>/g, ""); }

/** Images are lifted out of paragraphs, which can leave line breaks at either end. */
function trimRuns(runs: Run[]): Run[] {
  const result = runs.map(run => ({ ...run }));
  while (result.length && !result[0]!.text.replace(/^\s+/, "")) result.shift();
  if (result.length) result[0]!.text = result[0]!.text.replace(/^\s+/, "");
  while (result.length && !result[result.length - 1]!.text.replace(/\s+$/, "")) result.pop();
  if (result.length) result[result.length - 1]!.text = result[result.length - 1]!.text.replace(/\s+$/, "");
  return result;
}

function inlineRuns(tokens: Token[] | undefined, style: Omit<Run, "text">, warnings: string[], deferred: Block[]): Run[] {
  const runs: Run[] = [];
  const push = (text: string, extra: Omit<Run, "text"> = {}) => { if (text) runs.push({ text, ...style, ...extra }); };
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const value = token as Tokens.Text;
        if (value.tokens?.length) runs.push(...inlineRuns(value.tokens, style, warnings, deferred));
        else push(value.text);
        break;
      }
      case "escape": push((token as Tokens.Escape).text); break;
      case "strong": runs.push(...inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }, warnings, deferred)); break;
      case "em": runs.push(...inlineRuns((token as Tokens.Em).tokens, { ...style, italic: true }, warnings, deferred)); break;
      case "del": runs.push(...inlineRuns((token as Tokens.Del).tokens, style, warnings, deferred)); break;
      case "codespan": push((token as Tokens.Codespan).text, { code: true }); break;
      case "br": push("\n"); break;
      case "link": {
        const link = token as Tokens.Link;
        const label = inlineRuns(link.tokens, style, warnings, deferred).map(r => r.text).join("") || link.href;
        push(label, /^(https?:|mailto:)/i.test(link.href) ? { link: link.href } : {});
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        deferred.push({ type: "image", path: image.href, alt: image.text, ...(image.title ? { width: image.title } : {}) });
        break;
      }
      case "html": push(stripTags(token.raw)); break;
      default: push(stripTags((token as { raw: string }).raw));
    }
  }
  return runs;
}

function flattenList(list: Tokens.List, level: number, items: ListItem[], warnings: string[], deferred: Block[]): void {
  for (const item of list.items) {
    const own: Token[] = [], nested: Tokens.List[] = [];
    for (const token of item.tokens) {
      if (token.type === "list") nested.push(token as Tokens.List);
      else if (token.type === "text" || token.type === "paragraph") own.push(...((token as Tokens.Text).tokens ?? [token]));
      else if (token.type !== "space" && token.type !== "checkbox") warnings.push("列表项中忽略了不支持的内容：" + token.type);
    }
    const runs = inlineRuns(own, {}, warnings, deferred);
    if (item.task) runs.unshift({ text: item.checked ? "☑ " : "☐ " });
    items.push({ runs, level: Math.min(level, 2), ordered: !!list.ordered });
    for (const child of nested) flattenList(child, level + 1, items, warnings, deferred);
  }
}

const LAYOUT_DIRECTIVES: [RegExp, LayoutMode][] = [
  [/^(cards?|columns?|卡片|多栏|分栏)$/i, "cards"], [/^(timeline|时间轴|时间线)$/i, "timeline"], [/^(flow|process|steps?|流程|步骤)$/i, "flow"],
  [/^(layers?|architecture|stack|分层|架构)$/i, "layers"], [/^(pyramid|金字塔)$/i, "pyramid"], [/^(cycle|loop|循环|闭环)$/i, "cycle"],
  [/^(stats?|numbers?|figures?|数字|指标)$/i, "stats"], [/^(plain|list|常规|列表)$/i, "plain"],
];

function directive(html: string): Block | null {
  const match = /^\s*<!--\s*([a-z一-鿿]+)\s*:?\s*([\s\S]*?)\s*-->\s*$/i.exec(html);
  if (!match) return null;
  const [, name, value] = match;
  if (/^(notes?|备注)$/i.test(name!)) return { type: "note", text: value!.trim() };
  if (/^(pagebreak|newslide|分页|新页)$/i.test(name!)) return { type: "pagebreak" };
  const mode = LAYOUT_DIRECTIVES.find(([pattern]) => pattern.test(name!))?.[1];
  if (mode) return { type: "layout", mode };
  return null;
}

export function markdownToBlocks(content: string): ParsedMarkdown {
  if (typeof content !== "string" || !content.trim()) throw new Error("content 不能为空");
  if (content.length > MAX_CONTENT) throw new Error("content 超过 200000 字符");
  const warnings: string[] = [], blocks: Block[] = [];
  for (const token of Lexer.lex(content)) {
    const deferred: Block[] = [];
    switch (token.type) {
      case "space": break;
      case "heading": {
        const heading = token as Tokens.Heading;
        blocks.push({ type: "heading", level: Math.min(heading.depth, 4), runs: inlineRuns(heading.tokens, {}, warnings, deferred) });
        break;
      }
      case "paragraph": {
        const runs = trimRuns(inlineRuns((token as Tokens.Paragraph).tokens, {}, warnings, deferred));
        if (runs.some(r => r.text.trim())) blocks.push({ type: "paragraph", runs });
        break;
      }
      case "list": {
        const items: ListItem[] = [];
        flattenList(token as Tokens.List, 0, items, warnings, deferred);
        if (items.length) blocks.push({ type: "list", items });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        blocks.push({ type: "table", align: table.align,
          header: table.header.map(cell => inlineRuns(cell.tokens, {}, warnings, deferred)),
          rows: table.rows.map(row => row.map(cell => inlineRuns(cell.tokens, {}, warnings, deferred))) });
        break;
      }
      case "blockquote": {
        const paragraphs: Run[][] = [];
        for (const inner of (token as Tokens.Blockquote).tokens) {
          if (inner.type === "paragraph" || inner.type === "text") paragraphs.push(inlineRuns((inner as Tokens.Paragraph).tokens, {}, warnings, deferred));
          else if (inner.type === "list") {
            const items: ListItem[] = [];
            flattenList(inner as Tokens.List, 0, items, warnings, deferred);
            paragraphs.push(...items.map(i => [{ text: "• " }, ...i.runs]));
          } else if (inner.type !== "space") warnings.push("引用中忽略了不支持的内容：" + inner.type);
        }
        if (paragraphs.length) blocks.push({ type: "quote", paragraphs });
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const lang = code.lang?.trim().split(/\s+/)[0]?.toLowerCase();
        blocks.push({ type: "code", text: code.text, ...(lang ? { lang } : {}) });
        break;
      }
      case "hr": blocks.push({ type: "pagebreak" }); break;
      case "html": {
        const block = directive(token.raw);
        if (block) blocks.push(block);
        else if (!/^\s*<!--[\s\S]*-->\s*$/.test(token.raw)) {
          warnings.push("HTML 标签已按纯文本处理");
          const text = stripTags(token.raw).trim();
          if (text) blocks.push({ type: "paragraph", runs: [{ text }] });
        }
        break;
      }
      default: {
        const text = stripTags((token as { raw: string }).raw).trim();
        if (text) blocks.push({ type: "paragraph", runs: [{ text }] });
        warnings.push("未识别的 Markdown 结构按段落处理：" + token.type);
      }
    }
    blocks.push(...deferred);
  }
  const images = [...new Set(blocks.flatMap(block => block.type === "image" ? [block.path] : []))];
  if (images.length > 40) throw new Error("单次最多引用 40 张图片");
  return { blocks, images, warnings: [...new Set(warnings)] };
}
