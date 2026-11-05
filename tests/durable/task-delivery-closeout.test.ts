// Task deadline closeout: registered deliverables, the fallback delivery and its parts, run-time file sends.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as deliverables from "../../src/agent/deliverables.ts";
import { completeFile, deliverableCandidates, fileDigest, freezeFile, registerDeliverable, releasableSnapshots } from "../../src/agent/deliverables.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { createSession, defineExtension, Harness } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { IdentityDoc, MemberDirectory } from "../../src/durable/identity.ts";
import { activeRequest, closeoutExtension, deliverableTool } from "../../src/durable/closeout.ts";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { MemberCall, MemberTool } from "../../src/durable/tools.ts";
import { sendTools } from "../../src/agent/send-tools.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { fileDelivery } from "../../src/durable/file-delivery.ts";
import { BASH_DEFAULT_TIMEOUT, NATIVE_FILE_MAX_BYTES } from "../../src/core/config.ts";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { appendTiming, closeoutTool, localTime, validateCloseout } from "../../src/durable/closeout.ts";
import { MemberRecordsDoc, pendingDeliveries, recordsOf, settleInterrupted, type DeliveryPart, type LinkNote, type MemberRecords, type RequestRecord }
  from "../../src/durable/records.ts";
import { DurableService, type DurableServiceOptions } from "../../src/durable/service.ts";
import { fauxModels } from "../helpers/durable.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";
import { recordingOutbound } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { databaseOf, scopeOf, statsOf, tmpOf } from "../helpers/layout.ts";

const fixture = await tempFixture("closeout-"); afterAll(() => fixture.cleanup());
let seq = 0;
const GROUP = "100", PHONE = "1001";
const timing = { closeoutMs: 500, reserveMs: 100, fallbackMs: 2000 };
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("timeout: " + label); await Bun.sleep(10); }
}
const failModel = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic model error" });
/** A tool that leaves in the run record what a run-time send commits there. */
const seedSend = (change: (record: RequestRecord) => void) => () => [defineExtension({ name: "send-fixture", tools: [{
  name: "seed_send", description: "Synthetic run-time send", parameters: obj({}, { open: true }), replay: "safe",
  async execute(_args, api, invocation) {
    const item = (await activeRequest(api, invocation))!;
    await api.commit(async tx => change((await recordsOf(tx, item.phone)).requests[item.requestId]!), invocation);
    return { output: [{ type: "text", text: "recorded" }] };
  },
}] })];
const callSeed = () => fauxAssistantMessage([fauxToolCall("seed_send", {})], { stopReason: "toolUse" });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function setup(alias?: "case" | "link") {
  const actual = join(fixture.root, String(++seq)); await mkdir(actual);
  let root = actual;
  if (alias === "case" && process.platform === "win32") root = actual.toLowerCase();
  if (alias === "link") { root = actual + "-alias"; await fs.symlink(actual, root, process.platform === "win32" ? "junction" : "dir"); }
  const temp = tmpOf(root, GROUP, PHONE); await mkdir(temp, { recursive: true });
  const path = join(temp, "report.txt"); await writeFile(path, "original version");
  const { faux, models, model } = fauxModels();
  const out = recordingOutbound(), uploads: string[] = [];
  const upload = out.outbound.upload;
  // The bytes each upload carried: a file message only names the file.
  out.outbound.upload = async (source, signal) => { uploads.push(`${source.fileName}:${await readFile(source.path, "utf8")}`); return upload(source, signal); };
  const options: DurableServiceOptions = { layout: appLayout(root), modules: [], relay: null, materials: false, outbound: out.outbound,
    closeout: timing, limits: { runTimeoutMs: 3000, modelIdleMs: 3000, modelResponseMs: 3000, tickMs: 10, deliveryRetryMs: [100] },
    selection: { runtime: models as never, settings: undefined as never, ref: model, model: models.getModel(model.provider, model.modelId)!, thinkingLevel: "off",
      harnessSettings: { retry: { maxRetries: 0 } } } };
  const service = new DurableService(options);
  const register = (status = "draft") => fauxAssistantMessage([fauxToolCall("deliverable_register", { path, status, checked: [], unchecked: ["版式"], issues: [] })], { stopReason: "toolUse" });
  const message = (content: string) => out.message(GROUP, PHONE, content);
  const files = () => out.sent.filter(x => x.kind === "file");
  const record = async (svc = service) => Object.values((await svc.records(scopeOf(GROUP), PHONE)).requests).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const notices = (prefix: string) => out.sent.filter(x => x.kind === "notice" && x.text.startsWith(prefix));
  return { service, options, root, temp, path, faux, out, uploads, register, message, files, record, notices };
}

/** A fake invocation of one running request: snapshots and commits over an in-memory run record. */
function fakeRun(requestId: string, startedAt = Date.now()) {
  const record: RequestRecord = { requestId, createdAt: startedAt, notes: [], deliverables: [], files: [], events: {},
    reply: { kind: "group", receiveId: GROUP, senderImUserId: "im-1001", msgUid: `uid-${requestId}`, summary: "问题", receivedAt: startedAt } };
  const records: MemberRecords = { requests: { [requestId]: record }, attachments: {} };
  const tx = { doc: async (doc: unknown) => { if (doc === MemberRecordsDoc) return records; throw new Error("unexpected document"); } };
  const api = { conversationId: 1, taskId: 42, callId: requestId, agent: async () => ({}),
    snapshot: async (doc: unknown) => doc === InboxDoc ? { items: [{ requestId, startedAt }] }
      : doc === IdentityDoc ? { space: `group:${GROUP}`, phone: PHONE } : doc === MemberRecordsDoc ? structuredClone(records) : undefined,
    commit: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const write = async (_phone: string, _id: string, change: (r: RequestRecord) => void) => change(record);
  return { api, record, write, call: { api, context, callId: requestId, signal: undefined } as unknown as MemberCall };
}

/** deliverable_register as Durable calls it in the fake run; an error result rejects with its text. */
async function register(tool: MemberTool, params: object, run: ReturnType<typeof fakeRun>) {
  const result = await tool.registration.execute(params, run.api as never, context);
  if (result.isError) throw new Error(result.output?.map((part) => part.type === "text" ? part.text : "").join(""));
  return result;
}

test("model failure delivers only the registered immutable version, explanation first, then releases the snapshot", async () => {
  const f = await setup();
  f.faux.setResponses([f.register(), async () => { await writeFile(f.path, "later edit"); return failModel(); }]);
  try {
    await f.service.admit(f.message("make a report"));
    await until(() => f.files().length === 1, "fallback file");
    expect(f.uploads).toEqual(["report.txt:original version"]);
    const explanation = f.out.sent.findIndex(x => x.kind === "reply" && x.text.includes("未完成全部检查"));
    expect(explanation).toBeGreaterThan(-1); expect(explanation).toBeLessThan(f.out.sent.findIndex(x => x.kind === "file"));
    expect(f.out.sent[explanation]!.text).not.toContain("已检查");
    // The explanation leads with the @ of the asker, like a reply.
    expect(f.out.sent[explanation]!.mention).toBe("im-1001");
    await until(async () => pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE)).length === 0, "delivered");
    expect((await f.record())!.delivery!.deadline).toBeDefined();
    const snapshot = (await f.record())!.deliverables[0]!.path;
    await until(async () => !await stat(snapshot).then(() => true, () => false), "snapshot removal");
  } finally { await f.service.close(); }
});

