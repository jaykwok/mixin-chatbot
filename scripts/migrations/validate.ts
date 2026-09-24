// The current validator is intentionally outside historical migrations.
import { validateCurrentData } from "../../src/core/data-validation.ts";
try {
  await validateCurrentData(process.argv[2]!, process.argv[3]!, process.argv[4]);
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
