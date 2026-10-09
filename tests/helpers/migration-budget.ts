import { PROCESS_CLEANUP_MS } from "../../scripts/lib/process.ts";
import { VALIDATION_TIMEOUT_MS } from "../../scripts/migrations/lib/validation.ts";

// Each preview/apply/commit or CLI invocation owns an independent deadline and cleanup budget.
// The outer watchdog covers every sequential action plus finite fixture/diagnostic work.
export const CLI_ACTION_MS = VALIDATION_TIMEOUT_MS + 20_000;
export const migrationBudget = (actions: number, otherMs = 0) =>
  20_000 + actions * (CLI_ACTION_MS + PROCESS_CLEANUP_MS) + otherMs + 10_000;