test.each(["unregistered", "rejected", "incomplete"])("failure never auto sends %s files", async kind => {
  const f = await setup();
  if (kind === "incomplete") await writeFile(f.path, "");
  f.faux.setResponses(kind === "unregistered" ? [failModel()] : [f.register(kind === "rejected" ? "rejected" : "draft"), failModel()]);
  try {
    await f.service.admit(f.message("make a report"));
    await until(() => f.out.sent.some(x => x.text.includes("Synthetic model error")), "failure explanation");
    expect(f.files()).toEqual([]);
    // A run that registered nothing is only told why it failed: a plain question is not steered towards files.
    expect(f.out.sent.some(x => x.text.includes("没有可交付"))).toBe(kind !== "unregistered");
  } finally { await f.service.close(); }
});

test.each([false, true])("fallback prefers a checked version and falls back when its snapshot is damaged (tampered=%s)", async tampered => {
  const f = await setup();
  f.faux.setResponses([f.register("draft"), async () => {
    await writeFile(f.path, "checked content");
    return fauxAssistantMessage([fauxToolCall("deliverable_register", { path: f.path, status: "checked", checked: ["正文数据与资料核对"], unchecked: ["版式"], issues: [] })], { stopReason: "toolUse" });
  }, async () => {
    await writeFile(f.path, "new unreviewed content"); return f.register("draft");
  }, async () => {
    if (tampered) for (const item of (await f.record())!.deliverables) if (item.status === "checked") await writeFile(item.path, "damaged bytes");
    return failModel();
  }]);
  try {
    await f.service.admit(f.message("make a report"));
    await until(() => f.files().length === 1, "selected version");
    expect(f.uploads).toEqual(["report.txt:" + (tampered ? "new unreviewed content" : "checked content")]);
    const text = f.out.sent.find(x => x.text.includes("系统将交付"))!.text;
    expect(text).toContain(tampered ? "未完成全部检查" : "正文数据与资料核对");
    if (!tampered) expect(text).toContain("已检查版本");
  } finally { await f.service.close(); }
});

test("a failed explanation holds the files back; its retry resumes the saved plan without touching the ledger", async () => {
  const f = await setup(); let refusing = true;
  f.out.state.failWhen = item => refusing && item.kind === "reply" ? "failed" : false;
  f.faux.setResponses([f.register(), failModel()]);
  try {
    await f.service.admit(f.message("make a report"));
    await until(async () => ((await f.record())?.delivery?.parts[0]?.attempts ?? 0) >= 2, "a retried explanation");
    expect(f.files()).toEqual([]);
    expect((await f.record())!.delivery!.parts[1]!.state).toBe("pending");
    const ledger = openStatsLedger(statsOf(f.root));
    try {
      const before = readLedger(ledger);
      refusing = false;
      await until(async () => f.files().length === 1 && pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE)).length === 0, "the saved plan");
      expect(readLedger(ledger)).toEqual(before); // Delivery, snapshot release and record writes do not rewrite usage.
    } finally { ledger.close(); }
  } finally { await f.service.close(); }
});

test("an uncertain attachment counts as sent: its snapshot is released and it is not sent again, also after a restart", async () => {
  const f = await setup(); f.out.state.failWhen = item => item.kind === "file" ? "uncertain" : false;
  f.faux.setResponses([f.register(), failModel()]);
  let resumed: DurableService | undefined;
  try {
    await f.service.admit(f.message("make a report"));
    await until(async () => (await f.record())?.delivery?.parts[1]?.state === "uncertain", "uncertain send");
    const path = (await f.record())!.delivery!.parts[1]!.file!.path;
    await until(async () => !await stat(path).then(() => true, () => false), "released snapshot");
    expect(pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE))).toEqual([]);
    await f.service.close(); resumed = new DurableService(f.options); await resumed.start();
    f.faux.setResponses([fauxAssistantMessage("ordinary reply")]); f.out.state.failWhen = undefined;
    await resumed.admit(f.message("hello"));
    await until(() => f.out.sent.some(x => x.kind === "reply" && x.text === "ordinary reply"), "ordinary reply");
    await Bun.sleep(200);
    expect(f.files()).toEqual([]);
  } finally { await resumed?.close(); await f.service.close(); }
});

test.each(["/stop", "/clear"])("%s wins over a registered draft and no fallback is sent", async command => {
  const f = await setup(), started = Promise.withResolvers<void>();
  const waiting: FauxResponseFactory = (_transcript, options) => new Promise(resolve => {
    started.resolve(); options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
  });
  f.faux.setResponses([f.register(), waiting]);
  try {
    await f.service.admit(f.message("make a report")); await started.promise;
    await f.service.control(f.message(command));
    expect(f.out.sent.some(x => x.kind === "file" || x.text.includes("系统将交付"))).toBe(false);
    expect(pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE))).toEqual([]);
  } finally { await f.service.close(); }
});

