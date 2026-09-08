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
    expect(index.size()).toBe(20002);
    expect(index.get("0")).toBeDefined(); expect(index.get("1")).toBeUndefined();
    connection.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON objects BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    await expect(index.forget("0")).rejects.toThrow("disk failure");
    const other = await openRelayIndex(path);
    try {
      expect(other.get("0")).toBeDefined(); expect(other.size()).toBe(20002);
      connection.exec("DROP TRIGGER reject_delete"); await index.forget("0");
      expect(other.get("0")).toBeUndefined();
    } finally { other.close(); }
  } finally { index.close(); connection.close(); await fixture.cleanup(); }
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
