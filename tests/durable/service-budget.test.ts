import { afterAll, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DurableService, type DurableServiceOptions } from "../../src/durable/service.ts";
import { SpaceHarnesses } from "../../src/durable/spaces.ts";
import { pendingDeliveries } from "../../src/durable/records.ts";
import { InboundRouter } from "../../src/server/inbound.ts";
import { fauxModels, harnessOptions } from "../helpers/durable.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";
import { appLayout, scopeKey } from "../../src/core/layout.ts";

const fixture = await tempFixture("service-budget-");
afterAll(() => fixture.cleanup());
let sequence = 0;
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
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
  const { faux, models, model } = fauxModels();
  const root = join(fixture.root, String(++sequence));
  const out = recordingOutbound();
  const limits = { runTimeoutMs: 120000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 20, activeRequests: max };
  const selection = { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!,
    ref: model, thinkingLevel: "off" as const, harnessSettings: {} };
  const service = new DurableService({ layout: appLayout(root), modules: [], relay: null, materials: false, limits, selection, outbound: out.outbound, ...options });
  const replies = () => replyTexts(out.sent);
  return { service, faux, models, root, out, replies, limits, selection };
}

test("an inbound message beyond capacity gets the busy notice and is not admitted; after /stop the next one is", async () => {
  const f = setup(), gate = blocked(); f.faux.setResponses([gate.step, gate.step]);
  const controller = new AbortController();
  const ids: Record<string, string> = { "im-a": "13800000001", "im-b": "13800000002" };
  const router = new InboundRouter({ service: f.service, outbound: f.out.outbound, signal: controller.signal, onUnknown: () => {},
    directory: { initializing: false, lookup: id => ids[id] ? { phone: ids[id]!, imUserId: id, name: id } : undefined } });
  let serial = 0;
  const event = (user: string, text: string) => ({ receivedAt: Date.now(), sentAt: Date.now(), payload: {
    eventType: "callback:alt", groupId: "100", userId: user, msgUid: `uid-${++serial}`, type: "text", content: { content: text }, extraContent: "" } });
  try {
    router.handle(event("im-a", "first"));
    await until(() => gate.state.active === 1, "first provider");
    expect(f.service.hasUserRequestCapacity()).toBe(false);
    const busy = event("im-b", "second");
    router.handle(busy); await router.drain();
    expect(f.out.sent.filter(item => item.kind === "notice").map(item => item.text)).toEqual(["⚠️ 机器人现在比较忙，这条消息未加入队列，不会自动处理，请稍后重新发送。"]);
    // A redelivery of the refused message is dropped in process; it is not admitted later either.
    router.handle(busy); await router.drain();
    expect(f.out.sent.filter(item => item.kind === "notice")).toHaveLength(1);
    router.handle(event("im-a", "/stop")); await router.drain();
    await until(() => f.service.hasUserRequestCapacity(), "released cancellation capacity");
    router.handle(event("im-b", "second again")); await router.drain();
    await until(() => gate.state.calls === 2, "next provider");
    expect(gate.state.peak).toBe(1);
  } finally { controller.abort(); gate.release(); await router.drain(); await f.service.close(); }
}, 60000);

test("queued requests occupy capacity; a duplicate message is not admitted twice and takes no slot", async () => {
  const f = setup(2), gate = blocked(); f.faux.setResponses([gate.step, fauxAssistantMessage("queued"), fauxAssistantMessage("other")]);
  try {
    const first = f.out.message("100", "1001", "first");
    expect((await f.service.admit(first)).status).toBe("accepted");
    await until(() => gate.state.active === 1, "running head");
    expect((await f.service.admit(first)).status).toBe("duplicate");
    expect((await f.service.admit(f.out.message("100", "1001", "queued"))).status).toBe("accepted");
    expect((await f.service.admit(first)).status).toBe("duplicate");
    expect((await f.service.admit(f.out.message("200", "1002", "other"))).status).toBe("full");
    gate.release(); await until(() => f.replies().length === 2, "queue drained");
    await until(() => f.service.hasUserRequestCapacity(), "capacity released");
    expect((await f.service.admit(f.out.message("200", "1002", "other"))).status).toBe("accepted");
    await until(() => f.replies().length === 3, "released completion capacity");
    expect(gate.state.calls).toBe(1);
  } finally { gate.release(); await f.service.close(); }
}, 60000);

test("evicted Harnesses are collectable", async () => {
  const f = setup(2, { maxIdleSpaces: 0 }); f.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  const seen = new Map<string, WeakRef<object>>();
  const acquire = SpaceHarnesses.prototype.acquire, sweep = SpaceHarnesses.prototype.sweep;
  let open = -1;
  SpaceHarnesses.prototype.acquire = async function(scope) { const handle = await acquire.call(this, scope); seen.set(scopeKey(scope), new WeakRef(handle.harness)); return handle; };
  SpaceHarnesses.prototype.sweep = async function() { await sweep.call(this); open = this.openSpaces.length; };
  try {
    for (const group of ["100", "200"]) {
      await f.service.admit(f.out.message(group, "1001", "hello"));
      await until(() => f.replies().length === seen.size, "reply");
      await until(() => f.service.hasUserRequestCapacity(), "delivery finished");
      await f.service.maintain(); await until(() => open === 0, "eviction");
    }
    SpaceHarnesses.prototype.acquire = acquire; SpaceHarnesses.prototype.sweep = sweep;
    await f.service.maintain();
    const control = new SpaceHarnesses({ layout: appLayout(join(f.root, "control")), maxIdle: 0, harnessOptions: harnessOptions(f.models) });
    const controlRef = await (async () => { const handle = await control.acquire(scopeOf("control")); const ref = new WeakRef(handle.harness); handle.release(); return ref; })();
    await control.sweep();
    // A full-suite run can need more than five collections for the otherwise unreachable control Harness.
    // Observe release across event-loop turns, with a bound that still fails for a real retained reference.
    const collectionDeadline = Date.now() + 5000;
    do { await Bun.sleep(20); Bun.gc(true); }
    while ((controlRef.deref() !== undefined || [...seen.values()].some(ref => ref.deref() !== undefined)) && Date.now() < collectionDeadline);
    const retained = [...seen].filter(([, ref]) => ref.deref() !== undefined).map(([group]) => group);
    console.log(JSON.stringify({ probe: "retention", open, retained, controlRetained: controlRef.deref() !== undefined }));
    expect(controlRef.deref()).toBeUndefined(); expect(retained).toHaveLength(0);
    await control.closeAll();
  } finally { SpaceHarnesses.prototype.acquire = acquire; SpaceHarnesses.prototype.sweep = sweep; await f.service.close(); }
}, 60000);

