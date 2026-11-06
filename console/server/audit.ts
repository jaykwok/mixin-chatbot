// .console/audit/: one JSON line per conversation view, search, identity mode opened in full and export (requested, sent,
// interrupted, failed). Metadata only: no message text, no search text, no complete number, no credential or login link.
// Daily files, kept for a limited number of days.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IdentityMode } from "../ui/src/contract.ts";
import { dayKey } from "../../src/agent/stats-ledger.ts";

export type AuditAction = "view-open" | "identity-full" | "conversation-open" | "search"
  | "export-request" | "export-sent" | "export-interrupted" | "export-failed" | "log-view" | "log-export" | "plan" | "task-submit" | "directory-apply"
  | "push-settings" | "push-view" | "push-remind" | "push-cc" | "push-delete" | "push-group";

export interface AuditRecord {
  action: AuditAction;
  /** The console session's label (SessionView.label). */
  session: string;
  /** What was looked at: `stats`, a space path, or a space path and a masked member. */
  scope: string;
  mode: IdentityMode;
  /** Export identifier, to pair a request with its outcome. */
  export?: string;
  format?: string;
  rows?: number;
  bytes?: number;
  /** A short reason for a failure; never content. */
  note?: string;
}

/** The audit could not be written: the action it would have recorded is refused. */
export class AuditUnavailable extends Error { override name = "AuditUnavailable"; }

const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class AuditLog {
  #pruned = "";

  constructor(readonly dir: string, readonly retentionDays = 90, readonly now: () => number = Date.now) {}

  /** Appends one record; throws AuditUnavailable when it cannot. */
  write(record: AuditRecord): void {
    const at = this.now(), day = dayKey(at);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(this.dir, `${day}.jsonl`), JSON.stringify({ at: new Date(at).toISOString(), ...record }) + "\n", { mode: 0o600 });
    } catch (error) {
      throw new AuditUnavailable(`审计记录写入失败（${(error as NodeJS.ErrnoException).code ?? (error as Error).message}）`, { cause: error });
    }
    if (this.#pruned !== day) this.prune();
  }

  /** Deletes daily files older than the retention period. Failures leave the files for the next day. */
  prune(): void {
    const at = this.now();
    this.#pruned = dayKey(at);
    const oldest = dayKey(at - this.retentionDays * 86_400_000);
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const day = FILE.exec(name)?.[1];
      if (day && day < oldest) try { rmSync(join(this.dir, name), { force: true }); } catch {}
    }
  }
}
