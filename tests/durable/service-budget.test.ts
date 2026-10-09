import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { DurableService, type DurableServiceOptions, type Outbound } from "../../src/durable/service.ts";
import { GroupHarnesses } from "../../src/durable/groups.ts";
import { admitUserRequest, bindMessageService, hasUserRequestCapacity } from "../../src/server/webhook.ts";
import { fauxModels, harnessOptions } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("service-budget-");
afterAll(() => fixture.cleanup());
let sequence = 0;
const URL = "https://example.invalid/callback";
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 20000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}
function blocked() {
  const release = Promise.withResolvers<void>();
  const state = { active: 0, peak: 0, calls: 0 };
  const step: FauxResponseFactory = (_context, options) => new Promise<AssistantMessage>(done => {
    state.calls++; state.active++; state.peak = Math.max(state.peak, state.active);
    let ended = false;
    const finish = () => {
      if (ended) return; ended = true; state.active--;
      options?.signal?.removeEventListener("abort", finish);
      done(fauxAssistantMessage(options?.signal?.aborted ? "" : "answer", { stopReason: options?.signal?.aborted ? "aborted" : "stop" }));
    };
    if (options?.signal?.aborted) finish();
    else { options?.signal?.addEventListener("abort", finish, { once: true }); void release.promise.then(finish); }
  });
  return { state, step, release: () => release.resolve() };
}
function setup(max = 1, options: Partial<DurableServiceOptions> = {}) {
  const stateDb = new Database(":memory:"), deliveries = new DeliveryStore(stateDb);
  const { faux, models, model } = fauxModels();
  const root = join(fixture.root, String(++sequence));
  const replies: string[] = [];
  const outbound: Outbound = { sendText: async () => true, sendReply: async text => { replies.push(text); return true; },
    rate: () => ({ used: 0, limit: 20 }), refresh: async item => item.text };
  const limits = { runTimeoutMs: 120000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 20, activeRequests: max };
  const selection = { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!,
    ref: model, thinkingLevel: "off" as const, harnessSettings: {}, notices: [] };
  const service = new DurableService({ root, stateDb, deliveries, modules: [], relay: null, materials: false,
    limits, selection, outbound, ...options });
  return { service, stateDb, deliveries, faux, models, root, replies, limits, selection, outbound };
}

test("webhook capacity includes unfinished work after the durable HTTP receipt", async () => {
  const f = setup(), gate = blocked(); f.faux.setResponses([gate.step, gate.step]);
  bindMessageService(f.service);
  try {
    await admitUserRequest("first", "1001", "a", URL, "127.0.0.1");
    await until(() => gate.state.active === 1, "first provider");
    const capacity = hasUserRequestCapacity();
    const second = admitUserRequest("second", "1002", "b", URL, "127.0.0.1");
    if (second) { await second; await until(() => gate.state.active === 2, "second provider"); }
    console.log(JSON.stringify({ probe: "capacity", capacity, peak: gate.state.peak }));
    expect(capacity).toBe(false); expect(second).toBeUndefined(); expect(gate.state.peak).toBe(1);
    await f.service.control("1001", "a", "/stop", URL);
    await until(() => hasUserRequestCapacity(), "released cancellation capacity");
    expect(admitUserRequest("second", "1002", "b", URL, "127.0.0.1")).toBeDefined();
    await until(() => gate.state.calls === 2, "next provider");
  } finally { bindMessageService(undefined); gate.release(); await f.service.close(); f.stateDb.close(); }
}, 60000);

test("queued requests occupy capacity, duplicates and rejected admissions release their reservations", async () => {
  const f = setup(2), gate = blocked(); f.faux.setResponses([gate.step, fauxAssistantMessage("queued"), fauxAssistantMessage("other")]);
  try {
    expect((await f.service.admit("1001", "a", "first", URL, true)).status).toBe("accepted");
    await until(() => gate.state.active === 1, "running head");
    expect((await f.service.admit("1001", "a", "first", URL, true)).status).toBe("accepted");
    expect((await f.service.admit("1001", "a", "queued", URL, true)).status).toBe("accepted");
    expect((await f.service.admit("1001", "a", "first", URL, true)).status).toBe("accepted");
    expect((await f.service.admit("1002", "b", "other", URL)).status).toBe("full");
    gate.release(); await until(() => f.replies.length === 2, "queue drained");
    expect((await f.service.admit("1002", "b", "other", URL)).status).toBe("accepted");
    await until(() => f.replies.length === 3, "released completion capacity");
    expect(gate.state.calls).toBe(1);
  } finally { gate.release(); await f.service.close(); f.stateDb.close(); }
}, 60000);

