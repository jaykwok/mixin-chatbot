// The member directory (plan 5.8) against the local fake platform: paging, revocation and recheck rules, applying a saved
// scope in one switch, retries, ID replacement, conflicts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PlatformClient, PlatformRequestError } from "../../src/integrations/open-platform/client.ts";
import { DirectoryClient } from "../../src/integrations/open-platform/directory.ts";
import { type DirectoryScope, WHOLE_DIRECTORY } from "../../src/integrations/open-platform/directory-scope.ts";
import { IdentityDirectory, type DirectoryOptions, type ScanSummary } from "../../src/integrations/open-platform/identity-directory.ts";
import { FakePlatform, json } from "../helpers/fake-platform.ts";
import { applicationBinding } from "../../src/core/data-version.ts";

let fake: FakePlatform, db: Database, service: AbortController;
beforeEach(() => { fake = new FakePlatform(); db = new Database(":memory:"); service = new AbortController(); });
// Stopping the "service" keeps scheduled retries and rechecks from starting after the test.
afterEach(() => { service.abort(); fake.stop(); db.close(); });

const signal = new AbortController().signal;
const phoneOf = (n: number) => `1380000${String(n).padStart(4, "0")}`;
const depts = (...departments: string[]): DirectoryScope => ({ kind: "departments", departments });
const keep = async () => {};
function directoryClient() {
  return new DirectoryClient(new PlatformClient(fake.config, { endpoints: fake.endpoints, retryDelaysMs: [5, 5] }));
}
/** The whole directory unless `options` names a scope (`scope: undefined` is none saved). */
function open(options: Partial<DirectoryOptions> = {}, binding = applicationBinding(fake.config)) {
  return new IdentityDirectory(db, binding, { perSecond: 1000, concurrency: 8, scope: WHOLE_DIRECTORY, ...options });
}
/** Waits until no scan runs and `until` holds (five seconds at most). */
async function idle(directory: IdentityDirectory, until = () => true) {
  for (const end = Date.now() + 5000; (directory.status().running || !until()) && Date.now() < end;) await Bun.sleep(5);
}
const scans = () => (db.query("SELECT summary FROM directory_scans ORDER BY id").all() as { summary: string }[]).map(row => JSON.parse(row.summary) as ScanSummary);
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
  const directory = open({ now: () => clock++ });
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
  expect(summary).toMatchObject({ complete: false, revoked: 0, suspected: 0 });
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
    expect(summary).toMatchObject({ complete: false, added: 1, revoked: 0, suspected: 0 });
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

test("a routine sync revokes absent members; a large absence is rechecked after the delay and only those still absent are revoked", async () => {
  const all = members(30);
  let clock = 1_000_000;
  const directory = open({ now: () => clock, recheckDelayMs: 600_000 });
  await directory.scan("initial", directoryClient(), service.signal);
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: WHOLE_DIRECTORY, since: clock } });
  // Two leave: under the limit (10% and more than 20), revoked at once.
  members(28);
  expect(await directory.scan("daily", directoryClient(), service.signal)).toMatchObject({ revoked: 2, suspected: 0 });
  expect(directory.lookup(`im-${all[29]!.phone}`)).toBeUndefined();
  // 21 more leave: nobody is revoked yet; a full recheck is due ten (here virtual) minutes later.
  members(7);
  expect(await directory.scan("daily", directoryClient(), service.signal)).toMatchObject({ mode: "routine", complete: true, revoked: 0, suspected: 21 });
  expect(directory.mappings).toBe(28);
  expect(directory.status()).toMatchObject({ state: "effective", recheck: { count: 21, at: clock + 600_000 } });
  expect(directory.status().failure).toBeUndefined();
  // A sync before the recheck time confirms nothing; a member who is back leaves the recheck list.
  clock += 300_000;
  members(8);
  expect(await directory.scan("unknown", directoryClient(), service.signal)).toMatchObject({ revoked: 0, suspected: 20 });
  expect(directory.status().recheck).toEqual({ count: 20, at: clock - 300_000 + 600_000 });
  // The recheck: the twenty still absent go, and so do two fresh absences, under the limit on their own.
  clock += 300_000;
  members(6);
  expect(await directory.scan("recheck", directoryClient(), service.signal)).toMatchObject({ revoked: 22, suspected: 0 });
  expect(directory.mappings).toBe(6);
  expect(directory.status().recheck).toBeUndefined();
});

