// A built-in-only entry: readiness precedes loading configuration/database modules.
const id = process.env.MIXIN_VALIDATION_ID ?? "standalone";
const started = performance.now();
function report(phase: string, state: string, code?: number) {
  process.stderr.write("migration-validation " + JSON.stringify({ id, phase, state, code, pid: process.pid, elapsedMs: performance.now() - started }) + "\n");
}
report("entry-ready", "end");
try {
  report("imports-start", "start");
  const { validateConfiguration, validateCurrentData } = await import("../../src/core/data-validation.ts");
  report("imports-ready", "end");
  const observe = (phase: string, state: "start" | "end" | "failed") => report(phase, state);
  if (process.argv[2] === "--config") await validateConfiguration(process.argv[3]!, observe);
  else await validateCurrentData(process.argv[2]!, process.argv[3]!, process.argv[4] ?? process.argv[2]!, observe);
  report("result", "end", 0);
} catch (error) {
  report("result", "failed", 1);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
export {};
