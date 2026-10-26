import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, type Extension, wrapTool } from "@earendil-works/pi-durable";
import { pendingDeliveries } from "../../src/durable/records.ts";
import { DurableService, type DurableServiceOptions } from "../../src/durable/service.ts";
import { fauxModels } from "../helpers/durable.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";
import { appLayout, type Scope } from "../../src/core/layout.ts";

const fixture = await tempFixture("service-recovery-budget-");
afterAll(() => fixture.cleanup());
let sequence = 0;
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}
function setup(extensions?: (scope: Scope) => Extension[], maxIdleSpaces = 16) {
  const { faux, models, model } = fauxModels();
  const out = recordingOutbound();
  const common = {
    layout: appLayout(join(fixture.root, String(++sequence))),
    modules: [], relay: null, materials: false, maxIdleSpaces, extensions,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!,
      ref: model, thinkingLevel: "off" as const, harnessSettings: {} },
    outbound: out.outbound,
  } satisfies Omit<DurableServiceOptions, "limits">;
  const limits = { runTimeoutMs: 120000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 20, activeRequests: 2 };
  return { common, limits, faux, out, replies: () => replyTexts(out.sent) };
}
function safeTools() {
  const counts = [{ active: 0, peak: 0, calls: [] as string[] }, { active: 0, peak: 0, calls: [] as string[] }];
  let phase = 0;
  const releases = new Map<string, () => void>();
  const extensions = (scope: Scope) => {
    const group = scope.kind === "group" ? scope.groupId : "direct";
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
        return { output: [{ type: "text" as const, text: "finished" }] };
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
    await original.admit(f.out.message("100", "1001", "read a"));
    await original.admit(f.out.message("200", "1002", "read b"));
    await until(() => tools.counts[0]!.active === 2, "two original tools");
    await original.close(); tools.resume();
    resumed = new DurableService({ ...f.common, limits: { ...f.limits, activeRequests: 1 } });
    await resumed.start();
    await until(() => tools.counts[1]!.active >= 1, "first recovered tool"); await Bun.sleep(200);
    console.log(JSON.stringify({ probe: "recovered-safe-tools", mode, configured: 1, old: tools.counts[0], resumed: tools.counts[1] }));
    expect(tools.counts[1]!.peak).toBe(1); expect(resumed.hasUserRequestCapacity()).toBe(false);
    expect((await resumed.admit(f.out.message("300", "1003", "new"))).status).toBe("full");
    if (mode === "stop") {
      const running = tools.counts[1]!.calls[0]!, waiting = running === "100" ? "200" : "100";
      await resumed.control(f.out.message(waiting, waiting === "100" ? "1001" : "1002", "/stop"));
      expect(tools.counts[1]!.calls).toEqual([running]);
      await resumed.control(f.out.message(running, running === "100" ? "1001" : "1002", "/stop"));
      await until(() => resumed!.hasUserRequestCapacity(), "both cancellations released");
      expect(tools.counts[1]!.calls).toEqual([running]);
    } else if (mode === "close") {
      await resumed.close(); expect(tools.counts[1]!.active).toBe(0); expect(tools.counts[1]!.calls).toHaveLength(1);
    } else {
      tools.release(); await until(() => tools.counts[1]!.calls.length === 2, "second tool after slot released");
      expect(tools.counts[1]!.active).toBe(1); expect(tools.counts[1]!.peak).toBe(1);
      tools.release(); await until(() => resumed!.hasUserRequestCapacity(), "recovered requests completed");
      // Each recovered answer goes to the message it answers; nothing waits for another message.
      await until(() => f.replies().length === 2, "both recovered replies");
      expect(f.replies().sort()).toEqual(["answer a", "answer b"]);
      for (const [group, phone] of [["100", "1001"], ["200", "1002"]] as const) {
        const records = resumed;
        await until(async () => pendingDeliveries(await records.records(scopeOf(group), phone)).length === 0, "deliveries settled");
      }
    }
  } finally { tools.release(); await resumed?.close(); await original.close(); }
}, 60000);

test("parallel safe tools of one ordinary request reuse its slot", async () => {
  const tools = safeTools(), f = setup(tools.extensions);
  f.faux.setResponses([fauxAssistantMessage([
    fauxToolCall("safe_wait", {}, { id: "read-one" }), fauxToolCall("safe_wait", {}, { id: "read-two" }),
  ], { stopReason: "toolUse" })]);
  const service = new DurableService({ ...f.common, limits: { ...f.limits, activeRequests: 1 } });
  try {
    await service.admit(f.out.message("100", "1001", "parallel reads"));
    await until(() => tools.counts[0]!.active === 2, "parallel child tools");
    expect((await service.admit(f.out.message("200", "1002", "another request"))).status).toBe("full");
    await service.control(f.out.message("100", "1001", "/stop"));
    await until(() => service.hasUserRequestCapacity(), "request cancellation cleanup");
    expect(tools.counts[0]!.active).toBe(0);
  } finally { tools.release(); await service.close(); }
}, 60000);
