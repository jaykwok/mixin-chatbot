import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTENTION_RECENT_MS, changeScope, departmentPath, departmentRow, describeAttention, describeDepartments, describeDirectory, describeScope,
  describeScopeChange, describeScopeState, directoryStatus, doctorRows, listDepartments, main, readScopePaths, readServiceStatus, scopeRows } from "../../ops/tools/directory-admin.ts";
import { type DirectoryScope, parseScopeRequest, readDirectoryScope, sameScope, scopeChoiceHint, scopeDepartments, WHOLE_DIRECTORY } from "../../src/integrations/open-platform/directory-scope.ts";
import { writeDirectoryScope } from "../../src/integrations/open-platform/directory-scope-write.ts";
import { createApp } from "../../src/server/http-app.ts";
import type { DirectoryStatus, ScanSummary } from "../../src/integrations/open-platform/identity-directory.ts";
import { tempFixture } from "../helpers/temp.ts";

const now = 1_800_000_000_000;
const scan = (complete: boolean): ScanSummary => ({ id: 7, trigger: "daily", startedAt: now - 60_000, complete, departments: 3, members: 40, added: 0,
  renamed: 0, replaced: 0, reverified: 1, revoked: 0, suspected: 0, conflicts: 0, failures: 0, ...(complete ? {} : { error: "部门遍历失败" }) });
const depts = (...departments: string[]): DirectoryScope => ({ kind: "departments", departments });
const settled: DirectoryStatus = { mappings: 40, scope: WHOLE_DIRECTORY, state: "effective", effective: { scope: WHOLE_DIRECTORY, since: Date.now() - 3 * 86_400_000 },
  lastScan: scan(true), lastCompleteAt: now - 60_000 };
const rows = (status: Parameters<typeof doctorRows>[0]) => doctorRows(status, now).map(row => row.split("\t").slice(0, 2).join(" "));

test("doctor rows: a Stream down for over two minutes fails; a scope not yet in effect, an unfinished sync or a recheck needs checking", () => {
  const directory = settled;
  expect(rows({ verificationOnly: false, stream: { connected: true, reconnects: 0 }, directory })).toEqual(["pass 事件 Stream", "pass 通讯录同步"]);
  // A short disconnect is a reconnect in progress; a long one (or a Stream that never started) fails.
  expect(rows({ verificationOnly: false, stream: { connected: false, reconnects: 1, disconnectedSince: now - 30_000 }, directory })[0]).toBe("warn 事件 Stream");
  expect(rows({ verificationOnly: false, stream: { connected: false, reconnects: 1, disconnectedSince: now - 180_000 }, directory })[0]).toBe("fail 事件 Stream");
  expect(rows({ verificationOnly: false, directory })[0]).toBe("fail 事件 Stream");
  // The verification instance has no Stream row.
  expect(rows({ verificationOnly: true, directory })).toEqual(["pass 通讯录同步"]);
  const recheck = { count: 25, at: Date.now() + 7 * 60_000 };
  for (const changed of [{ ...directory, scope: depts("100"), state: "applying" as const }, { ...directory, scope: depts("100"), state: "failed" as const, failure: "x" },
    { ...directory, failure: "部门遍历失败" }, { ...directory, recheck }, { mappings: 0, scope: WHOLE_DIRECTORY, state: "applying" as const }, undefined]) {
    expect(rows({ verificationOnly: true, ...(changed ? { directory: changed } : {}) })).toEqual(["warn 通讯录同步"]);
  }
  const detail = doctorRows({ verificationOnly: true, directory: { ...directory, recheck } }, now)[0]!;
  expect(detail).toContain("大批成员缺席：25 个，7 分钟后再完整同步一轮复核，仍缺席的才撤销");
  expect(detail).not.toMatch(/[\r\n]/);
});

