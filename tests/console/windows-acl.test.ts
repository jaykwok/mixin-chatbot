import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertWindowsAcl } from "../../scripts/lib/windows-private-directory.ts";
import { prepareConsoleDir } from "../../scripts/ops/console/state.ts";
import { tempFixture } from "../helpers/temp.ts";

test("Windows ACL 策略接受 Administrators 属主，拒绝其他主体、错误 SID 和继承", () => {
  const root = join(process.cwd(), ".console"), sid = "S-1-5-21-1000";
  const entry = { path: root, owner: sid, protected: true, rules: [{ sid, type: "Allow" }] };
  const snapshot = { currentSid: sid, entries: [entry] };
  expect(() => assertWindowsAcl(snapshot, root, sid)).not.toThrow();
  expect(() => assertWindowsAcl({ ...snapshot, entries: [{ ...entry, owner: "S-1-5-32-544" }] }, root, sid)).not.toThrow();
  expect(() => assertWindowsAcl({ ...snapshot, entries: [{ ...entry, rules: [...entry.rules, { sid: "S-1-5-32-545", type: "Allow" }] }] }, root)).toThrow("其他主体");
  expect(() => assertWindowsAcl(snapshot, root, "S-1-5-21-9999")).toThrow("运维身份");
  expect(() => assertWindowsAcl({ ...snapshot, entries: [{ ...entry, protected: false }] }, root)).toThrow("继承");
  // An inherited .console left by an earlier console: the refusal names both ways out, with this account's SID.
  expect(() => assertWindowsAcl({ ...snapshot, entries: [{ ...entry, protected: false }] }, root))
    .toThrow(`移出项目目录，再启动控制台`);
  expect(() => assertWindowsAcl({ ...snapshot, entries: [{ ...entry, protected: false }] }, root))
    .toThrow(`icacls "${root}" /inheritance:r /grant:r "*${sid}:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"`);
  expect(() => assertWindowsAcl({ ...snapshot, entries: [{ ...entry, owner: "S-1-5-21-9999" }] }, root)).toThrow("属主");
});

test.skipIf(process.platform !== "win32")("真实 NTFS：新建、继承子文件、外加 Users 权限拒绝且不修复、SID 不符拒绝", async () => {
  const fixture = await tempFixture("console-acl-");
  const dir = join(fixture.root, ".console");
  try {
    prepareConsoleDir(dir);
    writeFileSync(join(dir, "inherited.json"), "{}");
    prepareConsoleDir(dir);
    const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...owner, sid: "S-1-5-21-9999" }));
    expect(() => prepareConsoleDir(dir)).toThrow("运维身份");
    writeFileSync(join(dir, "owner.json"), JSON.stringify(owner));
    const added = Bun.spawnSync(["icacls", join(dir, "inherited.json"), "/grant", "*S-1-5-32-545:R"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(added.exitCode).toBe(0);
    expect(() => prepareConsoleDir(dir)).toThrow("其他主体");
    expect(() => prepareConsoleDir(dir)).toThrow("其他主体");
  } finally { await fixture.cleanup(); }
}, 60_000);

test.skipIf(process.platform !== "win32")("真实 NTFS：遍历期间有文件被建删（链接发布的临时文件）不算权限错误", async () => {
  const fixture = await tempFixture("console-acl-churn-");
  const dir = join(fixture.root, ".console");
  prepareConsoleDir(dir);
  for (let t = 0; t < 40; t++) {
    mkdirSync(join(dir, "tasks", `task-${t}`), { recursive: true });
    for (const name of ["claim", "request.json", "events.jsonl"]) writeFileSync(join(dir, "tasks", `task-${t}`, name), "{}");
  }
  // Another process keeps publishing and removing temporary files, as task views and heartbeats do.
  const churn = Bun.spawn([process.execPath, "-e", `
    const { writeFileSync, rmSync } = require("node:fs"), { join } = require("node:path");
    const dir = ${JSON.stringify(dir)}, end = Date.now() + 60000; let n = 0;
    while (Date.now() < end) { const p = join(dir, "tasks", "task-" + (n % 40), "claim." + n++ + ".tmp"); writeFileSync(p, "{}"); rmSync(p, { force: true }); }
  `], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  try {
    await Bun.sleep(300);
    for (let i = 0; i < 6; i++) expect(() => prepareConsoleDir(dir)).not.toThrow();
  } finally { churn.kill(); await churn.exited; await fixture.cleanup(); }
}, 90_000);
