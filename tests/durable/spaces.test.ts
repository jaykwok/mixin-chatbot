import { afterAll, describe, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, symlinkSync, type PathLike, type StatOptions } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, createSession, defineExtension, Harness, type HarnessInspection, type SubmissionId } from "@earendil-works/pi-durable";
import { appLayout, DIRECT_SCOPE, groupScope as g, groupSegment, scopeKey, spaceDatabase, type Scope } from "../../src/core/layout.ts";
import { SpaceHarnesses, type SpaceHarnessesOptions } from "../../src/durable/spaces.ts";
import { memberConversation, MemberDirectory } from "../../src/durable/identity.ts";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, gatedResponse, harnessOptions } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-spaces-");
afterAll(() => fixture.cleanup());
let counter = 0;

/** A data directory per setup unless `root` names one; `groups` is the space cache over its conversations. */
function setup(options: Partial<SpaceHarnessesOptions> & { root?: string } = {}) {
  const { faux, models, model } = fauxModels();
  const { root: given, ...rest } = options;
  const root = given ?? join(fixture.root, `root-${++counter}`);
  mkdirSync(root, { recursive: true });
  const reports: unknown[] = [];
  const groups = new SpaceHarnesses({ harnessOptions: harnessOptions(models), onReport: (error) => reports.push(error), ...rest, layout: appLayout(root) });
  return { faux, model, models, root, reports, groups };
}

/** The database of group `groupId` below the data directory `root`, and its space directory. */
const dbPath = (root: string, groupId: string) => spaceDatabase(appLayout(root), g(groupId));
const spaceDir = (root: string, groupId: string) => dirname(dbPath(root, groupId));
const keys = (scopes: Scope[]) => scopes.map(scopeKey);

/** A claimed group with one member; `running` leaves a generation task running, as a crash would (crashImage). */
async function seed(root: string, groupId: string, running = false): Promise<string> {
  const { groups, faux, model } = setup({ root });
  let crash: (() => void) | undefined;
  try {
    const handle = await groups.acquire(g(groupId));
    const { conversation } = await memberConversation(handle.harness, g(groupId), "m1", { model }, context);
    if (running) {
      const gate = gatedResponse("不会用到");
      faux.setResponses([gate.step]);
      await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
      crash = crashImage(dbPath(root, groupId));
    }
    handle.release();
  } finally { await groups.closeAll(); }
  crash?.();
  return dbPath(root, groupId);
}

/**
 * The committed state of `path` now, as a crash would leave it; the returned function puts it in place once every
 * connection is closed. Since Durable 1.4.0 a close writes the tasks it stopped back as `pending`, so only a crash
 * leaves one `running` (and the next open's recovery then writes).
 */
