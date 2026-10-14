// Online result maintenance for one idle member: the service supplies the group harness, member, reference snapshot
// and shutdown signal; this decides what expires and drives the removal, settlement and queue steps.
//
// One pass, in order:
// 1. choose the member's due results (retention deadline, /clear request, capacity pressure, retry delay);
// 2. remove unreferenced ones (expiry is committed before each removal; failures record a retry delay);
// 3. Windows/macOS: a requested expiry whose directory is gone counts as removed (a crash before its receipt);
// 4. retire removed records (latest 256 expired receipts stay visible);
// 5. Linux: hand the remaining due, unreferenced records to the reclamation queue (frees the active quota);
// 6. retry a bounded batch of the queue, rotating deferred items;
// 7. sweep isolated task receipts no live or queued ownership claims.
import type { Context } from "@earendil-works/chord";
import type { DocumentReader, Harness } from "@earendil-works/pi-durable";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ResultOwnership } from "../../contracts/maintenance.ts";
import type { ReferenceText } from "../../core/reference-text.ts";
import { configuredRootlessTasks } from "../../core/task-backend.ts";
import { removeResultDirectories } from "./files.ts";
import { RESULT_PRESSURE, ResultsDoc } from "./ownership.ts";
import { handoffResults, reclamationBatch, ReclamationItems, ReclamationQueues, settleReclamation } from "./queue.ts";
import { referencedResults } from "./references.ts";

/** Expired receipts kept visible after removal. */
const RECEIPTS_KEPT = 256;
const RETRY_DELAY_MS = 60_000;

/** The member's results this pass may expire, and the deadline in force. Capacity pressure moves the deadline to now
 * (the task sweep uses the same deadline); referenced results stay protected either way. */
export function dueResults(calls: Readonly<Record<string, ResultOwnership>>, phone: string, before: number) {
  if (Object.keys(calls).length >= RESULT_PRESSURE) before = Date.now();
  const names = Object.entries(calls).filter(([, call]) => call.phone === phone).map(([name]) => name);
  const eligible = names.filter(name => calls[name]!.expiredAt === undefined
    && (calls[name]!.createdAt < before || calls[name]!.expiryRequestedAt !== undefined)
    && (calls[name]!.reclamation?.nextAttemptAt ?? 0) <= Date.now());
  const isolated = new Map(names.flatMap(name => calls[name]!.isolatedTask ? [[name, calls[name]!.isolatedTask!] as const] : []));
  return { before, names, eligible, isolated };
}

/** Removed results become expired receipts; only the latest receipts stay. Live ownership is never pruned by time alone. */
export function retireRemoved(records: Record<string, ResultOwnership>, removed: readonly string[]): void {
  for (const name of removed) if (records[name]) { records[name].expiredAt = Date.now(); delete records[name].reclamation; }
  const old = Object.entries(records).filter(([, call]) => call.expiredAt !== undefined)
    .sort((a, b) => a[1].expiredAt! - b[1].expiredAt!);
  for (const [name] of old.slice(0, Math.max(0, old.length - RECEIPTS_KEPT))) delete records[name];
}

/** A failed removal's retry record. */
function retryRecord(status: "deferred" | "refused", result: { reason?: string; identity?: { dev: string; ino: string } }, attemptedAt: number): NonNullable<ResultOwnership["reclamation"]> {
  return { status, ...(result.reason ? { reason: result.reason } : {}), ...(result.identity ? { identity: result.identity } : {}),
    attemptedAt, nextAttemptAt: attemptedAt + RETRY_DELAY_MS };
}

/** The member's lines of /status: requested expiries, queued records and everything still awaiting removal. */
export async function memberResultStatus(reader: DocumentReader, phone: string, context: Context) {
  const calls = (await reader.snapshot(ResultsDoc, context))?.calls ?? {};
  const expired = Object.entries(calls).filter(([, call]) => call.phone === phone && call.expiryRequestedAt !== undefined).map(([name]) => name);
  const backlog = (await reader.snapshot(ReclamationQueues, phone, context))?.count ?? 0;
  const pending = backlog + Object.values(calls).filter(call => call.phone === phone && call.reclamation !== undefined).length;
  return { expired, backlog, pending };
}

export interface ResultMaintenanceOptions {
  context: Context;
  /** Service shutdown: the queue retry stops between items. */
  signal: AbortSignal;
  warn(line: string): void;
}

/** The caller holds the idle-group gate and the member: no new call can start while a pass deletes. */
export class ResultMaintenance {
  constructor(private readonly options: ResultMaintenanceOptions) {}

