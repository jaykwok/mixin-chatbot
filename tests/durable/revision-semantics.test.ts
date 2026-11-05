// The revision cleanup and the checkpoint interval change only how documents are stored (revision-chain plan §5). A
// space that an older release left with long chains (the real service writing, never a base) is stopped with work in
// it: a reply waiting for its retry, a run cut off by the stop and a message queued behind it. It is copied twice and one
// copy is cleaned; both then restart under the same script, at the production interval and at intervals that cross a
// base on every (other) change. The interrupted work is finished, the waiting reply is sent once, every message
// redelivered is a duplicate, a new question continues the member's conversation, /stop and /clear (sent, and queued
// while stopped) behave as before. Both copies answer exactly alike, and the cleanup leaves the stats ledger byte for byte.
import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { appLayout } from "../../src/core/layout.ts";
import { CHECKPOINT_INTERVAL, checkpointPolicy } from "../../src/durable/checkpoint.ts";
import { queueSpaceClear } from "../../src/durable/offline.ts";
import { pendingDeliveries } from "../../src/durable/records.ts";
import { applyCleanup } from "../../src/durable/revision-cleanup/run.ts";
import { DurableService, type DurableServiceOptions, type Inbound } from "../../src/durable/service.ts";
import { NEVER, useCheckpointPolicy } from "../helpers/checkpoint-policy.ts";
import { fauxModels, gatedResponse, TEST_PROGRESS } from "../helpers/durable.ts";
import { databaseOf, scopeOf, statsOf } from "../helpers/layout.ts";
import { type Recording, recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { chainState, kindOf } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("revision-semantics-");
afterAll(() => fixture.cleanup());
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

const GROUP = "100", PHONE = "13800000001", OTHER = "13800000002", HANDLED = 70;
const data = (project: string) => join(project, "data");
const database = (project: string) => databaseOf(data(project), GROUP);

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await Bun.sleep(10); }
}

function open(project: string, out: Recording) {
  const { faux, models, model } = fauxModels();
  const options = {
    layout: appLayout(data(project)), modules: [], relay: null, materials: false, outbound: out.outbound,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 10, deliveryRetryMs: [1_500] },
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never,
      ref: model, thinkingLevel: "off", harnessSettings: { compaction: { enabled: false, keepRecentTokens: 1 },
        ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  } satisfies DurableServiceOptions;
  return { faux, service: new DurableService(options) };
}

const pending = async (service: DurableService) =>
  (await Promise.all([PHONE, OTHER].map(async phone => pendingDeliveries(await service.records(scopeOf(GROUP), phone))))).flat();
/** Each member's answers, in the order they went out. */
const answers = (out: Recording) => Object.fromEntries([PHONE, OTHER].map(phone => [phone, replyTexts(out.sent.filter(item => item.phone === phone))]));
/** The questions a model call was given (the member's conversation as the model sees it). */
const asked = (context: { messages: unknown[] }) => [...JSON.stringify(context.messages).matchAll(/question (?:\d+|[a-z]+(?: [a-z]+)*)/g)].map(match => match[0]);

function chains(project: string): { values: Record<number, string>; longest: Record<string, number> } {
  const db = new Database(database(project), { readonly: true });
  try {
    const state = chainState(db), longest: Record<string, number> = {};
    for (const [id, revisions] of Object.entries(state.chains)) {
      const kind = kindOf(db, Number(id));
      longest[kind] = Math.max(longest[kind] ?? 0, revisions);
    }
    return { values: state.values, longest };
  } finally { db.close(); }
}

/** The stats ledger's files as they are on disk. */
const statsFiles = (project: string) => ["", "-wal"].map(suffix => statsOf(data(project)) + suffix)
  .map(file => existsSync(file) ? readFileSync(file) : null);

/** The ledger's rows without their first and last times (two runs ask at different moments). */
function ledger(project: string) {
  const db = openStatsLedger(statsOf(data(project)));
  try {
    const rows = readLedger(db);
    return { ...rows, asks: rows.asks.map(({ firstAt: _first, lastAt: _last, ...row }) => row) };
  } finally { db.close(); }
}

// ─── The space as an older release left it ─────────────────────────────────

