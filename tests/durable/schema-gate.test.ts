// Durable 1.4.0 migrates schema 1 to 2 on open, and 1.3.0 cannot read the result. Every entry that opens a conversation
// database (service storage, offline maintenance, diagnostics snapshots) refuses another schema before that open, and
// leaves the file as it is; a new database is created normally.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { applySqliteMigrations, CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { withSpaceSnapshot } from "../../src/durable/diagnostics.ts";
import { queueSpaceClear } from "../../src/durable/offline.ts";
import { assertSpaceSchemas } from "../../src/durable/space-databases.ts";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-schema-gate-");
afterAll(() => fixture.cleanup());
let n = 0;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const version = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number }).version; } finally { db.close(); }
};

/** A database exactly as the official schema-1 migration leaves it (what Durable 1.3.0 created). */
async function schemaOne(): Promise<string> {
  const path = join(fixture.root, `old-${++n}.sqlite`), db = await openGroupDatabase(path);
  try { await applySqliteMigrations(db, SQLITE_MIGRATIONS.slice(0, 1)); } finally { await db.close(); }
  expect(version(path)).toBe(1);
  return path;
}

test("the gate expects the schema this program was built with", () => {
  expect(CURRENT_SQLITE_SCHEMA_VERSION).toBe(2);
});

test("a new database is created at the current schema and opens again", async () => {
  const path = join(fixture.root, `new-${++n}.sqlite`);
  await createSession(await openGroupStorage(path)).close(context);
  expect(version(path)).toBe(2);
  await createSession(await openGroupStorage(path)).close(context);
});

test("an existing schema-1 database, even without any record, is refused before the official open and left unchanged", async () => {
  const path = await schemaOne(), before = digest(path);
  await expect(openGroupStorage(path)).rejects.toThrow("Durable schema 1，当前程序只支持 schema 2");
  await expect(openGroupDatabase(path)).rejects.toThrow("不做原地升级");
  expect({ digest: digest(path), version: version(path) }).toEqual({ digest: before, version: 1 });
});

test("offline maintenance refuses a schema-1 database the same way", async () => {
  const path = await schemaOne(), before = digest(path);
  await expect(queueSpaceClear(path)).rejects.toThrow("Durable schema 1");
  expect(digest(path)).toBe(before);
});

test("a diagnostics snapshot refuses a schema-1 database without migrating its copy", async () => {
  const path = await schemaOne(), before = digest(path);
  let opened = false;
  await expect(withSpaceSnapshot(path, async () => { opened = true; })).rejects.toThrow("Durable schema 1");
  expect({ opened, digest: digest(path) }).toEqual({ opened: false, digest: before });
});

test("a database of something else, or an empty file, is not a conversation database", async () => {
  const foreign = join(fixture.root, `foreign-${++n}.sqlite`);
  const db = new Database(foreign); db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)"); db.close();
  const before = digest(foreign);
  await expect(openGroupStorage(foreign)).rejects.toThrow("无法识别");
  expect(digest(foreign)).toBe(before);
  const empty = join(fixture.root, `empty-${++n}.sqlite`);
  writeFileSync(empty, "");
  await expect(withSpaceSnapshot(empty, async () => undefined)).rejects.toThrow("无法识别");
  expect(readFileSync(empty).length).toBe(0);
});

/** A conversations root whose `space` holds the database `kind` (or none); the release checks read it. */
async function conversations(space: "direct" | "groups/g1", kind: "old" | "foreign" | "unreadable" | "current" | "none" | "directory") {
  const root = join(fixture.root, `conversations-${++n}`), dir = join(root, ...space.split("/")), path = join(dir, "durable.sqlite");
  mkdirSync(dir, { recursive: true });
  if (kind === "old") copyFileSync(await schemaOne(), path);
  if (kind === "foreign") { const db = new Database(path); db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)"); db.close(); }
  if (kind === "unreadable") writeFileSync(path, "not a database, but sixteen bytes and more");
  if (kind === "current") await createSession(await openGroupStorage(path)).close(context);
  if (kind === "directory") mkdirSync(path);
  return { root, path };
}

test.each(["direct", "groups/g1"] as const)("the release checks refuse a %s database this program cannot open, leaving it as it is", async space => {
  for (const [kind, message] of [["old", "Durable schema 1"], ["foreign", "无法识别"], ["unreadable", "无法读取会话库"], ["directory", "不是普通文件"]] as const) {
    const { root, path } = await conversations(space, kind);
    const before = kind === "directory" ? undefined : digest(path);
    await expect(assertSpaceSchemas(root), `${space} ${kind}`).rejects.toThrow(message);
    if (before) expect(digest(path), `${space} ${kind}`).toBe(before);
  }
  for (const kind of ["current", "none"] as const) await assertSpaceSchemas((await conversations(space, kind)).root);
  // An empty file is a database not created yet, as the service's open treats it; no conversations root at all is fine.
  const empty = await conversations(space, "none");
  writeFileSync(empty.path, "");
  await assertSpaceSchemas(empty.root);
  await assertSpaceSchemas(join(fixture.root, "no-such-root"));
});
