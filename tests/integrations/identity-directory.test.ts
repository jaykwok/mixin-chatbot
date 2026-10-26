// The member directory (plan 5.8) against the local fake platform: paging, revocation rules, ID replacement, conflicts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { DirectoryClient } from "../../src/integrations/open-platform/directory.ts";
import { IdentityDirectory } from "../../src/integrations/open-platform/identity-directory.ts";
import { FakePlatform, json } from "../helpers/fake-platform.ts";
import { applicationBinding } from "../../src/core/data-version.ts";

let fake: FakePlatform, db: Database;
beforeEach(() => { fake = new FakePlatform(); db = new Database(":memory:"); });
afterEach(() => { fake.stop(); db.close(); });

const signal = new AbortController().signal;
const phoneOf = (n: number) => `1380000${String(n).padStart(4, "0")}`;
function directoryClient() {
  return new DirectoryClient(new PlatformClient(fake.config, { endpoints: fake.endpoints, retryDelaysMs: [5, 5] }));
}
function open(binding = applicationBinding(fake.config), now?: () => number) {
  return new IdentityDirectory(db, binding, { perSecond: 1000, concurrency: 8, ...(now ? { now } : {}) });
}
/** `count` members spread over departments 2 and 3 (under the root), each with its own platform ID. */
function members(count: number, from = 1) {
  const all = Array.from({ length: count }, (_, i) => ({ phone: phoneOf(from + i), name: `成员${from + i}` }));
  fake.directory = { children: { "1": ["2", "3"] }, members: { "2": all.filter((_, i) => i % 2 === 0), "3": all.filter((_, i) => i % 2 === 1) },
    ids: Object.fromEntries(all.map(member => [member.phone, `im-${member.phone}`])) };
  return all;
}

test("a complete scan maps every member over paged departments; the lookup is local and synchronous", async () => {
  // 120 members in one department: two member pages; 40 child departments: two department pages.
  const all = Array.from({ length: 120 }, (_, i) => ({ phone: phoneOf(i + 1), name: `成员${i + 1}` }));
  const children = Array.from({ length: 40 }, (_, i) => String(100 + i));
  fake.directory = { children: { "1": children }, members: { "100": all }, ids: Object.fromEntries(all.map(m => [m.phone, `im-${m.phone}`])) };
  const directory = open();
  expect(directory.initializing).toBe(true);
  const summary = await directory.scan("initial", directoryClient(), signal);
  expect(summary).toMatchObject({ complete: true, departments: 41, members: 120, added: 120, revoked: 0, conflicts: 0, failures: 0 });
  expect(directory.initializing).toBe(false);
  expect(directory.lookup(`im-${phoneOf(77)}`)).toEqual({ phone: phoneOf(77), imUserId: `im-${phoneOf(77)}`, name: "成员77" });
  expect(directory.lookup("im-unknown")).toBeUndefined();
  const pages = fake.requestsTo("/open/v2/dept/users/list").filter(request => (request.body as { dept_id: string }).dept_id === "100");
  expect(pages.map(request => (request.body as { page_num: number }).page_num).sort()).toEqual([1, 2]);
  expect(fake.requestsTo("/open/v2/dept/children").filter(request => (request.body as { dept_id: string }).dept_id === "1")).toHaveLength(2);
  // A second scan resolves nobody again except the re-verification share (1/30, at least one).
  const before = fake.requestsTo("/open/applied/v1/user/detailByPhone").length;
  expect(await directory.scan("daily", directoryClient(), signal)).toMatchObject({ added: 0, reverified: 4 });
  expect(fake.requestsTo("/open/applied/v1/user/detailByPhone").length - before).toBe(4);
});

