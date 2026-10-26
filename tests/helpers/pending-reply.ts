// A closed run record whose reply still waits for delivery and names a file: what keeps a result path referenced.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { recordsOf, type RequestRecord } from "../../src/durable/records.ts";

export function pendingReply(requestId: string, path: string, now = Date.now()): RequestRecord {
  return {
    requestId, createdAt: now, closedAt: now, notes: [], deliverables: [], files: [], events: {},
    reply: { kind: "group", receiveId: "100", senderImUserId: "im-user", msgUid: `uid-${requestId}`, summary: "问题", receivedAt: now },
    delivery: { kind: "fallback", createdAt: now, parts: [{ id: "p1", kind: "file", state: "pending", attempts: 0,
      file: { name: "result", path, size: 1, sha256: "0".repeat(64) } }] },
  };
}

/** Record (or with `path` undefined, drop) a pending reply of `phone` naming `path`. */
export async function referTo(harness: Pick<Harness, "commit">, phone: string, requestId: string, path: string | undefined): Promise<void> {
  await harness.commit(async tx => {
    const records = await recordsOf(tx, phone);
    if (path === undefined) delete records.requests[requestId];
    else records.requests[requestId] = pendingReply(requestId, path);
  }, context);
}
