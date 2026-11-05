import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeAtomic } from "./state.ts";
import { fields } from "./operations.ts";
import { ApiProblem, type Route } from "./routes.ts";
import type { TaskRequest, TaskStore, TaskObservers } from "./tasks.ts";

const ID = /^upload-[a-f0-9]{32}$/, LIMIT = 512 * 1024 * 1024;
/** walMerged: the operator states the WAL-mode database has no -wal beside it (closed cleanly), as a path import finds by itself. */
interface Upload { version: 1; id: string; session: string; createdAt: number; databaseBytes: number; walBytes: number; walMerged?: true; ready: boolean; task?: string }
export class UploadStore {
  readonly root: string;
  private active = new Set<string>();
  constructor(consoleDir: string, readonly now = Date.now) {
    this.root = resolve(consoleDir, "uploads"); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("上传目录不是普通目录");
  }
  dir(id: string): string {
    if (!ID.test(id)) throw new Error("上传编号无效");
    const path = join(this.root, id), stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("上传目录无效");
    return path;
  }
  private read(id: string): Upload {
    const path = join(this.dir(id), "record.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("上传记录无效");
    const value = JSON.parse(readFileSync(path, "utf8")) as Upload;
    if (value.version !== 1 || value.id !== id || typeof value.session !== "string" || !Number.isSafeInteger(value.createdAt)
      || !Number.isSafeInteger(value.databaseBytes) || value.databaseBytes < 100 || !Number.isSafeInteger(value.walBytes) || value.walBytes < 0
      || value.databaseBytes + value.walBytes > LIMIT || value.walMerged !== undefined && (value.walMerged !== true || value.walBytes > 0) || typeof value.ready !== "boolean" || value.task !== undefined && !/^task-[a-f0-9]{32}$/.test(value.task)) throw new Error("上传记录损坏");
    return value;
  }
  private owned(id: string, session: string): Upload {
    const value = this.read(id);
    if (value.session !== session || this.now() - value.createdAt > 3600_000 || value.createdAt > this.now()) throw new Error("上传已过期，请重新选择文件");
    return value;
  }
  create(session: string, databaseBytes: number, walBytes = 0, walMerged = false): Upload {
    if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 100 || !Number.isSafeInteger(walBytes) || walBytes < 0 || databaseBytes + walBytes > LIMIT) throw new Error("统计文件及 WAL 合计不能超过 512 MB");
    if (walMerged && walBytes) throw new Error("已选择 -wal 文件时不能同时声明没有 -wal");
    let total = databaseBytes + walBytes, count = 0;
    for (const id of readdirSync(this.root).filter(id => ID.test(id))) { const value = this.read(id); total += value.databaseBytes + value.walBytes; if (value.session === session) count++; }
    if (total > 2 * LIMIT || count >= 4) throw new Error("已有上传占用空间，请取消未使用的上传或等待任务完成");
    const id = `upload-${randomUUID().replaceAll("-", "")}`, value: Upload = { version: 1, id, session, createdAt: this.now(), databaseBytes, walBytes, ...(walMerged ? { walMerged: true as const } : {}), ready: false };
    mkdirSync(join(this.root, id), { mode: 0o700 }); this.save(value); return value;
  }
  private save(value: Upload) { writeAtomic(join(this.dir(value.id), "record.json"), JSON.stringify(value) + "\n"); }
  async write(id: string, part: string, session: string, request: Request, alive = () => true): Promise<void> {
    const value = this.owned(id, session);
    if (value.ready || value.task || this.active.has(id) || !["database", "wal"].includes(part)) throw new Error("上传已封存或正在写入");
    const size = part === "database" ? value.databaseBytes : value.walBytes;
    if (!size || !request.body || request.headers.get("content-type") !== "application/octet-stream") throw new Error("上传文件或格式无效");
    const length = request.headers.get("content-length"); if (length !== null && Number(length) !== size) throw new Error("上传大小不符");
    const path = join(this.dir(id), part === "database" ? "stats.sqlite" : "stats.sqlite-wal");
    if (existsSync(path)) throw new Error("此文件已上传，请重新开始一份上传");
    this.active.add(id);
    let handle: Awaited<ReturnType<typeof open>> | undefined, complete = false;
    const reader = request.body.getReader();
    try {
      handle = await open(path, "wx", 0o600); let received = 0;
      for (;;) {
        request.signal.throwIfAborted(); if (!alive()) throw new Error("登录已失效"); const chunk = await reader.read(); if (chunk.done) break;
        received += chunk.value.byteLength; if (received > size) throw new Error("上传超过声明的大小");
        let offset = 0;
        while (offset < chunk.value.byteLength) { const result = await handle.write(chunk.value, offset); if (!result.bytesWritten) throw new Error("上传写入没有进展"); offset += result.bytesWritten; }
      }
      if (received !== size) throw new Error("上传未完成，请重新上传");
      await handle.sync(); complete = true;
    } finally {
      await reader.cancel().catch(() => {}); reader.releaseLock(); await handle?.close();
      if (!complete && handle) rmSync(path, { force: true }); this.active.delete(id);
    }
  }
  seal(id: string, session: string): void {
    const value = this.owned(id, session); if (value.task || this.active.has(id)) throw new Error("上传正在使用");
    const path = join(this.dir(id), "stats.sqlite");
    for (const [file, size] of [[path, value.databaseBytes], [path + "-wal", value.walBytes]] as const) {
      if (!size) continue; const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) throw new Error("上传文件不完整");
    }
    const header = Buffer.alloc(100), fd = openSync(path, "r"); try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
    if (header.subarray(0, 16).toString() !== "SQLite format 3\0") throw new Error("不是 SQLite 数据库");
    // The browser cannot see the sibling -wal: without it, unmerged changes would be missing silently. The operator says which.
    if ((header[18] === 2 || header[19] === 2) && !value.walBytes && !value.walMerged) throw new Error("这是 WAL 模式的数据库：同目录有 -wal 文件时请一并上传；确认没有（已正常关闭）时勾选“同目录没有 -wal 文件”后重新上传");
    value.ready = true; this.save(value);
  }
  path(id: string, session: string): string {
    const value = this.owned(id, session); if (!value.ready || value.task) throw new Error("上传尚未完成或已交给任务");
    return join(this.dir(id), "stats.sqlite");
  }
  bind(request: TaskRequest): void {
    const id = request.params.upload; if (id === undefined) return;
    const value = this.read(String(id));
    if (request.operation !== "stat-import" || !value.ready || value.task && value.task !== request.id || request.params.path !== join(this.dir(value.id), "stats.sqlite")) throw new Error("上传与任务不符");
    value.task = request.id; this.save(value);
  }
  remove(id: string, session?: string): void {
    const value = session === undefined ? this.read(id) : this.owned(id, session);
    if (this.active.has(id) || session !== undefined && value.task) throw new Error("上传已交给任务，不能取消");
    rmSync(this.dir(id), { recursive: true });
  }
  finish(request: TaskRequest): void {
    const id = request.params.upload; if (typeof id !== "string") return;
    const value = this.read(id); if (value.task === request.id) this.remove(id);
  }
  async prune(tasks: TaskStore, observers: TaskObservers): Promise<void> {
    for (const id of readdirSync(this.root).filter(id => ID.test(id))) {
      try {
        const value = this.read(id);
        if (!value.task && this.now() - value.createdAt > 3600_000) this.remove(id);
        else if (value.task) {
          const request = tasks.request(value.task);
          const view = await tasks.view(value.task, observers);
          if (request.params.upload === id && ["succeeded", "failed", "not-accepted"].includes(view.state)) this.finish(request);
        }
      } catch { /* Unknown/corrupt records are retained, never attributed to another task. */ }
    }
  }
  routes(): Record<string, Route> {
    const wrap = (run: Route["run"], raw = false): Route => ({ slow: true, raw, run: async context => {
      try { return await run(context); } catch (error) { throw new ApiProblem(409, "input", error instanceof Error ? error.message : "上传未完成"); }
    } });
    return {
      "POST /api/uploads": wrap(async ({ session, body }) => { const value = body as Record<string, unknown>; fields(value, ["databaseBytes", "walBytes", "walMerged"]);
        if (value.walMerged !== undefined && typeof value.walMerged !== "boolean") throw new Error("上传参数无效");
        const record = this.create(session.label, value.databaseBytes as number, (value.walBytes ?? 0) as number, value.walMerged === true); return { id: record.id }; }),
      "POST /api/uploads/:id/seal": wrap(async ({ session, params }) => { this.seal(params!.id!, session.label); return { ok: true }; }),
      "POST /api/uploads/:id/cancel": wrap(async ({ session, params }) => { this.remove(params!.id!, session.label); return { ok: true }; }),
      "POST /api/uploads/:id/:part": wrap(async ({ session, params, request, sessionAlive }) => { await this.write(params!.id!, params!.part!, session.label, request!, sessionAlive); return { ok: true }; }, true),
    };
  }
}
