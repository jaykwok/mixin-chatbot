// One result contract for CLI, platform adapters, startup guards and the existing console executor.
export interface OpsResult {
  protocol: "mixin-ops";
  version: 1;
  command: string;
  outcome: "success" | "refused" | "failed";
  wasRunning: boolean;
  finalState: "running" | "stopped" | "start-requested" | "unknown";
  exitCode: number;
  message: string;
}

/** A reported success never overrides the observed process exit code. Unknown/partial versions are not inferred. */
export function readOpsResult(source: unknown, command: string, exitCode: number): OpsResult | null {
  const value = source as Record<string, unknown> | null;
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || !value || Array.isArray(value)
    || value.protocol !== "mixin-ops" || value.version !== 1 || value.command !== command
    || !["success", "refused", "failed"].includes(String(value.outcome)) || typeof value.wasRunning !== "boolean"
    || !["running", "stopped", "start-requested", "unknown"].includes(String(value.finalState))
    || value.exitCode !== exitCode || typeof value.message !== "string" || (value.outcome === "success" && exitCode !== 0)) return null;
  return { protocol: "mixin-ops", version: 1, command, outcome: value.outcome as OpsResult["outcome"],
    wasRunning: value.wasRunning, finalState: value.finalState as OpsResult["finalState"], exitCode, message: value.message };
}
