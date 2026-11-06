// Identity labels per mode, member codes, the overall name-lookup state, and the audit log's retention.
import { afterAll, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuditLog, AuditUnavailable } from "../../console/server/audit.ts";
import { identityOf, MemberCodes, namesStatus, redactPhones } from "../../console/server/identity.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("console-identity-");
afterAll(() => fixture.cleanup());

const PHONE = "13812341234", DIGEST = `sha256-user-${"a".repeat(64)}`;

test("each mode shows what it allows: masked or complete numbers with names, codes only when anonymous", () => {
  const named = { state: "named" as const, name: "张三", observedAt: 5 };
  expect(identityOf("default", "k", PHONE, named)).toEqual({ key: "k", label: "张三（138****1234）", phone: "138****1234", name: "张三", nameState: "named", nameObservedAt: 5 });
  expect(identityOf("full", "k", PHONE, named).label).toBe("张三（13812341234）");
  expect(identityOf("anonymous", "k", PHONE, named, "A3")).toEqual({ key: "k", label: "成员 A3" });
  expect(identityOf("default", "k", PHONE, { state: "offline" })).toEqual({ key: "k", label: "138****1234", phone: "138****1234", nameState: "offline", nameNote: "机器人未运行，姓名不可用" });
  // A digest has no number to look up, whatever the lookup said.
  expect(identityOf("default", "k", DIGEST, undefined)).toMatchObject({ label: "sha256-user-aaaaaaa…", nameState: "summary", nameNote: "只有摘要形式身份" });
  expect(identityOf("default", "k", PHONE, undefined).nameState).toBe("failed");
});

test("member codes are unique, short while few, and grow without collisions", () => {
  const codes = new MemberCodes();
  const all = Array.from({ length: 3_000 }, () => codes.next());
  expect(new Set(all).size).toBe(3_000);
  expect(all.slice(0, 50).every(code => /^[A-HJ-NP-Z]\d$/.test(code))).toBe(true);
  expect(all.every(code => /^[A-HJ-NP-Z]\d+$/.test(code))).toBe(true);
});

test("the overall name state separates offline, failed and partial lookups; digests do not count", () => {
  const answered = { state: "named" as const, name: "x", observedAt: 9 }, missing = { state: "missing" as const, observedAt: 7 };
  expect(namesStatus([answered, missing, { state: "summary" }])).toEqual({ state: "ok", observedAt: 7 });
  expect(namesStatus([{ state: "offline" }, { state: "summary" }], "停了")).toEqual({ state: "offline", note: "停了" });
  expect(namesStatus([{ state: "failed" }, { state: "offline" }]).state).toBe("failed");
  expect(namesStatus([answered, { state: "failed" }]).state).toBe("partial");
  expect(namesStatus([])).toEqual({ state: "ok" });
});

test("redacts given numbers in structured text", () => {
  expect(redactPhones(`发送给 ${PHONE} 失败`, [PHONE])).toBe("发送给 138****1234 失败");
  expect(redactPhones(`发送给 ${PHONE} 失败`, [PHONE], () => "[成员号码]")).toBe("发送给 [成员号码] 失败");
});

test("the audit appends daily JSON lines and deletes files past the retention", async () => {
  const dir = join(fixture.root, "audit");
  let now = new Date(2026, 9, 27, 12).getTime();
  const audit = new AuditLog(dir, 90, () => now);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "2026-07-01.jsonl"), "{}\n");
  await writeFile(join(dir, "2026-08-01.jsonl"), "{}\n");
  await writeFile(join(dir, "notes.txt"), "kept");
  audit.write({ action: "view-open", session: "s1", scope: "stats", mode: "default" });
  expect((await readdir(dir)).sort()).toEqual(["2026-08-01.jsonl", "2026-10-27.jsonl", "notes.txt"]);
  const line = JSON.parse((await readFile(join(dir, "2026-10-27.jsonl"), "utf8")).trim());
  expect(line).toMatchObject({ action: "view-open", session: "s1", scope: "stats", mode: "default" });
  now += 40 * 86_400_000;
  audit.write({ action: "search", session: "s1", scope: "direct", mode: "anonymous" });
  expect((await readdir(dir)).sort()).toEqual(["2026-10-27.jsonl", "2026-12-06.jsonl", "notes.txt"]);

  const blocked = new AuditLog(join(fixture.root, "audit", "2026-10-27.jsonl", "x"));
  expect(() => blocked.write({ action: "search", session: "s1", scope: "direct", mode: "default" })).toThrow(AuditUnavailable);
});

// Windows: the audit inherits the ACL of .console and the project directory, as data/ does (DACL rules come in W2).
test.skipIf(process.platform === "win32")("on POSIX the audit directory is 700 and its files 600, even under a permissive umask", () => {
  const dir = join(fixture.root, "fresh-audit");
  const previous = process.umask(0o002);
  try {
    new AuditLog(dir).write({ action: "view-open", session: "s1", scope: "stats", mode: "default" });
  } finally { process.umask(previous); }
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(readdirSync(dir).map(name => statSync(join(dir, name)).mode & 0o777)).toEqual([0o600]);
});