test("parallel admissions reserve before opening and identity failure releases the slot", async () => {
  const f = setup(), gate = blocked(); f.faux.setResponses([gate.step]);
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.service.admit(f.out.message("100", String(i), String(i)))));
    expect(results.filter(result => result.status === "accepted")).toHaveLength(1);
    await until(() => gate.state.active === 1, "only admitted provider");
    await f.service.control(f.out.message("100", "0", "/stop"));
    await until(() => f.service.hasUserRequestCapacity(), "stop frees slot");
    const storage = await import("../../src/agent/storage-identity.ts");
    const identity = spyOn(storage, "ensureStorageIdentity").mockRejectedValueOnce(new Error("synthetic identity failure"));
    try { await expect(f.service.admit(f.out.message("200", "1002", "failed"))).rejects.toThrow("synthetic identity failure"); }
    finally { identity.mockRestore(); }
    expect(f.service.hasUserRequestCapacity()).toBe(true);
  } finally { gate.release(); await f.service.close(); }
}, 60000);

test("capacity stays reserved while the final reply is still being sent", async () => {
  const f = setup(), sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.faux.setResponses([fauxAssistantMessage("answer")]);
  const send = f.out.outbound.send;
  f.out.outbound.send = async (target, message, options) => {
    if (message.msgType === "markdown" && message.content.content.endsWith("answer")) { sending.resolve(); await release.promise; }
    return send(target, message, options);
  };
  try {
    await f.service.admit(f.out.message("100", "1001", "first")); await sending.promise;
    expect(f.service.hasUserRequestCapacity()).toBe(false);
    expect((await f.service.admit(f.out.message("200", "1002", "second"))).status).toBe("full");
    release.resolve(); await until(() => f.service.hasUserRequestCapacity(), "reply delivery completed");
  } finally { release.resolve(); await f.service.close(); }
}, 60000);

test("cold recovery bounds old running tasks after a lower limit and stop can cancel a waiting member", async () => {
  const f = setup(2), old = blocked(); f.faux.setResponses([old.step, old.step]);
  await f.service.admit(f.out.message("100", "1001", "first"));
  await f.service.admit(f.out.message("200", "1002", "second"));
  await until(() => old.state.active === 2, "two old tasks");
  await f.service.close(); old.release();
  const gate = blocked(); f.faux.setResponses([gate.step, gate.step]);
  const resumed = new DurableService({ layout: appLayout(f.root), selection: f.selection, modules: [], relay: null, materials: false,
    outbound: f.out.outbound, limits: { ...f.limits, activeRequests: 1 } });
  try {
    expect(await resumed.start()).toEqual([scopeOf("100"), scopeOf("200")]);
    await until(() => gate.state.active === 1, "one resumed provider"); await Bun.sleep(100);
    expect(gate.state.peak).toBe(1); expect(resumed.hasUserRequestCapacity()).toBe(false);
    expect((await resumed.admit(f.out.message("300", "1003", "new"))).status).toBe("full");
    await resumed.control(f.out.message("200", "1002", "/stop"));
    expect(gate.state.calls).toBe(1);
    await resumed.control(f.out.message("100", "1001", "/stop"));
    await until(() => resumed.hasUserRequestCapacity(), "recovered cancellations cleaned up");
    expect(gate.state.calls).toBe(1); expect(gate.state.peak).toBe(1);
  } finally { gate.release(); await resumed.close(); }
}, 60000);

test("a refused reply survives maintenance with no idle groups kept, and its retry sends it once", async () => {
  const f = setup(1, { maxIdleSpaces: 0, limits: { runTimeoutMs: 120000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 20, activeRequests: 1,
    deliveryRetryMs: [500] } });
  f.faux.setResponses([fauxAssistantMessage("answer")]);
  let attempts = 0;
  f.out.state.failWhen = item => item.kind === "reply" && ++attempts === 1 ? "failed" : false;
  try {
    await f.service.admit(f.out.message("100", "1001", "first"));
    await until(() => attempts === 1 && f.service.hasUserRequestCapacity(), "saved failed reply");
    await f.service.maintain();
    expect(pendingDeliveries(await f.service.records(scopeOf("100"), "1001"))).toHaveLength(1);
    await until(async () => pendingDeliveries(await f.service.records(scopeOf("100"), "1001")).length === 0, "the retry");
    await f.service.maintain();
    expect(attempts).toBe(2); expect(f.replies()).toEqual(["answer"]);
    expect(f.out.sent.filter(item => item.kind === "notice")).toEqual([]);
  } finally { await f.service.close(); }
}, 60000);
