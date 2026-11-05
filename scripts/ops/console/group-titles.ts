// Titles of conversation spaces and statistics groups: the registered group name (push settings, src/push/store.ts) in
// place of the storage segment. Read from the bot like member names; a stopped bot or a failed read leaves `群 <segment>`.
import { BotOffline, type BotReader } from "./bot.ts";

export interface GroupTitles {
  /** A statistics group: `direct` or a group's segment. */
  group(segment: string): string;
  /** A conversation space: `direct` or `groups/<segment>`. */
  space(space: string): string;
}

export async function groupTitles(bot: BotReader, signal?: AbortSignal): Promise<GroupTitles> {
  let names = new Map<string, string>();
  try {
    const result = await bot.read<{ groups: { segment: string; name: string }[] }>({ op: "groups" }, signal);
    names = new Map(result.groups.map(group => [group.segment, group.name]));
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof BotOffline)) console.error(`群名没有读到，按群号显示：${error instanceof Error ? error.message : String(error)}`);
  }
  const group = (segment: string) => segment === "direct" ? "单聊" : `群 ${names.get(segment) ?? segment}`;
  return { group, space: space => group(space === "direct" ? space : space.slice("groups/".length)) };
}