test("evicted Harnesses are collectable and idle members release their callback references", async () => {
  const f = setup(2, { maxIdleGroups: 0 }); f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  const seen = new Map<string, WeakRef<object>>();
  const acquire = GroupHarnesses.prototype.acquire, sweep = GroupHarnesses.prototype.sweep;
  let open = -1;
  GroupHarnesses.prototype.acquire = async function(group) { const handle = await acquire.call(this, group); seen.set(group, new WeakRef(handle.harness)); return handle; };
  GroupHarnesses.prototype.sweep = async function() { await sweep.call(this); open = this.openGroups.length; };
  try {
    for (const group of ["a", "b"]) {
      await f.service.admit("1001", group, "hello", URL);
      await until(() => f.replies.length === seen.size, "reply");
      await f.service.maintain(); await until(() => open === 0, "eviction");
    }
    GroupHarnesses.prototype.acquire = acquire; GroupHarnesses.prototype.sweep = sweep;
    await f.service.maintain();
    const control = new GroupHarnesses({ root: join(f.root, "control"), maxIdle: 0, harnessOptions: harnessOptions(f.models) });
    const controlRef = await (async () => { const handle = await control.acquire("control"); const ref = new WeakRef(handle.harness); handle.release(); return ref; })();
    await control.sweep();
    // A full-suite run can need more than five collections for the otherwise unreachable control Harness.
    // Observe release across event-loop turns, with a bound that still fails for a real retained reference.
    const collectionDeadline = Date.now() + 5000;
    do { await Bun.sleep(20); Bun.gc(true); }
    while ((controlRef.deref() !== undefined || [...seen.values()].some(ref => ref.deref() !== undefined)) && Date.now() < collectionDeadline);
    const retained = [...seen].filter(([, ref]) => ref.deref() !== undefined).map(([group]) => group);
    console.log(JSON.stringify({ probe: "retention", open, retained, controlRetained: controlRef.deref() !== undefined }));
    expect(controlRef.deref()).toBeUndefined(); expect(retained).toHaveLength(0);
    expect(f.service.callbackUrl("1001", "a", "fallback")).toBe("fallback");
    expect(f.service.callbackUrl("1001", "b", "fallback")).toBe("fallback");
    await control.closeAll();
  } finally { GroupHarnesses.prototype.acquire = acquire; GroupHarnesses.prototype.sweep = sweep; await f.service.close(); f.stateDb.close(); }
}, 60000);

test("parallel admissions reserve before opening and identity failure releases the slot", async () => {
  const f = setup(), gate = blocked(); f.faux.setResponses([gate.step]);
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.service.admit(String(i), "a", String(i), URL)));
    expect(results.filter(result => result.status === "accepted")).toHaveLength(1);
    await until(() => gate.state.active === 1, "only admitted provider");
    await f.service.control("0", "a", "/stop", URL);
    await until(() => f.service.hasUserRequestCapacity(), "stop frees slot");
    const storage = await import("../../src/agent/storage-identity.ts");
    const identity = spyOn(storage, "ensureStorageIdentity").mockRejectedValueOnce(new Error("synthetic identity failure"));
    try { await expect(f.service.admit("1002", "b", "failed", URL)).rejects.toThrow("synthetic identity failure"); }
    finally { identity.mockRestore(); }
    expect(f.service.hasUserRequestCapacity()).toBe(true);
  } finally { gate.release(); await f.service.close(); f.stateDb.close(); }
}, 60000);

test("capacity stays reserved while final reply delivery is still cleaning up", async () => {
  const f = setup(), sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.faux.setResponses([fauxAssistantMessage("answer")]);
  f.outbound.sendReply = async () => { sending.resolve(); await release.promise; return true; };
  try {
    await f.service.admit("1001", "a", "first", URL); await sending.promise;
    expect(f.service.hasUserRequestCapacity()).toBe(false);
    expect((await f.service.admit("1002", "b", "second", URL)).status).toBe("full");
    release.resolve(); await until(() => f.service.hasUserRequestCapacity(), "reply cleanup completed");
  } finally { release.resolve(); await f.service.close(); f.stateDb.close(); }
}, 60000);

test("cold recovery bounds old running tasks after a lower limit and stop can cancel a waiting member", async () => {
  const f = setup(2), old = blocked(); f.faux.setResponses([old.step, old.step]);
  await f.service.admit("1001", "a", "first", URL);
  await f.service.admit("1002", "b", "second", URL);
  await until(() => old.state.active === 2, "two old tasks");
  await f.service.close(); old.release();
  const gate = blocked(); f.faux.setResponses([gate.step, gate.step]);
  const resumed = new DurableService({ root: f.root, stateDb: f.stateDb, deliveries: f.deliveries,
    selection: f.selection, modules: [], relay: null, materials: false, outbound: f.outbound, limits: { ...f.limits, activeRequests: 1 } });
  try {
    expect(await resumed.start()).toEqual(["a", "b"]);
    await until(() => gate.state.active === 1, "one resumed provider"); await Bun.sleep(100);
    expect(gate.state.peak).toBe(1); expect(resumed.hasUserRequestCapacity()).toBe(false);
    expect((await resumed.admit("1003", "c", "new", URL)).status).toBe("full");
    await resumed.control("1002", "b", "/stop", URL);
    expect(gate.state.calls).toBe(1);
    await resumed.control("1001", "a", "/stop", URL);
    await until(() => resumed.hasUserRequestCapacity(), "recovered cancellations cleaned up");
    expect(gate.state.calls).toBe(1); expect(gate.state.peak).toBe(1);
  } finally { gate.release(); await resumed.close(); f.stateDb.close(); }
}, 60000);

test("eviction preserves a failed reply until deliver, then releases idle state without resending", async () => {
  const f = setup(1, { maxIdleGroups: 0 }); f.faux.setResponses([fauxAssistantMessage("answer")]);
  let attempts = 0;
  f.outbound.sendReply = async () => { attempts++; return false; };
  try {
    await f.service.admit("1001", "a", "first", URL);
    await until(() => attempts === 1 && f.service.hasUserRequestCapacity(), "saved failed reply");
    await f.service.maintain();
    expect(f.service.callbackUrl("1001", "a", "fallback")).toBe(URL);
    expect(f.deliveries.pending(JSON.stringify(["a", "1001"]))).toHaveLength(1);
    await f.service.control("1001", "a", "/deliver", URL);
    await f.service.maintain();
    await until(() => f.service.callbackUrl("1001", "a", "fallback") === "fallback", "idle member removed");
    expect(f.deliveries.pending(JSON.stringify(["a", "1001"]))).toHaveLength(0); expect(attempts).toBe(1);
  } finally { await f.service.close(); f.stateDb.close(); }
}, 60000);
