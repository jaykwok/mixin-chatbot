import { constants } from "node:fs";
import { copyFile, mkdir, open, stat, unlink, realpath, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { DeliveryStore } from "./delivery-store.ts";
import type { FileTransfer } from "./send-tools.ts";
import { isPathInside } from "../contracts/paths.ts";

export type ReviewStatus = "checked" | "draft" | "rejected";
export type Deliverable = {
  id: string; session: string; requestId: string; slot: string; seq: number; name: string;
  sourcePath: string; path: string; size: number; sha256: string; format: string; complete: boolean;
  status: ReviewStatus; checked: string[]; unchecked: string[]; issues: string[]; at: number;
};
export type FileSend = {
  id: string; session: string; requestId: string; deliveryId?: string; slot?: string;
  name: string; path: string; sha256: string; size: number; mode: "direct" | "relay";
  state: "planned" | "sending" | "sent" | "failed" | "uncertain" | "withdrawn";
  attempts: number; error?: string; at: number;
  relay?: Extract<FileTransfer, { mode: "relay" }>;
};
export type FallbackPlan = { id: string; session: string; requestId: string; deadline: number; textSent: boolean; withdrawn: boolean;
  relayFiles?: string[]; expiredNoticeAt?: number };

/** Streaming, abortable digest: large relay files do not occupy the JavaScript heap. */
export async function fileDigest(path: string, signal?: AbortSignal, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("文件不是普通文件或超过交付大小上限");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("文件增长超过交付大小上限");
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** Copy before recording; check both sides so later edits cannot change a registered version. */
export async function freezeFile(sourcePath: string, tempDir: string, requestId: string, maxBytes: number, signal?: AbortSignal, sourceDigest?: string) {
  const sha256 = sourceDigest ?? await fileDigest(sourcePath, signal, maxBytes);
  const parent = await realpath(tempDir), root = join(parent, ".deliverables");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error("交付快照目录不能是链接");
  const dir = join(root, createHash("sha256").update(requestId).digest("hex").slice(0, 24), randomUUID());
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== dir) throw new Error("交付快照目录越界");
  const name = basename(sourcePath), path = join(dir, name);
  try {
    await copyFile(sourcePath, path, constants.COPYFILE_EXCL);
    if (sha256 !== await fileDigest(path, signal, maxBytes)) throw new Error("复制期间源文件变化，请完成生成后重新登记");
    return { sourcePath, path, name, sha256, size: (await stat(path)).size, format: extname(name).slice(1).toLowerCase() };
  } catch (error) { await unlink(path).catch(() => {}); throw error; }
}

/** Structural completeness only; never a claim that content or layout has been reviewed. */
export async function completeFile(path: string, format: string): Promise<boolean> {
  const f = await open(path, "r");
  try {
    const { size } = await f.stat();
    if (!size) return false;
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await f.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    if (format === "pdf") return (await read(0, 5)).toString() === "%PDF-" &&
      (await read(Math.max(0, size - 1024), Math.min(size, 1024))).includes(Buffer.from("%%EOF"));
    const main = ({ docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" } as Record<string, string>)[format];
    if (!main) return true;
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let n = tail.length - 22; n >= 0; n--) if (tail.readUInt32LE(n) === 0x06054b50 && n + 22 + tail.readUInt16LE(n + 20) === tail.length) { end = n; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) return false;
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    // ZIP64 / multi-disk files are not treated as complete by this inexpensive check.
    if (count === 0xffff || length > 16 * 1024 * 1024 || offset + length > size - tail.length + end) return false;
    const directory = await read(offset, length), names = new Set<string>();
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50) return false;
      const nameLength = directory.readUInt16LE(pos + 28), extra = directory.readUInt16LE(pos + 30), comment = directory.readUInt16LE(pos + 32);
      if (directory.readUInt32LE(pos + 42) >= offset || pos + 46 + nameLength + extra + comment > directory.length) return false;
      names.add(directory.subarray(pos + 46, pos + 46 + nameLength).toString()); pos += 46 + nameLength + extra + comment;
    }
    return pos === directory.length && names.has("[Content_Types].xml") && names.has(main);
  } catch { return false; } finally { await f.close(); }
}