test("clock tail is copied, budgets clamp bash, delivery refuses nesting entry points, configuration rejects invalid order", async () => {
  const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];
  const added = appendTiming(messages, "[任务计时] test", 2);
  expect(messages[0]!.content).toBe("hello"); expect(JSON.stringify(added)).toContain("任务计时");
  const t = { closeoutMs: 300_000, reserveMs: 120_000, fallbackMs: 120_000 };
  expect(() => validateCloseout(t, 1200_000)).not.toThrow(); expect(() => validateCloseout(t, 500_000)).toThrow("小于");
  let run = fakeRun("r", Date.now() - 1200_000 + 200_000);
  const clamped = await closeoutTool("bash", { command: "sleep 1000", timeout: 600 }, run.api as never, context, t, 1200_000) as { timeout: number };
  expect(clamped.timeout).toBeLessThanOrEqual(80);
  run = fakeRun("r", Date.now() - 1200_000 + 60_000);
  for (const name of ["bash", "document_build", "codemode", "edit"]) await expect(closeoutTool(name, {}, run.api as never, context, t, 1200_000)).rejects.toThrow("交付阶段");
  for (const name of ["send_file", "send_image", "read", "deliverable_register"]) expect(await closeoutTool(name, {}, run.api as never, context, t, 1200_000)).toEqual({});
});

test("deliverable rules: a rejection covers every copy, limits per request, interrupted sends become uncertain, open parts keep their snapshots", async () => {
  const f = await setup();
  try {
    const run = fakeRun("r"), frozen = await freezeFile(f.path, f.temp, "r", 1024);
    const entry = { ...frozen, slot: "report", complete: true, checked: [], unchecked: [], issues: [] };
    registerDeliverable(run.record, { ...entry, status: "checked" });
    registerDeliverable(run.record, { ...entry, status: "rejected" });
    expect(deliverableCandidates(run.record)).toEqual([]);
    for (const slot of ["b", "c"]) registerDeliverable(run.record, { ...entry, slot, status: "draft" });
    expect(() => registerDeliverable(run.record, { ...entry, slot: "d", status: "draft" })).toThrow("3 个交付物");
    for (let n = run.record.deliverables.length; n < 8; n++) registerDeliverable(run.record, { ...entry, status: "draft" });
    expect(() => registerDeliverable(run.record, { ...entry, status: "draft" })).toThrow("8 个版本");

    const sent = await freezeFile(f.path, f.temp, "next", 1024), unsent = await freezeFile(f.path, f.temp, "next", 1024);
    const records: MemberRecords = { attachments: {}, requests: { next: { ...fakeRun("next").record, closedAt: Date.now(),
      files: [{ id: "run-send", name: "report.txt", path: sent.path, sha256: sent.sha256, size: sent.size, mode: "direct", state: "sending", attempts: 1, at: 1 }],
      delivery: { kind: "fallback", createdAt: 1, parts: [
        { id: "m0", kind: "markdown", body: "explanation", lead: true, state: "sent", attempts: 1 },
        { id: "f0", kind: "file", file: { name: "report.txt", path: unsent.path, size: unsent.size, sha256: unsent.sha256 }, state: "sending", attempts: 1 }] } } } };
    settleInterrupted(records);
    const next = records.requests.next!;
    // Fallback file parts are registered versions.
    registerDeliverable(next, { ...unsent, slot: "report", complete: true, status: "draft", checked: [], unchecked: [], issues: [] });
    expect([next.files[0]!.state, next.delivery!.parts[1]!.state]).toEqual(["uncertain", "uncertain"]);
    // An uncertain part counts as sent. A run-time send is not part of the plan: its snapshot goes either way.
    expect(releasableSnapshots(next).sort()).toEqual([sent.path, unsent.path].sort());
    // A file part still to be sent (failed, its retry due later) keeps its own; a final failure or an abandoned delivery does not.
    Object.assign(next.delivery!.parts[1]!, { state: "failed", retryAt: Date.now() + 60_000 });
    expect(releasableSnapshots(next)).toEqual([sent.path]);
    next.delivery!.abandoned = { at: Date.now(), reason: "expired" };
    expect(releasableSnapshots(next).sort()).toEqual([sent.path, unsent.path].sort());
    delete next.delivery!.abandoned; delete next.delivery!.parts[1]!.retryAt;
    expect(releasableSnapshots(next).sort()).toEqual([sent.path, unsent.path].sort());
    expect(await fileDigest(unsent.path)).toBe(unsent.sha256);
    await writeFile(unsent.path, "tampered"); expect(await fileDigest(unsent.path)).not.toBe(unsent.sha256);
    expect(await completeFile(unsent.path, "docx")).toBe(false);
  } finally { await f.service.close(); }
});

test.each(["task_timeout", "model_idle", "model_response_timeout"])("watchdog %s delivers a draft with its independent budget", async reason => {
  const f = await setup(); await f.service.close();
  // Every limit also covers the first model call, which registers the draft; a CI stall there longer than the
  // limit would abort before any draft exists. Give the limit under test that headroom and keep the others out of reach.
  const limit = (kind: string) => reason === kind ? 1500 : 30_000, logs: string[] = [];
  const service = new DurableService({ ...f.options, onLog: line => logs.push(line), limits: { runTimeoutMs: limit("task_timeout"), tickMs: 10,
    modelIdleMs: limit("model_idle"), modelResponseMs: limit("model_response_timeout") },
    closeout: { closeoutMs: 250, reserveMs: 100, fallbackMs: 2000 } });
  f.faux.setResponses([f.register(), (_t, options) => new Promise(resolve => {
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
  })]);
  try {
    await service.admit(f.message("make report"));
    await until(() => f.files().length > 0, reason);
    expect(f.files()).toHaveLength(1);
    expect(f.out.sent.some(x => x.text.includes("草稿"))).toBe(true);
    expect(logs.filter(line => line.includes("取消原因: "))).toEqual([expect.stringContaining("取消原因: " + reason)]);
  } finally { await service.close(); }
}, 30_000);

test("a failing step of the settling is retried with the watchdog's reason", async () => {
  const f = await setup(), logs: string[] = [], hang = Promise.withResolvers<void>();
  let fail = true;
  const open = Harness.open.bind(Harness);
  const failing = spyOn(Harness, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const opened = await open(...args), commit = opened.commit.bind(opened);
    opened.commit = ((work: never, invocation: never) => {
      if (fail && /#close/.test(new Error().stack ?? "")) { fail = false; throw new Error("synthetic commit failure"); }
      return commit(work, invocation);
    }) as never;
    return opened;
  });
  const service = new DurableService({ ...f.options, onLog: line => logs.push(line),
    limits: { ...f.options.limits, modelIdleMs: 200, modelResponseMs: 60_000, runTimeoutMs: 60_000 } });
  f.faux.setResponses([async (_context, options) => {
    await new Promise<void>(done => { void hang.promise.then(done); options?.signal?.addEventListener("abort", () => done(), { once: true }); });
    return failModel();
  }]);
  try {
    await service.admit(f.message("question"));
    await until(() => f.out.sent.some(x => x.text.includes("模型连续")), "the reason, after the retry");
    expect(fail).toBe(false);
    expect(f.out.sent.some(x => x.text.includes("时限检查已中止"))).toBe(false);
  } finally { hang.resolve(); failing.mockRestore(); await service.close(); await f.service.close(); }
}, 30_000);