test("a failed page makes the scan incomplete: nothing is revoked and the directory still counts as initializing", async () => {
  const all = members(6);
  const directory = open();
  fake.route("POST /open/v2/dept/users/list", () => json({ code: 500, message: "boom" }, 500));
  const failed = await directory.scan("initial", directoryClient(), signal);
  expect(failed.complete).toBe(false); expect(failed.error).toContain("部门遍历失败");
  expect(directory.initializing).toBe(true);
  fake.route("POST /open/v2/dept/users/list", undefined);
  await directory.scan("initial", directoryClient(), signal);
  expect(directory.mappings).toBe(6);
  // Department 3 fails now: its members are absent from an incomplete scan and stay mapped.
  fake.route("POST /open/v2/dept/users/list", (_request, body) => (body as { dept_id: string }).dept_id === "3"
    ? json({ code: 500, message: "boom" }, 500) : fake.encrypted({ users: fake.directory.members["2"]!.map(m => ({ ...m, union_id: "u", customer_id: "", extension: "" })), total_pages: 1 }));
  const partial = await directory.scan("daily", directoryClient(), signal);
  expect(partial).toMatchObject({ complete: false, revoked: 0 });
  expect(directory.mappings).toBe(6);
  expect(directory.lookup(`im-${all[1]!.phone}`)?.phone).toBe(all[1]!.phone);
  expect(directory.initializing).toBe(false);
});

const MEMBER_PAGE = "POST /open/v2/dept/users/list", CHILD_PAGE = "POST /open/v2/dept/children";
const deptOf = (body: unknown) => (body as { dept_id: string }).dept_id;
const pageOf = (body: unknown) => (body as { page_num: number }).page_num;

/** One mapped member in department 2; then department 2's (or the root's) page answers with `plain` (or fails on page 2). */
async function rescanWith(route: typeof MEMBER_PAGE | typeof CHILD_PAGE, dept: string, answer: (page: number) => Response) {
  const [member] = members(1);
  let clock = 1_000;
  const directory = open(undefined, () => clock++);
  expect(await directory.scan("initial", directoryClient(), signal)).toMatchObject({ complete: true, added: 1 });
  const completeAt = directory.status().lastCompleteAt;
  expect(completeAt).toBeNumber();
  // Other departments answer as the fake platform does (one page at most here).
  const usual = (body: unknown) => route === MEMBER_PAGE
    ? fake.encrypted({ users: (fake.directory.members[deptOf(body)] ?? []).map(m => ({ ...m, union_id: "u", customer_id: "", extension: "" })), total_pages: 1 })
    : fake.encrypted({ departments: (fake.directory.children[deptOf(body)] ?? []).map(id => ({ dept_id: id })), total_pages: 1 });
  fake.route(route, (_request, body) => deptOf(body) === dept ? answer(pageOf(body)) : usual(body));
  const summary = await directory.scan("daily", directoryClient(), signal);
  return { summary, directory, member: member!, completeAt };
}

const memberRow = { phone: phoneOf(1), name: "成员1", union_id: "u", customer_id: "", extension: "" };
test.each([
  ["no users list", { total_pages: 1 }],
  ["a null users list without total 0", { users: null, total_pages: 1 }],
  ["a users object", { users: {}, total_pages: 1 }],
  ["a users string, even with total 0", { users: "", total: 0, total_pages: 0 }],
  ["no page count", { users: [] }],
  ["a negative page count", { users: [], total_pages: -1 }],
  ["a fractional page count", { users: [], total_pages: 1.5 }],
  ["a non-numeric page count", { users: [], total_pages: "1页" }],
  ["an absurd page count", { users: [], total_pages: 10_001 }],
  ["page count 0 beside members", { users: [memberRow], total_pages: 0 }],
  ["a member that is no object", { users: [null], total_pages: 1 }],
] as const)("a member page with %s is refused: the scan is incomplete, revokes nobody and is not the last complete one", async (_, plain) => {
  const { summary, directory, member, completeAt } = await rescanWith(MEMBER_PAGE, "2", () => fake.encrypted(plain));
  expect(summary).toMatchObject({ complete: false, revoked: 0, pendingRevocations: 0 });
  expect(summary.error).toContain("部门遍历失败");
  expect(directory.lookup(`im-${member.phone}`)?.phone).toBe(member.phone);
  expect(directory.status().lastCompleteAt).toBe(completeAt!);
});