const template = join(fixture.root, "template");
const redeliveries: Inbound[] = [];
{
  const old = useCheckpointPolicy(NEVER);
  const out = recordingOutbound(), { faux, service } = open(template, out), interrupted = gatedResponse("answer interrupted");
  faux.setResponses([...Array.from({ length: HANDLED }, (_, i) => fauxAssistantMessage(`answer ${i + 1}`)), fauxAssistantMessage("answer waiting"),
    interrupted.step]);
  try {
    for (let i = 1; i <= HANDLED; i++) {
      const message = out.message(GROUP, i % 2 ? PHONE : OTHER, `question ${i}`);
      redeliveries.push(message);
      expect(await service.admit(message)).toMatchObject({ status: "accepted" });
      await until(() => replyTexts(out.sent).length === i, `answer ${i}`);
    }
    // The reply fails once; the service stops while it waits for its retry.
    out.state.failWhen = item => item.kind === "reply" && item.text === "answer waiting" ? "failed" : false;
    redeliveries.push(out.message(GROUP, PHONE, "question waiting"));
    await service.admit(redeliveries.at(-1)!);
    await until(async () => Object.values((await service.records(scopeOf(GROUP), PHONE)).requests)
      .some(record => record.delivery?.parts.some(part => part.state === "failed" && part.retryAt !== undefined)), "the failed reply");
    await service.control(out.message(GROUP, OTHER, "/clear"));
    await service.maintain();
    // The stop cuts off a run, with another message queued behind it.
    redeliveries.push(out.message(GROUP, OTHER, "question interrupted"));
    await service.admit(redeliveries.at(-1)!);
    await interrupted.started;
    redeliveries.push(out.message(GROUP, OTHER, "question queued"));
    expect(await service.admit(redeliveries.at(-1)!)).toMatchObject({ status: "accepted" });
  } finally { await service.close(); interrupted.open(); old(); }
}

/** The same script on a restarted copy; what it saw. */
async function resume(project: string) {
  const out = recordingOutbound(), stopped = gatedResponse("never shown"), heard: Record<string, string[]> = {};
  const answer = (text: string): FauxResponseFactory => context => { heard[text] = asked(context); return fauxAssistantMessage(text); };
  let { faux, service } = open(project, out), calls = 0, stop = "", clear = "";
  faux.setResponses([answer("answer interrupted"), answer("answer queued"), answer("answer new"),
    (context, options, state, model) => { heard["question stopped"] = asked(context); return stopped.step(context, options, state, model); },
    answer("answer after stop"), answer("answer after clear")]);
  // The earlier messages, so that this recording knows whom an answer to one of them goes to.
  const earlier = redeliveries.map(message => out.message(GROUP, message.phone, message.content, { msgUid: message.reply.msgUid }));
  try {
    await service.start();
    await until(async () => replyTexts(out.sent).includes("answer waiting") && replyTexts(out.sent).includes("answer queued")
      && (await pending(service)).length === 0, "the work the stop left");
    const redelivered: Record<string, number> = {};
    for (const message of earlier) {
      const { status } = await service.admit(message);
      redelivered[status] = (redelivered[status] ?? 0) + 1;
    }
    expect(await service.admit(out.message(GROUP, PHONE, "question new"))).toMatchObject({ status: "accepted" });
    await until(() => replyTexts(out.sent).includes("answer new"), "the new answer");
    await service.admit(out.message(GROUP, OTHER, "question stopped"));
    await stopped.started;
    stop = await service.control(out.message(GROUP, OTHER, "/stop"));
    await service.admit(out.message(GROUP, OTHER, "question after stop"));
    await until(() => replyTexts(out.sent).includes("answer after stop"), "the answer after /stop");
    clear = await service.control(out.message(GROUP, PHONE, "/clear"));
    await service.admit(out.message(GROUP, PHONE, "question after clear"));
    await until(async () => replyTexts(out.sent).includes("answer after clear") && (await pending(service)).length === 0, "the answer after /clear");
    await service.maintain();
    calls += faux.state.callCount;
    await service.close();

    // A /clear queued for every member while the service is stopped runs at the next start, before any message.
    const queued = await queueSpaceClear(database(project));
    ({ faux, service } = open(project, out));
    faux.setResponses([answer("answer offline")]);
    await service.start();
    await service.admit(out.message(GROUP, OTHER, "question offline"));
    await until(async () => replyTexts(out.sent).includes("answer offline") && (await pending(service)).length === 0, "the answer after the queued /clear");
    await service.maintain();
    calls += faux.state.callCount;
    const records = await Promise.all([PHONE, OTHER].map(async phone => Object.values((await service.records(scopeOf(GROUP), phone)).requests)
      .map(record => [record.delivery?.parts.map(part => part.state).join(",") ?? "", record.delivery?.abandoned?.reason ?? ""].join("|")).sort()));
    return { redelivered, answers: answers(out), notices: [PHONE, OTHER].map(phone => out.texts("notice", phone)), heard, calls, stop, clear,
      queued: { ...queued, queued: queued?.queued.toSorted() }, records };
  } finally { stopped.open(); await service.close(); }
}

