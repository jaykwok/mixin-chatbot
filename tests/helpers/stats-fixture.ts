// Build schema-3 ledger fixtures from record lines; no session files or runtime import path. A write to
// `<data>/<group>/users/<user>/stats.records` (a path shape of the fixtures only) is entered into `<data>/state/stats.sqlite`:
// each non-command user message is an ask on its day; the usage of assistant messages and of compaction/branch summaries
// counts under `provider/model` (models), a tool result's usage under its tool name (tools), on the record's day.
// Writing the same path again replaces that member's fixture rows.
import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { dayKey, openStatsLedger, recordAsks, type TokenTotals } from "../../src/agent/stats-ledger.ts";
import { isSlashCommandMessage } from "../../src/agent/commands.ts";
import { statsOf } from "./layout.ts";

type FixtureRows = { asks: { requestId: string; at: number }[]; usage: { day: string; bucket: "models" | "tools"; key: string; tokens: TokenTotals }[] };
const fixtures = new Map<string, Map<string, { group: string; user: string; rows: FixtureRows }>>();

const tokensOf = (raw: Record<string, unknown> | undefined): TokenTotals | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const tokens = { input: n(raw.input), output: n(raw.output), cacheRead: n(raw.cacheRead), cacheWrite: n(raw.cacheWrite), totalTokens: n(raw.totalTokens) };
  if (!tokens.totalTokens) tokens.totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return tokens;
};

export async function writeTestData(path: string, data: string | Uint8Array, options?: any): Promise<void> {
  if (basename(path) !== "stats.records") return writeFile(path, data, options);
  const user = basename(dirname(path)), group = basename(dirname(dirname(dirname(path))));
  const root = dirname(dirname(dirname(dirname(path))));
  const raw = String(data).trim().split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  let provider = "unknown", model = "unknown";
  const source = `fixture:${group}:${user}`;
  const rows: FixtureRows = { asks: [], usage: [] };
  for (const [index, item] of raw.entries()) {
    if (item.type === "model_change") { provider = item.provider ?? "unknown"; model = item.modelId ?? "unknown"; continue; }
    const at = Date.parse(item.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const day = dayKey(at);
    if (item.type === "compaction" || item.type === "branch_summary") {
      const tokens = tokensOf(item.usage);
      if (tokens) rows.usage.push({ day, bucket: "models", key: `${provider}/${model}`, tokens });
      continue;
    }
    const message = item.message;
    if (item.type !== "message" || !message) continue;
    if (message.role === "user") {
      const text = message.content?.find?.((part: any) => part.type === "text")?.text ?? "";
      if (!isSlashCommandMessage(text)) rows.asks.push({ requestId: `${source}:${index}`, at });
    } else if (message.role === "assistant") {
      const tokens = tokensOf(message.usage);
      if (tokens) rows.usage.push({ day, bucket: "models", key: `${message.provider ?? provider}/${message.model ?? model}`, tokens });
    } else if (message.role === "toolResult") {
      const tokens = tokensOf(message.usage);
      if (tokens) rows.usage.push({ day, bucket: "tools", key: message.toolName ?? "unknown", tokens });
    }
  }
  const members = fixtures.get(root) ?? new Map<string, { group: string; user: string; rows: FixtureRows }>();
  fixtures.set(root, members);
  members.set(source, { group, user, rows });
  const db = openStatsLedger(statsOf(root));
  try {
    db.transaction(() => {
      for (const table of ["asks_daily", "ask_ids", "usage_daily"]) db.query(`DELETE FROM ${table}`).run();
      const add = db.query(`INSERT INTO usage_daily (day, space, user, bucket, key, origin, input, output, cache_read, cache_write, total_tokens)
        VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?) ON CONFLICT(day, space, user, bucket, key, origin) DO UPDATE SET
          input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
          cache_write = cache_write + excluded.cache_write, total_tokens = total_tokens + excluded.total_tokens`);
      for (const member of members.values()) {
        for (const row of member.rows.usage) {
          const t = row.tokens;
          add.run(row.day, member.group, member.user, row.bucket, row.key, t.input, t.output, t.cacheRead, t.cacheWrite, t.totalTokens);
        }
      }
    })();
    for (const member of members.values()) {
      recordAsks(db, member.rows.asks.map(ask => ({ ...ask, space: member.group, user: member.user })));
    }
  } finally { db.close(); }
}
