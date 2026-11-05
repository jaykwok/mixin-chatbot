import { afterAll, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appLayout, DIRECT_SCOPE, groupScope, spaceTmp, userTmp } from "../../src/core/layout.ts";
import { openState } from "../../src/core/state.ts";
import { ensureStorageIdentities, ensureStorageIdentity } from "../../src/agent/storage-identity.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("storage-identity-");
afterAll(() => fixture.cleanup());
let counter = 0;
function place() {
  const root = join(fixture.root, `root-${++counter}`), db = openState(join(root, "state", "agent.sqlite"));
  return { layout: appLayout(root), db, rows: () => db.query("SELECT path, identity FROM storage_identity ORDER BY identity").all() as { path: string; identity: string }[] };
}

test("a space's members are recorded in one call, the same rows as one member at a time, and a repeat changes nothing", async () => {
  const batch = place(), single = place(), phones = ["13800000001", "13800000002", "abc"];
  await ensureStorageIdentities(batch.layout, DIRECT_SCOPE, phones, batch.db);
  for (const phone of phones) await ensureStorageIdentity(single.layout, DIRECT_SCOPE, phone, single.db);
  try {
    const relative = (rows: { path: string; identity: string }[], root: string) => rows.map(row => ({ ...row, path: row.path.slice(resolve(root).length) }));
    expect(relative(batch.rows(), batch.layout.tmp)).toEqual(relative(single.rows(), single.layout.tmp));
    expect(batch.rows().map(row => row.identity)).toEqual(["direct", ...phones.map(phone => JSON.stringify(["direct", phone]))].sort());
    await ensureStorageIdentities(batch.layout, DIRECT_SCOPE, phones, batch.db);
    expect(batch.rows()).toHaveLength(4);
    // A space without members: nothing to check, no rows.
    await ensureStorageIdentities(batch.layout, groupScope("100"), [], batch.db);
    expect(batch.rows()).toHaveLength(4);
  } finally { batch.db.close(); single.db.close(); }
});

test("any member's directory under another spelling refuses the whole call before a row is written", async () => {
  const { layout, db, rows } = place();
  try {
    const parent = spaceTmp(layout, DIRECT_SCOPE);
    await ensureStorageIdentity(layout, DIRECT_SCOPE, "13800000009", db);
    await mkdir(join(parent, "Abc"), { recursive: true });
    await expect(ensureStorageIdentities(layout, DIRECT_SCOPE, ["13800000001", "abc", "13800000002"], db)).rejects.toThrow("标识大小写与已有目录 Abc 冲突");
    expect(rows()).toHaveLength(2);
    // The directory with the member's own spelling is that member's: accepted.
    await ensureStorageIdentities(layout, DIRECT_SCOPE, ["13800000001", "Abc"], db);
    expect(await readdir(parent)).toEqual(["Abc"]);
    expect(rows()).toHaveLength(4);
  } finally { db.close(); }
});

test("a group under another spelling is refused for every member, in the conversations and in tmp", async () => {
  for (const under of ["conversations", "tmp"] as const) {
    const { layout, db } = place();
    try {
      await mkdir(join(under === "conversations" ? layout.conversations : layout.tmp, "groups", "Grp"), { recursive: true });
      await expect(ensureStorageIdentities(layout, groupScope("grp"), ["13800000001", "13800000002"], db)).rejects.toThrow("标识大小写与已有目录 Grp 冲突");
    } finally { db.close(); }
  }
});

test("a path already recorded for another identity refuses the call and keeps none of its new rows", async () => {
  const { layout, db, rows } = place();
  try {
    await ensureStorageIdentity(layout, DIRECT_SCOPE, "13800000001", db);
    // A row claiming the second member's path for a different identity (an alias that once took it).
    db.query("INSERT INTO storage_identity VALUES (?, ?)").run(resolve(userTmp(layout, DIRECT_SCOPE, "13800000002")), JSON.stringify(["direct", "other"]));
    await expect(ensureStorageIdentities(layout, DIRECT_SCOPE, ["13800000003", "13800000002", "13800000004"], db)).rejects.toThrow("映射到已有数据目录");
    expect(rows().map(row => row.identity)).toEqual([JSON.stringify(["direct", "13800000001"]), JSON.stringify(["direct", "other"]), "direct"]);
  } finally { db.close(); }
});
