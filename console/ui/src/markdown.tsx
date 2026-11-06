/** @jsxImportSource preact */
// Safe Markdown for assistant replies. The text is parsed into Preact elements, never into an HTML string: raw HTML in a
// message stays visible text, links open only for http(s) without a referrer, and images are named, not loaded. Every
// pattern is bounded (span lengths, nesting depth), so hostile text costs linear time.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "./icons.tsx";

type Align = "" | "left" | "center" | "right";
type Block =
  | { type: "code"; info: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; start: number; items: string[] }
  | { type: "rule" }
  | { type: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { type: "para"; text: string };

const MAX_DEPTH = 6;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const isTableStart = (lines: string[], i: number) =>
  lines[i]!.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("-") && TABLE_RULE.test(lines[i + 1]!);
const startsBlock = (lines: string[], i: number) => {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i);
};

function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  const text = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") { cell += "|"; i++; }
    else if (text[i] === "|") { out.push(cell.trim()); cell = ""; }
    else cell += text[i];
  }
  out.push(cell.trim());
  return out.slice(0, 50);
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!, close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push({ type: "code", info: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = HEADING.exec(line);
    if (heading) { out.push({ type: "heading", level: heading[1]!.length, text: heading[2] ?? "" }); i++; continue; }
    if (RULE.test(line)) { out.push({ type: "rule" }); i++; continue; }
    if (QUOTE.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^ {0,3}> ?/, ""));
      out.push({ type: "quote", text: quote.join("\n") });
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const item = ITEM.exec(lines[i]!);
        if (!item || /\d/.test(item[2]!) !== ordered) break;
        const body = [item[3] ?? ""];
        const indent = item[1]!.length + item[2]!.length + 1;
        for (i++; i < lines.length; i++) {
          const next = lines[i]!;
          // Continuation: indented lines (nested lists, wrapped text); a blank line continues only into indented text.
          if (next.trim() && /^\s{2,}/.test(next)) body.push(next.slice(Math.min(indent, next.length - next.trimStart().length)));
          else if (!next.trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!)) body.push("");
          else if (next.trim() && !startsBlock(lines, i) && !/^\s*$/.test(lines[i - 1]!)) body.push(next.trim());
          else break;
        }
        items.push(body.join("\n"));
        if (i < lines.length && !lines[i]!.trim() && i + 1 < lines.length && ITEM.test(lines[i + 1]!)) i++;
      }
      out.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items: items.slice(0, 1_000) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((spec): Align => spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : spec.startsWith(":") ? "left" : "");
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim(); i++) if (rows.length < 1_000) rows.push(cells(lines[i]!));
      out.push({ type: "table", head, align, rows });
      continue;
    }
    const para = [line];
    for (i++; i < lines.length && lines[i]!.trim() && !startsBlock(lines, i); i++) para.push(lines[i]!);
    out.push({ type: "para", text: para.join("\n") });
  }
  return out;
}

