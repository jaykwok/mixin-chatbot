import { afterAll, describe, mock, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, symlinkSync, type PathLike, type StatOptions } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSession, Harness, type HarnessInspection, type SubmissionId } from "@earendil-works/pi-durable";
import { groupSegment } from "../../src/agent/paths.ts";
import { GROUP_ROOT_LEASE } from "../../src/core/data-version.ts";
import { GROUP_DATABASE, GroupHarnesses, groupDatabasePath, type GroupHarnessesOptions } from "../../src/durable/groups.ts";
import { memberConversation, MemberDirectory } from "../../src/durable/identity.ts";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, gatedResponse, harnessOptions } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-groups-");
afterAll(() => fixture.cleanup());
let counter = 0;

function setup(options: Partial<GroupHarnessesOptions> = {}) {
  const { faux, models, model } = fauxModels();
  const root = options.root ?? join(fixture.root, `root-${++counter}`);
  mkdirSync(root, { recursive: true });
  const reports: unknown[] = [];
  const groups = new GroupHarnesses({ harnessOptions: harnessOptions(models), onReport: (error) => reports.push(error), ...options, root });
  return { faux, model, models, root, reports, groups };
}

/** A claimed group with one member; `running` leaves a generation task running, as a crash would (closing writes no outcome). */
async function seed(root: string, groupId: string, running = false): Promise<string> {
  const { groups, faux, model } = setup({ root });
  try {
    const handle = await groups.acquire(groupId);
    const { conversation } = await memberConversation(handle.harness, groupId, "m1", { model }, context);
    if (running) {
      const gate = gatedResponse("不会用到");
      faux.setResponses([gate.step]);
      await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
    }
    handle.release();
  } finally { await groups.closeAll(); }
  return groupDatabasePath(root, groupId);
}

/** Every row of every table through a fresh connection, closed again: any write since the last dump shows up. */
async function dump(path: string): Promise<string> {
  const db = await openGroupDatabase(path);
  try {
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const rows: Record<string, string[]> = {};
    for (const { name } of tables) rows[name] = (await db.all(`SELECT * FROM "${name}"`)).map((row) => JSON.stringify(row)).sort();
    return JSON.stringify(rows);
  } finally { await db.close(); }
}

async function taskStates(path: string): Promise<string[]> {
  const storage = await openGroupStorage(path);
  try { return (await storage.scanTasks({}, 100, undefined, context)).items.map((task) => task.state.status); }
  finally { await storage.close(context); }
}

/** No connection holds the database: the last close removed the WAL files, and Windows lets the file be renamed. */
function expectReleased(path: string): void {
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(existsSync(`${path}-shm`)).toBe(false);
  renameSync(path, `${path}.moved`);
  renameSync(`${path}.moved`, path);
}

/** Every Harness opened meanwhile (the real one; `inspect` replaced when `failInspect` is set). */
async function withOpenedHarnesses<T>(use: (opened: Harness[], failInspect: { on: boolean }) => Promise<T>): Promise<T> {
  const open = Harness.open;
  const opened: Harness[] = [];
  const failInspect = { on: false };
  Harness.open = async (...args) => {
    const harness = await open(...args);
    opened.push(harness);
    if (failInspect.on) harness.inspect = async () => { throw new Error("inspect failed"); };
    return harness;
  };
  try { return await use(opened, failInspect); } finally { Harness.open = open; }
}

/** `lstat` of one path fails with `code` while `use` runs (node:fs/promises as groups.ts imports it); returns the hits. */
async function withLstatFault(path: string, code: string, use: () => Promise<void>): Promise<number> {
  const fs = await import("node:fs/promises");
  // mock.module rewrites the imported namespace too: keep the real function before replacing it.
  const real = fs.lstat;
  let hits = 0;
  mock.module("node:fs/promises", () => ({ ...fs, lstat: async (target: PathLike, options?: StatOptions) => {
    if (resolve(String(target)) === resolve(path)) { hits++; throw Object.assign(new Error(`${code}: injected`), { code }); }
    return real(target, options);
  } }));
  try { await use(); } finally { mock.module("node:fs/promises", () => ({ ...fs, lstat: real })); }
  return hits;
}

/** The rejection of a discovery expected to fail. */
async function failedDiscovery(groups: GroupHarnesses): Promise<Error> {
  return groups.discover().then((found) => { throw new Error(`discovery succeeded: ${JSON.stringify(found)}`); }, (error: Error) => error);
}

