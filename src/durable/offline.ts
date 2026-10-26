// Changes to a space's Durable database while the service is stopped (the ops tools hold the maintenance lease).
//
// They only add work for the service to run at its next start, in the documents the service itself uses, so the change
// is carried out by the tested startup path (src/durable/service.ts: queued controls run before any member's messages)
// rather than by a second implementation here.
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ConversationId, createSession } from "@earendil-works/pi-durable";
import { scopeKey, spacePath, type Scope } from "../core/layout.ts";
import { databaseSpace, IdentityDoc } from "./identity.ts";
import { ControlsDoc } from "./inbox.ts";
import { queueManualCompaction } from "./manual-compaction.ts";
import { openGroupStorage } from "./sqlite.ts";
import { conversationIds } from "./conversations.ts";

export interface QueuedClear {
  /** The space the database records. */
  scope: Scope;
  /** Members that got a /clear now. */
  queued: string[];
  /** Members that already had one waiting (it now also cancels what arrived until now). */
  waiting: string[];
}

/** The space path a database file sits at: `<conversations>/direct/durable.sqlite` or `<conversations>/groups/<group>/durable.sqlite`. */
function locatedSpace(path: string): string {
  const dir = dirname(resolve(path));
  return basename(dirname(dir)) === "groups" ? `groups/${basename(dir)}` : basename(dir);
}

/** The space a database records; refused when it is not the one of its directory. */
async function recordedSpace(reader: Parameters<typeof databaseSpace>[0], path: string): Promise<Scope> {
  const scope = await databaseSpace(reader, context);
  if (scope === undefined) throw new Error(`${path} 没有记录所属的会话空间，拒绝修改`);
  if (spacePath(scope) !== locatedSpace(path)) throw new Error(`${path} 记录的会话空间不是这个目录的，拒绝修改`);
  return scope;
}

/**
 * Queue a /clear for every member conversation in a space's database (`<space dir>/durable.sqlite`), as if each member
 * had sent one now. At its next start the service runs them before any message: each member's waiting messages are
 * cancelled and the conversation is reset (the old context stays in the database, no space is freed), the member's
 * codemode results are removed and the usage is counted. A member with a /clear already waiting gets no second one;
 * the waiting one is moved to now. Undefined when the space has no database; a database recording another space than
 * its directory's is refused.
 */
export async function queueSpaceClear(path: string, now = Date.now()): Promise<QueuedClear | undefined> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`${path} 不是普通文件，拒绝修改`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const session = createSession(await openGroupStorage(path));
  try {
    const scope = await recordedSpace(session, path);
    const ids = await conversationIds(session, context, true);
    const phones: string[] = [];
    for (const id of ids) {
      const identity = await session.snapshot(IdentityDoc, id as ConversationId, context);
      if (identity?.phone) phones.push(identity.phone);
    }
    return await session.commit(async (tx) => {
      const controls = await tx.doc(ControlsDoc);
      // Maintenance holds the lease: every existing input precedes this offline clear, regardless of wall time.
      const epoch = controls.epoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("会话库的控制世代无效");
      const next = epoch + 1;
      controls.epoch = next;
      const result: QueuedClear = { scope, queued: [], waiting: [] };
      for (const phone of phones) {
        const waiting = controls.pending.find((control) => control.phone === phone && control.command === "/clear");
        if (waiting !== undefined) {
          waiting.receivedAt = Math.max(waiting.receivedAt, now);
          waiting.epoch = next;
          result.waiting.push(phone);
          continue;
        }
        controls.seq++;
        controls.pending.push({ phone, requestId: `ctl:${randomUUID()}`, seq: controls.seq, command: "/clear", receivedAt: now, epoch: next });
        result.queued.push(phone);
      }
      return result;
    }, context);
  } finally {
    await session.close(context);
  }
}

/** Maintenance lease required. A real task and its status are queued together; no model is called while offline. */
export async function queueMemberCompaction(path: string, phone: string): Promise<Awaited<ReturnType<typeof queueManualCompaction>>> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`${path} 不是普通文件，拒绝修改`);
  const session = createSession(await openGroupStorage(path));
  try {
    const space = scopeKey(await recordedSpace(session, path));
    const ids = await conversationIds(session, context, true);
    for (const id of ids) {
      const identity = await session.snapshot(IdentityDoc, id, context);
      if (identity?.space === space && identity.phone === phone) {
        return session.commit(tx => queueManualCompaction(tx, id), context);
      }
    }
    throw new Error("会话库里没有这个成员的会话");
  } finally { await session.close(context); }
}