/** An http(s) URL to link to, or null: other schemes and relative links stay text. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const ESCAPABLE = /[!-/:-@[-`{-~]/;
// Sticky patterns, tried only where their first character appears. Spans are capped so unclosed markers stay cheap.
const STRONG = /(\*\*|__)(?=\S)([^\n]{0,500}?\S)\1/y;
const EM = /([*_])(?=[^\s*_])([^\n]{0,500}?[^\s*_])\1/y;
const DEL = /~~(?=\S)([^\n]{0,500}?\S)~~/y;
const LINK = /(!?)\[([^\]\n]{0,500})\]\(\s*<?([^\s)>]{1,2000})>?(?:\s+"[^"\n]{0,300}")?\s*\)/y;
const AUTO = /<(https?:\/\/[^\s<>]{1,2000})>/y;
const BARE = /https?:\/\/[^\s<>"'`，。！？；：、（）【】「」《》]{1,2000}/y;

function Lines({ text }: { text: string }) {
  const parts = text.split("\n");
  return <>{parts.map((part, index) => index ? [<br key={`b${index}`} />, part] : part)}</>;
}

function Anchor({ href, children }: { href: string; children: ComponentChildren }) {
  const safe = safeHref(href);
  if (!safe) return <span class="md-unsafe" title="不是 http(s) 链接，未生成链接">{children}</span>;
  return <a href={safe} target="_blank" rel="noreferrer noopener" title={safe}>{children}</a>;
}

export function inline(text: string, depth = 0): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let plain = "";
  const flush = () => { if (plain) { out.push(<Lines key={out.length} text={plain} />); plain = ""; } };
  const at = (pattern: RegExp, index: number) => { pattern.lastIndex = index; return pattern.exec(text); };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1]!)) { plain += text[i + 1]; i += 2; continue; }
    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const fence = "`".repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close >= 0 && text[close + run] === "`") close = text.indexOf(fence, close + run + 1);
      if (close >= 0) {
        flush();
        out.push(<code key={out.length} class="md-inline-code">{text.slice(i + run, close).replace(/\n/g, " ")}</code>);
        i = close + run;
      } else { plain += fence; i += run; }
      continue;
    }
    if (depth < MAX_DEPTH) {
      let match: RegExpExecArray | null = null;
      if ((c === "*" || c === "_") && (match = at(STRONG, i)) && !(c === "_" && /\w/.test(text[i - 1] ?? ""))) {
        flush(); out.push(<strong key={out.length}>{inline(match[2]!, depth + 1)}</strong>); i += match[0].length; continue;
      }
      if ((c === "*" || c === "_") && (match = at(EM, i)) && !(c === "_" && (/\w/.test(text[i - 1] ?? "") || /\w/.test(text[i + match[0].length] ?? "")))) {
        flush(); out.push(<em key={out.length}>{inline(match[2]!, depth + 1)}</em>); i += match[0].length; continue;
      }
      if (c === "~" && (match = at(DEL, i))) {
        flush(); out.push(<del key={out.length}>{inline(match[1]!, depth + 1)}</del>); i += match[0].length; continue;
      }
      if ((c === "[" || c === "!") && (match = at(LINK, i))) {
        flush();
        if (match[1]) out.push(<span key={out.length} class="md-image" title={match[3]}><Icon name="file" size={13} />图片：{match[2] || "无说明"}（未加载）</span>);
        else out.push(<Anchor key={out.length} href={match[3]!}>{inline(match[2]!, depth + 1)}</Anchor>);
        i += match[0].length;
        continue;
      }
    }
    if (c === "<" && (AUTO.lastIndex = i, AUTO.test(text))) {
      const url = text.slice(i + 1, AUTO.lastIndex - 1);
      flush(); out.push(<Anchor key={out.length} href={url}>{url}</Anchor>); i = AUTO.lastIndex; continue;
    }
    if (c === "h" && !/[\w/]/.test(text[i - 1] ?? "")) {
      const match = at(BARE, i);
      if (match) {
        // Trailing punctuation belongs to the sentence, and a closing parenthesis only to a URL that opened one.
        let url = match[0].replace(/[.,;:!?'"]+$/, "");
        while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
        flush(); out.push(<Anchor key={out.length} href={url}>{url}</Anchor>); i += url.length; continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

function CodeBlock({ info, text }: { info: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_500); }, () => {});
  };
  return (
    <div class="md-code">
      <div class="md-code-bar"><span>{info || "文本"}</span>
        <button type="button" class="md-copy" onClick={copy} aria-label="复制代码">{copied ? "已复制" : "复制"}</button></div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

function renderBlocks(source: string, depth: number): ComponentChildren[] {
  return parseBlocks(source).map((block, index) => {
    switch (block.type) {
      case "code": return <CodeBlock key={index} info={block.info} text={block.text} />;
      case "heading": return <div key={index} class={`md-h md-h${block.level}`} role="heading" aria-level={Math.min(6, block.level + 2)}>{inline(block.text)}</div>;
      case "rule": return <hr key={index} />;
      case "quote": return <blockquote key={index}>{depth < MAX_DEPTH ? renderBlocks(block.text, depth + 1) : <Lines text={block.text} />}</blockquote>;
      case "list": {
        const items = block.items.map((item, at) => {
          const inner = depth < MAX_DEPTH ? parseBlocks(item) : [];
          // A tight item (one paragraph) renders inline, without a <p>.
          const body = inner.length === 1 && inner[0]!.type === "para" ? inline(inner[0]!.text)
            : depth < MAX_DEPTH ? renderBlocks(item, depth + 1) : <Lines text={item} />;
          return <li key={at}>{body}</li>;
        });
        return block.ordered ? <ol key={index} start={block.start}>{items}</ol> : <ul key={index}>{items}</ul>;
      }
      case "table": return (
        <div key={index} class="md-table-wrap">
          <table class="md-table">
            <thead><tr>{block.head.map((cell, at) => <th key={at} style={block.align[at] ? { textAlign: block.align[at] } : undefined}>{inline(cell)}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, at) => <tr key={at}>{block.head.map((_, column) => <td key={column} style={block.align[column] ? { textAlign: block.align[column] } : undefined}>{inline(row[column] ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      case "para": return <p key={index}>{inline(block.text)}</p>;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <div class="md">{renderBlocks(text, 0)}</div>;
}
