// Migration closeout: durable receipts, offline/manual compaction, reference-aware expiry and backup/reopen.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DurableService, memberKey, type Outbound } from "../../src/durable/service.ts";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { userTempDir } from "../../src/agent/paths.ts";
import { ControlsDoc, WebhookReceiptsDoc } from "../../src/durable/inbox.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { queueMemberCompaction } from "../../src/durable/offline.ts";
import { readLedger, openStatsLedger } from "../../src/agent/stats-ledger.ts";
import { ResultsDoc } from "../../src/durable/result-lifecycle.ts";
import { createDataBackup, restoreDataBackup } from "../../scripts/ops/data-backup.ts";
import { fauxModels, gatedResponse, TEST_PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-closeout-");
afterAll(() => fixture.cleanup());
const group = "group-a", phone = "13800000001", url = "https://example.invalid/callback?key=synthetic";
let counter = 0;
async function until(probe: () => boolean | Promise<boolean>) {
  const end = Date.now() + 20_000;
  while (!await probe()) { if (Date.now() > end) throw new Error("closeout wait timed out"); await Bun.sleep(10); }
}
function setup() {
  const root = join(fixture.root, `root-${++counter}`), { faux, models, model } = fauxModels(), stateDb = new Database(":memory:");
  const deliveries = new DeliveryStore(stateDb), replies: string[] = [], reports: unknown[] = [];
  const outbound: Outbound = { sendText: async () => true, sendReply: async text => { replies.push(text); return true; },
    rate: () => ({ used: 0, limit: 20 }), refresh: async item => item.text };
  const open = () => new DurableService({ root, stateDb, deliveries, modules: [], relay: null, materials: false, outbound,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 10, resultRetentionMs: 1 },
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never,
      ref: model, thinkingLevel: "off", notices: [], harnessSettings: { compaction: { enabled: false, keepRecentTokens: 1 },
        ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } }, onReport: error => reports.push(error) });
  return { root, faux, model, models, stateDb, deliveries, replies, reports, open };
}
async function database(root: string, change: (session: ReturnType<typeof createSession>) => Promise<void>) {
  const session = createSession(await openGroupStorage(groupDatabasePath(root, group)));
  try { await change(session); } finally { await session.close(context); }
}

test("concurrent duplicate receipts survive cold restart and clear; expiry permits a new request; no plaintext in receipt", async () => {
  const w = setup(); let service = w.open();
  w.faux.setResponses([fauxAssistantMessage("once"), fauxAssistantMessage("after TTL")]);
  try {
    await Promise.all(Array.from({ length: 5 }, () => service.admit(phone, group, "private synthetic content", url, true)));
    await until(() => w.replies.length === 1);
    await service.control(phone, group, "/clear", url);
    await service.close(); service = w.open(); await service.start();
    await service.admit(phone, group, "private synthetic content", url, true);
    await service.maintain(); expect(w.faux.state.callCount).toBe(1);
    await service.close();
    await database(w.root, async session => {
      const doc = await session.snapshot(WebhookReceiptsDoc, context);
      expect(doc!.items).toHaveLength(1); expect(JSON.stringify(doc)).not.toContain("private synthetic content");
      await session.commit(async tx => { (await tx.doc(WebhookReceiptsDoc)).items[0]!.at = 0; }, context);
    });
    service = w.open(); await service.start();
    await service.admit(phone, group, "private synthetic content", url, true);
    await until(() => w.replies.length === 2); expect(w.faux.state.callCount).toBe(2);
  } finally { await service.close(); w.stateDb.close(); }
});

test("offline compaction is deduplicated without calling a model; cold start resumes it and projects its own usage", async () => {
  const w = setup(); let service = w.open();
  w.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("summary")]);
  try {
    await service.admit(phone, group, "question one", url); await until(() => w.replies.length === 1);
    await service.admit(phone, group, "question two", url); await until(() => w.replies.length === 2);
    await service.close();
    const path = groupDatabasePath(w.root, group), queued = await queueMemberCompaction(path, phone);
    expect(queued.created).toBe(true);
    if (queued.taskId === undefined) throw new Error("a new offline compaction must have a task");
    expect(await queueMemberCompaction(path, phone)).toEqual({ taskId: queued.taskId, created: false });
    expect(w.faux.state.callCount).toBe(2);
    service = w.open(); await service.start(); await until(() => w.faux.state.callCount === 3);
    await until(async () => { await service.maintain(); const ledger = openStatsLedger(w.root);
      try { return readLedger(ledger).usage.some(row => row.kind === "compaction" && row.requests === 1); } finally { ledger.close(); } });
    expect(w.replies).toEqual(["first", "second"]);
  } finally { await service.close(); w.stateDb.close(); }
});

test("manual compaction reports admission before the summary ends, and stop cancels it", async () => {
  const w = setup(), service = w.open(), held = gatedResponse("summary");
  w.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second"), held.step]);
  let command: Promise<string> | undefined;
  try {
    await service.admit(phone, group, "one", url); await until(() => w.replies.length === 1);
    await service.admit(phone, group, "two", url); await until(() => w.replies.length === 2);
    let admitted = false;
    command = service.control(phone, group, "/compact", url, () => { admitted = true; });
    await held.started; expect(admitted).toBe(true);
    expect(await service.control(phone, group, "/status", url)).toContain("压缩会话历史");
    await service.control(phone, group, "/stop", url); expect(await command).toContain("未完成");
  } finally { held.open(); await command?.catch(() => {}); await service.close(); w.stateDb.close(); }
});

