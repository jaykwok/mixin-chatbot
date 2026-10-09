import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openRelayIndex } from "../../src/integrations/relay-index.ts";
import { openState } from "../../src/core/state.ts";
import { tempFixture } from "../helpers/temp.ts";

test("the SQLite ledger retains more than 20,000 live objects and commits deletions atomically", async () => {
  const fixture = await tempFixture("relay-ledger-");
  const path = join(fixture.root, "relay.sqlite");
  const index = await openRelayIndex(path);
  const connection = openState(path);
  try {
    const insert = connection.query("INSERT INTO objects VALUES (?, ?, ?, ?, ?, ?)");
    connection.transaction(() => {
      for (let i = 0; i < 20003; i++) insert.run(String(i), "https://files/" + i + "/a.pdf", "a.pdf", 1, "2026-09-01T00:00:00Z", "uploaded");
    })();
    await index.forget("1");
    expect(index.entries().length).toBe(20002);
    expect(index.get("0")).toBeDefined(); expect(index.get("1")).toBeUndefined();
    expect(index.findUploaded("https://files/20002/a.pdf")?.key).toBe("20002");
    connection.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON objects BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    await expect(index.forget("0")).rejects.toThrow("disk failure");
    const other = await openRelayIndex(path);
    try {
      expect(other.get("0")).toBeDefined(); expect(other.entries().length).toBe(20002);
      connection.exec("DROP TRIGGER reject_delete"); await index.forget("0");
      expect(other.get("0")).toBeUndefined();
    } finally { other.close(); }
  } finally { index.close(); connection.close(); await fixture.cleanup(); }
});

test("URL lookup preserves at/key order, planned uploads and updates in an existing ledger", async () => {
  const fixture = await tempFixture("relay-url-");
  const path = join(fixture.root, "relay.sqlite"), url = "https://files/shared/a.pdf";
  // A database created by the earlier schema, without the URL index.
  const previous = openState(path);
  previous.exec("CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL)");
  const insert = previous.query("INSERT INTO objects VALUES (?, ?, 'a.pdf', 1, ?, ?)");
  insert.run("b", url, "2026-09-02T00:00:00Z", "uploaded");
  insert.run("a", url, "2026-09-02T00:00:00Z", "uploaded");
  insert.run("c", url, "2026-09-03T00:00:00Z", "uploaded");
  insert.run("planned", url, "2026-09-01T00:00:00Z", "planned");
  insert.run("other", "https://files/other/a.pdf", "2026-09-01T00:00:00Z", "uploaded");
  previous.close();
  const index = await openRelayIndex(path);
  try {
    expect(index.findUploaded(url)?.key).toBe("a");
    expect(index.findUploaded("https://files/missing/a.pdf")).toBeUndefined();
    await index.remember({ ...index.get("a")!, at: "2026-09-04T00:00:00Z" });
    expect(index.findUploaded(url)?.key).toBe("b");
    await index.forget("b");
    expect(index.findUploaded(url)?.key).toBe("c");
    await index.remember({ ...index.get("planned")!, state: "uploaded" });
    expect(index.findUploaded(url)?.key).toBe("planned");
  } finally { index.close(); await fixture.cleanup(); }
});

test("a corrupt SQLite ledger fails closed without replacing its contents", async () => {
  const fixture = await tempFixture("relay-corrupt-");
  const path = join(fixture.root, "relay.sqlite");
  const contents = Buffer.from("corrupt database: preserve for recovery");
  await writeFile(path, contents);
  try {
    await expect(openRelayIndex(path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(contents);
  } finally { await fixture.cleanup(); }
});
