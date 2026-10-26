// Recovery menu of `bun run tui` without a pending transaction: what the deployment record allows. Only a record with valid
// base version fields of an unsupported data format offers the upgrade check (the target version checks its application
// binding); a damaged, incomplete or legacy record offers diagnostics only.
import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataMenu } from "../../scripts/ops/tui/recovery.ts";
import { VERSION_FILE } from "../../src/core/data-version.ts";
import { DATA_VERSION } from "../../src/core/version.ts";
import { tempFixture } from "../helpers/temp.ts";

const complete = { dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "0011223344", transaction: "deploy-previous", application: "a".repeat(64) };
const DEPLOY = { "1": "deploy", "2": "doctor" }, UPGRADE = { "1": "update", "2": "doctor" }, DIAGNOSE = { "2": "doctor" };

async function menuFor(record: string | null, store?: string) {
  const f = await tempFixture("tui-recovery-");
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    if (record !== null) await writeFile(join(f.root, "data/state", VERSION_FILE), record);
    if (store) await mkdir(join(f.root, store), { recursive: true });
    return { ...dataMenu(f.root), printed: log.mock.calls.map(args => args.join(" ")).join("\n") };
  } finally { log.mockRestore(); await f.cleanup(); }
}

test("an empty directory offers deployment", async () => {
  expect((await menuFor(null)).commands).toEqual(DEPLOY);
});

for (const [name, record] of [
  ["a newer data format with valid base version fields", { ...complete, dataVersion: DATA_VERSION + 1 }],
  // The data format decides before the application binding, which another format may name differently.
  ["a newer data format without an application binding", { ...complete, dataVersion: DATA_VERSION + 1, application: undefined }],
] as const)
  test(`${name} offers the upgrade check`, async () => {
    const menu = await menuFor(JSON.stringify(record));
    expect(menu.commands).toEqual(UPGRADE);
    expect(menu.prompt).toContain("升级（检查数据格式）");
  });

for (const [name, record, store] of [
  ["current format without an application binding", JSON.stringify({ ...complete, application: undefined })],
  ["current format without a transaction", JSON.stringify({ ...complete, transaction: undefined })],
  ["an invalid program version", JSON.stringify({ ...complete, appVersion: "not-a-version" })],
  ["a legacy marker without a program version", JSON.stringify({ dataVersion: 5, transaction: "old" })],
  ["an unreadable record", "{not json"],
  ["data without a record", null, "data/conversations/direct"],
] as const)
  test(`${name} offers diagnostics only and points to a fresh directory`, async () => {
    const menu = await menuFor(record, store);
    expect(menu.commands).toEqual(DIAGNOSE);
    expect(menu.printed).toContain("请在新目录全新部署");
  });