test("a sync that did not finish keeps every mapping, is shown as the reason and is retried automatically with backoff", async () => {
  members(6);
  const directory = open({ retryDelaysMs: [20, 40] });
  await directory.scan("initial", directoryClient(), service.signal);
  fake.route(MEMBER_PAGE, () => json({ code: 500, message: "boom" }, 500));
  const before = Date.now();
  expect(await directory.scan("daily", directoryClient(), service.signal)).toMatchObject({ complete: false, revoked: 0 });
  const failed = directory.status();
  expect(failed).toMatchObject({ state: "effective", mappings: 6 });
  expect(failed.failure).toContain("部门遍历失败");
  expect(failed.retryAt).toBeGreaterThanOrEqual(before + 20);
  // The first retry fails as well; a later one, after the longer delay, succeeds.
  await idle(directory, () => scans().length >= 3);
  fake.route(MEMBER_PAGE, undefined);
  await idle(directory, () => scans().at(-1)!.complete);
  expect(scans().map(scan => scan.trigger)).toEqual(["initial", "daily", ...Array<"retry">(scans().length - 2).fill("retry")]);
  expect(directory.status().failure).toBeUndefined();
  expect(directory.status().retryAt).toBeUndefined();
});

test("saving a scope applies it in one switch however many members it removes; until then the previous list stays in effect", async () => {
  const all = members(60);
  const directory = open();
  await directory.scan("initial", directoryClient(), service.signal);
  const gate = holdMembers("2");
  const saved: DirectoryScope[] = [];
  const persist = async (scope: DirectoryScope) => { saved.push(scope); };
  expect(await directory.changeScope(depts("2"), directoryClient(), service.signal, persist)).toBe("started");
  expect(saved).toEqual([depts("2")]);
  // Applying: the previous list, department 3 included, still answers and is not touched.
  expect(directory.status()).toMatchObject({ scope: depts("2"), state: "applying", effective: { scope: WHOLE_DIRECTORY }, running: { trigger: "scope", mode: "apply" } });
  expect([directory.applying, directory.scoped, directory.settled]).toEqual([true, false, false]);
  expect(directory.lookup(`im-${all[1]!.phone}`)?.phone).toBe(all[1]!.phone);
  gate.resolve();
  await idle(directory);
  // Half the list goes at once: a saved scope has no revocation limit.
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: depts("2") }, lastScan: { mode: "apply", complete: true, revoked: 30, suspected: 0 } });
  expect(directory.status().recheck).toBeUndefined();
  expect(all.map(member => directory.lookup(`im-${member.phone}`) !== undefined)).toEqual(all.map((_, i) => i % 2 === 0));
  expect([directory.applying, directory.scoped, directory.settled]).toEqual([false, true, true]);
  // The same scope again: nothing to do.
  expect(await directory.changeScope(depts("2"), directoryClient(), service.signal, persist)).toBe("unchanged");
  expect(saved).toHaveLength(1);
  expect(directory.status().running).toBeUndefined();
});

test("an apply that cannot finish changes nothing: the previous scope stays in effect, the failure is shown, and saving again retries", async () => {
  const all = members(6);
  const directory = open({ retryDelaysMs: [60_000] });
  await directory.scan("initial", directoryClient(), service.signal);
  fake.route(MEMBER_PAGE, () => json({ code: 500, message: "boom" }, 500));
  const before = Date.now();
  expect(await directory.changeScope(depts("2"), directoryClient(), service.signal, keep)).toBe("started");
  await idle(directory);
  const failed = directory.status();
  expect(failed).toMatchObject({ scope: depts("2"), state: "failed", effective: { scope: WHOLE_DIRECTORY }, lastScan: { mode: "apply", complete: false, revoked: 0 } });
  expect(failed.failure).toContain("新范围暂不应用，之前的名单继续生效");
  expect(failed.retryAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(all.every(member => directory.lookup(`im-${member.phone}`))).toBe(true);
  // Saving the same scope again retries at once, without writing the file again.
  fake.route(MEMBER_PAGE, undefined);
  expect(await directory.changeScope(depts("2"), directoryClient(), service.signal, async () => { throw new Error("saved again"); })).toBe("started");
  await idle(directory);
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: depts("2") } });
  expect(directory.status().retryAt).toBeUndefined();
  expect(directory.mappings).toBe(3);
});

test("a new member whose lookup failed blocks the switch; a member the platform refuses is only left out", async () => {
  const all = members(6);
  const directory = open({ scope: depts("2"), retryDelaysMs: [60_000] });
  await directory.scan("initial", directoryClient(), service.signal);
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: depts("2") }, mappings: 3 });
  const [flaky, refused] = [all[1]!, all[3]!];
  fake.route(DETAIL, (_request, body) => {
    const phone = (body as { loginId: string }).loginId;
    return phone === flaky.phone ? json({ code: 500, message: "boom" }, 500) : detail(phone);
  });
  await directory.changeScope(depts("3"), directoryClient(), service.signal, keep);
  await idle(directory);
  expect(directory.status()).toMatchObject({ state: "failed", effective: { scope: depts("2") }, mappings: 3 });
  expect(directory.status().failure).toBe("1 名新成员的身份没有查成（网络或平台故障）；新范围暂不应用，之前的名单继续生效");
  // The platform answers for the flaky member now and refuses the other one: the switch goes ahead without the refused member.
  delete fake.directory.ids[refused.phone];
  fake.route(DETAIL, undefined);
  await directory.changeScope(depts("3"), directoryClient(), service.signal, keep);
  await idle(directory);
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: depts("3") }, lastScan: { failures: 1, added: 2, revoked: 3 } });
  expect([1, 3, 5].map(i => directory.lookup(`im-${all[i]!.phone}`)?.phone)).toEqual([all[1]!.phone, undefined, all[5]!.phone]);
  expect(db.query("SELECT phone FROM directory_failures").all()).toEqual([{ phone: refused.phone }]);
});

