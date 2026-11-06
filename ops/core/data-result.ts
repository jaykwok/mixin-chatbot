import { PROTOCOL, PROTOCOL_VERSION, EXIT, type Outcome } from "../lib/maintenance-protocol.ts";
import type { NativeResult } from "./native-process.ts";

/** Process exit, complete protocol, action and conclusion must agree; stderr never contributes to success. */
export function maintenanceResult(result: NativeResult, action: string): { code: number; data: unknown } {
  let value: Record<string, unknown>;
  try { value = JSON.parse(result.stdout); } catch { throw new Error("维护工具没有返回完整 JSON 结果"); }
  if (!value || Array.isArray(value) || value.protocol !== PROTOCOL || value.version !== PROTOCOL_VERSION || value.command !== action
    || typeof value.outcome !== "string" || !Object.hasOwn(EXIT, value.outcome) || EXIT[value.outcome as Outcome] !== result.code
    || value.outcome === "success" && !Object.hasOwn(value, "result")) throw new Error("维护工具的退出码、动作或结论不一致");
  return { code: result.code, data: value.result };
}