export function assertCloseoutSchema(db: Database): boolean {
  const tables = ["closeout_schema", "deliverables", "file_sends", "fallback_plans", "document_events"];
  const present = tables.filter(name => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!present.length) return false;
  if (present.length !== tables.length || (db.query("SELECT version FROM closeout_schema WHERE id=1").get() as { version: number } | null)?.version !== 1) {
    throw new Error("交付物账本格式不支持或表缺失；请保留 agent.sqlite 及 WAL 并核对备份（需要 closeout schema 1）");
  }
  const columns = { deliverables: "id,session,request_id,seq,data", file_sends: "id,session,request_id,sha256,delivery_id,state,data",
    fallback_plans: "id,session,data", document_events: "id,session,request_id,data" };
  try { for (const [table, names] of Object.entries(columns)) db.query(`SELECT ${names} FROM ${table} LIMIT 0`).all(); }
  catch (cause) { throw new Error("交付物账本列缺失，请保留 agent.sqlite 及 WAL 并核对备份", { cause }); }
  return true;
}

/** Versioned alongside, not in place of, delivery_schema 2. JSON keeps review metadata append-only. */
export class CloseoutStore {
  readonly db: Database;
  constructor(readonly outbox: DeliveryStore) {
    this.db = outbox.database;
    this.db.transaction(() => {
      if (assertCloseoutSchema(this.db)) return;
      this.db.exec(`CREATE TABLE closeout_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
        INSERT INTO closeout_schema VALUES(1,1);
        CREATE TABLE deliverables (id TEXT PRIMARY KEY, session TEXT NOT NULL, request_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX deliverables_request ON deliverables(session,request_id,seq);
        CREATE TABLE file_sends (id TEXT PRIMARY KEY, session TEXT NOT NULL, request_id TEXT NOT NULL, sha256 TEXT NOT NULL, delivery_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session,request_id,sha256));
        CREATE INDEX file_sends_delivery ON file_sends(session,delivery_id);
        CREATE TABLE fallback_plans (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE document_events (id TEXT PRIMARY KEY, session TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL);`);
    })();
    this.db.query("UPDATE file_sends SET state='uncertain' WHERE state='sending'").run();
  }
  registrations(session: string, requestId: string): Deliverable[] {
    return this.db.query("SELECT data FROM deliverables WHERE session=? AND request_id=? ORDER BY seq").all(session, requestId).map(row => JSON.parse((row as { data: string }).data));
  }
  register(record: Omit<Deliverable, "id" | "seq" | "at">): Deliverable {
    return this.db.transaction(() => {
      const previous = this.registrations(record.session, record.requestId);
      if (previous.length >= 8) throw new Error("本任务最多登记 8 个版本，请发送已登记的最佳版本");
      if (!previous.some(each => each.slot === record.slot) && new Set(previous.map(each => each.slot)).size >= 3) throw new Error("本任务最多登记 3 个交付物");
      const next = { ...record, id: randomUUID(), seq: previous.length + 1, at: Date.now() };
      this.db.query("INSERT INTO deliverables VALUES(?,?,?,?,?)").run(next.id, next.session, next.requestId, next.seq, JSON.stringify(next));
      return next;
    })();
  }
  candidates(session: string, requestId: string): Deliverable[] {
    const all = this.registrations(session, requestId), rejected = new Set(all.filter(x => x.status === "rejected").map(x => x.sha256));
    return [...new Set(all.map(x => x.slot))].flatMap(slot => {
      const versions = all.filter(x => x.slot === slot && x.complete && !rejected.has(x.sha256)).reverse();
      const best = versions.find(x => x.status === "checked") ?? versions.find(x => x.status === "draft");
      return best ? [best] : [];
    });
  }
  files(session: string, requestId?: string, deliveryId?: string): FileSend[] {
    return this.db.query("SELECT data,state,delivery_id FROM file_sends WHERE session=? AND (? IS NULL OR request_id=?) AND (? IS NULL OR delivery_id=?) ORDER BY rowid")
      .all(session, requestId ?? null, requestId ?? null, deliveryId ?? null, deliveryId ?? null).map(row => {
        const r = row as { data: string; state: FileSend["state"]; delivery_id: string | null };
        return { ...JSON.parse(r.data), state: r.state, ...(r.delivery_id ? { deliveryId: r.delivery_id } : {}) };
      });
  }
  saveFile(file: FileSend): void {
    this.db.query(`INSERT INTO file_sends VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET delivery_id=excluded.delivery_id,state=excluded.state,data=excluded.data`)
      .run(file.id, file.session, file.requestId, file.sha256, file.deliveryId ?? null, file.state, JSON.stringify(file));
  }
  file(record: Pick<FileSend, "session" | "requestId" | "path" | "name" | "sha256" | "size" | "mode"> & { slot?: string }): FileSend {
    const existing = this.files(record.session, record.requestId).find(x => x.sha256 === record.sha256);
    if (existing) return existing;
    const file: FileSend = { ...record, id: randomUUID(), state: "planned", attempts: 0, at: Date.now() };
    this.saveFile(file); return file;
  }
  plan(session: string, id: string): FallbackPlan | undefined {
    const row = this.db.query("SELECT data FROM fallback_plans WHERE session=? AND id=?").get(session, id) as { data: string } | null;
    return row ? JSON.parse(row.data) : undefined;
  }
  savePlan(plan: FallbackPlan): void {
    this.db.query("INSERT INTO fallback_plans VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(plan.id, plan.session, JSON.stringify(plan));
  }
  createPlan(session: string, requestId: string, text: string, candidates: Deliverable[], budgetMs: number): FallbackPlan {
    return this.db.transaction(() => {
      const id = `fallback:${requestId}`, existing = this.plan(session, id);
      if (existing) return existing;
      const notes = this.outbox.find(session, `notes:${requestId}`);
      const linked = this.files(session, requestId).filter(file => file.mode === "relay" && file.state === "planned" && file.relay &&
        notes?.attachments.some(note => note.original === file.relay!.attachment.original &&
          note.reference.url === file.relay!.attachment.reference.url && note.reference.backend === file.relay!.attachment.reference.backend));
      const plan = { id, session, requestId, deadline: Date.now() + budgetMs, textSent: false, withdrawn: false, relayFiles: linked.map(file => file.id) };
      this.outbox.finalize(session, `notes:${requestId}`, id, [text, notes?.text].filter(Boolean).join("\n\n"), notes?.attachments ?? []);
      for (const candidate of candidates) {
        const file = this.file({ ...candidate, mode: "direct" });
        this.saveFile({ ...file, deliveryId: id });
      }
      for (const file of linked) this.saveFile({ ...file, deliveryId: id });
      this.savePlan(plan);
      this.event(session, requestId, "request_closed", { name: "request_closed", at: Date.now() });
      return plan;
    })();
  }
  /** Relay links covered by the explanation become sent only when that explanation is acknowledged. */
  acknowledgePlanText(plan: FallbackPlan): void {
    this.db.transaction(() => {
      this.savePlan({ ...plan, textSent: true });
      for (const file of this.files(plan.session, plan.requestId, plan.id)) {
        if (plan.relayFiles?.includes(file.id)) this.saveFile({ ...file, state: "sent" });
      }
    })();
  }
  /** Control receipt: no awaiting a network lock, no future automatic sends from these plans. */
  withdraw(session: string): void {
    this.db.transaction(() => {
      for (const row of this.db.query("SELECT data FROM fallback_plans WHERE session=?").all(session) as { data: string }[]) {
        this.savePlan({ ...JSON.parse(row.data), withdrawn: true });
      }
      this.db.query("UPDATE file_sends SET state='withdrawn' WHERE session=? AND state IN ('planned','failed') AND delivery_id IS NOT NULL").run(session);
    })();
  }
  event(session: string, requestId: string, id: string, data: { name: string; digest?: string; at?: number }): void {
    this.db.query("INSERT OR IGNORE INTO document_events VALUES(?,?,?,?)").run(JSON.stringify([session, requestId, id]), session, requestId, JSON.stringify(data));
  }
  events(session: string, requestId: string): { name: string; digest?: string }[] {
    return this.db.query("SELECT data FROM document_events WHERE session=? AND request_id=?").all(session, requestId).map(row => JSON.parse((row as { data: string }).data));
  }
  acknowledgeRelay(session: string, requestId: string): void {
    for (const file of this.files(session, requestId)) if (file.mode === "relay" && file.state === "planned") this.saveFile({ ...file, state: "sent" });
  }
  /** Retryable and uncertain files keep their bytes. Only unreferenced snapshots may be reclaimed. */
  async releaseSnapshots(session: string, requestId: string, tempDir: string, cancelled = false): Promise<void> {
    const files = this.files(session, requestId), plan = this.plan(session, `fallback:${requestId}`);
    const pendingReply = this.outbox.find(session, `notes:${requestId}`) ?? this.outbox.find(session, `reply:${requestId}`);
    const keep = new Set(files.filter(x => x.state !== "sent" &&
      ((x.deliveryId && (!cancelled || plan)) || (!cancelled && pendingReply && x.mode === "relay" && x.state === "planned"))).map(x => x.path));
    const paths = new Set([...this.registrations(session, requestId).map(x => x.path), ...files.map(x => x.path)]);
    let root: string | undefined;
    for (const path of paths) {
      if (keep.has(path)) continue;
      try {
        root ??= join(await realpath(tempDir), ".deliverables");
        const actual = await realpath(path);
        if (actual === root || !isPathInside(actual, root)) throw new Error("交付快照清理路径越界");
        await unlink(actual);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.event(session, requestId, "request_closed", { name: "request_closed", at: Date.now() });
    if (cancelled && !plan) this.db.query("DELETE FROM file_sends WHERE session=? AND request_id=? AND state!='sent'").run(session, requestId);
  }
  sweepMetadata(now = Date.now()): void {
    const cutoff = now - 7 * 24 * 3600_000;
    this.db.transaction(() => {
      const requests = this.db.query(`SELECT session,request_id FROM document_events e WHERE json_extract(data,'$.name')='request_closed' AND json_extract(data,'$.at')<?
        AND NOT EXISTS(SELECT 1 FROM file_sends f WHERE f.session=e.session AND f.request_id=e.request_id AND f.state!='sent' AND f.delivery_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.session=e.session AND d.id IN ('fallback:'||e.request_id,'reply:'||e.request_id,'notes:'||e.request_id))`)
        .all(cutoff) as { session: string; request_id: string }[];
      for (const { session, request_id } of requests) {
        for (const table of ["deliverables", "file_sends", "document_events"]) this.db.query(`DELETE FROM ${table} WHERE session=? AND request_id=?`).run(session, request_id);
        this.db.query("DELETE FROM fallback_plans WHERE session=? AND id=?").run(session, `fallback:${request_id}`);
      }
    })();
  }
}

/** Read by both online reclamation and offline maintenance; pending snapshots always remain protected. */
export function closeoutReferences(db: Database, groupId?: string): unknown[] {
  if (!assertCloseoutSchema(db)) return [];
  return ["deliverables", "file_sends"].flatMap(table => db.query(`SELECT data FROM ${table} WHERE (? IS NULL OR json_extract(session,'$[0]')=?)`)
    .all(groupId ?? null, groupId ?? null).map(row => JSON.parse((row as { data: string }).data)));
}
