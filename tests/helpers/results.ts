import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { withSpaceSnapshot } from "../../src/durable/diagnostics.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { ReclamationQueues } from "../../src/durable/results/queue.ts";

/**
 * A member's codemode results still awaiting physical removal (a deferred or refused removal, or a queued record), read
 * from a snapshot of the space database: the service may keep it open meanwhile.
 */
export function awaitingRemoval(database: string, phone: string): Promise<number> {
  return withSpaceSnapshot(database, async harness => {
    const calls = (await harness.snapshot(ResultsDoc, context))?.calls ?? {};
    const queued = (await harness.snapshot(ReclamationQueues, phone, context))?.count ?? 0;
    return queued + Object.values(calls).filter(call => call.phone === phone && call.reclamation !== undefined).length;
  });
}
