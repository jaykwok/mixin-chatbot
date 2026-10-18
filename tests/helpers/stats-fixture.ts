// Build current schema-2 ledger fixtures in memory; no session files or runtime import path.
import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { openStatsLedger, ingestConversationRecords } from "../../src/agent/stats-ledger.ts";
import type { StatsRecord } from "../../src/agent/stats-record.ts";
import { isSlashCommandMessage } from "../../src/agent/commands.ts";

export async function writeTestData(path: string, data: string | Uint8Array, options?: any): Promise<void> {
  if (basename(path) !== "stats.records") return writeFile(path, data, options);
  const user = basename(dirname(path)), group = basename(dirname(dirname(dirname(path))));
  const root = dirname(dirname(dirname(dirname(path))));
  const raw = String(data).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  let provider = "unknown", model = "unknown";
  const records: StatsRecord[] = [];
  for (const item of raw) {
    if (item.type === "model_change") { provider = item.provider ?? "unknown"; model = item.modelId ?? "unknown"; continue; }
    if (item.type === "session") continue;
    if (item.type === "compaction" || item.type === "branch_summary") {
      records.push({ type: "usage", kind: item.type, timestamp: item.timestamp, provider, model, usage: item.usage }); continue;
    }
    if (item.message) item.message = { ...item.message, provider: item.message.provider ?? provider, model: item.message.model ?? model,
      command: item.message.role === "user" && isSlashCommandMessage(item.message.content?.find((part: any) => part.type === "text")?.text ?? "") };
    records.push(item);
  }
  const db = openStatsLedger(root), source = `fixture:${group}:${user}`;
  try {
    db.query("DELETE FROM sources WHERE id = ?").run(source);
    ingestConversationRecords(db, { id: source, group, user, identity: source }, 0, records.length, records);
  } finally { db.close(); }
}
