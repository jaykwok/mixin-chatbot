// Applying a smaller directory scope end to end: the fake platform's directory, the identity directory, the inbound router
// and a durable service with a faux model. Once the new scope is in effect a member outside it cannot start a request; the
// member's request in flight finishes, and the member's records and statistics stay.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { applicationBinding } from "../../src/core/data-version.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";
import { DurableService } from "../../src/durable/service.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { DirectoryClient } from "../../src/integrations/open-platform/directory.ts";
import { WHOLE_DIRECTORY } from "../../src/integrations/open-platform/directory-scope.ts";
import { IdentityDirectory } from "../../src/integrations/open-platform/identity-directory.ts";
import { InboundRouter } from "../../src/server/inbound.ts";
import { fauxModels, gatedResponse } from "../helpers/durable.ts";
import { FakePlatform } from "../helpers/fake-platform.ts";
import { statsOf } from "../helpers/layout.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("directory-scope-apply-");
afterAll(() => fixture.cleanup());

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}

test("once a smaller scope is in effect a member outside it cannot start a request; the request in flight and the member's history stay", async () => {
  const inside = { phone: "13800000001", name: "成员甲" }, outside = { phone: "13800000002", name: "成员乙" };
  const fake = new FakePlatform();
  fake.directory = { children: { "1": ["2", "3"] }, members: { "2": [inside], "3": [outside] },
    ids: { [inside.phone]: "im-inside", [outside.phone]: "im-outside" } };
  const db = new Database(":memory:");
  const controller = new AbortController();
  const client = new DirectoryClient(new PlatformClient(fake.config, { endpoints: fake.endpoints, retryDelaysMs: [5, 5] }));
  const directory = new IdentityDirectory(db, applicationBinding(fake.config), { perSecond: 1000, concurrency: 8, scope: WHOLE_DIRECTORY });

  const { faux, models, model } = fauxModels();
  const gated = gatedResponse("答复二");
  faux.setResponses([fauxAssistantMessage("答复一"), gated.step, fauxAssistantMessage("答复三")]);
  const out = recordingOutbound();
  const service = new DurableService({ layout: appLayout(fixture.root), modules: [], relay: null, materials: false, outbound: out.outbound,
    limits: { runTimeoutMs: 120000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 20, activeRequests: 4 },
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!, ref: model,
      thinkingLevel: "off", harnessSettings: {} } });
  const router = new InboundRouter({ service, outbound: out.outbound, signal: controller.signal, onUnknown: () => {}, directory });
  let serial = 0;
  const event = (user: string, text: string) => ({ receivedAt: Date.now(), sentAt: Date.now(), payload: {
    eventType: "callback:alt", groupId: "100", userId: user, msgUid: `uid-${++serial}`, type: "text", content: { content: text }, extraContent: "" } });
  const ledger = (phone: string) => {
    const stats = openStatsLedger(statsOf(fixture.root));
    try { return readLedger(stats).asks.filter(row => row.user === phone).reduce((sum, row) => sum + row.asks, 0); } finally { stats.close(); }
  };
  try {
    await directory.scan("initial", client, controller.signal);
    router.handle(event("im-outside", "第一个问题"));
    await until(() => replyTexts(out.sent).length === 1, "first reply");
    // The member's second request is still running when the scope is saved and applied.
    router.handle(event("im-outside", "第二个问题"));
    await gated.started;
    expect(await directory.changeScope({ kind: "departments", departments: ["2"] }, client, controller.signal, async () => {})).toBe("started");
    await until(() => !directory.status().running, "apply finished");
    expect(directory.status()).toMatchObject({ state: "effective", effective: { scope: { kind: "departments", departments: ["2"] } }, mappings: 1 });
    // New requests from outside the scope are refused with the scope notice and never reach the service.
    router.handle(event("im-outside", "第三个问题"));
    router.handle(event("im-inside", "范围内的问题"));
    await router.drain();
    expect(out.sent.filter(item => item.kind === "notice").map(item => item.text)).toEqual([expect.stringContaining("你可能不在机器人同步的部门范围内")]);
    await until(() => replyTexts(out.sent).length === 2, "reply inside the scope");
    // The request received before the switch completes as usual.
    gated.open();
    await until(() => replyTexts(out.sent).length === 3, "request in flight");
    expect(replyTexts(out.sent)).toEqual(["答复一", "答复三", "答复二"]);
    expect(faux.state.callCount).toBe(3);
    // The member's records and statistics are kept.
    await until(() => ledger(outside.phone) === 2, "asks counted");
    expect(ledger(inside.phone)).toBe(1);
    expect(Object.keys((await service.records(groupScope("100"), outside.phone)).requests)).toHaveLength(2);
  } finally {
    controller.abort(); gated.open(); await router.drain(); await service.close(); db.close(); fake.stop();
  }
}, 60000);
