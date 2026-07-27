/**
 * Markdown 纯文本转换核心改编自 wong2/weixin-agent-sdk：
 * https://github.com/wong2/weixin-agent-sdk/blob/main/packages/sdk/src/messaging/send.ts
 * MIT License, Copyright (c) 2026 wong2。完整许可见 THIRD_PARTY_NOTICES.md。
 *
 * 本项目额外处理了波浪线代码围栏、标题和引用，并负责判断回复是否
 * 确实包含可渲染的 Markdown 标记。
 */

const TABLE_PATTERN =
  /(^|\n)\s*\|?.+\|.+\r?\n\s*\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?/;
const BLOCK_PATTERN =
  /```|~~~|(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|(?:[-*_]\s*){3,}$)/m;
const INLINE_PATTERN =
  /\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_)|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)/;

/** 普通段落走 text；确实带标题、强调、列表、链接、表格或代码时才渲染 Markdown。 */
export function shouldRenderMarkdown(text: string): boolean {
  return (
    TABLE_PATTERN.test(text) ||
    BLOCK_PATTERN.test(text) ||
    INLINE_PATTERN.test(text)
  );
}

/**
 * 把模型常见 Markdown 输出转成适合 text 消息的可读纯文本。
 * 保留换行和列表结构，只移除不影响语义的展示标记。
 */
export function markdownToPlainText(text: string): string {
  let result = text;

  // 代码块：去掉围栏，保留代码内容。
  result = result.replace(
    /```[^\n]*\n?([\s\S]*?)```/g,
    (_, code: string) => code.trim()
  );
  result = result.replace(
    /~~~[^\n]*\n?([\s\S]*?)~~~/g,
    (_, code: string) => code.trim()
  );
  // 图片不能通过 text 展示，直接移除；链接保留显示文字。
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Markdown 发送失败时，表格降级为逐行、空格分隔的文本。
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner
      .split("|")
      .map((cell) => cell.trim())
      .join(" ")
  );
  // 标题和引用保留正文；列表符号保留，避免破坏层次。
  result = result
    .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^\s{0,3}>[ \t]?/gm, "");
  // 行内格式只影响展示，移除标记。
  result = result
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");

  return result.replace(/\n{3,}/g, "\n\n").trim();
}
