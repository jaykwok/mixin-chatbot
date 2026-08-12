/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "清空你在本群的会话历史，开启新会话"],
  ["/stop", "强制停止当前任务（硬中断）"],
  ["/status", "查看状态（忙/闲、待消化的干预、最近工具）"],
]);

/** Extract a case-insensitive slash command token. */
export function canonicalCommand(content: string): string {
  const [token = ""] = content.trim().split(/\s+/, 1);
  return token.toLowerCase();
}

/** Commands are matched case-insensitively and may be followed by arguments. */
export function isCommandMessage(content: string): boolean {
  return SUPPORTED_COMMANDS.has(canonicalCommand(content));
}

const commandHelp = [...SUPPORTED_COMMANDS]
  .map(([command, description]) => `${command.padEnd(7)} ${description}`)
  .join("\n");

export const HELP_TEXT = `可用指令（在群里直接发送，必须以 / 开头，大小写不敏感）：
${commandHelp}

提示：agent 干活途中发普通消息 = 插入干预（下一步纳入）；发 /stop = 立即硬停。`;