test("a stop during the first fallback attachment drops the rest and frees its snapshots", async () => {
  const f = await setup(), path2 = join(f.temp, "other.txt"); await writeFile(path2, "other version");
  const upload = f.out.outbound.upload; let stop = true;
  f.out.outbound.upload = async (source, signal) => {
    // Upload of the first file: the /stop is committed (the delivery withdrawn) before the send goes on.
    if (stop) { stop = false; await f.service.control(f.message("/stop")); }
    return upload(source, signal);
  };
  f.faux.setResponses([f.register(), fauxAssistantMessage([fauxToolCall("deliverable_register", { path: path2, status: "draft", checked: [], unchecked: [], issues: [] })], { stopReason: "toolUse" }), failModel()]);
  try {
    await f.service.admit(f.message("two reports"));
    await until(async () => (await f.record())?.delivery?.parts.some(x => x.kind === "file" && x.state === "sent") === true, "first send");
    const delivery = (await f.record())!.delivery!;
    expect(delivery.abandoned?.reason).toBe("withdrawn");
    expect(delivery.parts.filter(x => x.kind === "file").map(x => x.state)).toEqual(["sent", "pending"]);
    const rest = delivery.parts.filter(x => x.kind === "file")[1]!.file!.path;
    await until(async () => !await stat(rest).then(() => true, () => false), "released snapshot");
    await Bun.sleep(300);
    expect(f.files()).toHaveLength(1);
    expect(pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE))).toEqual([]);
  } finally { await f.service.close(); }
});

test("every provider attempt gets fresh timing but stored conversation messages do not", async () => {
  const f = await setup(), seen: string[] = [];
  f.faux.setResponses([transcript => { seen.push(JSON.stringify(transcript.messages)); return f.register(); },
    transcript => { seen.push(JSON.stringify(transcript.messages)); return failModel(); }]);
  try {
    await f.service.admit(f.message("make report"));
    await until(() => f.files().length > 0, "file");
    expect(seen).toHaveLength(2); for (const transcript of seen) expect(transcript).toContain("[任务计时]");
    // The request's own directory below the member's tmp (the only write root of edit/write), with forward slashes.
    for (const transcript of seen) expect(transcript).toContain(`\\n[临时目录] ${f.temp.replace(/\\/g, "/")}/tasks/msg-`);
    await f.service.close();
    const storage = await openGroupStorage(databaseOf(f.root, GROUP)), sessionView = createSession(storage);
    try {
      const member = await sessionView.snapshot(MemberDirectory, PHONE, context);
      const entries = await storage.scanEntries({ conversationId: member!.conversationId as never }, 200, undefined, context);
      // The stable system prompt explains the marker; only the dynamic countdown must stay out of history.
      expect(JSON.stringify(entries.items.map(x => x.model))).not.toContain("[任务计时] 剩余");
      expect(JSON.stringify(entries.items.map(x => x.model))).not.toContain("[临时目录] ");
    } finally { await sessionView.close(context); }
  } finally { await f.service.close(); }
});

test("recovered time uses persisted startedAt and DeepSeek accepts both user-tail and tool-result-tail injection", async () => {
  const start = Date.now() - 600000, run = fakeRun("recovered", start);
  const extension = closeoutExtension(run.write, { closeoutMs: 300000, reserveMs: 120000, fallbackMs: 120000 }, 1200000);
  const handler = (extension.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers.beforeRequest;
  const messages = [{ role: "user" as const, content: "hello", timestamp: start }];
  const injected = await handler({ messages }, run.api as never, context);
  expect(injected).toBeDefined();
  expect(JSON.stringify(injected!.messages)).toMatch(/剩余 (9分\d+|10分0)秒/);
  expect(messages[0]!.content).toBe("hello");
  const proxy = deepseekProvider().getModels()[0]!;
  for (const transcript of [injected!.messages, appendTiming([...messages,
    fauxAssistantMessage([fauxToolCall("read", { path: "file.txt" }, { id: "c" })], { stopReason: "toolUse" }),
    { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 1 }], "[任务计时] test", Date.now())]) {
    expect(JSON.stringify(convertMessages(proxy as never, { messages: transcript } as never, {} as never))).toContain("任务计时");
  }
});

test("rebuild counts only advise; nested successes count once and factual repairs remain allowed before delivery", async () => {
  const run = fakeRun("rebuild", Date.now() - 1000000);
  const t = { closeoutMs: 300000, reserveMs: 120000, fallbackMs: 120000 }, extension = closeoutExtension(run.write, t, 1200000);
  const generation = (extension.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers;
  const tools = (extension.hooks![1] as { handlers: import("@earendil-works/pi-durable").ToolHooks }).handlers;
  for (let n = 0; n < 4; n++) {
    const call = { id: String(n), name: "document_build", args: {}, parent: "nested" };
    await tools.afterTool(call as never, { output: [] }, run.api as never, context);
    await tools.afterTool(call as never, { output: [] }, run.api as never, context);
  }
  await tools.afterTool({ id: "failed", name: "document_build", args: {} } as never, { output: [], isError: true }, run.api as never, context);
  const clock = await generation.beforeRequest({ messages: [{ role: "user", content: "repair", timestamp: 1 }] }, run.api as never, context);
  expect(JSON.stringify(clock!.messages)).toContain("已生成文档 4 版");
  expect(JSON.stringify(clock!.messages)).toContain("除修正事实错误外不要再重建");
  expect(await closeoutTool("document_build", { repair: true }, run.api as never, context, t, 1200000)).toEqual({ repair: true });
});

/** A minimal valid, uncompressed ZIP fixture; contents need only satisfy the structural completeness contract. */
function officeZip(): Buffer {
  const locals: Buffer[] = [], directories: Buffer[] = []; let offset = 0;
  for (const name of ["[Content_Types].xml", "word/document.xml"]) {
    const filename = Buffer.from(name), data = Buffer.from("<root/>"); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); directories.push(directory, filename); offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directories), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, central, end]);
}