test("clear receipt is committed before HTTP admission notification; execution can still be blocked", async () => {
  const w = setup(), service = w.open(); let admitted = false;
  try {
    await service.control(phone, group, "/clear", url, () => { admitted = true; });
    expect(admitted).toBe(true); await service.close();
    await database(w.root, async session => { expect((await session.snapshot(ControlsDoc, context))!.seq).toBe(1); });
  } finally { await service.close(); w.stateDb.close(); }
});

test("cold maintenance finishes an expiry receipt left after bytes were already removed", async () => {
  const w = setup(); let service = w.open();
  w.faux.setResponses([fauxAssistantMessage("seed")]);
  try {
    await service.admit(phone, group, "seed", url); await until(() => w.replies.length === 1); await service.close();
    await database(w.root, session => session.commit(async tx => {
      (await tx.doc(ResultsDoc)).calls["1-deleted-before-crash"] = { phone, createdAt: 1, expiryRequestedAt: 2 };
    }, context));
    service = w.open(); await service.control(phone, group, "/status", url);
    if (process.platform === "linux") {
      await service.maintain();
      await database(w.root, async session => { expect((await session.snapshot(ResultsDoc, context))!.calls["1-deleted-before-crash"]!.expiredAt).toBeUndefined(); });
      return; // A missing shared pathname is not a physical deletion receipt.
    }
    await until(async () => {
      await service.maintain(); let expired = false;
      await database(w.root, async session => { expired = (await session.snapshot(ResultsDoc, context))!.calls["1-deleted-before-crash"]!.expiredAt !== undefined; });
      return expired;
    });
    await service.close();
    await database(w.root, async session => { expect((await session.snapshot(ResultsDoc, context))!.calls["1-deleted-before-crash"]!.expiredAt).toBeGreaterThan(2); });
  } finally { await service.close(); w.stateDb.close(); }
});

test("current history and pending attachments survive retention/clear, unknown directories stay; released references expire durably", async () => {
  const w = setup(); let service = w.open();
  const temp = userTempDir(w.root, group, phone), workspace = join(w.root, group, "workspace");
  await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, "long.txt"), "synthetic ".repeat(100));
  w.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.read({path:"long.txt"}));' })], { stopReason: "toolUse" }), fauxAssistantMessage("saved")]);
  try {
    await service.admit(phone, group, "save output", url); await until(() => w.replies.length === 1);
    const root = join(temp, "codemode"), names = await readdir(root).catch(error => { throw new Error(`${error}; reports=${JSON.stringify(w.reports)}; replies=${JSON.stringify(w.replies)}`); }), name = names[0]!, file = join(root, name, "1.txt");
    expect(await readFile(file, "utf8")).toContain("synthetic");
    const old = new Date(0); await utimes(join(root, name, "index.txt"), old, old); await utimes(join(root, name), old, old);
    await mkdir(join(root, "9-unknown")); await writeFile(join(root, "9-unknown", "keep"), "unowned");
    await service.maintain(); expect(await readFile(file, "utf8")).toContain("synthetic");
    w.deliveries.put(memberKey(group, phone), "pending", `read ${file}`, [{ original: file, reference: {} as never }]);
    await service.control(phone, group, "/clear", url); expect(await readFile(file, "utf8")).toContain("synthetic");
    w.deliveries.acknowledge(["pending"]); await service.maintain();
    expect((await readdir(root)).sort()).toEqual(process.platform === "linux" ? [name, "9-unknown"].sort() : ["9-unknown"]);
    expect(await service.control(phone, group, "/status", url)).toContain("已过期结果");
    await service.close();
    await database(w.root, async session => {
      const call = (await session.snapshot(ResultsDoc, context))!.calls[name]!;
      expect(call.expiryRequestedAt).toBeGreaterThan(0);
      if (process.platform === "linux") { expect(call.expiredAt).toBeUndefined(); expect(call.reclamation?.status).toBe("deferred"); }
      else expect(call.expiredAt).toBeGreaterThan(0);
    });
  } finally { await service.close(); w.stateDb.close(); }
});

test("closed DB and external-result hash manifest restores exactly; tampered files reject before any restore writes", async () => {
  const root = join(fixture.root, `backup-${++counter}`), groups = join(root, "groups"), project = join(root, "project"), snapshot = join(root, "snapshot");
  await mkdir(join(project, "data/state"), { recursive: true }); await mkdir(join(groups, group, "users", phone, "tmp", "codemode", "1-call"), { recursive: true });
  const db = new Database(join(groups, group, "durable.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('persisted')"); db.close();
  await writeFile(join(groups, group, "users", phone, "tmp", "codemode", "1-call", "output.txt"), "exact bytes");
  const manifest = await createDataBackup(project, groups, snapshot);
  expect(manifest.files.some(file => file.path.endsWith("output.txt") && file.bytes === 11)).toBe(true);
  const restored = join(root, "restored"); await restoreDataBackup(snapshot, restored, join(restored, "data/groups"));
  const read = new Database(join(restored, "data/groups", group, "durable.sqlite"), { readonly: true });
  try { expect(read.query("SELECT value FROM proof").get()).toEqual({ value: "persisted" }); } finally { read.close(); }
  expect(await readFile(join(restored, "data/groups", group, "users", phone, "tmp", "codemode", "1-call", "output.txt"), "utf8")).toBe("exact bytes");
  await writeFile(join(snapshot, "groups", group, "users", phone, "tmp", "codemode", "1-call", "output.txt"), "wrong bytes");
  await expect(restoreDataBackup(snapshot, join(root, "refused"), join(root, "refused/groups"))).rejects.toThrow("损坏");
});
