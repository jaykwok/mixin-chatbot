// Durable message receipts, offline/manual compaction, reference-aware expiry and backup/reopen.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableService } from "../../src/durable/service.ts";
import { ControlsDoc } from "../../src/durable/inbox.ts";
import { ReceiptsDoc } from "../../src/durable/records.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { queueMemberCompaction } from "../../src/durable/offline.ts";
import { ASK_ID_RETENTION_MS, readLedger, openStatsLedger } from "../../src/agent/stats-ledger.ts";
import { ReclamationItems } from "../../src/durable/results/queue.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { createDataBackup, restoreDataBackup } from "../../scripts/ops/data-backup.ts";
import { fauxModels, gatedResponse, TEST_PROGRESS } from "../helpers/durable.ts";
import { referTo } from "../helpers/pending-reply.ts";
import { recordingOutbound } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { databaseOf, statsOf, tmpOf } from "../helpers/layout.ts";
import { awaitingRemoval } from "../helpers/results.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";

const fixture = await tempFixture("durable-closeout-");
afterAll(() => fixture.cleanup());
const group = "100", phone = "13800000001", other = "13800000002";
let counter = 0, latest: { out: ReturnType<typeof recordingOutbound>; reports: unknown[]; faux: ReturnType<typeof fauxModels>["faux"] } | undefined;
async function until(probe: () => boolean | Promise<boolean>) {
  // Give up before the 20 s test timeout so the failure reports the service state.
  const end = Date.now() + 15_000;
  while (!await probe()) {
    if (Date.now() > end) throw new Error(`closeout wait timed out; sent=${JSON.stringify(latest?.out.sent)}; `
      + `calls=${latest?.faux.state.callCount}; reports=${latest?.reports.map(String).join(" | ")}`);
    await Bun.sleep(10);
  }
}
function setup() {
  const root = join(fixture.root, `root-${++counter}`), { faux, models, model } = fauxModels(), out = recordingOutbound(), reports: unknown[] = [];
  const replies = () => out.sent.filter(item => item.kind === "reply").map(item => item.text);
  const open = () => new DurableService({ layout: appLayout(root), modules: [], relay: null, materials: false, outbound: out.outbound,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 10, resultRetentionMs: 1 },
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never,
      ref: model, thinkingLevel: "off", harnessSettings: { compaction: { enabled: false, keepRecentTokens: 1 },
        ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } }, onReport: error => reports.push(error) });
  latest = { out, reports, faux };
  return { root, faux, out, replies, reports, open, message: (content: string, who = phone) => out.message(group, who, content) };
}
async function database(root: string, change: (session: ReturnType<typeof createSession>) => Promise<void>) {
  const session = createSession(await openGroupStorage(databaseOf(root, group)));
  try { await change(session); } finally { await session.close(context); }
}

test("concurrent redeliveries are one request across /clear and a cold restart; the receipt holds no content and expires", async () => {
  const w = setup(); let service = w.open();
  w.faux.setResponses([fauxAssistantMessage("once"), fauxAssistantMessage("after expiry")]);
  const message = w.message("private synthetic content");
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => service.admit(message)));
    expect(results.filter(result => result.status === "accepted")).toHaveLength(1);
    await until(() => w.replies().length === 1);
    await service.control(w.message("/clear"));
    await service.close(); service = w.open(); await service.start();
    expect(await service.admit(message)).toEqual({ status: "duplicate" });
    await service.maintain(); expect(w.faux.state.callCount).toBe(1);
    await service.close();
    await database(w.root, async session => {
      const doc = await session.snapshot(ReceiptsDoc, context);
      expect(doc!.items[message.reply.msgUid]).toBeDefined();
      expect(JSON.stringify(doc)).not.toContain("private synthetic content");
    });
    // Past the retention the receipt (and the finished record it pointed to) is pruned; a redelivery is then new.
    service = w.open(); await service.start();
    await service.maintain(Date.now() + 2 * 24 * 3600_000);
    expect(await service.admit(message)).toEqual({ status: "accepted" });
    await until(() => w.replies().length === 2); expect(w.faux.state.callCount).toBe(2);
    expect(w.replies()).toEqual(["once", "after expiry"]);
    // Maintenance forgets counted requestIds past their retention; the counted asks stay.
    const ledger = () => openStatsLedger(statsOf(w.root));
    let db = ledger();
    try { expect(db.query("SELECT COUNT(*) AS n FROM ask_ids").get()).toEqual({ n: 2 }); } finally { db.close(); }
    await service.maintain(Date.now() + ASK_ID_RETENTION_MS + 3 * 24 * 3600_000);
    db = ledger();
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM ask_ids").get()).toEqual({ n: 0 });
      expect(readLedger(db).asks.reduce((sum, row) => sum + row.asks, 0)).toBe(2);
    } finally { db.close(); }
  } finally { await service.close(); }
});

