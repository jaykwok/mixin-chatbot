// Pi's own reading of its session files (pi-coding-agent SessionManager format, versions 1 to 3), for migrations that
// convert them (v3). The tree, compaction, branch summaries and context edits decide the active context exactly as the
// AgentSession engine saw it. Should a later Pi drop these exports, freeze a copy of them here.
import { buildSessionContext, convertToLlm, migrateSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

/** Entries as parsed from the file, header first; upgraded to the current format in place. */
export type FileEntries = Record<string, unknown>[];

/** The model messages of the active path ending at the newest entry, as the old engine sent them. */
export function activeMessages(entries: FileEntries): Message[] {
  migrateSessionEntries(entries as never);
  const body = entries.filter((entry) => entry.type !== "session") as unknown as SessionEntry[];
  if (!body.length) return [];
  return convertToLlm(buildSessionContext(body, body.at(-1)!.id).messages);
}

/** The entries of the active path, root first (after `activeMessages` upgraded them). */
export function activePath(entries: FileEntries): Record<string, unknown>[] {
  const byId = new Map<unknown, Record<string, unknown>>();
  for (const entry of entries) if (entry.type !== "session" && entry.id !== undefined) byId.set(entry.id, entry);
  const path: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current = entries.filter((entry) => entry.type !== "session").at(-1);
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = current.parentId === undefined || current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}