test("consecutive changes are handled in order and only the last one takes effect; saving the effective scope again cancels", async () => {
  const all = members(6);
  const directory = open();
  await directory.scan("initial", directoryClient(), service.signal);
  const gate = holdMembers("2", "3");
  const saved: DirectoryScope[] = [];
  const change = (scope: DirectoryScope) => directory.changeScope(scope, directoryClient(), service.signal, async saving => { saved.push(saving); });
  expect(await Promise.all([change(depts("2")), change(depts("3")), change(WHOLE_DIRECTORY), change(depts("3"))]))
    .toEqual(["started", "started", "cancelled", "started"]);
  expect(saved).toEqual([depts("2"), depts("3"), WHOLE_DIRECTORY, depts("3")]);
  expect(directory.mappings).toBe(6);
  gate.resolve();
  await idle(directory);
  // The two superseded applies changed nothing and are no failures.
  expect(scans().slice(1).map(scan => [scan.mode, scan.scope, scan.complete, scan.superseded ?? false]))
    .toEqual([["apply", depts("2"), false, true], ["apply", depts("3"), false, true], ["apply", depts("3"), true, false]]);
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: depts("3") } });
  expect(directory.status().failure).toBeUndefined();
  expect(all.map(member => directory.lookup(`im-${member.phone}`) !== undefined)).toEqual([false, true, false, true, false, true]);
});

test("a service stop in the middle of an apply changes nothing, and the restarted service continues it", async () => {
  members(6);
  await open().scan("initial", directoryClient(), service.signal);
  expect(open().startupTrigger()).toBeUndefined();
  const gate = holdMembers("2");
  const first = open();
  const stopping = new AbortController();
  expect(await first.changeScope(depts("2"), directoryClient(), stopping.signal, keep)).toBe("started");
  for (const end = Date.now() + 3000; !fake.requestsTo("/open/v2/dept/users/list").length && Date.now() < end;) await Bun.sleep(5);
  stopping.abort(new Error("服务停止"));
  await idle(first);
  gate.resolve();
  expect(db.query("SELECT count(*) AS n FROM member_directory").get()).toEqual({ n: 6 });
  // Started again with the saved scope (data/config/directory.json): the apply is picked up at once.
  const restarted = open({ scope: depts("2") });
  expect(restarted.startupTrigger()).toBe("scope");
  expect(restarted.applying).toBe(true);
  expect(await restarted.scan("scope", directoryClient(), service.signal)).toMatchObject({ mode: "apply", complete: true, revoked: 3 });
  expect(restarted.status()).toMatchObject({ state: "effective", effective: { scope: depts("2") }, mappings: 3 });
  expect(open({ scope: depts("2") }).startupTrigger()).toBeUndefined();
  // Without any effective record (first deployment) the first sync is the initial one.
  db.exec("DELETE FROM directory_effective");
  expect(open({ scope: depts("2") }).startupTrigger()).toBe("initial");
});

test("after an upgrade from 1.0.x the paused revocations are dropped; the first routine sync records the effective scope once rechecked", async () => {
  // 1.0.x left thirty mappings, a complete scan without the new summary fields and a paused round; no effective record.
  const all = members(30);
  open();
  const insert = db.query("INSERT INTO member_directory (phone, im_user_id, name, last_verified_at) VALUES (?, ?, ?, 1)");
  for (const member of all) insert.run(member.phone, `im-${member.phone}`, member.name);
  db.query("INSERT INTO directory_scans (trigger, started_at, finished_at, complete, summary) VALUES ('daily', 1, 2, 1, ?)")
    .run(JSON.stringify({ id: 1, trigger: "daily", startedAt: 1, finishedAt: 2, complete: true, pendingRevocations: 25 }));
  db.exec("CREATE TABLE directory_pending_revocations (scan_id INTEGER NOT NULL, phone TEXT NOT NULL); INSERT INTO directory_pending_revocations VALUES (1, 'x')");
  let clock = 1_000_000;
  const directory = open({ now: () => clock, recheckDelayMs: 600_000 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'directory_pending_revocations'").get()).toBeNull();
  expect(directory.startupTrigger()).toBe("initial");
  expect(directory.status()).toMatchObject({ state: "applying", mappings: 30 });
  expect(directory.status().effective).toBeUndefined();
  // Twenty-five are absent: rechecked, not revoked, and the scope is not recorded as effective yet.
  members(5);
  expect(await directory.scan("initial", directoryClient(), service.signal)).toMatchObject({ mode: "routine", revoked: 0, suspected: 25 });
  expect(directory.status()).toMatchObject({ state: "applying", recheck: { count: 25 } });
  clock += 600_000;
  expect(await directory.scan("recheck", directoryClient(), service.signal)).toMatchObject({ revoked: 25 });
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: WHOLE_DIRECTORY, since: clock }, mappings: 5 });
});