test("a run record outlives its retention until its ask is in the ledger, so a ledger failure loses no ask", async () => {
  const w = setup();
  // A directory where the ledger file goes: every open fails (admission count and syncs) until it is removed.
  await mkdir(statsOf(w.root), { recursive: true });
  const service = w.open();
  w.faux.setResponses([fauxAssistantMessage("answered")]);
  const requests = async () => Object.values((await service.records(groupScope(group), phone)).requests);
  try {
    expect(await service.admit(w.message("synthetic question"))).toMatchObject({ status: "accepted" });
    await until(async () => w.replies().length === 1 && (await requests()).every(record => record.closedAt !== undefined));
    expect(w.reports.length).toBeGreaterThan(0);
    const later = Date.now() + 25 * 3600_000;
    await service.maintain(later);
    expect(await requests()).toHaveLength(1);
    await rm(statsOf(w.root), { recursive: true });
    // The prune runs before the sync: this pass keeps the record and counts its ask; the next one removes it.
    await service.maintain(later);
    expect(await requests()).toHaveLength(1);
    await service.maintain(later + 60_000);
    expect(await requests()).toHaveLength(0);
    const db = openStatsLedger(statsOf(w.root));
    try { expect(readLedger(db).asks.reduce((sum, row) => sum + row.asks, 0)).toBe(1); } finally { db.close(); }
  } finally { await service.close(); }
});

test("offline compaction is deduplicated without calling a model; cold start resumes it and projects its own usage", async () => {
  const w = setup(); let service = w.open();
  w.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("summary")]);
  try {
    await service.admit(w.message("question one")); await until(() => w.replies().length === 1);
    await service.admit(w.message("question two")); await until(() => w.replies().length === 2);
    await service.close();
    const tokens = () => { const ledger = openStatsLedger(statsOf(w.root));
      try { return readLedger(ledger).usage.reduce((sum, row) => sum + row.totalTokens, 0); } finally { ledger.close(); } };
    const answered = tokens();
    expect(answered).toBeGreaterThan(0);
    const path = databaseOf(w.root, group), queued = await queueMemberCompaction(path, phone);
    expect(queued.created).toBe(true);
    if (queued.taskId === undefined) throw new Error("a new offline compaction must have a task");
    expect(await queueMemberCompaction(path, phone)).toEqual({ taskId: queued.taskId, created: false });
    expect(w.faux.state.callCount).toBe(2);
    service = w.open(); await service.start(); await until(() => w.faux.state.callCount === 3);
    // The offline compaction's usage joins the model's totals and is counted at the next sync.
    await until(async () => { await service.maintain(); return tokens() > answered; });
    expect(w.replies()).toEqual(["first", "second"]);
  } finally { await service.close(); }
});