test.each([["no phone field", {}], ["a null phone", { phone: null }], ["an empty phone", { phone: "" }]] as const)(
  "a member listed with %s keeps the round incomplete: the others are still mapped, nobody is revoked", async (_, phone) => {
    const newcomer = { ...memberRow, phone: phoneOf(2), name: "成员2" };
    const { summary, directory, member, completeAt } = await rescanWith(MEMBER_PAGE, "2", () => {
      fake.directory.ids[newcomer.phone] = `im-${newcomer.phone}`;
      return fake.encrypted({ users: [{ name: "成员1", ...phone }, newcomer], total_pages: 1 });
    });
    expect(summary).toMatchObject({ complete: false, added: 1, revoked: 0, pendingRevocations: 0 });
    expect(summary.error).toContain("1 名成员未返回手机号");
    expect(directory.lookup(`im-${member.phone}`)?.phone).toBe(member.phone);
    expect(directory.lookup(`im-${newcomer.phone}`)?.name).toBe("成员2");
    expect(directory.status().lastCompleteAt).toBe(completeAt!);
  });

test("a later member page that fails, or a root department page without its list, also keeps everyone", async () => {
  let run = await rescanWith(MEMBER_PAGE, "2", page => page === 1 ? fake.encrypted({ users: [], total_pages: 2 }) : json({ code: 500, message: "boom" }, 500));
  expect(run.summary).toMatchObject({ complete: false, revoked: 0 });
  expect(run.directory.lookup(`im-${run.member.phone}`)).toBeDefined();
  expect(run.directory.status().lastCompleteAt).toBe(run.completeAt!);
  fake.route(MEMBER_PAGE, undefined);
  db.close(); db = new Database(":memory:");
  run = await rescanWith(CHILD_PAGE, "1", () => fake.encrypted({ total_pages: 1 }));
  expect(run.summary).toMatchObject({ complete: false, revoked: 0 });
  expect(run.directory.lookup(`im-${run.member.phone}`)).toBeDefined();
  expect(run.directory.status().lastCompleteAt).toBe(run.completeAt!);
});

test.each([
  ["an empty users list", { users: [], total_pages: 0 }],
  ["no users list with total 0", { total: 0, total_pages: 0 }],
  ["a null users list with total and pages as digit strings", { users: null, total: "0", total_pages: "0" }],
] as const)("a department really emptied (%s) is a complete scan and its former member is revoked", async (_, plain) => {
  const { summary, directory, member, completeAt } = await rescanWith(MEMBER_PAGE, "2", () => fake.encrypted(plain));
  expect(summary).toMatchObject({ complete: true, revoked: 1, failures: 0 });
  expect(directory.lookup(`im-${member.phone}`)).toBeUndefined();
  expect(directory.status().lastCompleteAt).toBeGreaterThan(completeAt!);
});

test("a page count sent as a digit string reads as that number", async () => {
  const { summary, directory, member } = await rescanWith(MEMBER_PAGE, "2", () => fake.encrypted({ users: [memberRow], total_pages: "1" }));
  expect(summary).toMatchObject({ complete: true, revoked: 0 });
  expect(directory.lookup(`im-${member.phone}`)?.phone).toBe(member.phone);
});

test("a complete scan revokes absent members; over the threshold the round waits for an administrator's confirmation", async () => {
  const all = members(30);
  const directory = open();
  await directory.scan("initial", directoryClient(), signal);
  // Two leave: under the threshold (10% and more than 20), revoked at once.
  members(28);
  expect(await directory.scan("daily", directoryClient(), signal)).toMatchObject({ revoked: 2, pendingRevocations: 0 });
  expect(directory.lookup(`im-${all[29]!.phone}`)).toBeUndefined();
  // 21 more leave: held as candidates of this round.
  members(7);
  const held = await directory.scan("daily", directoryClient(), signal);
  expect(held).toMatchObject({ revoked: 0, pendingRevocations: 21 });
  expect(directory.mappings).toBe(28);
  expect(directory.status().pending).toEqual({ scanId: held.id, count: 21 });
  // Confirming a round whose set does not cover the absent members does not revoke: one more left since.
  members(6);
  expect(await directory.scan("confirm", directoryClient(), signal, held.id)).toMatchObject({ revoked: 0, pendingRevocations: 22 });
  const latest = directory.status().pending!;
  expect(await directory.scan("confirm", directoryClient(), signal, latest.scanId)).toMatchObject({ revoked: 22, pendingRevocations: 0 });
  expect(directory.mappings).toBe(6);
  expect(directory.status().pending).toBeUndefined();
});

