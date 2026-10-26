import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTENTION_RECENT_MS, changeScope, confirmRevocations, departmentRow, describeAttention, describeDirectory, doctorRows, listDepartments, readServiceStatus } from "../../scripts/ops/directory-admin.ts";
import { readDirectoryScope, sameScope, writeDirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { createApp } from "../../src/server/http-app.ts";
import type { ScanSummary } from "../../src/integrations/open-platform/identity-directory.ts";
import { tempFixture } from "../helpers/temp.ts";

const now = 1_800_000_000_000;
const scan = (complete: boolean): ScanSummary => ({ id: 7, trigger: "daily", startedAt: now - 60_000, complete, departments: 3, members: 40, added: 0,
  renamed: 0, replaced: 0, reverified: 1, revoked: 0, pendingRevocations: 0, conflicts: 0, failures: 0, ...(complete ? {} : { error: "部门遍历失败" }) });
const rows = (status: Parameters<typeof doctorRows>[0]) => doctorRows(status, now).map(row => row.split("\t").slice(0, 2).join(" "));

test("doctor rows: a Stream down for over two minutes fails; pending revocations and incomplete syncs need checking", () => {
  const directory = { mappings: 40, lastScan: scan(true), lastCompleteAt: now - 60_000 };
  expect(rows({ verificationOnly: false, stream: { connected: true, reconnects: 0 }, directory })).toEqual(["pass 事件 Stream", "pass 通讯录同步"]);
  // A short disconnect is a reconnect in progress; a long one (or a Stream that never started) fails.
  expect(rows({ verificationOnly: false, stream: { connected: false, reconnects: 1, disconnectedSince: now - 30_000 }, directory })[0]).toBe("warn 事件 Stream");
  expect(rows({ verificationOnly: false, stream: { connected: false, reconnects: 1, disconnectedSince: now - 180_000 }, directory })[0]).toBe("fail 事件 Stream");
  expect(rows({ verificationOnly: false, directory })[0]).toBe("fail 事件 Stream");
  // The verification instance has no Stream row.
  expect(rows({ verificationOnly: true, directory })).toEqual(["pass 通讯录同步"]);
  for (const changed of [{ ...directory, pending: { scanId: 7, count: 25 } }, { ...directory, lastScan: scan(false) }, { mappings: 0 }, undefined]) {
    expect(rows({ verificationOnly: true, ...(changed ? { directory: changed } : {}) })).toEqual(["warn 通讯录同步"]);
  }
  const detail = doctorRows({ verificationOnly: true, directory: { ...directory, pending: { scanId: 7, count: 25 } } }, now)[0]!;
  expect(detail).toContain("待确认撤销：25 个成员（第 7 轮）");
  expect(detail).not.toMatch(/[\r\n]/);
});

test("doctor rows: the service's attention counters warn while the last event is within a day; an older /health has no row", () => {
  const directory = { mappings: 40, lastScan: scan(true), lastCompleteAt: now - 60_000 };
  expect(rows({ verificationOnly: true, directory, attention: {} })).toEqual(["pass 通讯录同步", "pass 运行状况"]);
  const recent = { parked: { count: 2, lastAt: now - 3600_000, space: "群 g1" }, notSent: { count: 1, lastAt: now - 2 * ATTENTION_RECENT_MS, space: "单聊" } };
  expect(rows({ verificationOnly: true, directory, attention: recent })[1]).toBe("warn 运行状况");
  const detail = doctorRows({ verificationOnly: true, directory, attention: recent }, now)[1]!;
  expect(detail).toContain("停住的任务 2 次（最近 群 g1");
  expect(detail).toContain("未发出的模型请求 1 次（最近 单聊");
  expect(describeAttention(recent, now).map(event => [event.kind, event.recent])).toEqual([["parked", true], ["notSent", false]]);
  // Only old events: listed, not a warning (the counters clear only with a restart).
  expect(rows({ verificationOnly: true, directory, attention: { notSent: recent.notSent } })[1]).toBe("pass 运行状况");
  expect(rows({ verificationOnly: true, directory })).toEqual(["pass 通讯录同步"]);
});

test("status and confirmation go only to the recorded instance over the local control port", async () => {
  const fixture = await tempFixture("directory-admin-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = now;
  const confirmed: number[] = [];
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    health: () => ({ stream: { connected: true, reconnects: 2 }, directory: { mappings: 40, pending: { scanId: 7, count: 25 } },
      attention: { deliveryAbandoned: { count: 1, lastAt: now, space: "单聊" } } }),
    confirmRevocations: scanId => { confirmed.push(scanId); return scanId === 7 ? "started" : "stale"; } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const file = join(fixture.root, "instance.json");
  try {
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId, pid: process.pid, startedAt }));
    const status = await readServiceStatus(undefined, file);
    expect(status).toEqual({ stream: { connected: true, reconnects: 2 }, directory: { mappings: 40, pending: { scanId: 7, count: 25 } },
      attention: { deliveryAbandoned: { count: 1, lastAt: now, space: "单聊" } }, verificationOnly: false });
    expect(await confirmRevocations(7, undefined, file)).toContain("已确认");
    await expect(confirmRevocations(8, undefined, file)).rejects.toThrow("已不是待确认的撤销");
    expect(confirmed).toEqual([7, 8]);
    // Another instance on the port (a stale record) is refused before anything is sent.
    await writeFile(file, JSON.stringify({ port: server.port, token, instanceId: randomUUID(), pid: process.pid, startedAt }));
    await expect(readServiceStatus(undefined, file)).rejects.toThrow("不是当前实例");
    await writeFile(file, JSON.stringify({ port: server.port, token: "other", instanceId, pid: process.pid, startedAt }));
    await expect(confirmRevocations(7, undefined, file)).rejects.toThrow("实例口令不符");
    expect(confirmed).toEqual([7, 8]);
    await expect(readServiceStatus(undefined, join(fixture.root, "missing.json"))).rejects.toThrow("读不到服务实例记录");
  } finally { await server.stop(true); await fixture.cleanup(); }
});