function crashImage(path: string): () => void {
  const image = `${path}.crash`, db = new Database(path, { readonly: true });
  try { db.query("VACUUM INTO ?").run(image); } finally { db.close(); }
  return () => renameSync(image, path);
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

/** `lstat` of one path fails with `code` while `use` runs (node:fs/promises as spaces.ts imports it); returns the hits. */
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
async function failedDiscovery(groups: SpaceHarnesses): Promise<Error> {
  return groups.discover().then((found) => { throw new Error(`discovery succeeded: ${JSON.stringify(found)}`); }, (error: Error) => error);
}

describe("per-space Harness cache", () => {
  test("opens each space paused in its own database, claims it, and shares one Harness between handles", async () => {
    const { groups, root } = setup();
    try {
      const [a, b] = await Promise.all([groups.acquire(g("group-a")), groups.acquire(g("group-a"))]);
      expect(a.harness).toBe(b.harness);
      expect((await a.harness.inspect(context)).scheduling).toBe("paused");
      expect(existsSync(join(root, "conversations", "groups", "group-a", "durable.sqlite"))).toBe(true);
      const unsafe = await groups.acquire(g("群/../x"));
      expect(existsSync(dbPath(root, "群/../x"))).toBe(true);
      expect(groupSegment("群/../x")).toStartWith("sha256-");
      // All direct chats share one space, separate from every group, even one whose id is "direct".
      const [direct, named] = await Promise.all([groups.acquire(DIRECT_SCOPE), groups.acquire(g("direct"))]);
      expect(direct.harness).not.toBe(named.harness);
      expect(existsSync(join(root, "conversations", "direct", "durable.sqlite"))).toBe(true);
      expect(existsSync(join(root, "conversations", "groups", "direct", "durable.sqlite"))).toBe(true);
      expect(groups.openSpaces).toEqual(["direct", "group:direct", "group:group-a", "group:群/../x"].sort());
      a.release(); a.release(); b.release(); unsafe.release(); direct.release(); named.release();
    } finally { await groups.closeAll(); }
  });

  test("the direct database moved into a group's directory is refused, and a group's into the direct one", async () => {
    const { groups, root } = setup();
    try {
      (await groups.acquire(DIRECT_SCOPE)).release();
      (await groups.acquire(g("group-a"))).release();
      await groups.closeAll();
      const direct = join(root, "conversations", "direct", "durable.sqlite"), group = dbPath(root, "group-a");
      const swapped = join(root, "swapped.sqlite");
      renameSync(direct, swapped);
      renameSync(group, direct);
      renameSync(swapped, group);
      const fresh = setup({ root });
      await expect(fresh.groups.acquire(DIRECT_SCOPE)).rejects.toThrow("属于另一个空间");
      await expect(fresh.groups.acquire(g("group-a"))).rejects.toThrow("属于另一个空间");
      await expect(fresh.groups.discover()).rejects.toThrow("与所在目录不符");
      await fresh.groups.closeAll();
    } finally { await groups.closeAll(); }
  });

  test("a database moved into another group's directory is refused", async () => {
    const { groups, root } = setup();
    try {
      const handle = await groups.acquire(g("group-a"));
      handle.release();
      await groups.closeAll();
      mkdirSync(spaceDir(root, "group-b"));
      copyFileSync(dbPath(root, "group-a"), dbPath(root, "group-b"));
      const fresh = setup({ root });
      await expect(fresh.groups.acquire(g("group-b"))).rejects.toThrow("属于另一个空间");
      expect(fresh.groups.openSpaces).toEqual([]);
      await expect(fresh.groups.discover()).rejects.toThrow("与所在目录不符");
      await fresh.groups.closeAll();
    } finally { await groups.closeAll(); }
  });

  test("keeps at most maxIdle idle groups, least recently used closed first; data survives reopen", async () => {
    const { groups, model } = setup({ maxIdle: 1 });
    try {
      for (const group of ["a", "b", "c"]) {
        const handle = await groups.acquire(g(group));
        await memberConversation(handle.harness, g(group), "m1", { model }, context);
        handle.release();
        await groups.sweep();
      }
      expect(groups.openSpaces).toEqual(["group:c"]);
      const again = await groups.acquire(g("a"));
      expect((await memberConversation(again.harness, g("a"), "m1", { model }, context)).created).toBe(false);
      again.release();
      await groups.sweep();
      expect(groups.openSpaces).toEqual(["group:a"]);
    } finally { await groups.closeAll(); }
  });

  test("a group with a live task or application work is never evicted", async () => {
    let pending = true;
    const { groups, faux, model } = setup({ maxIdle: 0, pendingWork: async (_harness, scope) => scopeKey(scope) === "group:pending" && pending });
    try {
      const busy = await groups.acquire(g("busy"));
      const { conversation } = await memberConversation(busy.harness, g("busy"), "m1", { model }, context);
      const gate = gatedResponse("回答");
      faux.setResponses([gate.step]);
      const submission = await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
      busy.release();
      (await groups.acquire(g("pending"))).release();
      await groups.sweep();
      expect(groups.openSpaces).toEqual(["group:busy", "group:pending"]);
      gate.open();
      expect((await submission.wait(context)).status).toBe("done");
      await conversation.waitForIdle(context);
      pending = false;
      await groups.sweep();
      expect(groups.openSpaces).toEqual([]);
    } finally { await groups.closeAll(); }
  });

  test("an eviction that misses a task the Harness started meanwhile reopens the group for it", async () => {
    const { groups, faux, model } = setup({ maxIdle: 0 });
    try {
      const handle = await groups.acquire(g("racy"));
      const { conversation } = await memberConversation(handle.harness, g("racy"), "m1", { model }, context);
      const gate = gatedResponse("不会用到");
      faux.setResponses([gate.step]);
      const submission = await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
      // Simulate the race: the work check sees nothing, as if the task had been created just after it.
      const first = handle.harness;
      first.inspect = async (): Promise<HarnessInspection> => ({ scheduling: "running", tasks: [], submissions: [] });
      handle.release();
      await groups.sweep();
      expect(groups.openSpaces).toEqual(["group:racy"]);
      const reopened = await groups.acquire(g("racy"));
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
        const handle = await first.groups.acquire(g(group));
        const { conversation } = await memberConversation(handle.harness, g(group), "m1", { model: first.model }, context);
        if (group === "busy-b") {
          first.faux.setResponses([gate.step]);
          submissionId = (await conversation.submit({ type: "input", content: "问题" }, context)).id;
          await gate.started;
        }
        handle.release();
      }
    } finally { await first.groups.closeAll(); } // like a restart: the open request is aborted, the task stays live
    await (await openGroupStorage(dbPath(root, "unclaimed"))).close(context);
    mkdirSync(spaceDir(root, "no-database"));
    mkdirSync(join(root, "conversations", "groups", "not a segment"));
    mkdirSync(join(root, "conversations", "other"));

    const second = setup({ root });
    try {
      expect(keys(await second.groups.discover())).toEqual(["group:busy-b"]);
      expect(second.groups.openSpaces).toEqual(["group:busy-b"]);
      expect(second.reports.map(String)).toEqual([expect.stringContaining("没有登记空间")]);
      const handle = await second.groups.acquire(g("busy-b"));
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
    (await groups.acquire(g("a"))).release();
    await groups.closeAll(new Error("租约丢失"));
    expect(groups.openSpaces).toEqual([]);
    await expect(groups.acquire(g("a"))).rejects.toThrow("租约丢失");
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
        pendingWork: async (harness, _scope, callbackContext) => { captured = harness; given = callbackContext; await block("pendingWork"); return true; },
        prepare: async (harness, scope, callbackContext) => {
          captured = harness; given = callbackContext;
          await block("prepare");
          await memberConversation(harness, scope, "prepared", { model }, callbackContext);
        },
      });
      const before = await dump(path);
      const pending = (operation === "discover" ? groups.discover() : groups.acquire(g("g"))).then(() => "resolved", (error: unknown) => error);
      await reached.promise;
      await groups.closeAll(new Error("租约丢失"));
      // closeAll returned while the callback is still blocked: its connection is already closed.
      expect(groups.openSpaces).toEqual([]);
      expectReleased(path);
      if (point === "open") expect(captured).toBeUndefined();
      else {
        expect(given?.abortSignal?.aborted).toBe(true);
        await expect(memberConversation(captured!, g("g"), "after-close", { model }, context)).rejects.toThrow("closed");
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
    const { groups, model } = setup({ root, prepare: async (harness, _scope, callbackContext) => {
      captured = harness;
      await harness.commit(async (tx) => {
        (await tx.doc(MemberDirectory, "inside", { conversationId: 0, createdAt: 0 })).createdAt = 1;
        reached.resolve();
        await gate.promise;
      }, callbackContext);
    } });
    const acquiring = groups.acquire(g("g")).then(() => "resolved", (error: unknown) => error);
    await reached.promise;
    let closed = false;
    const closing = groups.closeAll(new Error("租约丢失")).then(() => { closed = true; });
    await Bun.sleep(300);
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(String(await acquiring)).toContain("租约丢失");
    await expect(memberConversation(captured!, g("g"), "after-close", { model }, context)).rejects.toThrow("closed");
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
        expect(groups.openSpaces).toEqual([]);
        expect(opened).toHaveLength(1);
        await expect(memberConversation(opened[0]!, g("g"), "after-failure", { model }, context)).rejects.toThrow("closed");
        expectReleased(path);
        expect(await dump(path)).toBe(before);
        fail = false;
        failInspect.on = false;
        expect(keys(await groups.discover())).toEqual(["group:g"]);
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
    mkdirSync(spaceDir(root, "group-b"));
    const moved = dbPath(root, "group-b");
    copyFileSync(own, moved);
    expect(await taskStates(moved)).toEqual(["running"]);
    const before = await dump(moved);
    const { groups } = setup({ root });
    await withOpenedHarnesses(async (opened) => {
      await expect(groups.acquire(g("group-b"))).rejects.toThrow("属于另一个空间");
      expect(opened).toHaveLength(0);
      expectReleased(moved);
      expect(await dump(moved)).toBe(before);
      // Discovery opens group-a (sorted first, its own database) and refuses group-b without a Harness.
      await expect(groups.discover()).rejects.toThrow("与所在目录不符");
      expect(opened).toHaveLength(1);
      expect(groups.openSpaces).toEqual(["group:group-a"]);
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
    const path = dbPath(root, "lost");
    const { faux, models, model } = fauxModels();
    const harness = await Harness.open(await openGroupStorage(path), harnessOptions(models)(), context);
    let crash: (() => void) | undefined;
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
      const gate = gatedResponse("不会用到");
      faux.setResponses([gate.step]);
      await conversation.submit({ type: "input", content: "问题" }, context);
      await gate.started;
      crash = crashImage(path);
    } finally { await harness.close(context); }
    crash?.();
    expect(await taskStates(path)).toEqual(["running"]);
    const before = await dump(path);
    const { groups, reports } = setup({ root });
    await withOpenedHarnesses(async (opened) => {
      await expect(groups.acquire(g("lost"))).rejects.toThrow("有数据但没有登记空间");
      expect(keys(await groups.discover())).toEqual([]);
      expect(reports.map(String)).toEqual([expect.stringContaining("没有登记空间")]);
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
      mkdirSync(spaceDir(root, "no-database"));
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
        expect(groups.openSpaces).toEqual([]);
        expect(reports).toEqual([]);
        expect(await dump(path)).toBe(before);
        // The same database once the fault is gone; the directory without a database is still skipped.
        expect(keys(await groups.discover())).toEqual(["group:busy"]);
        expect(opened).toHaveLength(1);
        await groups.closeAll();
      });
    });
  }

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a group directory this user may not enter fails discovery with the real EACCES; with access restored the group is found", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    await seed(root, "busy", true);
    const directory = spaceDir(root, "busy");
    const { groups, reports } = setup({ root });
    chmodSync(directory, 0o000);
    try {
      const error = await failedDiscovery(groups);
      expect(error.message).toContain("发现不完整");
      expect((error.cause as NodeJS.ErrnoException).code).toBe("EACCES");
      expect(groups.openSpaces).toEqual([]);
      expect(reports).toEqual([]);
    } finally { chmodSync(directory, 0o700); }
    expect(keys(await groups.discover())).toEqual(["group:busy"]);
    await groups.closeAll();
  });

  test("a symbolic link in the root or as the root fails discovery, as does a database path that is not a file; a missing root has none", async () => {
    // Junctions on Windows need no privilege and read as symbolic links; elsewhere the type is ignored.
    const linked = join(fixture.root, `root-${++counter}`);
    await seed(linked, "busy", true);
    symlinkSync(spaceDir(linked, "busy"), spaceDir(linked, "alias"), "junction");
    const first = setup({ root: linked });
    expect((await failedDiscovery(first.groups)).message).toContain("符号链接");
    expect(first.groups.openSpaces).toEqual([]);

    const alias = join(fixture.root, `root-${++counter}`);
    mkdirSync(alias);
    symlinkSync(join(linked, "conversations"), join(alias, "conversations"), "junction");
    const second = new SpaceHarnesses({ layout: appLayout(alias), harnessOptions: harnessOptions(fauxModels().models) });
    expect((await failedDiscovery(second)).message).toContain("符号链接");

    // Sorted before the odd one, "busy" opens first and stays open until closeAll.
    const odd = join(fixture.root, `root-${++counter}`);
    await seed(odd, "busy", true);
    mkdirSync(dbPath(odd, "odd"), { recursive: true });
    const third = setup({ root: odd });
    expect((await failedDiscovery(third.groups)).message).toContain("不是普通文件");
    expect(third.groups.openSpaces).toEqual(["group:busy"]);
    await third.groups.closeAll();

    const absent = new SpaceHarnesses({ layout: appLayout(join(fixture.root, "no-such-root")), harnessOptions: harnessOptions(fauxModels().models) });
    expect(keys(await absent.discover())).toEqual([]);
  });
});

