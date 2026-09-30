// The current validator is intentionally outside historical migrations.
// Usage: validate.ts <config project> <groups> [state project] — configuration and databases;
//        validate.ts --config <config project> — configuration only (a preview's projection, before any migration).
import { validateConfiguration, validateCurrentData } from "../../src/core/data-validation.ts";
try {
  if (process.argv[2] === "--config") await validateConfiguration(process.argv[3]!);
  else await validateCurrentData(process.argv[2]!, process.argv[3]!, process.argv[4]);
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
