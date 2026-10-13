// The per-member reclamation queue: ownership records handed out of the active table, each its own document, linked
// head → tail. Handoff, bounded batch reads, rotation and exact (offline) settlement are each one transaction step.
import type { Context } from "@earendil-works/chord";
import { defineDocFamily, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import { sameOwnership, type ResultOwnership } from "../../contracts/maintenance.ts";
import { ResultsDoc } from "./ownership.ts";

type ReclamationItem = { name: string; call: ResultOwnership; next?: string };
/** Individually indexed ownership records; moving out of the active quota never means physical deletion. */
export const ReclamationItems = defineDocFamily<ReclamationItem, ReclamationItem>({
  kind: "mixin.reclamation-item", version: 1, scope: "session", family: true, initial: seed => ({ ...seed }),
});
export const ReclamationQueues = defineDocFamily<{ head?: string; tail?: string; count: number; removed: number }, null>({
  kind: "mixin.reclamation-queue", version: 1, scope: "session", family: true, initial: () => ({ count: 0, removed: 0 }),
});

/** One commit publishes the new owner and releases the active quota. Failure rolls both changes back. */
export async function handoffResults(tx: Tx, phone: string, names: readonly string[], now: number): Promise<void> {
  const records = (await tx.doc(ResultsDoc)).calls;
  const queue = await tx.doc(ReclamationQueues, phone, null);
  for (const name of names) {
    const source = records[name];
    if (!source || source.phone !== phone || source.expiredAt !== undefined) continue;
    const call: ResultOwnership = JSON.parse(JSON.stringify(source));
    call.expiryRequestedAt ??= now;
    const item = await tx.doc(ReclamationItems, name, { name, call });
    if (item.name !== name || !sameOwnership(item.call, call)) throw new Error("回收账本已有不同归属的结果，拒绝交接");
    if (queue.tail) {
      const tail = await tx.doc(ReclamationItems, queue.tail, { name: "", call });
      if (tail.name !== queue.tail || tail.call.phone !== phone || tail.next !== undefined || queue.tail === name) throw new Error("回收队列尾部不一致");
      tail.next = name;
    } else {
      if (queue.head !== undefined || queue.count !== 0) throw new Error("回收队列为空但计数不一致");
      queue.head = name;
    }
    queue.tail = name; queue.count++;
    delete records[name];
  }
}

/** Bounded traversal uses family keys (indexed document identities), never an unbounded ownership JSON scan. */
export async function reclamationBatch(reader: DocumentReader, phone: string, context: Context, limit = 64): Promise<Readonly<ReclamationItem>[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096) throw new Error("回收批次大小无效");
  const queue = await reader.snapshot(ReclamationQueues, phone, context), result: Readonly<ReclamationItem>[] = [], seen = new Set<string>();
  let name = queue?.head;
  while (name && result.length < limit) {
    if (seen.has(name)) throw new Error("回收队列存在循环");
    seen.add(name);
    const item = await reader.snapshot(ReclamationItems, name, context);
    if (!item || item.name !== name || item.call.phone !== phone) throw new Error("回收队列归属记录缺失或不一致");
    result.push(item); name = item.next;
  }
  return result;
}

/** Pop a confirmed deletion, or rotate a deferred entry so one blocked record cannot starve the queue. */
export async function settleReclamation(tx: Tx, phone: string, expected: Readonly<ReclamationItem>, removed: boolean,
  retry?: ResultOwnership["reclamation"]): Promise<void> {
  const queue = await tx.doc(ReclamationQueues, phone, null);
  if (queue.head !== expected.name || queue.count < 1) throw new Error("回收队列头部已变化，拒绝覆盖");
  const item = await tx.doc(ReclamationItems, expected.name, { name: "", call: expected.call });
  if (item.name !== expected.name || item.call.phone !== phone) throw new Error("回收条目身份已变化");
  if (retry) item.call.reclamation = retry;
  const next = item.next;
  if (queue.count === 1) {
    if (next !== undefined || queue.tail !== item.name) throw new Error("回收队列长度不一致");
    if (!removed) return;
    delete queue.head; delete queue.tail;
  } else {
    if (!next || !queue.tail || queue.tail === item.name) throw new Error("回收队列链接不一致");
    queue.head = next;
    if (!removed) {
      const tail = await tx.doc(ReclamationItems, queue.tail, { name: "", call: expected.call });
      if (tail.name !== queue.tail || tail.call.phone !== phone || tail.next !== undefined) throw new Error("回收队列尾部已变化");
      tail.next = item.name; queue.tail = item.name; delete item.next;
    }
  }
  if (removed) { queue.count--; queue.removed++; await tx.retireDoc(ReclamationItems, expected.name); }
}

/** Offline completion splices exactly the confirmed owners from the queue in one transaction. */
export async function settleOfflineResults(tx: Tx, phone: string, confirmed: ReadonlyMap<string, ResultOwnership>): Promise<void> {
  const calls = (await tx.doc(ResultsDoc)).calls;
  for (const [name, expected] of confirmed) {
    if (expected.phone !== phone) throw new Error("离线回收归属不符");
    if (!calls[name]) continue;
    if (!sameOwnership(calls[name], expected)) throw new Error("离线回收结果已重新登记，拒绝覆盖");
    delete calls[name];
  }
  const queue = await tx.doc(ReclamationQueues, phone, null);
  let name = queue.head, previous: ReclamationItem | undefined, visited = 0, removed = 0;
  const count = queue.count, seen = new Set<string>();
  while (name) {
    if (seen.has(name) || ++visited > count) throw new Error("离线回收队列存在循环或计数不符");
    seen.add(name);
    const item = await tx.doc(ReclamationItems, name, { name: "", call: { phone, createdAt: 0 } });
    if (item.name !== name || item.call.phone !== phone) throw new Error("离线回收队列归属不符");
    const next = item.next, expected = confirmed.get(name);
    if (expected) {
      if (!sameOwnership(item.call, expected)) throw new Error("离线回收队列结果已重新登记");
      if (previous) { if (next) previous.next = next; else delete previous.next; }
      else { if (next) queue.head = next; else delete queue.head; }
      await tx.retireDoc(ReclamationItems, name); removed++;
    } else previous = item;
    name = next;
  }
  if (visited !== count || (visited > 0 && !seen.has(queue.tail ?? ""))) throw new Error("离线回收队列长度不符");
  if (previous) queue.tail = previous.name; else delete queue.tail;
  queue.count -= removed; queue.removed += removed;
}