test("layout checks require the same rendered digest; registrations are bounded and source changes cannot change a snapshot", async () => {
  const f = await setup(), source = join(f.temp, "report.docx"); await writeFile(source, officeZip());
  const run = fakeRun(`msg:${crypto.randomUUID()}`), tool = deliverableTool({ layout: appLayout(f.root), scope: groupScope(GROUP) });
  try {
    const params = { path: source, status: "checked", checked: ["版式看图", "正文与资料核对"], unchecked: [], issues: [] };
    await register(tool, params, run);
    const initial = run.record.deliverables[0]!;
    expect(initial.complete).toBe(true); expect(initial.status).toBe("draft"); expect(initial.checked).toEqual(["正文与资料核对"]);
    run.record.events.render = { name: "document_render", digest: await fileDigest(source), at: Date.now() };
    await register(tool, params, run);
    expect(run.record.deliverables[1]!.status).toBe("checked");
    for (let n = 2; n < 8; n++) await register(tool, { ...params, status: "draft" }, run);
    await expect(register(tool, params, run)).rejects.toThrow("8 个版本");
    await writeFile(source, "truncated"); expect(await fileDigest(initial.path)).toBe(initial.sha256);
    expect(await completeFile(source, "docx")).toBe(false);
  } finally { await f.service.close(); }
});

test("registration rejects cross-member paths and a source changed during copying", async () => {
  const f = await setup(), outside = join(f.root, "other-member.txt"); await writeFile(outside, "private");
  const run = fakeRun(`msg:${crypto.randomUUID()}`), tool = deliverableTool({ layout: appLayout(f.root), scope: groupScope(GROUP) });
  const params = { path: outside, status: "draft", checked: [], unchecked: [], issues: [] };
  try {
    await expect(register(tool, params, run)).rejects.toThrow("只能发送共享资料");
    const original = fs.copyFile;
    const copying = spyOn(fs, "copyFile").mockImplementation(async (source, target, flags) => {
      await writeFile(source, "changed while copying"); await original(source, target, flags);
    });
    try { await expect(register(tool, { ...params, path: f.path }, run)).rejects.toThrow("复制期间源文件变化"); }
    finally { copying.mockRestore(); }
    expect(run.record.deliverables).toEqual([]);
  } finally { await f.service.close(); }
});

test("a run-time send_file records sent/uncertain, deduplicates identical bytes and never retries an uncertain send", async () => {
  const f = await setup(), run = fakeRun("normal-send");
  const member = { phone: PHONE, conversationId: 1 as never, places: { tempDir: f.temp, workspaceDir: appLayout(f.root).workspace, indexPath: "", venvDir: "" } };
  try {
    const deliver = fileDelivery(member, run.call, { requestId: "normal-send", phone: PHONE });
    let sends = 0;
    const send = async (_source: unknown, begin: () => void) => { sends++; begin(); return { mode: "direct" as const }; };
    await deliver({ kind: "local", path: f.path, size: 16 }, "report.txt", undefined, send);
    expect(run.record.files[0]!.state).toBe("sent");
    await deliver({ kind: "local", path: f.path, size: 16 }, "report.txt", undefined, send); expect(sends).toBe(1);
    await writeFile(f.path, "another version");
    await expect(deliver({ kind: "local", path: f.path, size: 15 }, "report.txt", undefined, async (_source, begin) => { sends++; begin(); throw new Error("lost response"); })).rejects.toThrow("lost response");
    expect(run.record.files.map(x => x.state)).toEqual(["sent", "uncertain"]);
    const guidance = await deliver({ kind: "local", path: f.path, size: 15 }, "report.txt", undefined, send).catch(error => String(error));
    expect(guidance).toContain("结果不确定"); expect(guidance).toContain("新消息中明确要求重新发送");
    expect(sends).toBe(2);
    // A closed request takes no more sends.
    run.record.closedAt = Date.now();
    await expect(deliver({ kind: "local", path: f.path, size: 15 }, "report.txt", undefined, send)).rejects.toThrow("任务已结束");
  } finally { await f.service.close(); }
});

test("a relay link of the run goes out once when the run then fails, and is not sent again as a file", async () => {
  const f = await setup();
  const note: LinkNote = { original: "report: https://relay.example/old", reference: { backend: "fixture", url: "https://relay.example/object", name: "report.txt", size: 16 } as never };
  f.out.outbound.links = async notes => notes.map(each => each.original.replace("/old", "/fresh")).join("\n\n");
  const service = new DurableService({ ...f.options, extensions: seedSend(record => {
    const version = record.deliverables[0]!;
    record.files.push({ id: "relay", name: version.name, path: version.path, sha256: version.sha256, size: version.size, mode: "relay", state: "planned", attempts: 1, at: Date.now(),
      relay: { url: "https://relay.example/object", note: note.original, attachment: note, size: version.size } });
    record.notes.push(note);
  }) });
  f.faux.setResponses([f.register(), callSeed(), failModel()]);
  try {
    await service.admit(f.message("large report"));
    await until(async () => (await f.record(service))?.delivery !== undefined && pendingDeliveries(await service.records(scopeOf(GROUP), PHONE)).length === 0, "delivered");
    expect(f.files()).toEqual([]);
    expect(f.out.sent.filter(x => x.text.includes("relay.example/fresh"))).toHaveLength(1);
    expect(f.out.sent.some(x => x.text.includes("下载链接随后发出"))).toBe(true);
    expect((await f.record(service))!.delivery!.parts.find(part => part.kind === "file")!.state).toBe("sent");
  } finally { await service.close(); await f.service.close(); }
});

test("a relay upload that failed during the run is sent by the fallback", async () => {
  const f = await setup();
  const service = new DurableService({ ...f.options, extensions: seedSend(record => {
    const version = record.deliverables[0]!;
    record.files.push({ id: "relay", name: version.name, path: version.path, sha256: version.sha256, size: version.size, mode: "relay", state: "failed", error: "upload failed", attempts: 1, at: Date.now() });
  }) });
  f.faux.setResponses([f.register(), callSeed(), failModel()]);
  try {
    await service.admit(f.message("large report"));
    await until(() => f.files().length === 1, "the fallback file");
  } finally { await service.close(); await f.service.close(); }
});