test("departments and scope changes go to the recorded instance; malformed IDs are refused before the service acts", async () => {
  const fixture = await tempFixture("directory-scope-");
  const token = "test-admin-token", instanceId = randomUUID(), startedAt = now;
  const parents: string[] = [], scopes: (string[] | undefined)[] = [];
  const app = createApp({ isStopping: () => false, adminToken: token, shutdown: () => {}, instanceId, startedAt,
    listDepartments: async parent => { parents.push(parent); return [{ id: "100", name: "总部", count: 12 }, { id: "101", name: "保密\t部" }]; },
    changeScope: async departments => {
      if (departments?.includes("999")) throw new Error("部门 999 不存在或应用无权读取（code=404002）；范围未改");
      if (departments?.[0] === "300") return "unchanged";
      scopes.push(departments);
      return (departments ?? []).map(id => ({ id, name: "部门" + id, fullName: "集团/部门" + id }));
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
    const checked = await changeScope(["100", "101"], undefined, file);
    expect(checked !== "unchanged" && checked.map(departmentRow)).toEqual(["100\t-\t集团/部门100", "101\t-\t集团/部门101"]);
    expect(await changeScope(undefined, undefined, file)).toEqual([]);
    expect(await changeScope(["300"], undefined, file)).toBe("unchanged");
    await expect(changeScope(["100", "999"], undefined, file)).rejects.toThrow("部门 999 不存在");
    await expect(changeScope(["100", "100"], undefined, file)).rejects.toThrow("重复");
    await expect(changeScope([], undefined, file)).rejects.toThrow("1 到 200 个部门 ID");
    expect(scopes).toEqual([["100", "101"], undefined]);
    await writeFile(file, JSON.stringify({ port: server.port, token: "other", instanceId, pid: process.pid, startedAt }));
    await expect(changeScope(["100"], undefined, file)).rejects.toThrow("实例口令不符");
    expect(scopes).toHaveLength(2);
  } finally { await server.stop(true); await fixture.cleanup(); }
});

test("the scope file: absent means the whole directory; written atomically; anything malformed is refused", async () => {
  const fixture = await tempFixture("directory-scope-file-");
  const path = join(fixture.root, "config", "directory.json");
  try {
    expect(readDirectoryScope(path)).toBeUndefined();
    expect(describeDirectory({ mappings: 3 })[1]).toBe("同步范围：整个通讯录");
    await writeDirectoryScope(["100", "200"], path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ format: 1, departments: ["100", "200"] });
    expect(readDirectoryScope(path)).toEqual(["100", "200"]);
    expect(describeDirectory({ mappings: 3, scope: ["100", "200"] })[1]).toBe("同步范围：2 个部门（100、200）及其子部门");
    for (const bad of [{ format: 1, departments: [] }, { format: 1, departments: ["a b"] }, { format: 2, departments: ["1"] }, { format: 1, departments: ["1"], extra: 1 }, []]) {
      await writeFile(path, JSON.stringify(bad));
      expect(() => readDirectoryScope(path)).toThrow();
    }
    await writeDirectoryScope(undefined, path);
    expect(readDirectoryScope(path)).toBeUndefined();
    await writeDirectoryScope(undefined, path);
    // A blank change on the whole directory, or the same departments in another order, is no change.
    expect([sameScope(undefined, undefined), sameScope(["1", "2"], ["2", "1"])]).toEqual([true, true]);
    expect([sameScope(undefined, ["1"]), sameScope(["1"], undefined), sameScope(["1"], ["1", "2"]), sameScope(["1", "2"], ["1", "3"])]).toEqual([false, false, false, false]);
  } finally { await fixture.cleanup(); }
});