test("doctor rows: the service's attention counters warn while the last event is within a day; an older /health has no row", () => {
  const directory = settled;
  expect(rows({ verificationOnly: true, directory, attention: {} })).toEqual(["pass 通讯录同步", "pass 运行状况"]);
  const recent = { interrupted: { count: 2, lastAt: now - 3600_000, space: "群 g1" }, notSent: { count: 1, lastAt: now - 2 * ATTENTION_RECENT_MS, space: "单聊" } };
  expect(rows({ verificationOnly: true, directory, attention: recent })[1]).toBe("warn 运行状况");
  const detail = doctorRows({ verificationOnly: true, directory, attention: recent }, now)[1]!;
  expect(detail).toContain("反复中断而结束的任务 2 次（最近 群 g1");
  expect(detail).toContain("未发出的模型请求 1 次（最近 单聊");
  expect(describeAttention(recent, now).map(event => [event.kind, event.recent])).toEqual([["interrupted", true], ["notSent", false]]);
  // Only old events: listed, not a warning (the counters clear only with a restart).
  expect(rows({ verificationOnly: true, directory, attention: { notSent: recent.notSent } })[1]).toBe("pass 运行状况");
  expect(rows({ verificationOnly: true, directory })).toEqual(["pass 通讯录同步"]);
});

test("the scope state says whether the saved scope is in effect, and what is in effect until it is", () => {
  expect(describeScopeState(settled)).toBe("已生效（3 天前完成）");
  const applying: DirectoryStatus = { ...settled, scope: depts("100", "200"), state: "applying" };
  expect(describeScopeState(applying)).toBe("正在应用，完成前之前的范围（整个通讯录）仍然生效");
  // Without an effective record: the first sync, or the list of an older version.
  const { effective: _, ...bootstrap } = applying;
  expect(describeScopeState({ ...bootstrap, mappings: 0 })).toBe("正在进行首次同步");
  expect(describeScopeState(bootstrap)).toBe("正在应用，完成前之前的名单仍然生效");
  const failed: DirectoryStatus = { ...applying, state: "failed", failure: "部门遍历失败：HTTP 500", retryAt: Date.now() + 5 * 60_000 };
  expect(describeScopeState(failed)).toBe("应用失败：部门遍历失败：HTTP 500；之前的范围（整个通讯录）仍然生效，5 分钟后自动重试，用同一范围再保存一次可立即重试");
  expect(describeDirectory(failed).slice(0, 3)).toEqual(["通讯录映射：40 个", "同步范围：2 个部门（100、200）及其子部门", `范围状态：${describeScopeState(failed)}`]);
  // The reason of a failed apply is part of the state; an unfinished routine sync gets its own line.
  expect(describeDirectory(failed).some(line => line.startsWith("上一轮没有完成"))).toBe(false);
  expect(describeDirectory({ ...settled, failure: "部门遍历失败", retryAt: Date.now() + 15 * 60_000 })).toContain("上一轮没有完成：部门遍历失败（15 分钟后自动重试）");
});

test("status goes only to the recorded instance over the local control port", async () => {
  const fixture = await tempFixture("directory-admin-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = now;
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    health: () => ({ stream: { connected: true, reconnects: 2 }, directory: settled, attention: { deliveryAbandoned: { count: 1, lastAt: now, space: "单聊" } } }),
    changeScope: async () => ({ status: "unchanged" }) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const status = await readServiceStatus(undefined, file);
    expect(status).toEqual({ stream: { connected: true, reconnects: 2 }, directory: settled,
      attention: { deliveryAbandoned: { count: 1, lastAt: now, space: "单聊" } }, verificationOnly: false });
    // Another instance on the port (a stale record) is refused before anything is sent.
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId: randomUUID(), pid: process.pid, startedAt }));
    await expect(readServiceStatus(undefined, file)).rejects.toThrow("不是当前实例");
    await writeFile(file, JSON.stringify({ port: server.port, token: "other", instanceId, pid: process.pid, startedAt }));
    await expect(changeScope(depts("100"), undefined, file)).rejects.toThrow("实例口令不符");
    await expect(readServiceStatus(undefined, join(fixture.root, "missing.json"))).rejects.toThrow("读不到服务实例记录");
  } finally { await server.stop(true); await fixture.cleanup(); }
});