test.each(["sent", "uncertain"] as const)("a run that only sent a file (%s) and ended without text gets a short reply, not a failure", async state => {
  const f = await setup();
  const service = new DurableService({ ...f.options, extensions: seedSend(record => {
    record.files.push({ id: "send", name: "report.txt", path: join(f.temp, ".deliverables", "gone.txt"), sha256: "0".repeat(64), size: 1, mode: "direct", state, attempts: 1, at: Date.now() });
  }) });
  f.faux.setResponses([callSeed(), fauxAssistantMessage("")]);
  try {
    await service.admit(f.message("send it"));
    await until(() => f.out.sent.some(x => x.kind === "reply"), "the reply");
    expect(f.out.sent.filter(x => x.kind === "reply").map(x => x.text)).toEqual([expect.stringContaining("文件已发出")]);
  } finally { await service.close(); await f.service.close(); }
});

test("send_image is in the run record: a registered image that went out is not sent again by the fallback", async () => {
  const f = await setup(), image = join(f.temp, "chart.png"); await writeFile(image, PNG);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("deliverable_register", { path: image, status: "draft", checked: [], unchecked: [], issues: [] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("send_image", { source: image })], { stopReason: "toolUse" }), failModel()]);
  try {
    await f.service.admit(f.message("draw a chart"));
    await until(async () => (await f.record())?.delivery !== undefined && pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE)).length === 0, "delivered");
    // The image message only; no file message for the same bytes.
    expect(f.files().map(x => x.text)).toEqual(["image"]);
    expect((await f.record())!.files.map(x => x.state)).toEqual(["sent"]);
  } finally { await f.service.close(); }
});

test("the reminder asks only for versions nothing reached the member of", async () => {
  const run = fakeRun("reminder"), f = await setup();
  const hooks = closeoutExtension(run.write, timing, 3000).hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks };
  const frozen = await freezeFile(f.path, f.temp, "reminder", 1024);
  registerDeliverable(run.record, { ...frozen, slot: "report", complete: true, status: "draft", checked: [], unchecked: [], issues: [] });
  const send = { id: "s", name: frozen.name, path: frozen.path, sha256: frozen.sha256, size: frozen.size, attempts: 1, at: 1 };
  const remind = async () => { delete run.record.events.delivery_reminder; return hooks.handlers.onYield!({} as never, run.api as never, context); };
  try {
    run.record.files = [{ ...send, mode: "relay", state: "failed", error: "upload failed" }];
    expect(await remind()).toMatchObject({ continue: expect.stringContaining("尚未发送") });
    run.record.files = [{ ...send, mode: "relay", state: "planned", relay: { url: "u", note: "n", attachment: {} as never, size: 1 } }];
    expect(await remind()).toBeUndefined();
    for (const state of ["sent", "uncertain"] as const) {
      run.record.files = [{ ...send, mode: "direct", state }];
      expect(await remind()).toBeUndefined();
    }
  } finally { await f.service.close(); }
});

test("a failure notice without files keeps the reply's window instead of the fallback budget", async () => {
  const f = await setup();
  f.faux.setResponses([failModel()]);
  try {
    await f.service.admit(f.message("a plain question"));
    await until(() => f.out.sent.some(x => x.text.includes("Synthetic model error")), "the failure reply");
    const delivery = (await f.record())!.delivery!;
    expect(delivery.kind).toBe("fallback"); expect(delivery.deadline).toBeUndefined();
  } finally { await f.service.close(); }
});

test("send_file through the run record says how large a file too large for any delivery is, before hashing or copying it", async () => {
  const f = await setup(), run = fakeRun("too-large"), large = join(f.temp, "large.bin");
  const handle = await fs.open(large, "w"); await handle.truncate(NATIVE_FILE_MAX_BYTES + 1); await handle.close();
  const member = { phone: PHONE, conversationId: 1 as never, places: { tempDir: f.temp, workspaceDir: appLayout(f.root).workspace, indexPath: "", venvDir: "" } };
  await mkdir(member.places.workspaceDir, { recursive: true });
  const unused = async () => { throw new Error("no send expected"); };
  const sendFile = sendTools(null, async () => ({ channel: { file: unused, image: unused }, workspaceDir: member.places.workspaceDir, tempDir: f.temp,
    notes: { add: unused }, fileDelivery: fileDelivery(member, run.call, { requestId: "too-large", phone: PHONE }) }))[1]!;
  const opening = spyOn(fs, "open");
  try {
    opening.mockClear();
    await expect(sendFile.run({ source: large }, member as never, run.call)).rejects.toThrow(formatSize(NATIVE_FILE_MAX_BYTES));
    expect(opening).not.toHaveBeenCalled();
    expect(run.record.files).toEqual([]);
  } finally { opening.mockRestore(); await f.service.close(); }
});

test.each(["none", "text", "links"] as const)("a reply's link notes are refreshed on every attempt (failure: %s); a failure pauses the delivery until its retry, and the links go out once", async failure => {
  const f = await setup();
  const note: LinkNote = { original: "large file: https://relay.example/old", reference: { backend: "fixture", url: "https://relay.example/object", name: "report.txt", size: 16 } as never };
  let refreshes = 0, broken = failure !== "none";
  f.out.outbound.links = async notes => {
    refreshes++; expect(notes).toEqual([note]);
    if (broken && failure === "links") throw new Error("temporary signing failure");
    return notes.map(each => each.original.replace("https://relay.example/old", "https://relay.example/fresh")).join("\n\n");
  };
  f.faux.setResponses([fauxAssistantMessage("first answer")]);
  let service = f.service;
  try {
    // A first message makes the member's conversation; the second request is then written as a closed record whose
    // reply (with the run's link note) waits to be sent, as a run that ended just before the restart leaves it.
    await service.admit(f.message("hello")); await until(() => f.out.sent.some(x => x.kind === "reply"), "first reply");
    await service.close();
    f.out.state.failWhen = item => broken && failure === "text" && item.kind === "reply" ? "failed" : false;
    const asked = f.message("send large report"), now = Date.now();
    const session = createSession(await openGroupStorage(databaseOf(f.root, GROUP)));
    try {
      await session.commit(async tx => {
        (await recordsOf(tx, PHONE)).requests["msg:links"] = { requestId: "msg:links", reply: asked.reply, createdAt: now, closedAt: now,
          notes: [note], deliverables: [], files: [], events: {},
          delivery: { kind: "reply", createdAt: now, parts: [
            { id: "m0", kind: "markdown", body: "answer with a link", lead: true, state: "pending", attempts: 0 },
            { id: "l0", kind: "links", note: 0, state: "pending", attempts: 0 }] } };
      }, context);
    } finally { await session.close(context); }
    service = new DurableService(f.options); await service.start();
    const links = () => f.out.sent.filter(x => x.text.includes("relay.example/fresh"));
    const parts = async () => (await service.records(scopeOf(GROUP), PHONE)).requests["msg:links"]!.delivery!.parts;
    if (failure !== "none") {
      await until(async () => (await parts()).some(part => part.attempts >= 2), "a retried part");
      expect(links()).toEqual([]);
      broken = false;
    }
    await until(async () => pendingDeliveries(await service.records(scopeOf(GROUP), PHONE)).length === 0, "delivered");
    expect(links()).toHaveLength(1);
    expect(f.out.sent.filter(x => x.kind === "reply" && x.text === "answer with a link")).toHaveLength(1);
    expect(f.files()).toEqual([]); expect(f.uploads).toEqual([]);
    // Every attempt of the note signs again; while the text fails, the note waits untried.
    expect(refreshes).toBe(failure === "links" ? (await parts())[1]!.attempts : 1);
  } finally { await service.close(); await f.service.close(); }
});