test("an unreadable effective record counts as none: the next sync is routine and writes it again", async () => {
  members(4);
  await open().scan("initial", directoryClient(), service.signal);
  db.exec(`UPDATE directory_effective SET scope = '{"departments":"2"}'`);
  const directory = open();
  expect(directory.startupTrigger()).toBe("initial");
  expect(await directory.scan("initial", directoryClient(), service.signal)).toMatchObject({ mode: "routine", complete: true, revoked: 0 });
  expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: WHOLE_DIRECTORY } });
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
  const directory = open({ now: () => clock });
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
    expect(() => open({}, applicationBinding(config))).toThrow("通讯录属于另一个应用或平台环境");
  expect(open().mappings).toBe(2);
});

/** The member lists of `held` departments wait for the returned gate; every other department answers at once. */
function holdMembers(...held: string[]): PromiseWithResolvers<void> {
  const gate = Promise.withResolvers<void>();
  fake.route(MEMBER_PAGE, async (_request, body) => {
    const dept = deptOf(body);
    if (held.includes(dept)) await gate.promise;
    return fake.encrypted({ users: (fake.directory.members[dept] ?? []).map(m => ({ ...m, union_id: "u", customer_id: "", extension: "" })), total_pages: 1 });
  });
  return gate;
}

const DETAIL = "POST /open/applied/v1/user/detailByPhone";
/** detailByPhone as the fake platform answers it: the member's ID, or the refusal for a phone it does not know. */
function detail(phone: string): Response {
  const id = fake.directory.ids[phone];
  return id ? fake.encrypted({ userId: `u-${id}`, imUserId: id, userName: "", loginId: phone, phone }) : json({ code: 400001, success: false, msg: "用户不存在" });
}

test("new members resolve while the walk is still running; a phone later seen with another name is withdrawn", async () => {
  const [a] = members(2);
  // Department 2 also lists a newcomer whom department 3 (still being walked) lists under another name.
  fake.directory.members["2"]!.push({ phone: phoneOf(7), name: "甲" });
  fake.directory.members["3"]!.push({ phone: phoneOf(7), name: "乙" });
  fake.directory.ids[phoneOf(7)] = "im-7";
  const gate = holdMembers("3");
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
  const directory = open({ scope: depts("2") });
  expect(await directory.scan("initial", directoryClient(), signal)).toMatchObject({ complete: true, departments: 2, members: 4, added: 4 });
  expect([1, 2, 5, 6].map(n => directory.lookup(`im-${phoneOf(n)}`)?.phone)).toEqual([1, 2, 5, 6].map(phoneOf));
  expect(directory.lookup(`im-${phoneOf(3)}`)).toBeUndefined();
  expect(fake.requestsTo("/open/v2/dept/children").map(r => (r.body as { dept_id: string }).dept_id)).not.toContain("1");
  expect(directory.status()).toMatchObject({ scope: depts("2"), state: "effective", effective: { scope: depts("2") } });
  expect(directory.scoped).toBe(true);
});