test("departments and scope changes go to the recorded instance; malformed IDs are refused before the service acts", async () => {
  const fixture = await tempFixture("directory-scope-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = now;
  const parents: string[] = [], scopes: DirectoryScope[] = [];
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    listDepartments: async parent => { parents.push(parent); return [{ id: "100", name: "总部", count: 12 }, { id: "101", name: "保密\t部" }]; },
    changeScope: async scope => {
      const departments = scopeDepartments(scope);
      if (departments?.includes("999")) throw new Error("部门 999：部门不属于当前组织（code=422010）；范围未改");
      if (departments?.[0] === "300") return { status: "unchanged" };
      scopes.push(scope);
      const checked = (departments ?? []).map(id => ({ id, name: "部门" + id, fullName: "集团/部门" + id }));
      return { status: departments?.[0] === "400" ? "cancelled" : "started", departments: checked };
    } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const listed = await listDepartments(undefined, undefined, file);
    expect(listed.map(departmentRow)).toEqual(["100\t12\t总部", "101\t-\t保密 部"]);
    await listDepartments("100", undefined, file);
    expect(parents).toEqual(["1", "100"]);
    await expect(listDepartments("../1", undefined, file)).rejects.toThrow("无效的部门 ID");
    const checked = await changeScope(depts("100", "101"), undefined, file);
    expect(checked.status).toBe("started");
    expect(checked.status !== "unchanged" && checked.departments.map(departmentRow)).toEqual(["100\t-\t集团/部门100", "101\t-\t集团/部门101"]);
    // What the picker's pane and the command line print: the departments the service checked, then how it takes effect.
    const started = describeScopeChange(depts("100", "101"), checked);
    expect(started.slice(0, 3)).toEqual(["已保存，服务正在应用新范围：只同步以下 2 个部门及其子部门（ID、人数、名称）", "100\t-\t集团/部门100", "101\t-\t集团/部门101"]);
    expect(started.at(-1)).toStartWith("服务立即按新范围完整同步");
    const whole = await changeScope(WHOLE_DIRECTORY, undefined, file);
    expect(whole).toEqual({ status: "started", departments: [] });
    expect(describeScopeChange(WHOLE_DIRECTORY, whole)[0]).toBe("已保存，服务正在应用新范围：整个通讯录");
    const unchanged = await changeScope(depts("300"), undefined, file);
    expect(unchanged).toEqual({ status: "unchanged" });
    expect(describeScopeChange(depts("300"), unchanged)).toEqual(["同步范围未变（1 个部门（300）及其子部门），已经生效，未重新同步。"]);
    const cancelled = await changeScope(depts("400"), undefined, file);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(describeScopeChange(depts("400"), cancelled)).toEqual(["已改回当前生效的范围（1 个部门（400）及其子部门），未完成的范围应用已取消。"]);
    await expect(changeScope(depts("100", "999"), undefined, file)).rejects.toThrow("部门 999：部门不属于当前组织");
    // The service refuses malformed requests before it acts: duplicates, no departments, the root's alias 1 (it lists
    // departments above but is no scope), and anything but an explicit whole directory or a department list.
    await expect(changeScope(depts("100", "100"), undefined, file)).rejects.toThrow("重复");
    await expect(changeScope(depts(), undefined, file)).rejects.toThrow("1 到 200 个部门 ID");
    await expect(changeScope(depts("100", "1"), undefined, file)).rejects.toThrow("部门 1 是根部门的查询别名，不能作为同步范围；要同步整个通讯录请明确选择整个通讯录（all）");
    const post = (body: string) => fetch(`http://127.0.0.1:${server.port}/_admin/directory/scope`, { method: "POST", body,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } })
      .then(async response => [response.status, (await response.json() as { message?: string }).message]);
    expect(await post('{"departments":null}')).toEqual([400, '整个通讯录需要明确写成 {"all":true}']);
    expect(await post('{"departments":"100"}')).toEqual([400, "departments 必须是 1 到 200 个部门 ID"]);
    for (const body of ["{}", '{"all":false}', '{"all":true,"departments":["100"]}', "[]", "null", "not json"]) {
      expect(await post(body)).toEqual([400, '请求体必须是 {"all":true} 或 {"departments":[部门 ID,…]}']);
    }
    expect(scopes).toEqual([depts("100", "101"), WHOLE_DIRECTORY, depts("400")]);
    await writeFile(file, JSON.stringify({ port: server.port, token: "other", instanceId, pid: process.pid, startedAt }));
    await expect(changeScope(depts("100"), undefined, file)).rejects.toThrow("实例口令不符");
    expect(scopes).toHaveLength(3);
  } finally { await server.stop(true); await fixture.cleanup(); }
});

