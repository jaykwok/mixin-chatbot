// Background reclamation of expired task receipts, bounded per tick: at most 128 directory entries are read from a kept
// stream per user tmp (16 streams at most), so a large receipt namespace is never listed or sorted at once.
import type { Dir } from "node:fs";
import { opendir, realpath, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { ID_PATTERN } from "../../contracts/maintenance.ts";
import type { Receipt } from "../../contracts/task-receipt.ts";
import type { DirectoryRemoval } from "../held-directory.ts";
import type { KeyedQueue } from "../lifecycle.ts";
import type { ReferenceText } from "../reference-text.ts";
import type { TaskControl } from "./control.ts";
import { retryLater } from "./phases.ts";

/** Whether the owner of a manager-held result has settled it; without this proof the receipt is kept. */
export type ResultSettled = (id: string, resultName: string) => Promise<boolean>;

export class ReceiptSweep {
  #directories = new Map<string, Dir>();

  /** Runs on the manager's own queue and control root; `reclaim` is the manager's queued reclamation. */
  constructor(private readonly control: TaskControl, private readonly queue: KeyedQueue,
    private readonly reclaim: (id: string, temp: string) => Promise<DirectoryRemoval>) {}

  async tick(tempDir: string, before: number, references: ReferenceText, excluded: ReadonlySet<string>, settled?: ResultSettled): Promise<DirectoryRemoval[]> {
    await this.control.initialize();
    // A member who never ran a tool has no tmp yet, so nothing of theirs can be swept.
    const temp = await realpath(tempDir).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    if (temp === undefined) return [];
    const results: DirectoryRemoval[] = [];
    for (const name of await this.#batch(temp)) {
      const id = name.slice(0, -5); if (!name.endsWith(".json") || !ID_PATTERN.test(id)) continue;
      if (excluded.has(id)) continue;
      let receipt: Receipt;
      try { receipt = await this.control.load(id); }
      catch (error) { results.push({ name: id, status: "refused", reason: String(error) }); continue; }
      if (receipt.temp !== temp || references.includes(join(temp, ".isolated-work", id), join(temp, ".isolated-work") + sep)) continue;
      // Result ownership is external to this receipt. Missing caller proof must never discard its only deletion evidence.
      if (receipt.role === "results" && (!receipt.resultName || !settled || !await settled(id, receipt.resultName))) continue;
      // An archived receipt is the archive's ownership record: plan replay and `discardArchive` still need it.
      if (receipt.phase === "archived") continue;
      if (receipt.phase === "removed") {
        if (receipt.role === undefined) continue; // Old receipts do not distinguish external result ownership.
        await this.queue.run(id, async () => {
          if ((await this.control.load(id)).phase !== "removed") throw new Error("回收回执状态已变化");
          await unlink(join(this.control.root, "receipts", name));
        });
        continue;
      }
      if (receipt.createdAt >= before || (receipt.reclamation?.nextAttemptAt ?? 0) > Date.now()) continue;
      let result: DirectoryRemoval;
      try { result = await this.reclaim(id, temp); }
      catch (error) { result = { name: id, status: "refused", reason: String(error) }; }
      if (result.status !== "removed") {
        const current = await this.control.load(id);
        retryLater(current, result.reason); await this.control.save(current);
      }
      results.push(result);
    }
    return results;
  }

  /** The next entries of this tmp's kept receipt stream; the stream closes (and restarts next tick) at its end. */
  async #batch(temp: string): Promise<string[]> {
    let directory = this.#directories.get(temp);
    if (!directory) {
      if (this.#directories.size >= 16) {
        const [old, handle] = this.#directories.entries().next().value!;
        this.#directories.delete(old); await handle.close();
      }
      directory = await opendir(join(this.control.root, "receipts")); this.#directories.set(temp, directory);
    }
    const batch: string[] = [];
    try {
      for (let index = 0; index < 128; index++) {
        const entry = await directory.read();
        if (!entry) { this.#directories.delete(temp); await directory.close(); break; }
        batch.push(entry.name);
      }
    } catch (error) {
      this.#directories.delete(temp); await directory.close().catch(() => {}); throw error;
    }
    return batch;
  }
}