  /** One pass over the member's results, steps 1–7 of the file comment. */
  async member(harness: Harness, phone: string, tempDir: string, deadline: number, references: ReferenceText): Promise<void> {
    const calls = (await harness.snapshot(ResultsDoc, this.options.context))?.calls ?? {};
    const due = dueResults(calls, phone, deadline);
    const protectedNames = referencedResults(tempDir, due.names, references, due.isolated);
    const removed = await this.#removeDue(harness, tempDir, due, protectedNames);
    await this.#reconcileRemoved(calls, tempDir, due.names, removed);
    // Only successful removals may be retired. A failed deletion remains registered for the next sweep/clear retry.
    if (removed.length) await harness.commit(async tx => retireRemoved((await tx.doc(ResultsDoc)).calls, removed), this.options.context);
    if (process.platform === "linux") {
      const pendingNames = due.eligible.filter(name => !protectedNames.has(name) && !removed.includes(name));
      if (pendingNames.length) await harness.commit(tx => handoffResults(tx, phone, pendingNames, Date.now()), this.options.context);
    }
    await this.#retryQueue(harness, phone, tempDir, references);
    await this.#sweepTasks(harness, tempDir, due.before, references);
  }

  /** Step 2: each expiry is committed before its removal; failures record their retry delay. Returns the removed names. */
  async #removeDue(harness: Harness, tempDir: string, due: ReturnType<typeof dueResults>, protectedNames: ReadonlySet<string>): Promise<string[]> {
    const context = this.options.context;
    return removeResultDirectories(tempDir, Infinity, { isolated: due.isolated, registered: new Set(due.eligible), protected: protectedNames,
      expire: async expired => { await harness.commit(async tx => {
        const records = (await tx.doc(ResultsDoc)).calls;
        for (const name of expired) if (records[name]) records[name].expiryRequestedAt ??= Date.now();
      }, context); },
      record: async results => { if (results.some(item => item.status !== "removed")) await harness.commit(async tx => {
        const records = (await tx.doc(ResultsDoc)).calls, attemptedAt = Date.now();
        for (const item of results) if (item.status !== "removed" && records[item.name]) records[item.name]!.reclamation = retryRecord(item.status, item, attemptedAt);
      }, context); },
    });
  }

  /** Step 3: reconcile a crash after deletion but before its completion receipt was committed (adds to `removed`). */
  async #reconcileRemoved(calls: Readonly<Record<string, ResultOwnership>>, tempDir: string, names: readonly string[], removed: string[]): Promise<void> {
    if (process.platform === "linux") return; // An absent shared name does not prove physical deletion.
    for (const name of names) {
      // An isolated result is never under `codemode/`: its task's receipt says whether it is gone (step 2).
      if (!/^\d+-[A-Za-z0-9_.-]+$/.test(name) || calls[name]!.isolatedTask !== undefined || calls[name]!.expiryRequestedAt === undefined
        || calls[name]!.expiredAt !== undefined || removed.includes(name)) continue;
      try { await lstat(join(tempDir, "codemode", name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.push(name); else throw error; }
    }
  }

  /** Step 7: a task receipt goes only when neither a live record nor a queued item still claims its task. */
  async #sweepTasks(harness: Harness, tempDir: string, before: number, references: ReferenceText): Promise<void> {
    const context = this.options.context, settledCalls = (await harness.snapshot(ResultsDoc, context))?.calls ?? {};
    const pending = (await configuredRootlessTasks()?.sweep(tempDir, before, references, new Set(), async (id, name) => {
      const active = settledCalls[name], queued = await harness.snapshot(ReclamationItems, name, context);
      return !(active?.isolatedTask === id && active.expiredAt === undefined) && queued?.call.isolatedTask !== id;
    }))?.filter(item => item.status !== "removed") ?? [];
    if (pending.length) this.options.warn(`隔离任务物理回收待办：${pending.length} 个；` + pending.map(item => `${item.name}: ${item.reason}`).join("；"));
  }

  /** Step 6: one bounded batch from the queue head: a confirmed removal pops its item, anything else rotates it to the tail. */
  async #retryQueue(harness: Harness, phone: string, tempDir: string, references: ReferenceText): Promise<void> {
    for (const item of await reclamationBatch(harness, phone, this.options.context)) {
      if (this.options.signal.aborted) return;
      const isolated = new Map(item.call.isolatedTask ? [[item.name, item.call.isolatedTask]] : []);
      const protectedNames = referencedResults(tempDir, [item.name], references, isolated);
      let removed = false, retry: ResultOwnership["reclamation"];
      if (!protectedNames.size && (item.call.reclamation?.nextAttemptAt ?? 0) <= Date.now()) {
        const outcome = await removeResultDirectories(tempDir, Infinity, { isolated, registered: new Set([item.name]), protected: protectedNames,
          expire: async () => {}, record: async results => {
            const result = results.find(result => result.name === item.name);
            if (result && result.status !== "removed") retry = retryRecord(result.status, result, Date.now());
          } });
        removed = outcome.includes(item.name);
      }
      await harness.commit(tx => settleReclamation(tx, phone, item, removed, retry), this.options.context);
    }
  }
}