describe("per-group Harness cache", () => {
  test("opens each group paused in its own database, claims it, and shares one Harness between handles", async () => {
    const { groups, root } = setup();
    try {
      const [a, b] = await Promise.all([groups.acquire("group-a"), groups.acquire("group-a")]);
      expect(a.harness).toBe(b.harness);
      expect((await a.harness.inspect(context)).scheduling).toBe("paused");
      expect(existsSync(join(root, "group-a", GROUP_DATABASE))).toBe(true);
      const unsafe = await groups.acquire("群/../x");
      expect(existsSync(groupDatabasePath(root, "群/../x"))).toBe(true);
      expect(groupSegment("群/../x")).toStartWith("sha256-");
      expect(groups.openGroups).toEqual(["group-a", "群/../x"].sort());
      a.release(); a.release(); b.release(); unsafe.release();
    } finally { await groups.closeAll(); }
  });

  test("a database moved into another group's directory is refused", async () => {
    const { groups, root } = setup();
    try {
      const handle = await groups.acquire("group-a");
      handle.release();
      await groups.closeAll();
      mkdirSync(join(root, "group-b"));
      copyFileSync(groupDatabasePath(root, "group-a"), groupDatabasePath(root, "group-b"));
      const fresh = setup({ root });
      await expect(fresh.groups.acquire("group-b")).rejects.toThrow("属于另一个群");
      expect(fresh.groups.openGroups).toEqual([]);
      await expect(fresh.groups.discover()).rejects.toThrow("与所在目录不符");
      await fresh.groups.closeAll();
    } finally { await groups.closeAll(); }
  });

  test("keeps at most maxIdle idle groups, least recently used closed first; data survives reopen", async () => {
    const { groups, model } = setup({ maxIdle: 1 });
    try {
      for (const group of ["a", "b", "c"]) {
        const handle = await groups.acquire(group);
        await memberConversation(handle.harness, group, "m1", { model }, context);
        handle.release();
        await groups.sweep();
      }
      expect(groups.openGroups).toEqual(["c"]);
      const again = await groups.acquire("a");
      expect((await memberConversation(again.harness, "a", "m1", { model }, context)).created).toBe(false);
      again.release();
      await groups.sweep();
      expect(groups.openGroups).toEqual(["a"]);
    } finally { await groups.closeAll(); }
  });

  test("a group with a live task or application work is never evicted", async () => {
    let pending = true;
    const { groups, faux, model } = setup({ maxIdle: 0, pendingWork: async (_harness, groupId) => groupId === "pending" && pending });
    try {
      const busy = await groups.acquire("busy");
      const { conversation } = await memberConversation(busy.harness, "busy", "m1", { model }, context);
      const gate = gatedResponse("回答");
      faux.setResponses([gate.step]);
      const submission = await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
      busy.release();
      (await groups.acquire("pending")).release();
      await groups.sweep();
      expect(groups.openGroups).toEqual(["busy", "pending"]);
      gate.open();
      expect((await submission.wait(context)).status).toBe("done");
      await conversation.waitForIdle(context);
      pending = false;
      await groups.sweep();
      expect(groups.openGroups).toEqual([]);
    } finally { await groups.closeAll(); }
  });

  test("an eviction that misses a task the Harness started meanwhile reopens the group for it", async () => {
    const { groups, faux, model } = setup({ maxIdle: 0 });
    try {
      const handle = await groups.acquire("racy");
      const { conversation } = await memberConversation(handle.harness, "racy", "m1", { model }, context);
      const gate = gatedResponse("不会用到");
      faux.setResponses([gate.step]);
      const submission = await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
      // Simulate the race: the work check sees nothing, as if the task had been created just after it.
      const first = handle.harness;
      first.inspect = async (): Promise<HarnessInspection> => ({ scheduling: "running", tasks: [], submissions: [] });
      handle.release();
      await groups.sweep();
      expect(groups.openGroups).toEqual(["racy"]);
      const reopened = await groups.acquire("racy");
      expect(reopened.harness).not.toBe(first);
      const inspection = await reopened.harness.inspect(context);
      expect(inspection.scheduling).toBe("paused");
      expect(inspection.tasks.length).toBeGreaterThan(0);
      faux.setResponses([fauxAssistantMessage("重开后的回答")]);
      reopened.harness.resume();
      expect((await (await reopened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
      reopened.release();
    } finally { await groups.closeAll(); }
  });

  test("discovery opens every group with work, paused, and closes the rest", async () => {
    const first = setup();
    const { root } = first;
    const gate = gatedResponse("不会用到");
    let submissionId: SubmissionId | undefined;
    try {
      for (const group of ["idle-a", "busy-b"]) {
        const handle = await first.groups.acquire(group);
        const { conversation } = await memberConversation(handle.harness, group, "m1", { model: first.model }, context);
        if (group === "busy-b") {
          first.faux.setResponses([gate.step]);
          submissionId = (await conversation.submit({ type: "input", content: "问题" }, context)).id;
          await gate.started;
        }
        handle.release();
      }
    } finally { await first.groups.closeAll(); } // like a restart: the open request is aborted, the task stays live
    await (await openGroupStorage(join(root, "unclaimed", GROUP_DATABASE))).close(context);
    mkdirSync(join(root, "no-database"));
    mkdirSync(join(root, GROUP_ROOT_LEASE));

    const second = setup({ root });
    try {
      expect(await second.groups.discover()).toEqual(["busy-b"]);
      expect(second.groups.openGroups).toEqual(["busy-b"]);
      expect(second.reports.map(String)).toEqual([expect.stringContaining("没有登记群标识")]);
      const handle = await second.groups.acquire("busy-b");
      const inspection = await handle.harness.inspect(context);
      expect(inspection.scheduling).toBe("paused");
      expect(inspection.tasks.length).toBeGreaterThan(0);
      second.faux.setResponses([fauxAssistantMessage("重启后的回答")]);
      handle.harness.resume();
      expect((await (await handle.harness.submission(submissionId!, context))!.wait(context)).status).toBe("done");
      handle.release();
    } finally { await second.groups.closeAll(); }
  });

  test("after closeAll no group opens and discovery is refused", async () => {
    const { groups } = setup();
    (await groups.acquire("a")).release();
    await groups.closeAll(new Error("租约丢失"));
    expect(groups.openGroups).toEqual([]);
    await expect(groups.acquire("a")).rejects.toThrow("租约丢失");
    await expect(groups.discover()).rejects.toThrow("租约丢失");
  });
});

describe("connections that are still opening, failing or refused", () => {
  // D1-R1-2: the Harness options, the work check and prepare are application code that may block for any time.
  const blocking = [["discover", "open"], ["discover", "pendingWork"], ["discover", "prepare"], ["acquire", "open"], ["acquire", "prepare"]] as const;
  for (const [operation, point] of blocking) {
    test(`closeAll while ${operation} is blocked in ${point} closes its connection at once; nothing commits afterwards`, async () => {
      const root = join(fixture.root, `root-${++counter}`);
      const path = await seed(root, "g");
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const block = async (at: string) => { if (at === point) { reached.resolve(); await gate.promise; } };
      let captured: Harness | undefined;
      let given: Context | undefined;
      const { models, model } = fauxModels();
      const options = harnessOptions(models);
      const { groups, reports } = setup({ root,
        harnessOptions: async () => { await block("open"); return options(); },
        pendingWork: async (harness, _groupId, callbackContext) => { captured = harness; given = callbackContext; await block("pendingWork"); return true; },
        prepare: async (harness, groupId, callbackContext) => {
          captured = harness; given = callbackContext;
          await block("prepare");
          await memberConversation(harness, groupId, "prepared", { model }, callbackContext);
        },
      });
      const before = await dump(path);
      const pending = (operation === "discover" ? groups.discover() : groups.acquire("g")).then(() => "resolved", (error: unknown) => error);
      await reached.promise;
      await groups.closeAll(new Error("租约丢失"));
      // closeAll returned while the callback is still blocked: its connection is already closed.
      expect(groups.openGroups).toEqual([]);
      expectReleased(path);
      if (point === "open") expect(captured).toBeUndefined();
      else {
        expect(given?.abortSignal?.aborted).toBe(true);
        await expect(memberConversation(captured!, "g", "after-close", { model }, context)).rejects.toThrow("closed");
      }
      expect(await dump(path)).toBe(before);
      gate.resolve();
      expect(String(await pending)).toContain("租约丢失");
      // Released, the callback met a closed Harness (blocked in open, no Harness opened at all): still nothing written.
      expect(captured === undefined).toBe(point === "open");
      expectReleased(path);
      expect(await dump(path)).toBe(before);
      expect(reports).toEqual([]);
    });
  }

  test("a prepare blocked inside an admitted commit holds closeAll until the commit settles; nothing commits after it", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const path = await seed(root, "g");
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let captured: Harness | undefined;
    const { groups, model } = setup({ root, prepare: async (harness, _groupId, callbackContext) => {
      captured = harness;
      await harness.commit(async (tx) => {
        (await tx.doc(MemberDirectory, "inside", { conversationId: 0, createdAt: 0 })).createdAt = 1;
        reached.resolve();
        await gate.promise;
      }, callbackContext);
    } });
    const acquiring = groups.acquire("g").then(() => "resolved", (error: unknown) => error);
    await reached.promise;
    let closed = false;
    const closing = groups.closeAll(new Error("租约丢失")).then(() => { closed = true; });
    await Bun.sleep(300);
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(String(await acquiring)).toContain("租约丢失");
    await expect(memberConversation(captured!, "g", "after-close", { model }, context)).rejects.toThrow("closed");
    expectReleased(path);
    const storage = await openGroupStorage(path);
    try {
      const reader = createSession(storage);
      expect(await reader.snapshot(MemberDirectory, "inside", context)).toEqual({ conversationId: 0, createdAt: 1 });
      expect(await reader.snapshot(MemberDirectory, "after-close", context)).toBeUndefined();
    } finally { await storage.close(context); }
  });

  // D1-R1-3: every failure between opening and handing the connection over closes it and keeps the original error.
  for (const point of ["inspect", "pendingWork", "prepare"] as const) {
    test(`a discovery whose ${point} fails closes its connection and keeps the error; the next discovery opens exactly one`, async () => {
      const root = join(fixture.root, `root-${++counter}`);
      const path = await seed(root, "g");
      let fail = true;
      const { groups, model, reports } = setup({ root,
        pendingWork: async () => { if (fail && point === "pendingWork") throw new Error("pendingWork failed"); return true; },
        prepare: async () => { if (fail && point === "prepare") throw new Error("prepare failed"); },
      });
      await withOpenedHarnesses(async (opened, failInspect) => {
        failInspect.on = point === "inspect";
        const before = await dump(path);
        await expect(groups.discover()).rejects.toThrow(`${point} failed`);
        expect(groups.openGroups).toEqual([]);
        expect(opened).toHaveLength(1);
        await expect(memberConversation(opened[0]!, "g", "after-failure", { model }, context)).rejects.toThrow("closed");
        expectReleased(path);
        expect(await dump(path)).toBe(before);
        fail = false;
        failInspect.on = false;
        expect(await groups.discover()).toEqual(["g"]);
        expect(opened).toHaveLength(2);
        await groups.closeAll();
        // Closing the one connection the second discovery opened released the file: no other was left open.
        expectReleased(path);
        expect(reports).toEqual([]);
      });
    });
  }

  // D1-R1-4: opening a Harness recovers interrupted tasks (a write), so ownership is checked before it.
  test("another group's database is refused by acquire and discovery before any recovery; the own group still recovers", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const own = await seed(root, "group-a", true);
    mkdirSync(join(root, "group-b"));
    const moved = groupDatabasePath(root, "group-b");
    copyFileSync(own, moved);
    expect(await taskStates(moved)).toEqual(["running"]);
    const before = await dump(moved);
    const { groups } = setup({ root });
    await withOpenedHarnesses(async (opened) => {
      await expect(groups.acquire("group-b")).rejects.toThrow("属于另一个群");
      expect(opened).toHaveLength(0);
      expectReleased(moved);
      expect(await dump(moved)).toBe(before);
      // Discovery opens group-a (sorted first, its own database) and refuses group-b without a Harness.
      await expect(groups.discover()).rejects.toThrow("与所在目录不符");
      expect(opened).toHaveLength(1);
      expect(groups.openGroups).toEqual(["group-a"]);
      await groups.closeAll();
    });
    expectReleased(moved);
    expect(await dump(moved)).toBe(before);
    expect(await taskStates(moved)).toEqual(["running"]);
    // The normal path: opening the group's own database recovered the same interrupted task.
    expect(await taskStates(own)).toEqual(["pending"]);
  });

  test("a database with data but no recorded group is refused, never claimed, by acquire and discovery", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const path = groupDatabasePath(root, "lost");
    const { faux, models, model } = fauxModels();
    const harness = await Harness.open(await openGroupStorage(path), harnessOptions(models)(), context);
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
      const gate = gatedResponse("不会用到");
      faux.setResponses([gate.step]);
      await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
    } finally { await harness.close(context); }
    expect(await taskStates(path)).toEqual(["running"]);
    const before = await dump(path);
    const { groups, reports } = setup({ root });
    await withOpenedHarnesses(async (opened) => {
      await expect(groups.acquire("lost")).rejects.toThrow("有数据但没有登记群标识");
      expect(await groups.discover()).toEqual([]);
      expect(reports.map(String)).toEqual([expect.stringContaining("没有登记群标识")]);
      expect(opened).toHaveLength(0);
      await groups.closeAll();
    });
    expectReleased(path);
    expect(await dump(path)).toBe(before);
    expect(await taskStates(path)).toEqual(["running"]);
  });
});

