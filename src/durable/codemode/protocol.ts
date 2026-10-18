// Non-public upstream codemode document/outcome dependencies. Recheck with every Pi release.
import type { JsonObject, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CodemodeDetails } from "./index.ts";

/** The outcome the official tool commits for a script: its output, and details with the call rows. */
export type ScriptResult = { output: ToolResultContent[]; isError?: boolean; details: CodemodeDetails };
export type ToolResultContent = NonNullable<ToolExecutionResult["output"]>[number];

export function isScriptResult(value: unknown): value is ScriptResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { output?: unknown; details?: { calls?: unknown } };
  return Array.isArray(result.output) && typeof result.details === "object" && result.details !== null && Array.isArray(result.details.calls);
}

/** The official run document (not exported), as the attempt's first commit names it. */
export type RunState = { result?: JsonObject; outputDir?: string };
export const RUN_DOC_KIND = "pi.codemode.run";