test("department details: paths from the ancestors, refused departments listed apart; the status rows survive a failed lookup", async () => {
  const fixture = await tempFixture("directory-details-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = now;
  const asked: string[][] = [];
  let mode: "ok" | "fail" | "hang" = "ok", release = () => {};
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    describeDepartments: async ids => {
      asked.push(ids);
      if (mode === "fail") throw new Error("通讯录 /open/v2/dept/get 失败：HTTP 502");
      if (mode === "hang") await new Promise<void>(resolve => { release = resolve; });
      return { departments: ids.filter(id => id !== "999").map(id => id === "111"
        ? { id, name: "平台\t组", count: 8, fullName: "集团/总部/研发中心/平台组", parentId: "110", ancestors: [{ id: "100", name: "总部" }, { id: "110", name: "" }] }
        : { id, name: "部门" + id, fullName: "集团/部门" + id }),
      unavailable: ids.includes("999") ? [{ id: "999", message: "部门不属于当前组织（code=422010）" }] : [] };
    } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const described = await describeDepartments(["111", "200", "999"], undefined, file);
    // A nameless ancestor shows its ID; without a chain the platform's full path stands in.
    expect(described.departments.map(departmentPath)).toEqual(["总部 / 110 / 平台\t组", "集团/部门200"]);
    expect(described.unavailable.map(item => item.id)).toEqual(["999"]);
    expect(await scopeRows(["111", "200", "999"], undefined, file)).toEqual(["范围内的部门（ID、人数、路径）：", "111\t8\t总部 / 110 / 平台 组",
      "200\t-\t集团/部门200", "999\t-\t平台拒绝：部门不属于当前组织（code=422010）"]);
    await expect(describeDepartments(["a b"], undefined, file)).rejects.toThrow("无效的部门 ID");
    await expect(describeDepartments([], undefined, file)).rejects.toThrow("1 到 200 个部门 ID");
    expect(asked).toHaveLength(2);
    mode = "fail";
    expect(await scopeRows(["111"], undefined, file)).toEqual(["范围内部门的名称未能读取：读取部门详情失败：通讯录 /open/v2/dept/get 失败：HTTP 502"]);
    mode = "hang";
    await expect(describeDepartments(["111"], undefined, file, 200)).rejects.toThrow("服务 1 秒内没有答复");
    release();
    // A caller that cancels (the console closing the picker) gets its own reason back, not a dead port.
    const reason = new Error("选择器已关闭"), caller = new AbortController();
    const cancelled = describeDepartments(["111"], undefined, file, undefined, caller.signal);
    for (const end = Date.now() + 3000; asked.length < 5 && Date.now() < end;) await Bun.sleep(5);
    caller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    release();
    await writeFile(file, JSON.stringify({ port: server.port, token: "other", instanceId, pid: process.pid, startedAt }));
    expect((await scopeRows(["111"], undefined, file))[0]).toContain("实例口令不符");
    expect(asked).toHaveLength(5);
  } finally { release(); await server.stop(true); }
  // Nothing listening on the recorded port.
  await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
  try { await expect(describeDepartments(["111"], undefined, file)).rejects.toThrow(`本机端口 ${server.port} 无响应`); }
  finally { await fixture.cleanup(); }
});

