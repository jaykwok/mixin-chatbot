/** Single source of truth for command recognition and /help output. */
export const SUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["/help", "查看本帮助"],
  ["/clear", "归档你在本群的历史，开启新会话"],
  ["/stop", "取消当前任务和排队消息"],
  ["/status", "查看任务状态、排队消息和未送达记录"],
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

提示：普通消息按收到顺序排队；/stop 取消当前任务和等待消息，已发出的内容无法撤回。`;

export function unknownCommandText(content: string): string {
  return `⚠️ 未知指令「${canonicalCommand(content)}」\n\n${HELP_TEXT}`;
}