test("manual compaction reports admission before the summary ends, and stop cancels it", async () => {
  const w = setup(), service = w.open(), held = gatedResponse("summary");
  w.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), held.step]);
  let command: Promise<string> | undefined;
  try {
    await service.admit(w.message("one")); await until(() => w.replies().length === 1);
    await service.admit(w.message("two")); await until(() => w.replies().length === 2);
    let admitted = false;
    command = service.control(w.message("/compact"), () => { admitted = true; });
    await held.started; expect(admitted).toBe(true);
    expect(await service.control(w.message("/status"))).toContain("压缩会话历史");
    await service.control(w.message("/stop")); expect(await command).toContain("未完成");
  } finally { held.open(); await command?.catch(() => {}); await service.close(); }
});

test("a /clear is committed before its admission is reported; execution can still be blocked", async () => {
  const w = setup(), service = w.open(); let admitted = false;
  try {
    await service.control(w.message("/clear"), () => { admitted = true; });
    expect(admitted).toBe(true); await service.close();
    await database(w.root, async session => { expect((await session.snapshot(ControlsDoc, context))!.seq).toBe(1); });
  } finally { await service.close(); }
});

test("cold maintenance finishes an expiry receipt left after bytes were already removed", async () => {
  const w = setup(); let service = w.open();
  w.faux.setResponses([fauxAssistantMessage("seed")]);
  try {
    await service.admit(w.message("seed")); await until(() => w.replies().length === 1); await service.close();
    await database(w.root, session => session.commit(async tx => {
      (await tx.doc(ResultsDoc)).calls["1-deleted-before-crash"] = { phone, createdAt: 1, expiryRequestedAt: 2 };
    }, context));
    service = w.open(); await service.start();
    if (process.platform === "linux") {
      await service.maintain();
      await database(w.root, async session => {
        expect((await session.snapshot(ResultsDoc, context))!.calls["1-deleted-before-crash"]).toBeUndefined();
        expect((await session.snapshot(ReclamationItems, "1-deleted-before-crash", context))!.call.expiredAt).toBeUndefined();
      });
      return; // A missing shared pathname is not a physical deletion receipt.
    }
    await until(async () => {
      await service.maintain(); let expired = false;
      await database(w.root, async session => { expired = (await session.snapshot(ResultsDoc, context))!.calls["1-deleted-before-crash"]!.expiredAt !== undefined; });
      return expired;
    });
    await service.close();
    await database(w.root, async session => { expect((await session.snapshot(ResultsDoc, context))!.calls["1-deleted-before-crash"]!.expiredAt).toBeGreaterThan(2); });
  } finally { await service.close(); }
});

test("current history survives retention and /clear, unknown directories stay; another member's pending reply protects a path until it is gone", async () => {
  const w = setup(); let service = w.open();
  const temp = tmpOf(w.root, group, phone), workspace = appLayout(w.root).workspace;
  await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, "long.txt"), "synthetic ".repeat(4500));
  w.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.read({path:"long.txt"}));' })], { stopReason: "toolUse" }),
    fauxAssistantMessage("saved"), fauxAssistantMessage("other member")]);
  // Reopen with the other member's run records changed while the service is closed (it holds the group database).
  const refer = async (path: string | undefined) => {
    await service.close();
    await database(w.root, session => referTo(session, other, "msg:pending", path));
    service = w.open(); await service.start();
  };
  try {
    await service.admit(w.message("save output")); await until(() => w.replies().length === 1);
    await service.admit(w.message("hello", other)); await until(() => w.replies().length === 2);
    const root = join(temp, "codemode"), names = await readdir(root).catch(error => { throw new Error(`${error}; reports=${JSON.stringify(w.reports)}`); }), name = names[0]!, file = join(root, name, "output.txt");
    expect(await readFile(file, "utf8")).toContain("synthetic");
    const old = new Date(0); await utimes(join(root, name), old, old);
    await mkdir(join(root, "9-unknown")); await writeFile(join(root, "9-unknown", "keep"), "unowned");
    await service.maintain(); expect(await readFile(file, "utf8")).toContain("synthetic");
    await refer(file);
    await service.control(w.message("/clear")); expect(await readFile(file, "utf8")).toContain("synthetic");
    // A different member's undelivered reply protects the path even after this member clears its context.
    await service.maintain(); expect(await readFile(file, "utf8")).toContain("synthetic");
    await refer(undefined);
    await until(async () => {
      await service.maintain();
      // The expiry is requested from /clear on; wait for the maintenance outcome itself (Linux: an isolated result's
      // removal is deferred).
      return process.platform === "linux" ? await awaitingRemoval(databaseOf(w.root, group), phone) > 0 : !(await readdir(root)).includes(name);
    });
    expect((await readdir(root)).sort()).toEqual(process.platform === "linux" ? [name, "9-unknown"].sort() : ["9-unknown"]);
    await service.close();
    await database(w.root, async session => {
      const call = process.platform === "linux" ? (await session.snapshot(ReclamationItems, name, context))!.call : (await session.snapshot(ResultsDoc, context))!.calls[name]!;
      expect(call.expiryRequestedAt).toBeGreaterThan(0);
      if (process.platform === "linux") { expect(call.expiredAt).toBeUndefined(); expect(call.reclamation?.status).toBe("deferred"); }
      else expect(call.expiredAt).toBeGreaterThan(0);
    });
  } finally { await service.close(); }
});