test("each link note is its own delivered message: after a later note fails, its retry after a restart sends only the missing one", async () => {
  const f = await setup();
  const note = (name: string): LinkNote => ({ original: `📎 ${name}: https://relay.example/old/${name}`,
    reference: { backend: "fixture", url: `https://relay.example/${name}`, name, size: 16 } as never });
  const one = note("one"), two = note("two"), refreshed: string[] = [];
  let broken = true;
  f.out.outbound.links = async notes => {
    refreshed.push(...notes.map(each => each.reference.name));
    return notes.map(each => each.original.replace("/old/", "/fresh/")).join("\n\n");
  };
  f.faux.setResponses([fauxAssistantMessage("first answer")]);
  let service = f.service;
  try {
    await service.admit(f.message("hello")); await until(() => f.out.sent.some(x => x.kind === "reply"), "first reply");
    await service.close();
    f.out.state.failWhen = item => broken && item.text.includes("/fresh/two") ? "failed" : false;
    const asked = f.message("send two large files"), now = Date.now();
    const session = createSession(await openGroupStorage(databaseOf(f.root, GROUP)));
    try {
      await session.commit(async tx => {
        const parts: DeliveryPart[] = [{ id: "m0", kind: "markdown", body: "two links", lead: true, state: "pending", attempts: 0 },
          { id: "l0", kind: "links", note: 0, state: "pending", attempts: 0 }, { id: "l1", kind: "links", note: 1, state: "pending", attempts: 0 }];
        (await recordsOf(tx, PHONE)).requests["msg:two-links"] = { requestId: "msg:two-links", reply: asked.reply, createdAt: now, closedAt: now,
          notes: [one, two], deliverables: [], files: [], events: {}, delivery: { kind: "reply", createdAt: now, parts } };
      }, context);
    } finally { await session.close(context); }
    const sentLinks = (name: string) => f.out.sent.filter(x => x.text.includes(`/fresh/${name}`));
    const parts = () => service.records(scopeOf(GROUP), PHONE).then(records => records.requests["msg:two-links"]!.delivery!.parts);
    service = new DurableService(f.options); await service.start();
    await until(async () => (await parts())[2]!.state === "failed", "the failed note");
    expect(sentLinks("one")).toHaveLength(1);
    expect(sentLinks("two")).toEqual([]);
    expect((await parts()).slice(0, 2).map(part => [part.id, part.state])).toEqual([["m0", "sent"], ["l0", "sent"]]);
    // The confirmed note survives a restart; the retry re-signs and sends only the failed one.
    await service.close();
    broken = false;
    service = new DurableService(f.options); await service.start();
    await until(async () => pendingDeliveries(await service.records(scopeOf(GROUP), PHONE)).length === 0, "delivered");
    expect(sentLinks("one")).toHaveLength(1);
    expect(sentLinks("two")).toHaveLength(1);
    expect(f.out.sent.filter(x => x.kind === "reply" && x.text === "two links")).toHaveLength(1);
    expect(refreshed.filter(name => name === "one")).toEqual(["one"]);
    expect(refreshed.filter(name => name === "two")).toHaveLength((await parts())[2]!.attempts);
  } finally { await service.close(); await f.service.close(); }
});

test.each(["case", "link"] as const)("delivery through a %s root cleans canonical snapshots", async alias => {
  const f = await setup(alias); f.faux.setResponses([f.register(), failModel()]);
  try {
    await f.service.admit(f.message("report"));
    await until(async () => pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE)).length === 0 && f.files().length === 1, "delivered");
    const path = (await f.record())!.deliverables[0]!.path;
    await until(async () => !await stat(path).then(() => true, () => false), "canonical snapshot cleanup");
  } finally { await f.service.close(); }
});

test("a snapshot cleanup failure after delivery leaves nothing to send", async () => {
  const f = await setup(); f.faux.setResponses([f.register(), failModel()]);
  const cleanup = spyOn(deliverables, "deleteSnapshots").mockRejectedValue(new Error("fixture cleanup failure"));
  try {
    await f.service.admit(f.message("report"));
    await until(async () => f.files().length === 1 && pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE)).length === 0, "delivered");
    await Bun.sleep(30);
    expect(cleanup).toHaveBeenCalled();
    expect(pendingDeliveries(await f.service.records(scopeOf(GROUP), PHONE))).toEqual([]);
    expect(f.files()).toHaveLength(1);
  } finally { cleanup.mockRestore(); await f.service.close(); }
});

