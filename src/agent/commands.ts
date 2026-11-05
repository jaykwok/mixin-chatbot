/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "开启新会话，之前的聊天记录仍保留在库里"],
  ["/stop", "停止你的当前任务，取消还在排队的消息"],
  ["/status", "查看处理进度、排队消息和正在运行的工具"],
  ["/compact", "压缩你在当前群或单聊的会话，保留聊天记录；会产生模型用量"],
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

export const HELP_TEXT = `可用指令（群里需 @机器人，@ 放在指令前后均可；单聊直接发送。指令以 / 开头，大小写不敏感）：
${commandHelp}

回复推送时（先点推送卡片上的「回复」；群里同样需 @机器人）：
/完成   提交回复，和点卡片上的「已回复」一样
/取消   放弃这次还没提交的回复

推送管理员在群里：
/登记群 群名   登记这个群，推送人之后可以按群名推送到群

提示：你在每个群和单聊里的消息分别按顺序处理；/stop 不会撤回已发出的内容。回复没发出去时机器人会自动重发。`;

export function unknownCommandText(content: string): string {
  return `⚠️ 未知指令「${canonicalCommand(content)}」\n\n${HELP_TEXT}`;
}