test("closed DB and external-result hash manifest restores exactly; tampered files reject before any restore writes", async () => {
  const root = join(fixture.root, `backup-${++counter}`), data = join(root, "data"), snapshot = join(root, "snapshot");
  const database = databaseOf(data, group), output = join(tmpOf(data, group, phone), "codemode", "1-call");
  await mkdir(join(database, ".."), { recursive: true }); await mkdir(output, { recursive: true });
  const db = new Database(database);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('persisted')"); db.close();
  await writeFile(join(output, "output.txt"), "exact bytes");
  await mkdir(join(data, "workspace"), { recursive: true }); await writeFile(join(data, "workspace", "手册.md"), "shared");
  // Archived tmp entries are not copied again (a link inside one would even refuse the whole backup); their plans are.
  const archive = join(data, "state", "reclamation", "backup", "rm");
  await mkdir(join(archive, "tmp-plan-0"), { recursive: true }); await mkdir(join(archive, ".tmp-plans"));
  await writeFile(join(archive, "tmp-plan-0", "old.bin"), "archived"); await writeFile(join(archive, ".tmp-plans", "plan.json"), "{}");
  if (process.platform !== "win32") await symlink("/", join(archive, "tmp-plan-0", "link"));
  await mkdir(join(data, "state", "reclamation", "snapshots", "snapshot-x"), { recursive: true });
  await writeFile(join(data, "state", "reclamation", "snapshots", "snapshot-x", "group.sqlite"), "copy");
  const manifest = await createDataBackup(data, snapshot);
  expect(manifest.files.some(file => file.area === "tmp" && file.path.endsWith("output.txt") && file.bytes === 11)).toBe(true);
  expect(manifest.files.some(file => file.area === "workspace" && file.path === "手册.md")).toBe(true);
  expect(manifest.files.filter(file => file.area === "state").map(file => file.path)).toEqual(["reclamation/backup/rm/.tmp-plans/plan.json"]);
  // An external workspace belongs to its operator and is left out.
  expect((await createDataBackup(data, join(root, "snapshot-external"), true)).files.some(file => file.area === "workspace")).toBe(false);
  const restored = join(root, "restored", "data"); await restoreDataBackup(snapshot, restored);
  const read = new Database(databaseOf(restored, group), { readonly: true });
  try { expect(read.query("SELECT value FROM proof").get()).toEqual({ value: "persisted" }); } finally { read.close(); }
  expect(await readFile(join(tmpOf(restored, group, phone), "codemode", "1-call", "output.txt"), "utf8")).toBe("exact bytes");
  await expect(restoreDataBackup(snapshot, restored)).rejects.toThrow("恢复目标必须为空");
  await writeFile(join(snapshot, "tmp", "groups", group, phone, "codemode", "1-call", "output.txt"), "wrong bytes");
  await expect(restoreDataBackup(snapshot, join(root, "refused", "data"))).rejects.toThrow("损坏");
});
