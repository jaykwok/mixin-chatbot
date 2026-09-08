import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { stateDatabase } from "../core/state.ts";

export interface PendingDelivery { id: string; text: string; at: string; }

/** Durable pending text, independent of Pi history. No callback credentials are stored. */
export class DeliveryStore {
  constructor(private readonly db: Database = stateDatabase()) {
    db.exec("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, session TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session)");
  }
  assertCapacity(session: string): void {
    const { count } = this.db.query("SELECT count(*) AS count FROM deliveries WHERE session = ?").get(session) as { count: number };
    if (count >= 64) throw new Error("待补发回复已达 64 条，请先发送 /deliver 补发，再发送新的问题");
  }
  /** One row per run: early links survive a crash, and the final answer updates that row. */
  save(session: string, text: string, id?: string): string {
    return this.db.transaction(() => {
      if (id) {
        const result = this.db.query("UPDATE deliveries SET text = ? WHERE id = ? AND session = ?").run(text, id, session);
        if (result.changes !== 1) throw new Error("未送达记录不存在或不属于当前会话");
        return id;
      }
      this.assertCapacity(session);
      const newId = randomUUID();
      this.db.query("INSERT INTO deliveries VALUES (?, ?, ?, ?)").run(newId, session, text, new Date().toISOString());
      return newId;
    })();
  }
  pending(session: string): PendingDelivery[] {
    return this.db.query("SELECT id, text, at FROM deliveries WHERE session = ? ORDER BY at, rowid").all(session) as PendingDelivery[];
  }
  acknowledge(ids: string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.db.query("DELETE FROM deliveries WHERE id = ?").run(id);
    })();
  }
}
