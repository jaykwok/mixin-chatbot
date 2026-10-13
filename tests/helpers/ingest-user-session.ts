import { openStatsLedger, ingestSessionFile } from "../../src/agent/stats-ledger.ts";

export async function ingestUserSession(root: string, group: string, user: string) {
  const db = openStatsLedger(root);
  try { return await ingestSessionFile(db, root, group, user); } finally { db.close(); }
}
