import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { stateDatabase } from "../core/state.ts";
import type { RelayReference } from "../integrations/relay.ts";

export interface DeliveryAttachment { original: string; reference: RelayReference; }
export interface PendingDelivery { id: string; text: string; at: string; attachments: DeliveryAttachment[]; blockedReason?: string; }

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
    throw new Error("待补发账本格式需要迁移；请先停止机器人，运行 tmp/migrate-audit-2026-09-13.ts --apply 后再启动");
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
  /** One row per run: early links survive a crash, and the final answer updates that row. */
  save(session: string, text: string, id?: string, attachments: DeliveryAttachment[] = []): string {
    return this.db.transaction(() => {
      if (id) {
        const result = this.db.query("UPDATE deliveries SET text = ?, attachments = ?, blocked_reason = NULL WHERE id = ? AND session = ?").run(text, JSON.stringify(attachments), id, session);
        if (result.changes !== 1) throw new Error("未送达记录不存在或不属于当前会话");
        return id;
      }
      this.assertCapacity(session);
      const newId = randomUUID();
      this.db.query("INSERT INTO deliveries (id, session, text, at, attachments) VALUES (?, ?, ?, ?, ?)").run(newId, session, text, new Date().toISOString(), JSON.stringify(attachments));
      return newId;
    })();
  }
  pending(session: string): PendingDelivery[] {
    const rows = this.db.query("SELECT id, text, at, attachments, blocked_reason FROM deliveries WHERE session = ? ORDER BY at, rowid").all(session) as {
      id: string; text: string; at: string; attachments: string; blocked_reason: string | null;
    }[];
    return rows.map(({ blocked_reason, attachments, ...row }) => ({ ...row,
      attachments: JSON.parse(attachments), ...(blocked_reason ? { blockedReason: blocked_reason } : {}) }));
  }
  acknowledge(ids: string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.db.query("DELETE FROM deliveries WHERE id = ?").run(id);
    })();
  }
}
