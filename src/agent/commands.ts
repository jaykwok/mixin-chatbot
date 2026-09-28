/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "归档你在本群的聊天记录，开启新会话"],
  ["/stop", "停止你的当前任务，取消还在排队的消息"],
  ["/status", "查看处理进度、排队消息和待补发回复数量"],
  ["/deliver", "补发已生成但没发到群里的回复"],
]);

/**
 * Extract a case-insensitive slash command token. The platform removes the
 * @bot mention from textMsg.content before forwarding, wherever it was typed.
 */
export function canonicalCommand(content: string): string {
  const [token = ""] = content.trim().split(/\s+/, 1);
  return token.toLowerCase();
}

/** Any message whose first token starts with / is command syntax. */
export function isSlashCommandMessage(content: string): boolean {
  return canonicalCommand(content).startsWith("/");
}

const commandHelp = [...SUPPORTED_COMMANDS]
  .map(([command, description]) => `${command.padEnd(7)} ${description}`)
  .join("\n");

export const HELP_TEXT = `可用指令（@机器人名放在指令前后均可，指令必须以 / 开头，大小写不敏感）：
${commandHelp}

提示：你在本群的消息会按顺序处理；/stop 不会撤回已发出的内容。/deliver 会补发之前保存的回复，可能与群里已有的内容重复。`;

export function unknownCommandText(content: string): string {
  return `⚠️ 未知指令「${canonicalCommand(content)}」\n\n${HELP_TEXT}`;
}
