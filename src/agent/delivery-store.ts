import type { Database } from "bun:sqlite";
import { stateDatabase } from "../core/state.ts";
import type { RelayReference } from "../integrations/relay.ts";

export interface DeliveryAttachment { original: string; reference: RelayReference; }
export interface PendingDelivery { id: string; text: string; at: string; attachments: DeliveryAttachment[]; blockedReason?: string; }
type DeliveryRow = { id: string; text: string; at: string; attachments: string; blocked_reason: string | null };
const delivery = ({ blocked_reason, attachments, ...row }: DeliveryRow): PendingDelivery => ({ ...row,
  attachments: JSON.parse(attachments), ...(blocked_reason ? { blockedReason: blocked_reason } : {}) });

/** Shared read-only schema check; absent tables are initialized by the normal service. */
export function assertDeliverySchema(db: Database): void {
  const versionTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'delivery_schema'").get();
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get()) {
    if (versionTable) throw new Error("待补发账本 schema 存在但数据表缺失，请检查备份");
    return;
  }
  const version = versionTable ? (db.query("SELECT version FROM delivery_schema WHERE id = 1").get() as { version: number } | null)?.version : undefined;
  const columns = new Set((db.query("PRAGMA table_info(deliveries)").all() as { name: string }[]).map(column => column.name));
  if (version !== 2 || ["id", "session", "text", "at", "attachments", "blocked_reason"].some(column => !columns.has(column))) {
    throw new Error("待补发账本格式不受当前迁移支持（需要 schema 2）；请保持停机并保留数据库及 WAL，按 docs/data-migrations.md 的旧账本说明处理");
  }
}

/** Durable pending text, independent of Pi history. No callback credentials are stored. */
export class DeliveryStore {
  constructor(private readonly db: Database = stateDatabase()) {
    db.transaction(() => {
      const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get();
      if (exists) {
        assertDeliverySchema(db);
      } else {
        db.exec("CREATE TABLE deliveries (id TEXT PRIMARY KEY, session TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', blocked_reason TEXT)");
        db.exec("CREATE INDEX deliveries_session ON deliveries(session)");
        db.exec("CREATE TABLE delivery_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
        db.exec("INSERT INTO delivery_schema VALUES (1, 2)");
      }
    })();
  }
  assertCapacity(session: string): void {
    const { count } = this.db.query("SELECT count(*) AS count FROM deliveries WHERE session = ?").get(session) as { count: number };
    if (count >= 64) throw new Error("待补发回复已达 64 条，请先发送 /deliver 补发，再发送新的问题");
  }
  pending(session: string): PendingDelivery[] {
    const rows = this.db.query("SELECT id, text, at, attachments, blocked_reason FROM deliveries WHERE session = ? ORDER BY at, rowid").all(session) as DeliveryRow[];
    return rows.map(delivery);
  }
  /** Include other members: a forwarded file can reference another member's result. */
  groupReferences(groupId: string): PendingDelivery[] {
    const rows = this.db.query("SELECT id, text, at, attachments, blocked_reason FROM deliveries WHERE json_extract(session, '$[0]') = ? ORDER BY at, rowid").all(groupId) as DeliveryRow[];
    return rows.map(delivery);
  }
  hasPending(session: string): boolean {
    return this.db.query("SELECT 1 FROM deliveries WHERE session = ? LIMIT 1").get(session) !== null;
  }
  /** One row by its deterministic run id and owner. */
  find(session: string, id: string): PendingDelivery | undefined {
    const row = this.db.query("SELECT id, text, at, attachments, blocked_reason FROM deliveries WHERE session = ? AND id = ?").get(session, id) as DeliveryRow | null;
    return row ? delivery(row) : undefined;
  }
  /** Create or replace a row with a deterministic id, keeping its original time; no capacity check (checked at run start). */
  put(session: string, id: string, text: string, attachments: DeliveryAttachment[] = []): void {
    this.db.transaction(() => {
      const owner = this.db.query("SELECT session FROM deliveries WHERE id = ?").get(id) as { session: string } | null;
      if (owner && owner.session !== session) throw new Error("未送达记录不属于当前会话");
      if (owner) this.db.query("UPDATE deliveries SET text = ?, attachments = ?, blocked_reason = NULL WHERE id = ?").run(text, JSON.stringify(attachments), id);
      else this.db.query("INSERT INTO deliveries (id, session, text, at, attachments) VALUES (?, ?, ?, ?, ?)").run(id, session, text, new Date().toISOString(), JSON.stringify(attachments));
    })();
  }
  /** Replace row `from` (if any) by row `to` in one transaction: a run's link notes become its final reply. */
  finalize(session: string, from: string, to: string, text: string, attachments: DeliveryAttachment[]): void {
    this.db.transaction(() => {
      this.put(session, to, text, attachments);
      this.db.query("DELETE FROM deliveries WHERE id = ? AND session = ?").run(from, session);
    })();
  }
  acknowledge(ids: string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.db.query("DELETE FROM deliveries WHERE id = ?").run(id);
    })();
  }
}
