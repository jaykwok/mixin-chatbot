import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { UploadStore } from "../../console/server/uploads.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { Auth } from "../../console/server/auth.ts";
import { createHandler } from "../../console/server/server.ts";
import { guardConfig } from "../../console/server/guard.ts";
import { operationPreparer } from "../../console/server/prepare-operation.ts";
import { Views } from "../../console/server/views.ts";
import { tempFixture } from "../helpers/temp.ts";

const actor = { pid: 10, startedAt: "fixture" };
const observers = { hosting: async () => ({ state: "ended" as const }), needsRecovery: async () => false };
function source(path: string): Buffer {
  const db = new Database(path, { create: true }); db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE fixture (id INTEGER); INSERT INTO fixture VALUES (1)"); db.close(); return readFileSync(path);
}
const uploadRequest = (bytes: Uint8Array) => new Request("http://127.0.0.1:11012/upload", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes });

test("统计上传受来源和登录保护，封存及取消路由不会误匹配原始流，JSON 仍限制 16 KB", async () => {
  const f = await tempFixture("console-upload-http-");
  try {
    const uploads = new UploadStore(join(f.root, ".console")), auth = new Auth(), login = auth.exchange(auth.issueToken().token)!;
    const handler = createHandler({ port: 11012, guard: guardConfig(11012), auth, instanceId: "fixture", overview: async () => { throw new Error("unused"); },
      bundle: { index: { path: "/", type: "text/html", body: new Uint8Array() }, assets: new Map() }, routes: uploads.routes() });
    const call = (path: string, body: unknown, raw = false, origin = "http://127.0.0.1:11012") => handler(new Request(`http://127.0.0.1:11012${path}`, {
      method: "POST", headers: { Host: "127.0.0.1:11012", Origin: origin, "X-Console-Request": "1", "Content-Type": raw ? "application/octet-stream" : "application/json", cookie: `${auth.cookieName}=${login.sessionId}` },
      body: raw ? body as Uint8Array : JSON.stringify(body),
    }));
    const bytes = source(join(f.root, "fixture.sqlite"));
    expect((await call("/api/uploads", { databaseBytes: bytes.length }, false, "http://127.0.0.1:9999")).status).toBe(403);
    expect((await call("/api/uploads", { databaseBytes: bytes.length, extra: "x".repeat(20000) })).status).toBe(400);
    const created = await call("/api/uploads", { databaseBytes: bytes.length }); expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };
    expect((await call(`/api/uploads/${id}/database`, bytes, true)).status).toBe(200);
    expect((await call(`/api/uploads/${id}/seal`, {})).status).toBe(200);
    expect((await call(`/api/uploads/${id}/database`, bytes, true)).status).toBe(409);
    expect((await call(`/api/uploads/${id}/cancel`, {})).status).toBe(200); expect(readdirSync(uploads.root)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("上传验证 WAL 缺失、大小、跨会话、过期及部分失败；任务结束和未接单后删除私有副本", async () => {
  const f = await tempFixture("console-upload-task-"); let now = 1;
  try {
    const uploads = new UploadStore(join(f.root, ".console"), () => now), tasks = new TaskStore(join(f.root, ".console"), () => now);
    const bytes = source(join(f.root, "fixture.sqlite"));
    const broken = uploads.create("s", bytes.length);
    await expect(uploads.write(broken.id, "database", "other", uploadRequest(bytes))).rejects.toThrow("过期");
    await expect(uploads.write(broken.id, "database", "s", uploadRequest(bytes.subarray(0, 100)))).rejects.toThrow("未完成");
    expect(existsSync(join(uploads.dir(broken.id), "stats.sqlite"))).toBe(false);
    const wal = Buffer.from(bytes); wal[18] = 2; wal[19] = 2;
    await uploads.write(broken.id, "database", "s", uploadRequest(wal));
    expect(() => uploads.seal(broken.id, "s")).toThrow("WAL"); uploads.remove(broken.id, "s");
    // A cleanly closed WAL database has no -wal: the operator says so, as a path import finds by itself.
    expect(() => uploads.create("s", wal.length, 10, true)).toThrow("不能同时");
    const merged = uploads.create("s", wal.length, 0, true);
    await uploads.write(merged.id, "database", "s", uploadRequest(wal)); uploads.seal(merged.id, "s");
    expect(uploads.path(merged.id, "s")).toBe(join(uploads.dir(merged.id), "stats.sqlite")); uploads.remove(merged.id, "s");
    for (const terminal of ["done", "not-accepted"]) {
      const file = uploads.create("s", bytes.length); await uploads.write(file.id, "database", "s", uploadRequest(bytes)); uploads.seal(file.id, "s");
      const prepared = await operationPreparer(f.root, new Views(), undefined, uploads)("stat-import", { upload: file.id }, "s");
      expect(prepared.path).toBe(join(uploads.dir(file.id), "stats.sqlite"));
      const task = tasks.create({ planId: "plan-" + "a".repeat(32), operation: "stat-import", params: prepared, project: f.root, mechanism: "systemd-system" }, terminal);
      uploads.bind(tasks.request(task.id));
      expect(() => uploads.remove(file.id, "s")).toThrow("不能取消");
      await uploads.prune(tasks, observers); expect(existsSync(uploads.dir(file.id))).toBe(true);
      if (terminal === "done") { tasks.accept(task.id, actor); tasks.finish(task.id, { outcome: "success", exitCode: 0, finalState: "stopped", message: "完成" }); }
      else { now += 60_000; tasks.abandon(task.id); }
      await uploads.prune(tasks, observers); expect(existsSync(join(uploads.root, file.id))).toBe(false);
    }
    const expired = uploads.create("s", bytes.length); now += 3600_001;
    await uploads.prune(tasks, observers); expect(existsSync(join(uploads.root, expired.id))).toBe(false);
    expect(() => uploads.create("s", 513 * 1024 * 1024)).toThrow("512 MB");
    expect(() => uploads.dir("../../outside")).toThrow("编号");
  } finally { await f.cleanup(); }
});
