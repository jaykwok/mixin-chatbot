/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "归档你在本群的聊天记录，开启新会话"],
  ["/stop", "停止你的当前任务，取消还在排队的消息"],
  ["/status", "查看处理进度、排队消息和待补发回复数量"],
  ["/deliver", "补发已生成但没发到群里的回复"],
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

/** Any normalized message whose first token starts with / is command syntax. */
export function isSlashCommandMessage(content: string): boolean {
  return canonicalCommand(content).startsWith("/");
}

const commandHelp = [...SUPPORTED_COMMANDS]
  .map(([command, description]) => `${command.padEnd(7)} ${description}`)
  .join("\n");

export const HELP_TEXT = `可用指令（可前置 @机器人名，指令必须以 / 开头，大小写不敏感）：
${commandHelp}

提示：你在本群的消息会按顺序处理；/stop 不会撤回已发出的内容。/deliver 会补发之前保存的回复，可能与群里已有的内容重复。`;

export function unknownCommandText(content: string): string {
  return `⚠️ 未知指令「${canonicalCommand(content)}」\n\n${HELP_TEXT}`;
}