test("confirming revocations accepts only the pending round and never while a scan runs", async () => {
  members(30);
  const directory = open();
  await directory.scan("initial", directoryClient(), signal);
  members(5);
  const held = await directory.scan("daily", directoryClient(), signal);
  expect(directory.status().pending).toEqual({ scanId: held.id, count: 25 });
  expect(directory.confirmRevocations(held.id + 1, directoryClient(), signal)).toBe("stale");
  // A running scan (here a slow, then failing department page) makes the confirmation wait for the next try.
  const gate = Promise.withResolvers<void>();
  fake.route("POST /open/v2/dept/children", async () => { await gate.promise; return json({ code: 500, message: "boom" }, 500); });
  const running = directory.scan("daily", directoryClient(), signal);
  expect(directory.confirmRevocations(held.id, directoryClient(), signal)).toBe("busy");
  gate.resolve(); await running;
  fake.route("POST /open/v2/dept/children", undefined);
  // The incomplete scan in between kept the round pending; confirming starts a complete rescan that revokes it.
  expect(directory.status().pending?.scanId).toBe(held.id);
  expect(directory.confirmRevocations(held.id, directoryClient(), signal)).toBe("started");
  for (let i = 0; i < 200 && directory.status().pending; i++) await Bun.sleep(10);
  expect(directory.status().pending).toBeUndefined();
  expect(directory.mappings).toBe(5);
});

test("a changed platform ID replaces the mapping atomically; the old ID no longer resolves", async () => {
  const [a] = members(1);
  const directory = open();
  await directory.scan("initial", directoryClient(), signal);
  fake.directory.ids[a!.phone] = "im-new";
  // With one mapping the re-verification share is that mapping.
  expect(await directory.scan("daily", directoryClient(), signal)).toMatchObject({ reverified: 1, replaced: 1 });
  expect(directory.lookup(`im-${a!.phone}`)).toBeUndefined();
  expect(directory.lookup("im-new")?.phone).toBe(a!.phone);
});

test("an ID moves to a new phone only when the complete directory shows its old owner gone; otherwise it is a conflict", async () => {
  const [a, b] = members(2);
  const directory = open();
  await directory.scan("initial", directoryClient(), signal);
  // A new member reports A's ID while A is still present: not merged, nothing revoked this round.
  fake.directory.members["2"]!.push({ phone: phoneOf(9), name: "新成员" });
  fake.directory.ids[phoneOf(9)] = `im-${a!.phone}`;
  const conflicted = await directory.scan("daily", directoryClient(), signal);
  expect(conflicted).toMatchObject({ conflicts: 1, added: 0 });
  expect(directory.lookup(`im-${a!.phone}`)?.phone).toBe(a!.phone);
  // A leaves: the ID moves to the new phone.
  fake.directory.members["2"] = fake.directory.members["2"]!.filter(m => m.phone !== a!.phone);
  expect(await directory.scan("daily", directoryClient(), signal)).toMatchObject({ conflicts: 0, replaced: 1 });
  expect(directory.lookup(`im-${a!.phone}`)?.phone).toBe(phoneOf(9));
  expect(directory.lookup(`im-${b!.phone}`)?.phone).toBe(b!.phone);
});