describe("discovery skips only databases that do not exist", () => {
  // D1-R2-1: a group with work whose database cannot be checked must not vanish from a discovery that looks complete.
  for (const code of ["EACCES", "EIO"]) {
    test(`a database of a group with work that fails with ${code} fails discovery; once it can be read the group is found`, async () => {
      const root = join(fixture.root, `root-${++counter}`);
      const path = await seed(root, "busy", true);
      mkdirSync(join(root, "no-database"));
      const before = await dump(path);
      const { groups, reports } = setup({ root });
      await withOpenedHarnesses(async (opened) => {
        const hits = await withLstatFault(path, code, async () => {
          const error = await failedDiscovery(groups);
          expect(error.message).toContain("发现不完整");
          expect((error.cause as NodeJS.ErrnoException).code).toBe(code);
        });
        expect(hits).toBe(1);
        expect(opened).toHaveLength(0);
        expect(groups.openGroups).toEqual([]);
        expect(reports).toEqual([]);
        expect(await dump(path)).toBe(before);
        // The same database once the fault is gone; the directory without a database is still skipped.
        expect(await groups.discover()).toEqual(["busy"]);
        expect(opened).toHaveLength(1);
        await groups.closeAll();
      });
    });
  }

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a group directory this user may not enter fails discovery with the real EACCES; with access restored the group is found", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    await seed(root, "busy", true);
    const directory = join(root, "busy");
    const { groups, reports } = setup({ root });
    chmodSync(directory, 0o000);
    try {
      const error = await failedDiscovery(groups);
      expect(error.message).toContain("发现不完整");
      expect((error.cause as NodeJS.ErrnoException).code).toBe("EACCES");
      expect(groups.openGroups).toEqual([]);
      expect(reports).toEqual([]);
    } finally { chmodSync(directory, 0o700); }
    expect(await groups.discover()).toEqual(["busy"]);
    await groups.closeAll();
  });

  test("a symbolic link in the root or as the root fails discovery, as does a database path that is not a file; a missing root has none", async () => {
    // Junctions on Windows need no privilege and read as symbolic links; elsewhere the type is ignored.
    const linked = join(fixture.root, `root-${++counter}`);
    await seed(linked, "busy", true);
    symlinkSync(join(linked, "busy"), join(linked, "alias"), "junction");
    const first = setup({ root: linked });
    expect((await failedDiscovery(first.groups)).message).toContain("符号链接");
    expect(first.groups.openGroups).toEqual([]);

    const alias = join(fixture.root, `root-${++counter}`);
    symlinkSync(linked, alias, "junction");
    const second = new GroupHarnesses({ root: alias, harnessOptions: harnessOptions(fauxModels().models) });
    expect((await failedDiscovery(second)).message).toContain("符号链接");

    // Sorted before the odd one, "busy" opens first and stays open until closeAll.
    const odd = join(fixture.root, `root-${++counter}`);
    await seed(odd, "busy", true);
    mkdirSync(join(odd, "odd", GROUP_DATABASE), { recursive: true });
    const third = setup({ root: odd });
    expect((await failedDiscovery(third.groups)).message).toContain("不是普通文件");
    expect(third.groups.openGroups).toEqual(["busy"]);
    await third.groups.closeAll();

    const absent = new GroupHarnesses({ root: join(fixture.root, "no-such-root"), harnessOptions: harnessOptions(fauxModels().models) });
    expect(await absent.discover()).toEqual([]);
  });
});
