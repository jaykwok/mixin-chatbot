/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "清空你在本群的会话历史，开启新会话"],
  ["/stop", "强制停止当前任务（硬中断）"],
  ["/status", "查看状态（忙/闲、待消化的干预、最近工具）"],
]);

/**
 * Remove the IM platform's leading bot mention: @, the displayed bot name,
 * then U+FFA0 HALFWIDTH HANGUL FILLER. U+FFA0 is the platform's actual mention
 * separator even though it is rendered like a space. Normal whitespace is not
 * accepted. Only the first leading mention is removed so mentions that are
 * part of the user's actual prompt are kept.
 */
export function stripLeadingMention(content: string): string {
  return content.trim().replace(/^@[^\uFFA0]+\uFFA0/u, "");
}

/** Extract a case-insensitive slash command token from normalized IM text. */
export function canonicalCommand(content: string): string {
  const [token = ""] = stripLeadingMention(content).split(/\s+/, 1);
  return token.toLowerCase();
}

/** Commands are matched case-insensitively and may be followed by arguments. */
export function isCommandMessage(content: string): boolean {
  return SUPPORTED_COMMANDS.has(canonicalCommand(content));
}

/** Any normalized message whose first token starts with / is command syntax. */
export function isSlashCommandMessage(content: string): boolean {
  return canonicalCommand(content).startsWith("/");
}

const commandHelp = [...SUPPORTED_COMMANDS]
  .map(([command, description]) => `${command.padEnd(7)} ${description}`)
  .join("\n");

export const HELP_TEXT = `可用指令（可前置 @机器人名，指令必须以 / 开头，大小写不敏感）：
${commandHelp}

提示：AI 干活途中发普通消息 = 插入干预（下一步纳入）；发 /stop = 立即硬停。`;

export function unknownCommandText(content: string): string {
  return `⚠️ 未知指令「${canonicalCommand(content)}」\n\n${HELP_TEXT}`;
}