describe("a failed Session", () => {
  test("a Session that fails without a storage error (the Harness's own bookkeeping) stops the process as a storage failure does", async () => {
    const fatal: Error[] = [];
    const { groups, root } = setup({ onFatal: (error) => fatal.push(error) });
    try {
      const handle = await groups.acquire(g("g1"));
      // Internal to Durable (SessionImpl.fail): what the scheduler calls for a throw in its own commits.
      (handle.harness as unknown as { fail(error: unknown): void }).fail(new Error("synthetic bookkeeping failure"));
      await handle.harness.closed;
      await Bun.sleep(0);
      expect(fatal.map((error) => error.message)).toEqual([`会话库会话已失败，需重启服务：${dbPath(root, "g1")}`]);
      expect((fatal[0]!.cause as Error).message).toBe("synthetic bookkeeping failure");
      handle.release();
      await expect(groups.acquire(g("g2"))).rejects.toBe(fatal[0]);
    } finally { await groups.closeAll(); }
  });

  test("the stop is decided when the failure closes the Session, while a running tool still holds its close", async () => {
    const fatal: Error[] = [];
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const { faux, models, model } = fauxModels();
    const hold = { name: "hold", description: "Waits until the test releases it.", parameters: Type.Object({}), replay: "unsafe" as const,
      execute: async () => { start(); await held; return { output: [{ type: "text" as const, text: "done" }] }; } };
    const { groups, root } = setup({ onFatal: (error) => fatal.push(error), harnessOptions: () => {
      const registry = createRegistry();
      registry.install(defineExtension({ name: "test.hold", tools: [hold] }));
      return { models, registry, settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } } };
    } });
    try {
      const handle = await groups.acquire(g("g1"));
      const { conversation } = await memberConversation(handle.harness, g("g1"), "m1", { model }, context);
      faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {}, { id: "hold-1" })], { stopReason: "toolUse" })]);
      await conversation.submit({ type: "input", content: "运行" }, context);
      await started;
      let closed = false;
      void handle.harness.closed.then(() => { closed = true; });
      (handle.harness as unknown as { fail(error: unknown): void }).fail(new Error("synthetic bookkeeping failure"));
      // Synchronously, before the tool ends: the owner knows, and no group opens.
      expect(fatal.map((error) => error.message)).toEqual([`会话库会话已失败，需重启服务：${dbPath(root, "g1")}`]);
      await expect(groups.acquire(g("g2"))).rejects.toBe(fatal[0]);
      await Bun.sleep(50);
      expect(closed).toBe(false);
      handle.release();
      release();
      await handle.harness.closed;
      expect(fatal).toHaveLength(1);
    } finally { release(); await groups.closeAll(); }
  });

  test("closing idle spaces and shutting down is no failure", async () => {
    const fatal: Error[] = [];
    const { groups } = setup({ onFatal: (error) => fatal.push(error), maxIdle: 0 });
    const handle = await groups.acquire(g("g1"));
    handle.release();
    await groups.sweep();
    (await groups.acquire(g("g2"))).release();
    await groups.closeAll();
    expect(fatal).toEqual([]);
  });
});