test("the scope by department paths: the service's tree names the departments, unknown ones keep their IDs; no answer leaves the IDs", async () => {
  const fixture = await tempFixture("directory-paths-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = now;
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    scopePaths: () => ({ "100": "集团/总部", "200": "集团/华东" }) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const paths = await readScopePaths(undefined, file);
    expect(paths).toEqual({ "100": "集团/总部", "200": "集团/华东" });
    expect(describeScope(depts("100"), paths)).toBe("1 个部门及其子部门：集团/总部");
    expect(describeScope(depts("100", "300"), paths)).toBe("2 个部门及其子部门：集团/总部；部门 300");
    expect(describeScope(depts("1", "2", "3", "4", "5", "6"), {})).toBe("6 个部门及其子部门：部门 1；部门 2；部门 3；部门 4；部门 5 等");
    expect(describeScope(WHOLE_DIRECTORY, paths)).toBe("整个通讯录");
    const applying: DirectoryStatus = { mappings: 3, scope: depts("300"), state: "applying", effective: { scope: depts("100"), since: now } };
    expect(describeScopeState(applying, paths)).toBe("正在应用，完成前之前的范围（1 个部门及其子部门：集团/总部）仍然生效");
    // The paths need the token, like the other control routes; refused (as by a service without the route), the scope keeps its IDs.
    expect((await fetch(`http://127.0.0.1:${server.port}/_admin/directory/scope-paths`, { method: "POST" })).status).toBe(404);
    await writeFile(file, JSON.stringify({ port: server.port, token: "other", instanceId, pid: process.pid, startedAt }));
    expect(await readScopePaths(undefined, file)).toEqual({});
  } finally { await server.stop(true); await fixture.cleanup(); }
});

test("without a saved scope the status reads unset, the doctor fails and points at the picker or the whole directory", () => {
  const unset: DirectoryStatus = { mappings: 12, state: "unset" };
  expect(rows({ verificationOnly: true, directory: unset })).toEqual(["fail 通讯录同步"]);
  expect(describeDirectory(unset).slice(0, 3)).toEqual(["通讯录映射：12 个", "同步范围：未设置（不同步）",
    `范围状态：未设置：不同步通讯录，不认识的成员无法确认身份；${scopeChoiceHint()}`]);
  // Linux has the terminal wizard (ops.sh directory-scope); ops.ps1 has no terminal, so Windows ticks departments in the console only.
  expect(scopeChoiceHint("win32")).toBe("在控制台「通讯录」中选择，或用 directory-scope all 同步整个通讯录");
  expect(scopeChoiceHint("linux")).toBe("在控制台「通讯录」或终端（不带参数的 directory-scope）中逐层勾选部门，或用 directory-scope all 同步整个通讯录");
  // The unset state passes through as it is.
  expect(directoryStatus(unset)).toBe(unset as unknown as DirectoryStatus);
});

test("the command line takes all or nothing: department IDs, unknown, repeated or extra arguments and a missing terminal are refused", async () => {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  try {
    // No service runs in the test's directory: a request would fail with 1 rather than refuse with 2. A terminal is claimed so
    // only the arguments decide; the wizard would start for an empty scope.
    for (const argv of [["scope", "111"], ["scope", "1"], ["scope", "all", "all"], ["scope", "", "all"], ["scope", "all", "--force"],
      ["status", "extra"], ["doctor", "extra"], ["bogus"], [""]]) {
      expect({ argv, code: await main(argv, true) }).toEqual({ argv, code: 2 });
    }
    expect(errors.filter(line => line.startsWith("命令行不接受部门 ID"))).toHaveLength(2);
    errors.length = 0;
    // ops.ps1 passes an empty value when no scope is given; without a terminal nothing defaults to the whole directory.
    for (const argv of [["scope"], ["scope", ""], ["scope", "  "]]) expect(await main(argv, false)).toBe(2);
    expect(errors).toEqual(Array(3).fill(`没有终端，不能逐层勾选部门，也不默认整个通讯录；${scopeChoiceHint()}`));
  } finally { spy.mockRestore(); }
});

