import { expect, test } from "bun:test";
import { join } from "node:path";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { ensureStorageIdentity } from "../../src/agent/storage-identity.ts";
import { openState } from "../../src/core/state.ts";
import { tempFixture } from "../helpers/temp.ts";
import { mkdir } from "node:fs/promises";

test("rejects old delivery schemas without changing their rows or columns", async () => {
  const fixture = await tempFixture("delivery-migration-"), path = join(fixture.root, "state.sqlite");
  const db = openState(path);
  try {
    db.exec("CREATE TABLE deliveries (id TEXT PRIMARY KEY, session TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)");
    db.query("INSERT INTO deliveries VALUES (?, ?, ?, ?)").run("old", "session", "legacy reply", "2026-09-13");
    expect(() => new DeliveryStore(db)).toThrow("需要迁移");
    expect(db.query("SELECT text FROM deliveries").get()).toEqual({ text: "legacy reply" });
    expect((db.query("PRAGMA table_info(deliveries)").all() as { name: string }[]).map(column => column.name)).toEqual(["id", "session", "text", "at"]);
  } finally { db.close(); await fixture.cleanup(); }
});

test("preserves structured references and migration holds across reopen", async () => {
  const fixture = await tempFixture("delivery-schema-"), path = join(fixture.root, "state.sqlite");
  let db = openState(path);
  try {
    let store = new DeliveryStore(db);
    const attachments = [{ original: "generated note", reference: { backend: "hash", url: "https://files.invalid/a/b", name: "b", size: 5 } }];
    const id = store.save("session", "generated note", undefined, attachments);
    db.query("UPDATE deliveries SET blocked_reason = ? WHERE id = ?").run("旧附件无法确认归属", id);
    db.close(); db = openState(path); store = new DeliveryStore(db);
    expect(store.pending("session")[0]!.attachments).toEqual(attachments);
    expect(store.pending("session")[0]!.blockedReason).toBe("旧附件无法确认归属");
    expect(store.pending("session")).toHaveLength(1);
  } finally { db.close(); await fixture.cleanup(); }
});

test("pending links and final text survive restart until acknowledgement", async () => {
  const fixture = await tempFixture("deliveries-");
  const path = join(fixture.root, "state.sqlite");
  let db = openState(path);
  try {
    let store = new DeliveryStore(db);
    const id = store.save("session-a", "https://files/a_b");
    store.save("session-a", "final\nhttps://files/a_b", id);
    db.close(); db = openState(path); store = new DeliveryStore(db);
    expect(store.pending("session-a").map(row => row.text)).toEqual(["final\nhttps://files/a_b"]);
    expect(store.pending("session-b")).toEqual([]);
    expect(() => store.save("session-b", "wrong owner", id)).toThrow();
    db.exec("CREATE TRIGGER reject_ack BEFORE DELETE ON deliveries BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    expect(() => store.acknowledge([id])).toThrow("disk failure");
    expect(store.pending("session-a")).toHaveLength(1);
    db.exec("DROP TRIGGER reject_ack"); store.acknowledge([id]);
    expect(store.pending("session-a")).toEqual([]);
  } finally { db.close(); await fixture.cleanup(); }
});

test("storage identities reject case aliases before or after restart", async () => {
  const fixture = await tempFixture("storage-identity-");
  const path = join(fixture.root, "state.sqlite");
  let db = openState(path);
  try {
    await ensureStorageIdentity(fixture.root, "Group", "User", db);
    await expect(ensureStorageIdentity(fixture.root, "group", "User", db)).rejects.toThrow("映射");
    await expect(ensureStorageIdentity(fixture.root, "Group", "user", db)).rejects.toThrow("映射");
    db.close(); db = openState(path);
    await expect(ensureStorageIdentity(fixture.root, "group", "User", db)).rejects.toThrow();
    await mkdir(join(fixture.root, "LegacyGroup", "users", "LegacyUser"), { recursive: true });
    await expect(ensureStorageIdentity(fixture.root, "legacygroup", "LegacyUser", db)).rejects.toThrow("已有目录");
    await ensureStorageIdentity(fixture.root, "LegacyGroup", "LegacyUser", db);
  } finally { db.close(); await fixture.cleanup(); }
});