test("one phone with two names in the directory is a conflict: not mapped, and the round revokes nobody", async () => {
  const [a, b] = members(2);
  const directory = open();
  await directory.scan("initial", directoryClient(), signal);
  fake.directory.members["3"] = [{ phone: phoneOf(5), name: "甲" }];
  fake.directory.members["2"] = [{ phone: phoneOf(5), name: "乙" }];
  fake.directory.ids[phoneOf(5)] = "im-5";
  const summary = await directory.scan("daily", directoryClient(), signal);
  expect(summary).toMatchObject({ conflicts: 1, revoked: 0 });
  expect(directory.lookup("im-5")).toBeUndefined();
  expect([directory.lookup(`im-${a!.phone}`)?.phone, directory.lookup(`im-${b!.phone}`)?.phone]).toEqual([a!.phone, b!.phone]);
  // A conflicted round is not a complete one.
  expect(db.query("SELECT complete FROM directory_scans WHERE id = ?").get(summary.id)).toEqual({ complete: 0 });
});

test("a member the platform does not know is a resolution failure, retried by the next scan", async () => {
  const [a] = members(1);
  delete fake.directory.ids[a!.phone];
  const directory = open();
  expect(await directory.scan("initial", directoryClient(), signal)).toMatchObject({ complete: true, failures: 1, added: 0 });
  expect(db.query("SELECT attempts FROM directory_failures").all()).toEqual([{ attempts: 1 }]);
  fake.directory.ids[a!.phone] = "im-late";
  expect(await directory.scan("unknown", directoryClient(), signal)).toMatchObject({ failures: 0, added: 1 });
  expect(directory.lookup("im-late")?.phone).toBe(a!.phone);
  expect(db.query("SELECT count(*) AS n FROM directory_failures").get()).toEqual({ n: 0 });
});

test("another app or environment is refused and the table is kept; unknown IDs trigger at most one scan per cooldown", async () => {
  members(2);
  let clock = 1_000_000;
  const directory = open(undefined, () => clock);
  await directory.scan("initial", directoryClient(), signal);
  expect(directory.mappings).toBe(2);
  expect(directory.requestScan(directoryClient(), signal)).toBe(true);
  // Running, then cooling down.
  expect(directory.requestScan(directoryClient(), signal)).toBe(false);
  for (const end = Date.now() + 3000; directory.status().running && Date.now() < end;) await Bun.sleep(5);
  expect(directory.requestScan(directoryClient(), signal)).toBe(false);
  clock += 30 * 60_000;
  expect(directory.requestScan(directoryClient(), signal)).toBe(true);
  for (const end = Date.now() + 3000; directory.status().running && Date.now() < end;) await Bun.sleep(5);
  for (const config of [{ ...fake.config, environment: "staging" as const }, { ...fake.config, appId: "another-app" }])
    expect(() => open(applicationBinding(config))).toThrow("通讯录属于另一个应用或平台环境");
  expect(open().mappings).toBe(2);
});

/** Department 3's member list waits for the returned gate; every other department answers at once. */
function holdDepartment3(): PromiseWithResolvers<void> {
  const gate = Promise.withResolvers<void>();
  fake.route("POST /open/v2/dept/users/list", async (_request, body) => {
    const dept = (body as { dept_id: string }).dept_id;
    if (dept === "3") await gate.promise;
    return fake.encrypted({ users: (fake.directory.members[dept] ?? []).map(m => ({ ...m, union_id: "u", customer_id: "", extension: "" })), total_pages: 1 });
  });
  return gate;
}

test("new members resolve while the walk is still running; a phone later seen with another name is withdrawn", async () => {
  const [a] = members(2);
  // Department 2 also lists a newcomer whom department 3 (still being walked) lists under another name.
  fake.directory.members["2"]!.push({ phone: phoneOf(7), name: "甲" });
  fake.directory.members["3"]!.push({ phone: phoneOf(7), name: "乙" });
  fake.directory.ids[phoneOf(7)] = "im-7";
  const gate = holdDepartment3();
  const directory = open();
  const scan = directory.scan("initial", directoryClient(), signal);
  for (const end = Date.now() + 3000; !directory.lookup("im-7") && Date.now() < end;) await Bun.sleep(5);
  // Usable before the walk has finished.
  expect(directory.lookup(`im-${a!.phone}`)?.phone).toBe(a!.phone);
  expect(directory.lookup("im-7")?.name).toBe("甲");
  expect(directory.status().running?.phase).toBe("遍历部门");
  gate.resolve();
  expect(await scan).toMatchObject({ complete: true, added: 2, conflicts: 1, revoked: 0 });
  expect(directory.lookup("im-7")).toBeUndefined();
  expect(directory.mappings).toBe(2);
});