test("without a saved scope nothing is synced: existing mappings stay and answer, no scan starts, and saving any scope starts one", async () => {
  // A 1.0.1 deployment synced the whole directory and has no data/config/directory.json.
  const all = members(4);
  await open().scan("initial", directoryClient(), service.signal);
  const before = fake.requests.length;
  const directory = open({ scope: undefined });
  expect(directory.status()).toMatchObject({ state: "unset", mappings: 4, effective: { scope: WHOLE_DIRECTORY } });
  expect(directory.status().scope).toBeUndefined(); expect(directory.scope).toBeUndefined();
  expect([directory.unset, directory.applying, directory.settled, directory.scoped]).toEqual([true, false, false, false]);
  expect(directory.startupTrigger()).toBeUndefined();
  expect(directory.lookup(`im-${all[0]!.phone}`)?.phone).toBe(all[0]!.phone);
  // Unknown IDs start nothing and an explicit scan is refused: the platform is never asked.
  expect(directory.requestScan(directoryClient(), service.signal)).toBe(false);
  await expect(directory.scan("daily", directoryClient(), service.signal)).rejects.toThrow("还没有设置通讯录同步范围，不同步");
  expect(fake.requests.length).toBe(before);
  expect(directory.mappings).toBe(4);
  // Setting the whole directory, which the old list already covers, starts a routine sync at once.
  const saved: DirectoryScope[] = [];
  expect(await directory.changeScope(WHOLE_DIRECTORY, directoryClient(), service.signal, async scope => { saved.push(scope); })).toBe("started");
  expect(saved).toEqual([WHOLE_DIRECTORY]);
  await idle(directory);
  expect(directory.status()).toMatchObject({ scope: WHOLE_DIRECTORY, state: "effective", lastScan: { trigger: "scope", mode: "routine", complete: true } });
  expect(directory.unset).toBe(false);
  // Departments from unset apply the new list in one switch.
  const other = open({ scope: undefined });
  expect(await other.changeScope(depts("2"), directoryClient(), service.signal, keep)).toBe("started");
  await idle(other);
  expect(other.status()).toMatchObject({ scope: depts("2"), state: "effective", effective: { scope: depts("2") }, lastScan: { mode: "apply", revoked: 2 } });
  // A first deployment without any record: the first sync is the initial one.
  db.exec("DELETE FROM directory_effective; DELETE FROM member_directory; DELETE FROM directory_scans");
  const fresh = open({ scope: undefined });
  expect(fresh.status()).toMatchObject({ state: "unset", mappings: 0 });
  expect(fresh.initializing).toBe(true);
  expect(await fresh.changeScope(depts("3"), directoryClient(), service.signal, keep)).toBe("started");
  expect(fresh.status().running).toMatchObject({ trigger: "initial" });
  await idle(fresh);
  expect(fresh.status()).toMatchObject({ state: "effective", effective: { scope: depts("3") }, mappings: 2 });
});

test("changing the scope supersedes the running sync without revoking anyone and applies the new departments at once", async () => {
  const all = members(6);
  const directory = open();
  await directory.scan("initial", directoryClient(), service.signal);
  const gate = holdMembers("3");
  const running = directory.scan("daily", directoryClient(), service.signal);
  for (const end = Date.now() + 3000; (directory.status().running?.departments ?? 0) < 2 && Date.now() < end;) await Bun.sleep(5);
  expect(await directory.changeScope(depts("3"), directoryClient(), service.signal, keep)).toBe("started");
  expect(await running).toMatchObject({ complete: false, superseded: true, revoked: 0, error: "通讯录范围已变更，已重新开始同步" });
  expect(directory.status().running).toMatchObject({ trigger: "scope", mode: "apply" });
  gate.resolve();
  await idle(directory);
  // Department 2's three members are outside the new scope: the new list leaves them out.
  expect(directory.status().lastScan).toMatchObject({ trigger: "scope", mode: "apply", complete: true, departments: 1, members: 3, revoked: 3 });
  expect(all.map(m => directory.lookup(`im-${m.phone}`) !== undefined)).toEqual([false, true, false, true, false, true]);
  // Back to the whole directory: they are mapped again (same IDs, looked up again as new members of the list).
  expect(await directory.changeScope(WHOLE_DIRECTORY, directoryClient(), service.signal, keep)).toBe("started");
  await idle(directory);
  expect(directory.mappings).toBe(6);
  expect(directory.status()).toMatchObject({ scope: WHOLE_DIRECTORY, state: "effective", effective: { scope: WHOLE_DIRECTORY } });
});

test("departments list with names and counts over every page; the detail of an unknown department is refused", async () => {
  const children = Array.from({ length: 40 }, (_, i) => String(100 + i));
  fake.directory = { children: { "1": children }, members: {}, ids: {},
    info: { "100": { name: "总部", count: 12, fullName: "集团/总部" }, "101": { name: "保密部" } } };
  const listed = await directoryClient().childDepartments("1");
  expect(listed).toHaveLength(40);
  expect(listed.slice(0, 3)).toEqual([{ id: "100", name: "总部", count: 12 }, { id: "101", name: "保密部" }, { id: "102", name: "" }]);
  expect(await directoryClient().department("100")).toEqual({ id: "100", name: "总部", count: 12, fullName: "集团/总部", parentId: "1" });
  await expect(directoryClient().department("999")).rejects.toThrow("code=422010");
});

