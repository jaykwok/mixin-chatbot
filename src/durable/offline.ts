// Changes to a group's Durable database while the service is stopped (the ops tools hold the maintenance lease).
//
// They only add work for the service to run at its next start, in the documents the service itself uses, so the change
// is carried out by the tested startup path (src/durable/service.ts: queued controls run before any member's messages)
// rather than by a second implementation here.
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ConversationId, createSession } from "@earendil-works/pi-durable";
import { groupSegment } from "../agent/paths.ts";
import { databaseGroup, IdentityDoc } from "./identity.ts";
import { ControlsDoc } from "./inbox.ts";
import { queueManualCompaction } from "./manual-compaction.ts";
import { openGroupStorage } from "./sqlite.ts";

export interface QueuedClear {
  /** The group the database records. */
  groupId: string;
  /** Members that got a /clear now. */
  queued: string[];
  /** Members that already had one waiting (it now also cancels what arrived until now). */
  waiting: string[];
}

/**
 * Queue a /clear for every member conversation in a group's database (`<group dir>/durable.sqlite`), as if each member
 * had sent one now. At its next start the service runs them before any message: each member's waiting messages are
 * cancelled and the conversation is reset (the old context stays in the database, no space is freed), the member's
 * codemode results are removed and the usage is counted. A member with a /clear already waiting gets no second one;
 * the waiting one is moved to now. Undefined when the group has no database; a database recording another group than
 * its directory's is refused.
 */
export async function queueGroupClear(path: string, now = Date.now()): Promise<QueuedClear | undefined> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`${path} 不是普通文件，拒绝修改`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const session = createSession(await openGroupStorage(path));
  try {
    const groupId = await databaseGroup(session, context);
    if (groupId === undefined) throw new Error(`${path} 没有记录所属的群，拒绝修改`);
    if (groupSegment(groupId) !== basename(dirname(path))) throw new Error(`${path} 记录的群不是这个目录的群，拒绝修改`);
    const ids = await session.commit(async (tx) => {
      const found: number[] = [];
      let cursor: Parameters<typeof tx.scanConversations>[2];
      for (;;) {
        const page = await tx.scanConversations({}, 200, cursor);
        for (const record of page.items) if (record.owner === undefined) found.push(record.id as number);
        if (page.next === undefined) return found;
        cursor = page.next;
      }
    }, context);
    const phones: string[] = [];
    for (const id of ids) {
      const identity = await session.snapshot(IdentityDoc, id as ConversationId, context);
      if (identity?.phone) phones.push(identity.phone);
    }
    return await session.commit(async (tx) => {
      const controls = await tx.doc(ControlsDoc);
      // Maintenance holds the lease: every existing input precedes this offline clear, regardless of wall time.
      const epoch = controls.epoch ?? 0;
      if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("群库的控制世代无效");
      controls.epoch = epoch + 1;
      const result: QueuedClear = { groupId, queued: [], waiting: [] };
      for (const phone of phones) {
        const waiting = controls.pending.find((control) => control.phone === phone && control.command === "/clear");
        if (waiting !== undefined) {
          waiting.receivedAt = Math.max(waiting.receivedAt, now);
          waiting.epoch = controls.epoch ?? 0;
          result.waiting.push(phone);
          continue;
        }
        controls.seq++;
        controls.pending.push({ phone, requestId: `ctl:${randomUUID()}`, seq: controls.seq, command: "/clear", receivedAt: now, epoch: controls.epoch ?? 0 });
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
    const groupId = await databaseGroup(session, context);
    if (groupId === undefined || groupSegment(groupId) !== basename(dirname(path))) throw new Error("群库身份与目录不符，拒绝修改");
    const ids = await session.commit(async tx => {
      const found: ConversationId[] = [];
      let cursor: Parameters<typeof tx.scanConversations>[2];
      for (;;) {
        const page = await tx.scanConversations({}, 200, cursor);
        for (const record of page.items) if (record.owner === undefined) found.push(record.id);
        if (page.next === undefined) return found;
        cursor = page.next;
      }
    }, context);
    for (const id of ids) {
      const identity = await session.snapshot(IdentityDoc, id, context);
      if (identity?.groupId === groupId && identity.phone === phone) {
        return session.commit(tx => queueManualCompaction(tx, id), context);
      }
    }
    throw new Error("群库里没有这个成员的会话");
  } finally { await session.close(context); }
}