test("a scope walks only the chosen departments and their subdepartments", async () => {
  const all = Array.from({ length: 6 }, (_, i) => ({ phone: phoneOf(i + 1), name: `成员${i + 1}` }));
  fake.directory = { children: { "1": ["2", "3"], "2": ["4"] }, members: { "2": all.slice(0, 2), "3": all.slice(2, 4), "4": all.slice(4) },
    ids: Object.fromEntries(all.map(m => [m.phone, `im-${m.phone}`])) };
  const directory = new IdentityDirectory(db, applicationBinding(fake.config), { perSecond: 1000, concurrency: 8, scope: ["2"] });
  expect(await directory.scan("initial", directoryClient(), signal)).toMatchObject({ complete: true, departments: 2, members: 4, added: 4 });
  expect([1, 2, 5, 6].map(n => directory.lookup(`im-${phoneOf(n)}`)?.phone)).toEqual([1, 2, 5, 6].map(phoneOf));
  expect(directory.lookup(`im-${phoneOf(3)}`)).toBeUndefined();
  expect(fake.requestsTo("/open/v2/dept/children").map(r => (r.body as { dept_id: string }).dept_id)).not.toContain("1");
  expect(directory.status().scope).toEqual(["2"]);
  expect(directory.scoped).toBe(true);
});

test("changing the scope aborts the running scan without revoking anyone and rescans with the new departments at once", async () => {
  const all = members(6);
  const directory = open();
  await directory.scan("initial", directoryClient(), signal);
  const gate = holdDepartment3();
  const running = directory.scan("daily", directoryClient(), signal);
  for (const end = Date.now() + 3000; (directory.status().running?.departments ?? 0) < 2 && Date.now() < end;) await Bun.sleep(5);
  await directory.changeScope(["3"], directoryClient(), signal);
  expect(await running).toMatchObject({ complete: false, revoked: 0, error: "通讯录范围已变更，已重新开始同步" });
  expect(directory.status().running?.trigger).toBe("scope");
  gate.resolve();
  for (const end = Date.now() + 3000; directory.status().running && Date.now() < end;) await Bun.sleep(5);
  // Department 2's three members are outside the new scope: absent from a complete scan, under the threshold, revoked.
  expect(directory.status().lastScan).toMatchObject({ trigger: "scope", complete: true, departments: 1, members: 3, revoked: 3 });
  expect(all.map(m => directory.lookup(`im-${m.phone}`) !== undefined)).toEqual([false, true, false, true, false, true]);
  // Back to the whole directory: the next scan maps them again.
  await directory.changeScope(undefined, directoryClient(), signal);
  for (const end = Date.now() + 3000; directory.status().running && Date.now() < end;) await Bun.sleep(5);
  expect(directory.mappings).toBe(6);
  expect(directory.status().scope).toBeUndefined();
});

test("departments list with names and counts over every page; the detail of an unknown department is refused", async () => {
  const children = Array.from({ length: 40 }, (_, i) => String(100 + i));
  fake.directory = { children: { "1": children }, members: {}, ids: {},
    info: { "100": { name: "总部", count: 12, fullName: "集团/总部" }, "101": { name: "保密部" } } };
  const listed = await directoryClient().childDepartments("1");
  expect(listed).toHaveLength(40);
  expect(listed.slice(0, 3)).toEqual([{ id: "100", name: "总部", count: 12 }, { id: "101", name: "保密部" }, { id: "102", name: "" }]);
  expect(await directoryClient().department("100")).toEqual({ id: "100", name: "总部", count: 12, fullName: "集团/总部" });
  await expect(directoryClient().department("999")).rejects.toThrow("code=404002");
});
