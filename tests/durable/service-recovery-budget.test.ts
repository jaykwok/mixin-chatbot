import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, type Extension, wrapTool } from "@earendil-works/pi-durable";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { DEDUP_TTL } from "../../src/core/config.ts";
import { DurableService, type DurableServiceOptions, memberKey } from "../../src/durable/service.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("service-recovery-budget-");
afterAll(() => fixture.cleanup());
const URL = "https://example.invalid/callback";
let sequence = 0;
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 20000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}
function setup(extensions?: (groupId: string) => Extension[], maxIdleGroups = 16) {
  const stateDb = new Database(":memory:");
  const { faux, models, model } = fauxModels();
  let replies = 0;
  const common = {
    root: join(fixture.root, String(++sequence)), stateDb, deliveries: new DeliveryStore(stateDb),
    modules: [], relay: null, materials: false, maxIdleGroups, extensions,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!,
      ref: model, thinkingLevel: "off" as const, harnessSettings: {}, notices: [] },
    outbound: { sendText: async () => true, sendReply: async () => { replies++; return true; },
      rate: () => ({ used: 0, limit: 20 }), refresh: async (item: { text: string }) => item.text },
  } satisfies Omit<DurableServiceOptions, "limits">;
  const limits = { runTimeoutMs: 120000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 20, activeRequests: 2 };
  return { common, limits, faux, stateDb, replies: () => replies };
}
function safeTools() {
  const counts = [{ active: 0, peak: 0, calls: [] as string[] }, { active: 0, peak: 0, calls: [] as string[] }];
  let phase = 0;
  const releases = new Map<string, () => void>();
  const extensions = (group: string) => {
    const extension = defineExtension({ name: "test.safe-tool", tools: [{ name: "safe_wait",
    description: "A synthetic cancellable safe read.", parameters: Type.Object({}), replay: "safe",
    async execute(_args, api, context) {
      const count = counts[phase]!; count.calls.push(group); count.active++; count.peak = Math.max(count.peak, count.active);
      const key = `${group}:${api.callId}`;
      try {
        await new Promise<void>((resolve, reject) => {
          const signal = context.abortSignal!;
          const cleanup = () => { releases.delete(key); signal.removeEventListener("abort", abort); };
          const abort = () => { cleanup(); reject(signal.reason); };
          releases.set(key, () => { cleanup(); resolve(); });
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
        return { content: [{ type: "text" as const, text: "finished" }] };
      } finally { count.active--; }
    },
    }] });
    // Replacing execute in a later extension must not bypass the lifecycle budget.
    return [extension, defineExtension({ name: "test.safe-tool-wrapper",
      wraps: [wrapTool(extension.tools![0]!, () => extension.tools![0]!)] })];
  };
  return { extensions, counts, resume: () => { phase = 1; }, release: () => { for (const release of [...releases.values()]) release(); } };
}

test.each(["stop", "close", "drain"])("cold recovery safe tools share member slots and %s ends capacity waits", async mode => {
  const tools = safeTools(), f = setup(tools.extensions);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("safe_wait", {}, { id: "read-a" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("safe_wait", {}, { id: "read-b" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("answer a"), fauxAssistantMessage("answer b"),
  ]);
  const original = new DurableService({ ...f.common, limits: f.limits });
  let resumed: DurableService | undefined;
  try {
    await original.admit("1001", "a", "read a", URL);
    await original.admit("1002", "b", "read b", URL);
    await until(() => tools.counts[0]!.active === 2, "two original tools");
    await original.close(); tools.resume();
    resumed = new DurableService({ ...f.common, limits: { ...f.limits, activeRequests: 1 } });
    await resumed.start();
    await until(() => tools.counts[1]!.active >= 1, "first recovered tool"); await Bun.sleep(200);
    console.log(JSON.stringify({ probe: "recovered-safe-tools", mode, configured: 1, old: tools.counts[0], resumed: tools.counts[1] }));
    expect(tools.counts[1]!.peak).toBe(1); expect(resumed.hasUserRequestCapacity()).toBe(false);
    expect((await resumed.admit("1003", "c", "new", URL)).status).toBe("full");
    if (mode === "stop") {
      const running = tools.counts[1]!.calls[0]!, waiting = running === "a" ? "b" : "a";
      await resumed.control(waiting === "a" ? "1001" : "1002", waiting, "/stop", URL);
      expect(tools.counts[1]!.calls).toEqual([running]);
      await resumed.control(running === "a" ? "1001" : "1002", running, "/stop", URL);
      await until(() => resumed!.hasUserRequestCapacity(), "both cancellations released");
      expect(tools.counts[1]!.calls).toEqual([running]);
    } else if (mode === "close") {
      await resumed.close(); expect(tools.counts[1]!.active).toBe(0); expect(tools.counts[1]!.calls).toHaveLength(1);
    } else {
      tools.release(); await until(() => tools.counts[1]!.calls.length === 2, "second tool after slot released");
      expect(tools.counts[1]!.active).toBe(1); expect(tools.counts[1]!.peak).toBe(1);
      tools.release(); await until(() => resumed!.hasUserRequestCapacity(), "recovered requests completed");
      expect(f.common.deliveries.pending(memberKey("a", "1001"))).toHaveLength(1);
      expect(f.common.deliveries.pending(memberKey("b", "1002"))).toHaveLength(1);
      expect(f.replies()).toBe(0); // Callback URLs are learned again after a restart.
    }
  } finally { tools.release(); await resumed?.close(); await original.close(); f.stateDb.close(); }
}, 60000);

test("parallel safe tools of one ordinary request reuse its slot", async () => {
  const tools = safeTools(), f = setup(tools.extensions);
  f.faux.setResponses([fauxAssistantMessage([
    fauxToolCall("safe_wait", {}, { id: "read-one" }), fauxToolCall("safe_wait", {}, { id: "read-two" }),
  ], { stopReason: "toolUse" })]);
  const service = new DurableService({ ...f.common, limits: { ...f.limits, activeRequests: 1 } });
  try {
    await service.admit("1001", "a", "parallel reads", URL);
    await until(() => tools.counts[0]!.active === 2, "parallel child tools");
    expect((await service.admit("1002", "b", "another request", URL)).status).toBe("full");
    await service.control("1001", "a", "/stop", URL);
    await until(() => service.hasUserRequestCapacity(), "request cancellation cleanup");
    expect(tools.counts[0]!.active).toBe(0);
  } finally { tools.release(); await service.close(); f.stateDb.close(); }
}, 60000);

test("maintenance does not renew idle member activity or resurrect expired callbacks", async () => {
  const f = setup(); f.faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("new answer")]);
  const service = new DurableService({ ...f.common, limits: f.limits });
  try {
    await service.admit("1001", "a", "first", URL);
    await until(() => f.replies() === 1 && service.hasUserRequestCapacity(), "reply and cleanup"); await Bun.sleep(100);
    await Bun.sleep(DEDUP_TTL / 2);
    await service.maintain(); await Bun.sleep(100);
    expect(service.callbackUrl("1001", "a", "fallback")).toBe(URL);
    await Bun.sleep(DEDUP_TTL / 2 + 300);
    await service.maintain(); await Bun.sleep(100);
    console.log(JSON.stringify({ probe: "idle-member-pruning", callback: service.callbackUrl("1001", "a", "fallback") }));
    expect(service.callbackUrl("1001", "a", "fallback")).toBe("fallback");
    for (let i = 0; i < 3; i++) { await service.maintain(); await Bun.sleep(30); expect(service.callbackUrl("1001", "a", "fallback")).toBe("fallback"); }
    await service.admit("1001", "a", "new", URL + "/new");
    await until(() => f.replies() === 2 && service.hasUserRequestCapacity(), "new member activity");
    await service.maintain(); await Bun.sleep(50);
    expect(service.callbackUrl("1001", "a", "fallback")).toBe(URL + "/new");
  } finally { await service.close(); f.stateDb.close(); }
}, 60000);
