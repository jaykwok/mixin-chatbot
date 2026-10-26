// The task number each member is running, for lines written outside the service (tool command timings).
// The service marks a request when its run starts and clears it when the run ends.
import { scopeKey, scopeLabel, type Scope } from "../core/layout.ts";

const running = new Map<string, string>();
const key = (scope: Scope, phone: string) => JSON.stringify([scopeKey(scope), phone]);

export function markRunning(scope: Scope, phone: string, taskNumber: string): void {
  running.set(key(scope, phone), taskNumber);
}

/** Clears only the given run: a later run of the same member may have started meanwhile. */
export function clearRunning(scope: Scope, phone: string, taskNumber: string): void {
  if (running.get(key(scope, phone)) === taskNumber) running.delete(key(scope, phone));
}

/** `单聊|群 …, 用户: …, 任务: …` as the service writes it; `任务: -` when no run is known. */
export function memberTaskText(scope: Scope, phone: string): string {
  return `${scopeLabel(scope)}, 用户: ${phone}, 任务: ${running.get(key(scope, phone)) ?? "-"}`;
}