test("the space before the cleanup: long chains of the real documents, no base", () => {
  const { longest } = chains(template);
  expect(longest["mixin.receipts"]).toBeGreaterThan(CHECKPOINT_INTERVAL);
  expect(longest["mixin.member-records"]).toBeGreaterThan(CHECKPOINT_INTERVAL);
});

for (const interval of [CHECKPOINT_INTERVAL, 2, 1]) {
  test(`整理后与未整理的副本在基准间隔 ${interval} 下表现相同：重启续做，待重试的回答发送一次，重投都是重复，新问题接着原会话，/stop、/clear 与离线排队的 /clear 照常；统计账本不被整理改动`, async () => {
    // Names of the same length: the member's tmp path is part of the prompt, whose length the faux provider counts as tokens.
    const cleaned = join(fixture.root, `cleaned-${interval}`), control = join(fixture.root, `control-${interval}`);
    cpSync(template, cleaned, { recursive: true });
    cpSync(template, control, { recursive: true });
    const before = chains(cleaned), stats = statsFiles(cleaned);
    const summary = await applyCleanup({ project: cleaned });
    expect(summary.documents).toBeGreaterThanOrEqual(2);
    const after = chains(cleaned);
    expect(after.values).toEqual(before.values);
    expect(after.longest["mixin.receipts"]).toBe(1);
    expect(after.longest["mixin.member-records"]).toBe(1);
    expect(statsFiles(cleaned)).toEqual(stats);

    restore = useCheckpointPolicy(checkpointPolicy({ interval }));
    const seen = await resume(control), cleanedSeen = await resume(cleaned);
    expect(cleanedSeen).toEqual(seen);
    expect(seen.redelivered).toEqual({ duplicate: redeliveries.length });
    expect(seen.answers).toEqual({
      [PHONE]: ["answer waiting", "answer new", "answer after clear"],
      [OTHER]: ["answer interrupted", "answer queued", "answer after stop", "answer offline"],
    });
    expect(seen.calls).toBe(7);
    expect(seen.stop).toContain("已停止");
    expect(seen.queued).toEqual({ scope: scopeOf(GROUP), queued: [PHONE, OTHER], waiting: [] });
    // The conversation goes on where it was; each /clear starts a new one.
    expect(seen.heard["answer new"]).toEqual([...redeliveries.filter((_, i) => i < HANDLED && i % 2 === 0).map(message => message.content),
      "question waiting", "question new"]);
    expect(seen.heard["answer interrupted"]).toEqual(["question interrupted"]);
    expect(seen.heard["answer queued"]).toEqual(["question interrupted", "question queued"]);
    expect(seen.heard["answer after clear"]).toEqual(["question after clear"]);
    expect(seen.heard["answer offline"]).toEqual(["question offline"]);
    expect(ledger(cleaned)).toEqual(ledger(control));
    // From here on the chains stay within the interval (the uncleaned copy's were compacted online by their next change).
    for (const project of [cleaned, control]) {
      const { longest } = chains(project);
      for (const kind of ["mixin.receipts", "mixin.member-records", "mixin.controls"]) {
        expect(longest[kind] ?? 0, `${kind} at interval ${interval}`).toBeLessThanOrEqual(interval);
      }
    }
  }, 120_000);
}
