import { defineDoc } from "@earendil-works/pi-durable";
import type { UsageRecord } from "./attempts.ts";

export type AuxiliaryRequest = {
  taskId: number; callId: string; kind: "classifier" | "image"; provider: string; model: string;
  startedAt: number; endedAt?: number; withdrawn?: boolean; outcome?: "stop" | "error" | "aborted"; usage?: UsageRecord;
};
/** Charged from these receipts only, so a tool/codemode parent never adds the same bill again. */
export const AuxiliaryDoc = defineDoc<{ starts: Record<string, AuxiliaryRequest> }>({
  kind: "mixin.auxiliary-requests", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ starts: {} }),
});
