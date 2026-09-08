// Use the same maintained Markdown parser as Pi; never strip URL/code characters by regex.
import { Lexer, type Token, type Tokens } from "marked";

function inline(tokens: Token[]): string { return tokens.map(plain).join(""); }
function plain(token: Token): string {
  switch (token.type) {
    case "space": return token.raw;
    case "code": return (token as Tokens.Code).text + "\n";
    case "codespan": return (token as Tokens.Codespan).text;
    case "br": return "\n";
    case "hr": return "\n";
    case "image": {
      const image = token as Tokens.Image;
      return `${image.text || "图片"} (${image.href})`;
    }
    case "link": {
      const link = token as Tokens.Link;
      const label = inline(link.tokens);
      return label === link.href ? link.href : label + " (" + link.href + ")";
    }
    case "list": {
      const list = token as Tokens.List;
      return list.items.map((item, i) => (list.ordered ? String(Number(list.start) + i) + ". " : "- ") + inline(item.tokens).trim()).join("\n") + "\n";
    }
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: Tokens.TableCell[]) => cells.map((cell) => inline(cell.tokens)).join(" ");
      return row(table.header) + "\n\n" + table.rows.map(row).join("\n") + "\n";
    }
    case "html": return token.raw.replace(/<[^>]*>/g, "");
    default: {
      const value = token as Token & { tokens?: Token[]; text?: string };
      const text = value.tokens ? inline(value.tokens) : value.text ?? value.raw;
      return text + (["paragraph", "heading", "blockquote"].includes(token.type) ? "\n" : "");
    }
  }
}

export function markdownToPlainText(text: string): string {
  return inline(Lexer.lex(text)).replace(/\n{3,}/g, "\n\n").trim();
}

export function shouldRenderMarkdown(text: string): boolean {
  const formatted = (token: Token): boolean => {
    if (["heading", "blockquote", "list", "table", "code", "codespan", "strong", "em", "del", "image", "hr"].includes(token.type)) return true;
    if (token.type === "link" && token.raw.startsWith("[")) return true;
    const nested = (token as Token & { tokens?: Token[] }).tokens;
    return !!nested?.some(formatted);
  };
  return Lexer.lex(text).some(formatted);
}