test("department descriptions walk parent_id up to the root once per ancestor; a refused department or an unreadable chain stays local", async () => {
  // 1 → 100 → 110 → 111; 1 → 200; 450 (not readable) → 451; 600 has no parent_id; 700 and 701 are each other's parent.
  fake.directory = { children: { "1": ["100", "200"], "100": ["110"], "110": ["111"], "450": ["451"], "700": ["701"], "701": ["700"] }, members: {}, ids: {},
    info: { "100": { name: "总部" }, "110": { name: "研发中心", count: 20 }, "111": { name: "平台组", count: 8, fullName: "集团|总部|研发中心|平台组" },
      "200": { name: "华东" }, "451": { name: "孤立组" }, "600": { name: "无上级" }, "700": { name: "环甲" }, "701": { name: "环乙" } } };
  const before = fake.requests.length;
  const described = await directoryClient().describe(["111", "110", "200", "451", "600", "700", "999"]);
  // The platform's "|" between the levels becomes the tree's "/".
  expect(described.departments).toEqual([
    { id: "111", name: "平台组", count: 8, fullName: "集团/总部/研发中心/平台组", parentId: "110", ancestors: [{ id: "100", name: "总部" }, { id: "110", name: "研发中心" }] },
    { id: "110", name: "研发中心", count: 20, fullName: "研发中心", parentId: "100", ancestors: [{ id: "100", name: "总部" }] },
    { id: "200", name: "华东", fullName: "华东", parentId: "1", ancestors: [] },
    // The parent 450 is refused: the department is still described, without a chain.
    { id: "451", name: "孤立组", fullName: "孤立组", parentId: "450" },
    { id: "600", name: "无上级", fullName: "无上级" },
    { id: "700", name: "环甲", fullName: "环甲", parentId: "701" },
  ]);
  expect(described.unavailable).toHaveLength(1);
  expect(described.unavailable[0]).toMatchObject({ id: "999" });
  expect(described.unavailable[0]!.message).toContain("code=422010");
  // Shared ancestors are read once, the root never.
  const asked = fake.requests.slice(before).filter(request => request.path === "/open/v2/dept/get").map(request => (request.body as { dept_id: string }).dept_id);
  expect(asked.toSorted()).toEqual(["100", "110", "111", "200", "450", "451", "600", "700", "701", "999"]);
  expect(described.unavailable[0]!.message).toBe("部门不属于当前组织（code=422010）");
});

test("department descriptions: the organisation's own root, the parent of every top-level department, is not part of a path", async () => {
  // As on the real platform: the children API's 1 is the root department 9000, which top-level departments name as their parent.
  fake.directory = { children: { "1": ["100", "200"], "100": ["110"] }, members: {}, ids: {}, root: "9000",
    info: { "9000": { name: "集团", count: 30 }, "100": { name: "总部" }, "110": { name: "研发中心", fullName: "集团|总部|研发中心" }, "200": { name: "华东" } } };
  const before = fake.requests.length;
  const described = await directoryClient().describe(["110", "200"]);
  expect(described.departments.map(item => [item.id, item.parentId, item.ancestors])).toEqual([
    ["110", "100", [{ id: "100", name: "总部" }]], ["200", "9000", []]]);
  // The root is read once, to learn that it is the root.
  const asked = fake.requests.slice(before).filter(request => request.path === "/open/v2/dept/get").map(request => (request.body as { dept_id: string }).dept_id);
  expect(asked.toSorted()).toEqual(["100", "110", "200", "9000"]);
});

/** dept/get answers: `fail` gives the code for one department, the others wait for `gate` and then answer under the root. */
function gatedDetails(fail: Record<string, () => Response>) {
  const gate = Promise.withResolvers<void>();
  fake.route("POST /open/v2/dept/get", async (_request, body) => {
    const id = (body as { dept_id: string }).dept_id;
    if (fail[id]) return fail[id]();
    await gate.promise;
    return fake.encrypted({ dept_id: id, parent_id: "1", name: "部门" + id });
  });
  const asked = () => fake.requestsTo("/open/v2/dept/get").map(request => (request.body as { dept_id: string }).dept_id);
  return { gate, asked };
}
const eight = Array.from({ length: 8 }, (_, i) => String(100 + i));

test("department descriptions: a failure that is not an explicit refusal fails the lookup, names the department and stops the queued ones", async () => {
  // A code outside the documented refusals (a platform fault, or an undocumented permission code) says nothing about the department.
  for (const answer of [() => json({ code: 500009, msg: "查询部门失败" }), () => json({ code: 403001, msg: "无权限" }), () => json({ code: 500, msg: "boom" }, 503)]) {
    fake.requests.length = 0;
    const { gate, asked } = gatedDetails({ "100": answer });
    const failed = await directoryClient().describe(eight).then(() => new Error("没有失败"), (error: Error) => error);
    expect(failed.message).toMatch(/^部门 100：通讯录 \/open\/v2\/dept\/get 失败：HTTP \d+ code=\d+$/);
    // Four lookups at a time: the four still queued never start (the three in flight are cancelled, maybe before the platform reads them).
    gate.resolve();
    await Bun.sleep(20);
    expect(asked()).toContain("100");
    expect(asked().filter(id => Number(id) >= 104)).toEqual([]);
  }
  // A network failure is not a refusal either.
  class Offline extends DirectoryClient {
    override async department(): Promise<never> { throw new PlatformRequestError("通讯录 /open/v2/dept/get：连接失败（ECONNREFUSED）", "unsent"); }
  }
  await expect(new Offline({} as PlatformClient).describe(["100", "200"])).rejects.toThrow("部门 100：通讯录 /open/v2/dept/get：连接失败");
});

