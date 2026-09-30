import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { validateRuntimeConfig } from "./runtime-schema.ts";
import { openModelRuntime, openSettings, resolveModelSelection } from "./model-config.ts";
import { openExistingStatsLedger } from "../agent/stats-ledger.ts";
import { assertDeliverySchema } from "../agent/delivery-store.ts";

/**
 * Configuration only: runtime.json, models and the selected model under `project`, which may be a preview's
 * projection. Opens no database, so it can run before a migration and against read-only data.
 */
export async function validateConfiguration(project: string): Promise<void> {
  if (process.env.BOT_MODEL_CACHE_RETENTION?.trim()) throw new Error("请移除 BOT_MODEL_CACHE_RETENTION 环境变量");
  const path = join(project, "data/config/runtime.json");
  validateRuntimeConfig(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  const runtime = await openModelRuntime({ modelsPath: join(project, "data/config/models.json"), modelsStorePath: join(project, "data/runtime/models-store.json") });
  await resolveModelSelection(runtime, openSettings(join(project, "data/runtime/pi/settings.json")));
}

/** Used by the service and migration runner. No database creation, migrations or requests. */
export async function validateCurrentData(project: string, groups: string, stateProject = project): Promise<void> {
  await validateConfiguration(project);
  const stats = openExistingStatsLedger(groups);
  try {
    if (stats) {
      for (const table of ["sources", "activity", "tool_counts", "usage_totals", "meta"]) stats.query(`SELECT * FROM ${table} LIMIT 0`).all();
    } else if (existsSync(join(groups, "stats.sqlite"))) {
      const db = new Database(join(groups, "stats.sqlite"), { readonly: true });
      try { if (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().length) throw new Error("统计账本缺少 schema，拒绝登记"); }
      finally { db.close(); }
    }
  } finally { stats?.close(); }
  const state = join(stateProject, "data/state/agent.sqlite");
  if (existsSync(state)) {
    const db = new Database(state, { readonly: true, strict: true });
    try { assertDeliverySchema(db); } finally { db.close(); }
  }
}
