// Shared by the migration tests (tests/ops/migrations.test.ts, migration-group-roots, migration-verification, migration-v2).
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeProcess } from "../../scripts/lib/process.ts";
import { publishJson } from "../../scripts/migrations/lib/io.ts";
import { CLI_ACTION_MS } from "./migration-budget.ts";
import { tempFixture } from "./temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

/** A project with a fixture model, the given cache retention and an external group root. */
export async function fixture(retention = "short") {
  const files = await tempFixture("migrations-");
  const groups = join(files.root, "external-groups");
  const context = { project: files.root, groups, decisions: {} };
  await mkdir(groups);
  await publishJson(join(files.root, "data/config/runtime.json"), { BOT_MODEL_CACHE_RETENTION: retention, GROUP_DATA_ROOT: groups });
  await publishJson(join(files.root, "data/config/models.json"), { providers: { fixture: {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } });
  await publishJson(join(files.root, "data/runtime/pi/settings.json"), { defaultProvider: "fixture", defaultModel: "test" });
  await mkdir(join(files.root, "data/state"), { recursive: true });
  return { ...files, context };
}

export async function execute(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = await executeProcess({ command: process.execPath, args, cwd, env: { ...process.env, ...env }, timeoutMs: CLI_ACTION_MS });
  return { code: result.exitCode, text: result.stdout + result.stderr };
}

// Copy only the bootstrap graph. Business views and npm dependencies are deliberately absent.
export async function copyBootstrap(root: string) {
  for (const path of ["scripts/ops/tui.ts", "scripts/ops/tui/recovery.ts", "scripts/ops/tui/transaction.ts", "scripts/ops/tui/platform.ts", "scripts/lib/confirmed-transaction.ts", "src/core/data-version.ts", "scripts/lib/operation-log.ts", "scripts/lib/redact.ts", "scripts/lib/cli.ts", "src/server/index.ts"]) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await copyFile(join(project, path), join(root, path));
  }
}