test("department descriptions: cancelling rejects with the reason, cancels queued lookups and returns no partial result", async () => {
  const reason = new Error("选择器已关闭");
  const aborted = new AbortController();
  aborted.abort(reason);
  await expect(directoryClient().describe(["100"], aborted.signal)).rejects.toBe(reason);
  expect(fake.requestsTo("/open/v2/dept/get")).toHaveLength(0);

  const { gate, asked } = gatedDetails({});
  const client = directoryClient(), controller = new AbortController();
  const waitFor = async (count: number) => { for (const end = Date.now() + 3000; asked().length < count && Date.now() < end;) await Bun.sleep(5); };
  const pending = client.describe(eight, controller.signal);
  await waitFor(4);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  // The four in flight were cancelled as well: their slots (shared by the client's lookups) are free before the platform answers them.
  const again = client.describe(["100"], AbortSignal.timeout(2000));
  await waitFor(5);
  expect(asked()).toHaveLength(5);
  gate.resolve();
  expect((await again).departments.map(department => department.id)).toEqual(["100"]);
  await Bun.sleep(20);
  expect(asked()).toHaveLength(5);
});

test("checking departments before saving the scope tells a refusal from a failed check and stops when cancelled", async () => {
  fake.directory = { children: { "1": ["100"] }, members: {}, ids: {}, info: { "100": { name: "总部" } } };
  expect(await directoryClient().verify(["100"])).toEqual([{ id: "100", name: "总部", fullName: "总部", parentId: "1" }]);
  await expect(directoryClient().verify(["100", "999"])).rejects.toThrow("部门 999：部门不属于当前组织（code=422010）；范围未改");
  // The documented refusal codes count as well.
  fake.route("POST /open/v2/dept/get", () => json({ code: 404002, msg: "部门不存在" }));
  await expect(directoryClient().verify(["100"])).rejects.toThrow("部门 100：部门不存在（code=404002）；范围未改");
  fake.route("POST /open/v2/dept/get", () => json({ code: 400002, msg: "dept_id格式无效: 100" }));
  await expect(directoryClient().verify(["100"])).rejects.toThrow("部门 100：部门 ID 格式无效（code=400002）；范围未改");
  fake.route("POST /open/v2/dept/get", () => json({ code: 500009, msg: "查询部门失败" }));
  await expect(directoryClient().verify(["100"])).rejects.toThrow("没能向平台核对部门 100（通讯录 /open/v2/dept/get 失败：HTTP 200 code=500009）；范围未改");
  const reason = new Error("caller gone"), controller = new AbortController();
  controller.abort(reason);
  await expect(directoryClient().verify(["100"], controller.signal)).rejects.toBe(reason);
});

test("a complete scan records the department tree with names, paths and members; lookups, subtrees and expansion are local", async () => {
  const all = Array.from({ length: 6 }, (_, i) => ({ phone: phoneOf(i + 1), name: `成员${i + 1}` }));
  fake.directory = { children: { "1": ["2", "3"], "2": ["4"], "4": ["5"] }, members: { "1": all.slice(5), "2": all.slice(0, 2), "3": all.slice(2, 3), "4": all.slice(3, 4), "5": all.slice(4, 5) },
    ids: Object.fromEntries(all.map(m => [m.phone, `im-${m.phone}`])),
    info: { "2": { name: "技术部" }, "3": { name: "财务部" }, "4": { name: "研发 组" }, "5": { name: "后端" } } };
  const directory = open();
  expect(directory.departments.updatedAt).toBeUndefined();
  await directory.scan("initial", directoryClient(), signal);
  const tree = directory.departments;
  expect(tree.updatedAt).toBeNumber();
  expect(tree.all().map(d => [d.id, d.parent, d.path])).toEqual([["2", null, "技术部"], ["4", "2", "技术部/研发 组"], ["5", "4", "技术部/研发 组/后端"], ["3", null, "财务部"]]);
  // By name, by path or a path's tail, whitespace ignored; nothing found gives similar ones.
  expect(tree.find("研发组").matches.map(d => d.id)).toEqual(["4"]);
  expect(tree.find("技术部/研发组").matches.map(d => d.id)).toEqual(["4"]);
  expect(tree.find("研发").matches).toEqual([]);
  expect(tree.find("研发").similar.map(d => d.id)).toEqual(["4", "5"]);
  expect(tree.subtree("2").sort()).toEqual(["2", "4", "5"]);
  expect(tree.within("5", ["2"])).toBe(true); expect(tree.within("3", ["2"])).toBe(false);
  expect(tree.members(["2"], true).map(m => m.phone)).toEqual([1, 2, 4, 5].map(phoneOf));
  expect(tree.members(["2"], false).map(m => m.phone)).toEqual([1, 2].map(phoneOf));
  // Everyone includes the root's own members; a member without a mapping is not expanded.
  expect(tree.everyone()).toHaveLength(6);
  db.query("DELETE FROM member_directory WHERE phone = ?").run(phoneOf(4));
  expect(tree.members(["4"], false)).toEqual([]);
});

