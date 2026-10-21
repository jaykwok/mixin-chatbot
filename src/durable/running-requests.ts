// The task number each member is running, for lines written outside the service (tool command timings).
// The service marks a request when its run starts and clears it when the run ends.

const running = new Map<string, string>();
const key = (groupId: string, phone: string) => JSON.stringify([groupId, phone]);

export function markRunning(groupId: string, phone: string, taskNumber: string): void {
  running.set(key(groupId, phone), taskNumber);
}

/** Clears only the given run: a later run of the same member may have started meanwhile. */
export function clearRunning(groupId: string, phone: string, taskNumber: string): void {
  if (running.get(key(groupId, phone)) === taskNumber) running.delete(key(groupId, phone));
}

/** `群: …, 用户: …, 任务: …` as the service writes it; `任务: -` when no run is known. */
export function memberTaskText(groupId: string, phone: string): string {
  return `群: ${groupId}, 用户: ${phone}, 任务: ${running.get(key(groupId, phone)) ?? "-"}`;
}
