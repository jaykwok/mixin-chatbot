import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { validateRuntimeConfig } from "./runtime-schema.ts";
import { openModelRuntime, openSettings, resolveModelSelection } from "./model-config.ts";
import { openExistingStatsLedger, STATS_TABLES } from "../agent/stats-ledger.ts";
import { readAuxiliaryConfig } from "./auxiliary-config.ts";
import { readMcpConfig } from "./mcp-config.ts";
import { readRelayConfigFile } from "../integrations/relay-s3.ts";
import { readRelayIndex } from "../integrations/relay-index.ts";
import { readAppBotConfig } from "../integrations/open-platform/config.ts";
import { readDirectoryScope } from "../integrations/open-platform/directory-scope.ts";
import { assertApplication, deploymentRecord } from "./data-version.ts";
import { checkProjectLayout } from "./layout.ts";
import { assertSpaceSchemas } from "../durable/space-databases.ts";

export interface ValidationOptions {
  /**
   * The final workspace of the deployment being validated (absolute, or relative to the project). Default: the
   * WORKSPACE_ROOT the service will read (environment, then data/config/runtime.json), else data/workspace.
   */
  readonly workspace?: string;
}

function configuredWorkspace(runtime: Record<string, string | undefined>, options: ValidationOptions): string | undefined {
  return options.workspace ?? (process.env.WORKSPACE_ROOT?.trim() || runtime.WORKSPACE_ROOT);
}

/**
 * Configuration of `project` and its place in the deployment: app-bot.json, directory.json, runtime.json, models and the
 * selected model; the data directory belongs to the configured application (deployment record); the workspace layout.
 * Opens no database, so it can run before release preparation and against read-only data.
 */
export async function validateConfiguration(project: string, options: ValidationOptions = {}): Promise<void> {
  const app = readAppBotConfig(join(project, "data/config/app-bot.json"));
  if (!app) throw new Error("缺少应用机器人配置 data/config/app-bot.json，请运行配置向导");
  assertApplication(deploymentRecord(project), app);
  readDirectoryScope(join(project, "data/config/directory.json"));
  const path = join(project, "data/config/runtime.json");
  const runtime = validateRuntimeConfig(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  checkProjectLayout(project, configuredWorkspace(runtime, options));
  const relayPath = join(project, "data/config/relay.json");
  readRelayConfigFile(relayPath);
  const models = await openModelRuntime({ modelsPath: join(project, "data/config/models.json"), modelsStorePath: join(project, "data/runtime/models-store.json") });
  await resolveModelSelection(models, openSettings(join(project, "data/runtime/pi/settings.json")));
  const auxiliary = readAuxiliaryConfig(join(project, "data/config/auxiliary.json"));
  readMcpConfig(join(project, "data/config/mcp.json"));
  for (const type of ["classifier", "image"] as const) {
    const ref = auxiliary?.[type];
    if (ref && !models.getModelOfType(type, ref.provider, ref.modelId)) throw new Error(`auxiliary.json：没有 ${type} 模型 ${ref.provider}/${ref.modelId}`);
  }
}

/**
 * Used by the service, the verification instance and the release commit. No database creation, migrations or requests.
 * Besides the configuration: the relay index, the stats ledger and every existing conversation database must be in the
 * format this program opens, so an incompatible database is refused while the release can still be rolled back, not
 * when the committed service first opens it.
 */
export async function validateCurrentData(project: string, options: ValidationOptions = {}): Promise<void> {
  await validateConfiguration(project, options);
  if (existsSync(join(project, "data/config/relay.json"))) readRelayIndex(join(project, "data/state/relay.sqlite"));
  const path = join(project, "data/state/stats.sqlite");
  const stats = openExistingStatsLedger(path);
  try {
    if (stats) {
      for (const table of STATS_TABLES) stats.query(`SELECT * FROM ${table} LIMIT 0`).all();
    } else if (existsSync(path)) {
      const db = new Database(path, { readonly: true });
      try { if (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().length) throw new Error("统计账本缺少 schema，拒绝登记"); }
      finally { db.close(); }
    }
  } finally { stats?.close(); }
  await assertSpaceSchemas(join(project, "data", "conversations"));
}