test("the scope file: absent is unset; written atomically; the whole directory must be written out; anything malformed is refused", async () => {
  const fixture = await tempFixture("directory-scope-file-");
  const path = join(fixture.root, "config", "directory.json");
  try {
    expect(readDirectoryScope(path)).toBeUndefined();
    expect(describeScope(undefined)).toBe("未设置（不同步）");
    expect(describeScope(WHOLE_DIRECTORY)).toBe("整个通讯录");
    await writeDirectoryScope(depts("100", "200"), path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ format: 1, departments: ["100", "200"] });
    expect(readDirectoryScope(path)).toEqual(depts("100", "200"));
    expect(describeScope(depts("100", "200"))).toBe("2 个部门（100、200）及其子部门");
    await writeDirectoryScope(WHOLE_DIRECTORY, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ format: 1, all: true });
    expect(readDirectoryScope(path)).toEqual(WHOLE_DIRECTORY);
    for (const bad of [{ format: 1, departments: [] }, { format: 1, departments: ["a b"] }, { format: 2, departments: ["100"] }, { format: 1, departments: ["100"], extra: 1 },
      { format: 1, all: false }, { format: 1, all: "true" }, { format: 1, all: true, departments: ["100"] }, { format: 1, departments: null }, { format: 1 }, { all: true }, []]) {
      await writeFile(path, JSON.stringify(bad));
      expect(() => readDirectoryScope(path)).toThrow();
    }
    // A file the service cannot parse is an error, not unset.
    await writeFile(path, "{");
    expect(() => readDirectoryScope(path)).toThrow();
    // The same departments in another order are the same scope.
    expect([sameScope(WHOLE_DIRECTORY, WHOLE_DIRECTORY), sameScope(depts("1", "2"), depts("2", "1"))]).toEqual([true, true]);
    expect([sameScope(WHOLE_DIRECTORY, depts("1")), sameScope(depts("1"), WHOLE_DIRECTORY), sameScope(depts("1"), depts("1", "2")), sameScope(depts("1", "2"), depts("1", "3"))])
      .toEqual([false, false, false, false]);
  } finally { await fixture.cleanup(); }
});

test("the control route takes an explicit whole directory or departments, never an empty choice", () => {
  expect(parseScopeRequest({ all: true })).toEqual(WHOLE_DIRECTORY);
  expect(parseScopeRequest({ departments: ["100"] })).toEqual(depts("100"));
  expect(() => parseScopeRequest({ departments: null })).toThrow('整个通讯录需要明确写成 {"all":true}');
  for (const bad of [undefined, null, [], {}, { all: false }, { all: 1 }, { all: true, departments: ["100"] }, { departments: "100" }, { scope: "all" }])
    expect(() => parseScopeRequest(bad)).toThrow();
});

const project = join(import.meta.dir, "../..");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

// macOS hands ops.sh to its own entry, which runs the tool as the service account and needs root.
test.skipIf(!bash || !existsSync(bash) || process.platform === "darwin")("ops.sh directory-scope passes its arguments through; without host Bun and without a terminal it runs in the container without -it", async () => {
  const fixture = await tempFixture("directory-scope-ops-");
  const root = fixture.root, log = join(root, "calls.log");
  try {
    await cp(join(project, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
    await mkdir(join(root, "scripts/ops"), { recursive: true }); await copyFile(join(project, "scripts/ops.sh"), join(root, "scripts/ops.sh"));
    const record = (name: string) => `() { echo "${name} $*" >> '${posixPath(log)}'; case "$1" in ps) echo mixin-bot ;; esac\n}`;
    const ops = async (hostBun: boolean, ...args: string[]) => {
      // Exported functions stand in for the tools (PATH stubs are not reliable under Git Bash); "command -v bun" fails without host Bun.
      const tools = hostBun ? { "BASH_FUNC_bun%%": record("bun") }
        : { "BASH_FUNC_command%%": '() { if [ "$1" = -v ] && [ "$2" = bun ]; then return 1; fi; builtin command "$@"\n}' };
      const child = Bun.spawn([bash!, posixPath(join(root, "scripts/ops.sh")), "directory-scope", ...args], { cwd: root, stdin: "ignore", stdout: "pipe",
        stderr: "pipe", windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: "1", "BASH_FUNC_docker%%": record("docker"), ...tools,
          "BASH_FUNC_flock%%": "() { return 0;\n}", BOT_PORT: "", BOT_DOMAIN: "" } });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, out + err).toBe(0);
    };
    // Each ops.sh start costs seconds under Git Bash: three cover host Bun, the container, and arguments the tool must refuse.
    await ops(true, "all");
    await ops(false);
    await ops(false, "111", "all");
    expect((await readFile(log, "utf8")).trim().split("\n").filter(line => !line.startsWith("docker ps"))).toEqual([
      "bun run ops/tools/directory-admin.ts scope all",
      "docker exec mixin-bot bun run ops/tools/directory-admin.ts scope",
      "docker exec mixin-bot bun run ops/tools/directory-admin.ts scope 111 all",
    ]);
  } finally { await fixture.cleanup(); }
}, 30000);
