import { randomUUID } from "node:crypto";
import { scan, apply, selectEntries } from "../../ops/tools/backup-cleanup.ts";
import { fields, textParam } from "../../ops/core/operations.ts";
import { ApiProblem, type Route } from "./routes.ts";
import { redactSecrets } from "../../src/lib/redact.ts";

export class BackupForms {
  private selections = new Map<string, { session: string; report: string; code: string; expires: number }>();
  constructor(readonly project: string) {}
  end(session: string): void { for (const [key, value] of this.selections) if (value.session === session) this.selections.delete(key); }
  prepare(params: Record<string, unknown>, session: string): Record<string, unknown> {
    fields(params, ["selection", "indexes"]);
    const selection = this.selections.get(textParam(params.selection));
    if (!selection || selection.session !== session || selection.expires <= Date.now()) throw new Error("备份列表已过期，请重新扫描");
    if (!Array.isArray(params.indexes) || !params.indexes.length) throw new Error("请选择要删除的备份");
    // Each preview rewrites the manifest's actions. The scan stays usable for another preview, checked against this version;
    // an earlier preview's confirmation code no longer matches, so only the latest one can run.
    const confirm = selectEntries(this.project, selection.report, selection.code, params.indexes as number[]);
    selection.code = confirm;
    return { report: selection.report, confirm };
  }
  /** A cleanup task took a preview of this scan: what it deletes makes the list stale, so it cannot be previewed again. */
  bind(request: { operation: string; params: Record<string, unknown> }): void {
    if (request.operation !== "backup-clean") return;
    for (const [key, value] of this.selections) if (value.report === request.params.report) this.selections.delete(key);
  }
  routes(): Record<string, Route> {
    return { "POST /api/backups/scan": { slow: true, run: async ({ session, body }) => {
      try {
        fields(body as Record<string, unknown>, []);
        const scanned = scan(this.project);
        if (!scanned.report) return { selection: null, entries: [] };
        const preview = apply(this.project, scanned.report), id = randomUUID();
        for (const [key, value] of this.selections) if (value.expires <= Date.now() || value.session === session.label) this.selections.delete(key);
        this.selections.set(id, { session: session.label, report: scanned.report, code: preview.code, expires: Date.now() + 600_000 });
        const shown = (text: string) => redactSecrets(text).replace(/\b1[3-9]\d{9}\b/g, value => `${value.slice(0, 3)}****${value.slice(-4)}`);
        // The same name can sit in two areas (a transaction's snapshot and its moved files): show where, and why.
        return { selection: id, entries: scanned.entries.map((entry, index) => ({ index,
          name: shown(entry.path), basis: entry.basis.map(shown),
          bytes: entry.bytes, category: entry.category, selected: entry.action === "delete",
          selectable: ["confirmed-test", "business"].includes(entry.category) && !scanned.protected.has(entry.path),
        })) };
      } catch (error) { throw new ApiProblem(409, "input", error instanceof Error ? error.message : "扫描失败"); }
    } } };
  }
}