test("an incomplete scan keeps the previous tree; a later complete one replaces it", async () => {
  const all = members(4);
  fake.directory = { ...fake.directory, info: { "2": { name: "甲部" }, "3": { name: "乙部" } } };
  const directory = open({ retryDelaysMs: [60_000] });
  await directory.scan("initial", directoryClient(), service.signal);
  expect(directory.departments.all().map(d => d.path)).toEqual(["乙部", "甲部"]);
  fake.directory = { ...fake.directory, children: { "1": ["2"] }, info: { "2": { name: "甲部（新）" } } };
  fake.route(MEMBER_PAGE, () => json({ code: 500, message: "boom" }, 500));
  await directory.scan("daily", directoryClient(), service.signal);
  expect(directory.departments.all().map(d => d.path)).toEqual(["乙部", "甲部"]);
  fake.route(MEMBER_PAGE, undefined);
  await directory.scan("daily", directoryClient(), service.signal);
  expect(directory.departments.all().map(d => d.path)).toEqual(["甲部（新）"]);
  expect(directory.departments.members(["2"], true).map(m => m.phone)).toEqual(all.filter((_, i) => i % 2 === 0).map(m => m.phone));
});

test("a saved scope's tree starts at the chosen departments with their full paths, and switches with the new list", async () => {
  const all = Array.from({ length: 4 }, (_, i) => ({ phone: phoneOf(i + 1), name: `成员${i + 1}` }));
  // As on the real platform, the full path separates the levels with "|".
  fake.directory = { children: { "1": ["2", "3"], "2": ["4"] }, members: { "2": all.slice(0, 1), "3": all.slice(1, 2), "4": all.slice(2) },
    ids: Object.fromEntries(all.map(m => [m.phone, `im-${m.phone}`])),
    info: { "2": { name: "技术部", fullName: "公司|技术部" }, "3": { name: "财务部", fullName: "公司|财务部" }, "4": { name: "研发组" } } };
  const directory = open();
  await directory.scan("initial", directoryClient(), service.signal);
  expect(directory.departments.all().map(d => d.path)).toEqual(["技术部", "技术部/研发组", "财务部"]);
  // The whole directory names no departments.
  expect(directory.scopePaths()).toEqual({});
  // While the new scope cannot be applied, the tree of the list in effect stays; the scope is named from what the walk read.
  fake.route(MEMBER_PAGE, () => json({ code: 500, message: "boom" }, 500));
  expect(await directory.changeScope(depts("2"), directoryClient(), service.signal, keep)).toBe("started");
  await idle(directory);
  expect(directory.departments.all().map(d => d.path)).toEqual(["技术部", "技术部/研发组", "财务部"]);
  expect(directory.scopePaths()).toEqual({ "2": "公司/技术部" });
  fake.route(MEMBER_PAGE, undefined);
  expect(await directory.changeScope(depts("2"), directoryClient(), service.signal, keep)).toBe("started");
  await idle(directory, () => directory.settled);
  expect(directory.departments.all().map(d => [d.id, d.parent, d.path])).toEqual([["2", null, "公司/技术部"], ["4", "2", "公司/技术部/研发组"]]);
  expect(directory.departments.find("财务部").matches).toEqual([]);
  // A path given from any level down finds the department below the chosen one.
  expect(directory.departments.find("技术部/研发组").matches.map(d => d.id)).toEqual(["4"]);
  expect(directory.departments.find("公司/技术部/研发组").matches.map(d => d.id)).toEqual(["4"]);
  // After a restart the tree names the scope in effect.
  expect(open({ scope: depts("2") }).scopePaths()).toEqual({ "2": "公司/技术部" });
  // A chosen department below another chosen one hangs under it; one whose name cannot be read keeps a placeholder.
  expect(await directory.changeScope(depts("2", "4", "9"), directoryClient(), service.signal, keep)).toBe("started");
  await idle(directory, () => directory.settled);
  expect(directory.departments.all().map(d => [d.id, d.parent])).toEqual([["2", null], ["4", "2"], ["9", null]]);
  expect(directory.departments.get("9")?.path).toBe("部门 9");
  expect(directory.departments.subtree("2").sort()).toEqual(["2", "4"]);
  expect(directory.scopePaths()).toEqual({ "2": "公司/技术部", "4": "研发组", "9": "部门 9" });
});