test("a fallback past its deadline is given up at startup without sending its files; a withdrawn one is left alone", async () => {
  const f = await setup(); f.faux.setResponses([fauxAssistantMessage("hello")]);
  let service = f.service;
  try {
    await service.admit(f.message("hello")); await until(() => f.out.sent.some(x => x.kind === "reply"), "first reply");
    await service.close();
    const frozen = await freezeFile(f.path, f.temp, "expired", 1024), now = Date.now();
    const asked = { expired: f.message("expired").reply, withdrawn: f.message("withdrawn").reply };
    const session = createSession(await openGroupStorage(databaseOf(f.root, GROUP)));
    try {
      await session.commit(async tx => {
        const records = await recordsOf(tx, PHONE);
        for (const id of ["expired", "withdrawn"]) {
          records.requests[`msg:${id}`] = { requestId: `msg:${id}`, reply: asked[id as keyof typeof asked], createdAt: now, closedAt: now,
            notes: [], deliverables: [], files: [], events: {},
            delivery: { kind: "fallback", createdAt: now, deadline: now - 1000, ...(id === "withdrawn" ? { abandoned: { at: now, reason: "withdrawn" as const } } : {}), parts: [
              { id: "m0", kind: "markdown", body: "saved explanation", lead: true, state: "sent", attempts: 1 },
              { id: "f0", kind: "file", file: { name: "report.txt", path: frozen.path, size: frozen.size, sha256: frozen.sha256 }, state: "pending", attempts: 0 }] } };
        }
      }, context);
    } finally { await session.close(context); }
    const sentBefore = f.out.sent.length;
    service = new DurableService(f.options); await service.start();
    const delivery = async (id: string) => (await service.records(scopeOf(GROUP), PHONE)).requests[`msg:${id}`]!.delivery!;
    await until(async () => (await delivery("expired")).abandoned !== undefined, "the expired fallback given up");
    expect((await delivery("expired")).abandoned!.reason).toBe("expired");
    expect((await delivery("withdrawn")).abandoned!.reason).toBe("withdrawn");
    expect(pendingDeliveries(await service.records(scopeOf(GROUP), PHONE))).toEqual([]);
    await service.close(); service = new DurableService(f.options); await service.start();
    f.faux.setResponses([fauxAssistantMessage("hello again")]);
    await service.admit(f.message("another message"));
    await until(() => f.out.sent.filter(x => x.kind === "reply").length === 2, "second reply");
    // Nothing but the new reply went out: no files, no notices.
    expect(f.out.sent.slice(sentBefore).map(x => [x.kind, x.text])).toEqual([["reply", "hello again"]]);
  } finally { await service.close(); await f.service.close(); }
});

test("bash always preserves delivery time, respects its configured default, and the clock has no ambiguous UTC timestamp", async () => {
  const t = { closeoutMs: 300000, reserveMs: 120000, fallbackMs: 120000 };
  const at = (remaining: number) => fakeRun("bash-budget", Date.now() - 7200000 + remaining);
  expect((await closeoutTool("bash", { timeout: 900 }, at(400000).api as never, context, t, 7200000) as { timeout: number }).timeout).toBeLessThanOrEqual(280);
  expect((await closeoutTool("bash", {}, at(5000000).api as never, context, t, 7200000) as { timeout: number }).timeout).toBe(BASH_DEFAULT_TIMEOUT);
  const longCloseout = { ...t, closeoutMs: 3000000 };
  expect((await closeoutTool("bash", {}, at(2800000).api as never, context, longCloseout, 7200000) as { timeout: number }).timeout).toBe(BASH_DEFAULT_TIMEOUT);
  const run = at(400000), extension = closeoutExtension(run.write, t, 7200000);
  const hooks = (extension.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers;
  const result = await hooks.beforeRequest({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }, run.api as never, context);
  expect(JSON.stringify(result!.messages)).toContain("[任务计时] 剩余"); expect(JSON.stringify(result!.messages)).not.toContain("截止");
  // The current date and time to the minute in the server's zone; nothing generated, registered or sent yet, so no counts.
  const clock = JSON.stringify(result!.messages).match(/；现在是 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})（服务器时区 UTC[+-]\d{2}:\d{2}）。/);
  expect(clock).not.toBeNull();
  expect(Math.abs(new Date(clock![1].replace(" ", "T")).getTime() - Date.now())).toBeLessThan(120_000);
  for (const count of ["已生成文档", "已登记交付物", "已发送"]) expect(JSON.stringify(result!.messages)).not.toContain(count);
  // Without a temp-directory source (only tests build the extension so) the tail names none.
  expect(JSON.stringify(result!.messages)).not.toContain("[临时目录]");
  const named = closeoutExtension(run.write, t, 7200000, (phone, requestId) => `C:\\data\\tmp\\${phone}\\tasks\\${requestId}`);
  const tail = await (named.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers
    .beforeRequest({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }, run.api as never, context);
  expect(JSON.stringify(tail!.messages)).toContain(`）。\\n[临时目录] C:/data/tmp/${PHONE}/tasks/bash-budget"`);
});

test("the clock is the server's local date and time to the minute with its UTC offset", () => {
  const now = Date.UTC(2026, 10, 2, 23, 30, 59), date = new Date(now), offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(value).padStart(2, "0");
  expect(localTime(now)).toStartWith(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}（`);
  expect(localTime(now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（服务器时区 UTC[+-]\d{2}:\d{2}）$/);
  if (offset === 480) expect(localTime(now)).toBe("2026-11-03 07:30（服务器时区 UTC+08:00）");
});

test("send_file reuses registered snapshots and duplicates without copying, and checks a new copy only once", async () => {
  const f = await setup(), id = "reads", run = fakeRun(id);
  const member = { phone: PHONE, conversationId: 1 as never, places: { tempDir: f.temp, workspaceDir: appLayout(f.root).workspace, indexPath: "", venvDir: "" } };
  const frozen = await freezeFile(f.path, f.temp, id, 1024);
  registerDeliverable(run.record, { ...frozen, slot: "file", complete: true, status: "draft", checked: [], unchecked: [], issues: [] });
  const copying = spyOn(fs, "copyFile"), opening = spyOn(fs, "open"); let sends = 0;
  try {
    const deliver = fileDelivery(member, run.call, { requestId: id, phone: PHONE });
    const send = async () => { sends++; return { mode: "direct" as const }; };
    await deliver({ kind: "local", path: frozen.path, size: frozen.size }, "report.txt", undefined, send);
    await deliver({ kind: "local", path: f.path, size: frozen.size }, "report.txt", undefined, send);
    expect(copying).not.toHaveBeenCalled(); expect(sends).toBe(1); expect(run.record.files[0]!.path).toBe(frozen.path);
    await writeFile(f.path, "new bytes"); opening.mockClear();
    await deliver({ kind: "local", path: f.path, size: 9 }, "report.txt", undefined, send);
    expect(copying).toHaveBeenCalledTimes(1); expect(opening).toHaveBeenCalledTimes(2); expect(sends).toBe(2);
  } finally { copying.mockRestore(); opening.mockRestore(); await f.service.close(); }
});
