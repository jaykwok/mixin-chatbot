// Task deadline closeout; the existing closeout.test.ts covers service shutdown.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { CloseoutStore, closeoutReferences, completeFile, fileDigest, freezeFile } from "../../src/agent/deliverables.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { createSession } from "@earendil-works/pi-durable";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { closeoutExtension } from "../../src/durable/closeout.ts";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fileURLToPath } from "node:url";
import { deliverableTool } from "../../src/durable/closeout.ts";
import type { MemberCall } from "../../src/durable/tools.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { fileDelivery } from "../../src/durable/file-delivery.ts";
import { BASH_DEFAULT_TIMEOUT } from "../../src/core/config.ts";
import { appendTiming, closeoutTool, validateCloseout } from "../../src/durable/closeout.ts";
import { DurableService, type DurableServiceOptions, type Outbound } from "../../src/durable/service.ts";
import { userTempDir } from "../../src/agent/paths.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("closeout-"); afterAll(() => fixture.cleanup());
let seq = 0;
const session = JSON.stringify(["group-a", "1001"]), callback = "https://example.invalid/callback";
const timing = { closeoutMs: 500, reserveMs: 100, fallbackMs: 2000 };
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timeout: " + label); await Bun.sleep(10); }
}
const failModel = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic model error" });
async function setup(alias?: "case" | "link") {
  const actual = join(fixture.root, String(++seq)); await mkdir(actual);
  let root = actual;
  if (alias === "case" && process.platform === "win32") root = actual.toLowerCase();
  if (alias === "link") { root = actual + "-alias"; await fs.symlink(actual, root, process.platform === "win32" ? "junction" : "dir"); }
  const temp = userTempDir(root, "group-a", "1001"); await mkdir(temp, { recursive: true });
  const path = join(temp, "report.txt"); await writeFile(path, "original version");
  const stateDb = new Database(":memory:"), outbox = new DeliveryStore(stateDb);
  const { faux, models, model } = fauxModels();
  const sent: { kind: string; text: string }[] = [], states = { failText: false, failFile: false };
  const outbound: Outbound = {
    async sendText(text, _group, _phone, _url, options) { sent.push({ kind: options?.traffic ?? "text", text }); return !states.failText; },
    async sendReply(text) { sent.push({ kind: "reply", text }); return true; },
    async sendAttachment(path, name) { sent.push({ kind: "file", text: name + ":" + await readFile(path, "utf8") }); if (states.failFile) throw new Error("uncertain transport"); return { mode: "direct" }; },
    rate: () => ({ used: 0, limit: 20 }), refresh: async item => item.text,
  };
  const options: DurableServiceOptions = { root, stateDb, deliveries: outbox, modules: [], relay: null, materials: false, outbound,
    closeout: timing, limits: { runTimeoutMs: 3000, modelIdleMs: 3000, modelResponseMs: 3000, tickMs: 10 },
    selection: { runtime: models as never, settings: undefined as never, ref: model, model: models.getModel(model.provider, model.modelId)!, thinkingLevel: "off",
      notices: [], harnessSettings: { retry: { maxRetries: 0 } } } };
  const service = new DurableService(options), store = new CloseoutStore(outbox);
  const register = (status = "draft") => fauxAssistantMessage([fauxToolCall("deliverable_register", { path, status, checked: [], unchecked: ["版式"], issues: [] })], { stopReason: "toolUse" });
  return { service, store, options, root, temp, path, stateDb, outbox, faux, sent, states, register };
}

test("model failure delivers only the registered immutable version, explanation first, then releases completed bytes", async () => {
  const f = await setup();
  f.faux.setResponses([f.register(), async () => { await writeFile(f.path, "later edit"); return failModel(); }]);
  try {
    await f.service.admit("1001", "group-a", "make a report", callback);
    await until(() => f.sent.some(x => x.kind === "file"), "fallback file");
    expect(f.sent.find(x => x.kind === "file")!.text).toBe("report.txt:original version");
    const explanation = f.sent.findIndex(x => x.text.includes("未完成全部检查"));
    expect(explanation).toBeGreaterThan(-1); expect(explanation).toBeLessThan(f.sent.findIndex(x => x.kind === "file"));
    expect(f.sent[explanation]!.text).not.toContain("已检查");
    await until(() => f.outbox.pending(session).length === 0, "ack");
    const file = f.store.files(session)[0]!; expect(file.state).toBe("sent");
    await until(() => !Bun.file(file.path).size, "snapshot removal").catch(async () => expect(await stat(file.path).then(() => true, () => false)).toBe(false));
  } finally { await f.service.close(); f.stateDb.close(); }
});

test.each(["unregistered", "rejected", "incomplete"])("failure never auto sends %s files", async kind => {
  const f = await setup();
  if (kind === "incomplete") await writeFile(f.path, "");
  f.faux.setResponses(kind === "unregistered" ? [failModel()] : [f.register(kind === "rejected" ? "rejected" : "draft"), failModel()]);
  try {
    await f.service.admit("1001", "group-a", "make a report", callback);
    await until(() => f.sent.some(x => x.text.includes("没有可交付")), "failure explanation");
    expect(f.sent.filter(x => x.kind === "file")).toEqual([]);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test.each([false, true])("fallback prefers a checked version and falls back when its snapshot is damaged (tampered=%s)", async tampered => {
  const f = await setup();
  f.faux.setResponses([f.register("draft"), async () => {
    await writeFile(f.path, "checked content");
    return fauxAssistantMessage([fauxToolCall("deliverable_register", { path: f.path, status: "checked", checked: ["正文数据与资料核对"], unchecked: ["版式"], issues: [] })], { stopReason: "toolUse" });
  }, async () => {
    await writeFile(f.path, "new unreviewed content"); return f.register("draft");
  }, async () => {
    if (tampered) {
      const requestId = f.store.db.query("SELECT request_id FROM deliverables LIMIT 1").get() as { request_id: string };
      for (const item of f.store.registrations(session, requestId.request_id)) if (item.status === "checked") await writeFile(item.path, "damaged bytes");
    }
    return failModel();
  }]);
  try {
    await f.service.admit("1001", "group-a", "make a report", callback);
    await until(() => f.sent.some(x => x.kind === "file"), "selected version");
    expect(f.sent.find(x => x.kind === "file")!.text).toBe("report.txt:" + (tampered ? "new unreviewed content" : "checked content"));
    const text = f.sent.find(x => x.text.includes("系统将交付"))!.text;
    expect(text).toContain(tampered ? "未完成全部检查" : "正文数据与资料核对");
    if (!tampered) expect(text).toContain("已检查版本");
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("failed explanation sends no files; /deliver resumes the retained plan", async () => {
  const f = await setup(); f.states.failText = true;
  f.faux.setResponses([f.register(), failModel()]);
  try {
    await f.service.admit("1001", "group-a", "make a report", callback);
    await until(() => f.sent.some(x => x.text.includes("已保存交付内容")), "failure notice");
    expect(f.sent.some(x => x.kind === "file")).toBe(false);
    expect(f.store.files(session)[0]!.state).toBe("planned");
    f.states.failText = false;
    const ledger = openStatsLedger(f.root);
    try {
      const before = readLedger(ledger);
      await f.service.control("1001", "group-a", "/deliver", callback);
      expect(readLedger(ledger)).toEqual(before); // Delivery, snapshot release and metadata writes do not rewrite usage.
    } finally { ledger.close(); }
    expect(f.sent.filter(x => x.kind === "file")).toHaveLength(1); expect(f.outbox.pending(session)).toEqual([]);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("uncertain attachment is retained across restart and only manually retried", async () => {
  const f = await setup(); f.states.failFile = true; f.faux.setResponses([f.register(), failModel()]);
  let resumed: DurableService | undefined;
  try {
    await f.service.admit("1001", "group-a", "make a report", callback);
    await until(() => f.store.files(session)[0]?.state === "uncertain", "uncertain send");
    const path = f.store.files(session)[0]!.path; expect(await readFile(path, "utf8")).toBe("original version");
    await f.service.close(); resumed = new DurableService(f.options); await resumed.start();
    f.faux.setResponses([fauxAssistantMessage("ordinary reply")]); f.states.failFile = false;
    await resumed.admit("1001", "group-a", "hello", callback);
    await until(() => f.sent.some(x => x.kind === "reply"), "ordinary reply");
    expect(f.sent.filter(x => x.kind === "file")).toHaveLength(1);
    await resumed.control("1001", "group-a", "/deliver", callback);
    expect(f.sent.filter(x => x.kind === "file")).toHaveLength(2);
    expect(f.sent.some(x => x.text.includes("上次发送结果不确定"))).toBe(true);
  } finally { await resumed?.close(); await f.service.close(); f.stateDb.close(); }
});

test.each(["/stop", "/clear"])("%s wins over a registered draft and no fallback is sent", async command => {
  const f = await setup(), started = Promise.withResolvers<void>();
  const waiting: FauxResponseFactory = (_transcript, options) => new Promise(resolve => {
    started.resolve(); options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
  });
  f.faux.setResponses([f.register(), waiting]);
  try {
    await f.service.admit("1001", "group-a", "make a report", callback); await started.promise;
    await f.service.control("1001", "group-a", command, callback);
    expect(f.sent.some(x => x.kind === "file" || x.text.includes("系统将交付"))).toBe(false);
    expect(f.outbox.pending(session)).toEqual([]);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("clock tail is copied, budgets clamp bash, delivery refuses nesting entry points, configuration rejects invalid order", async () => {
  const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];
  const added = appendTiming(messages, "[任务计时] test", 2);
  expect(messages[0]!.content).toBe("hello"); expect(JSON.stringify(added)).toContain("任务计时");
  const t = { closeoutMs: 300_000, reserveMs: 120_000, fallbackMs: 120_000 };
  expect(() => validateCloseout(t, 1200_000)).not.toThrow(); expect(() => validateCloseout(t, 500_000)).toThrow("小于");
  let remaining = 200_000;
  const api = { conversationId: 1, snapshot: async (doc: unknown) => doc === InboxDoc
    ? { items: [{ requestId: "r", startedAt: Date.now() - 1200_000 + remaining }] } : { groupId: "group-a", phone: "1001" } } as never;
  const clamped = await closeoutTool("bash", { command: "sleep 1000", timeout: 600 }, api, context, t, 1200_000) as { timeout: number };
  expect(clamped.timeout).toBeLessThanOrEqual(80); remaining = 60_000;
  for (const name of ["bash", "document_build", "codemode", "edit"]) await expect(closeoutTool(name, {}, api, context, t, 1200_000)).rejects.toThrow("交付阶段");
  for (const name of ["send_file", "send_image", "read", "deliverable_register"]) expect(await closeoutTool(name, {}, api, context, t, 1200_000)).toEqual({});
});

test("store deduplication, rejection of all copies, schema recovery, and protected unresolved snapshots", async () => {
  const f = await setup();
  try {
    const frozen = await freezeFile(f.path, f.temp, "r", 1024);
    const record = { ...frozen, session, requestId: "r", slot: "report", complete: true, checked: [], unchecked: [], issues: [] };
    f.store.register({ ...record, status: "checked" });
    f.store.register({ ...record, status: "rejected" });
    expect(f.store.candidates(session, "r")).toEqual([]);
    const good = await freezeFile(f.path, f.temp, "next", 1024);
    const registered = f.store.register({ ...record, ...good, requestId: "next", status: "draft" });
    f.store.createPlan(session, "next", "explanation", [registered], 2000);
    let file = f.store.files(session, "next")[0]!;
    expect(f.store.file({ ...file })).toEqual(file);
    f.store.saveFile({ ...file, state: "sending" });
    const recovered = new CloseoutStore(f.outbox); file = recovered.files(session, "next")[0]!;
    expect(file.state).toBe("uncertain");
    expect(JSON.stringify(closeoutReferences(f.stateDb))).toContain(good.path.replaceAll("\\", "\\\\"));
    await f.store.releaseSnapshots(session, "next", f.temp);
    expect(await fileDigest(good.path)).toBe(good.sha256);
    await writeFile(good.path, "tampered"); expect(await fileDigest(good.path)).not.toBe(good.sha256);
    expect(await completeFile(good.path, "docx")).toBe(false);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test.each(["task_timeout", "model_idle", "model_response_timeout"])("watchdog %s delivers a draft with its independent budget", async reason => {
  const f = await setup(); await f.service.close();
  const service = new DurableService({ ...f.options, limits: { runTimeoutMs: 600, tickMs: 10,
    modelIdleMs: reason === "model_idle" ? 120 : 900, modelResponseMs: reason === "model_response_timeout" ? 120 : 900 },
    closeout: { closeoutMs: 250, reserveMs: 100, fallbackMs: 2000 } });
  f.faux.setResponses([f.register(), (_t, options) => new Promise(resolve => {
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
  })]);
  try {
    await service.admit("1001", "group-a", "make report", callback);
    await until(() => f.sent.some(x => x.kind === "file"), reason);
    expect(f.sent.filter(x => x.kind === "file")).toHaveLength(1);
    expect(f.sent.some(x => x.text.includes("草稿"))).toBe(true);
  } finally { await service.close(); f.stateDb.close(); }
});

test("a stop during the first fallback attachment withdraws the rest; manual delivery sends only the remainder", async () => {
  const f = await setup(), path2 = join(f.temp, "other.txt"); await writeFile(path2, "other version");
  const originalSend = f.options.outbound!.sendAttachment!; let stop = true;
  f.options.outbound!.sendAttachment = async (...args) => {
    if (stop) { stop = false; await f.service.control("1001", "group-a", "/stop", callback); }
    return originalSend(...args);
  };
  f.faux.setResponses([f.register(), fauxAssistantMessage([fauxToolCall("deliverable_register", { path: path2, status: "draft", checked: [], unchecked: [], issues: [] })], { stopReason: "toolUse" }), failModel()]);
  try {
    await f.service.admit("1001", "group-a", "two reports", callback);
    await until(() => f.store.files(session).some(x => x.state === "sent"), "first send");
    expect(f.store.files(session).map(x => x.state)).toEqual(["sent", "withdrawn"]);
    expect(f.sent.filter(x => x.kind === "file")).toHaveLength(1);
    await f.service.control("1001", "group-a", "/deliver", callback);
    expect(f.sent.filter(x => x.kind === "file")).toHaveLength(2);
    expect(f.store.files(session).every(x => x.state === "sent")).toBe(true);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("every provider attempt gets fresh timing but stored conversation messages do not", async () => {
  const f = await setup(), seen: string[] = [];
  f.faux.setResponses([transcript => { seen.push(JSON.stringify(transcript.messages)); return f.register(); },
    transcript => { seen.push(JSON.stringify(transcript.messages)); return failModel(); }]);
  try {
    await f.service.admit("1001", "group-a", "make report", callback);
    await until(() => f.sent.some(x => x.kind === "file"), "file");
    expect(seen).toHaveLength(2); for (const transcript of seen) expect(transcript).toContain("[任务计时]");
    await f.service.close();
    const storage = await openGroupStorage(groupDatabasePath(f.root, "group-a")), sessionView = createSession(storage);
    try {
      const member = await sessionView.snapshot(MemberDirectory, "1001", context);
      const entries = await storage.scanEntries({ conversationId: member!.conversationId as never }, 200, undefined, context);
      // The stable system prompt explains the marker; only the dynamic countdown must stay out of history.
      expect(JSON.stringify(entries.items.map(x => x.model))).not.toContain("[任务计时] 剩余");
    } finally { await sessionView.close(context); }
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("recovered time uses persisted startedAt and DeepSeek accepts both user-tail and tool-result-tail injection", async () => {
  const f = await setup();
  try {
    const extension = closeoutExtension(f.store, { closeoutMs: 300000, reserveMs: 120000, fallbackMs: 120000 }, 1200000);
    const handler = (extension.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers.beforeRequest;
    const start = Date.now() - 600000;
    const api = { conversationId: 1, snapshot: async (doc: unknown) => doc === InboxDoc ? { items: [{ requestId: "recovered", startedAt: start }] } : { groupId: "group-a", phone: "1001" } };
    const messages = [{ role: "user" as const, content: "hello", timestamp: start }];
    const injected = await handler({ messages }, api as never, context);
    expect(injected).toBeDefined();
    expect(JSON.stringify(injected!.messages)).toMatch(/剩余 (9分\d+|10分0)秒/);
    expect(messages[0]!.content).toBe("hello");
    const proxy = deepseekProvider().getModels()[0]!;
    for (const transcript of [injected!.messages, appendTiming([...messages,
      fauxAssistantMessage([fauxToolCall("read", { path: "file.txt" }, { id: "c" })], { stopReason: "toolUse" }),
      { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 1 }], "[任务计时] test", Date.now())]) {
      expect(JSON.stringify(convertMessages(proxy as never, { messages: transcript } as never, {} as never))).toContain("任务计时");
    }
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("rebuild counts only advise; nested successes count once and factual repairs remain allowed before delivery", async () => {
  const f = await setup();
  try {
    const t = { closeoutMs: 300000, reserveMs: 120000, fallbackMs: 120000 }, extension = closeoutExtension(f.store, t, 1200000);
    const generation = (extension.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers;
    const tools = (extension.hooks![1] as { handlers: import("@earendil-works/pi-durable").ToolHooks }).handlers;
    const api = { conversationId: 1, taskId: 42, snapshot: async (doc: unknown) => doc === InboxDoc
      ? { items: [{ requestId: "rebuild", startedAt: Date.now() - 1000000 }] } : { groupId: "group-a", phone: "1001" } };
    for (let n = 0; n < 4; n++) {
      const call = { id: String(n), name: "document_build", args: {}, parent: "nested" };
      await tools.afterTool(call as never, { output: [] }, api as never, context);
      await tools.afterTool(call as never, { output: [] }, api as never, context);
    }
    await tools.afterTool({ id: "failed", name: "document_build", args: {} } as never, { output: [], isError: true }, api as never, context);
    const clock = await generation.beforeRequest({ messages: [{ role: "user", content: "repair", timestamp: 1 }] }, api as never, context);
    expect(JSON.stringify(clock!.messages)).toContain("已生成文档 4 版");
    expect(JSON.stringify(clock!.messages)).toContain("除修正事实错误外不要再重建");
    expect(await closeoutTool("document_build", { repair: true }, api as never, context, t, 1200000)).toEqual({ repair: true });
  } finally { await f.service.close(); f.stateDb.close(); }
});

test.each(["planned", "sending", "sent"])("forced process death after persisted %s keeps one explanation/plan and prevents uncertain automatic retry", async boundary => {
  const root = join(fixture.root, `kill-${++seq}`); await mkdir(root);
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/task-delivery-kill.ts", import.meta.url)), root, boundary],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_JSC_jitMemoryReservationSize: "16777216" } });
  try {
    const reader = child.stdout.getReader(), first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("READY"); reader.releaseLock();
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL"); await child.exited;
    const db = new Database(join(root, "state.sqlite"));
    try {
      const outbox = new DeliveryStore(db), store = new CloseoutStore(outbox), files = store.files(session);
      expect(outbox.pending(session)).toHaveLength(1); expect(files).toHaveLength(1);
      expect(files[0]!.state).toBe(boundary === "sending" ? "uncertain" : boundary);
      expect(await readFile(files[0]!.path, "utf8")).toBe("retained snapshot");
      expect(store.plan(session, "fallback:request")?.deadline).toBeGreaterThan(Date.now());
    } finally { db.close(); }
  } finally { child.kill(); await child.exited; }
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
  const api = { conversationId: 1, taskId: 1, agent: async () => ({}), snapshot: async (doc: unknown) => doc === InboxDoc
    ? { items: [{ requestId: "review", startedAt: Date.now() }] } : { phone: "1001", groupId: "group-a" } };
  const tool = deliverableTool({ root: f.root, groupId: "group-a" }, f.store);
  const call = { api, context, callId: "review", signal: undefined } as unknown as MemberCall;
  try {
    const params = { path: source, status: "checked", checked: ["版式看图", "正文与资料核对"], unchecked: [], issues: [] };
    await tool.run(params, call);
    const initial = f.store.registrations(session, "review")[0]!;
    expect(initial.complete).toBe(true); expect(initial.status).toBe("draft"); expect(initial.checked).toEqual(["正文与资料核对"]);
    f.store.event(session, "review", "render", { name: "document_render", digest: await fileDigest(source) });
    await tool.run(params, call);
    expect(f.store.registrations(session, "review")[1]!.status).toBe("checked");
    for (let n = 2; n < 8; n++) await tool.run({ ...params, status: "draft" }, call);
    await expect(tool.run(params, call)).rejects.toThrow("8 个版本");
    await writeFile(source, "truncated"); expect(await fileDigest(initial.path)).toBe(initial.sha256);
    expect(await completeFile(source, "docx")).toBe(false);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("registration rejects cross-member paths and a source changed during copying", async () => {
  const f = await setup(), outside = join(f.root, "other-member.txt"); await writeFile(outside, "private");
  const api = { conversationId: 1, taskId: 1, agent: async () => ({}), snapshot: async (doc: unknown) => doc === InboxDoc
    ? { items: [{ requestId: "copy-race", startedAt: Date.now() }] } : { phone: "1001", groupId: "group-a" } };
  const tool = deliverableTool({ root: f.root, groupId: "group-a" }, f.store), call = { api, context, callId: "copy" } as unknown as MemberCall;
  const params = { path: outside, status: "draft", checked: [], unchecked: [], issues: [] };
  try {
    await expect(tool.run(params, call)).rejects.toThrow("只能发送本群");
    const original = fs.copyFile;
    const copying = spyOn(fs, "copyFile").mockImplementation(async (source, target, flags) => {
      await writeFile(source, "changed while copying"); await original(source, target, flags);
    });
    try { await expect(tool.run({ ...params, path: f.path }, call)).rejects.toThrow("复制期间源文件变化"); }
    finally { copying.mockRestore(); }
    expect(f.store.registrations(session, "copy-race")).toEqual([]);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("closed unplanned sends are reclaimed, but a pending relay reply keeps its bytes until acknowledged", async () => {
  const f = await setup();
  try {
    // Text-only tasks never create the member's scratch directory.
    await f.store.releaseSnapshots(session, "text-only", join(f.temp, "not-created"));
    expect(f.store.events(session, "text-only").map(event => event.name)).toEqual(["request_closed"]);
    const frozen = await freezeFile(f.path, f.temp, "orphan", 1024);
    const orphan = f.store.file({ ...frozen, session, requestId: "orphan", mode: "direct" });
    f.store.saveFile({ ...orphan, state: "uncertain" });
    await f.store.releaseSnapshots(session, "orphan", f.temp);
    expect(await stat(frozen.path).then(() => true, () => false)).toBe(false);
    expect(f.store.files(session, "orphan")[0]!.state).toBe("uncertain"); // Keep the audit state for seven days.
    f.store.sweepMetadata(Date.now() + 8 * 86400000);
    expect(f.store.files(session, "orphan")).toEqual([]);
    const relay = await freezeFile(f.path, f.temp, "relay", 1024);
    f.store.file({ ...relay, session, requestId: "relay", mode: "relay" });
    f.outbox.finalize(session, "notes:relay", "reply:relay", "a link awaiting delivery", []);
    await f.store.releaseSnapshots(session, "relay", f.temp);
    expect(await fileDigest(relay.path)).toBe(relay.sha256);
    f.outbox.acknowledge(["reply:relay"]); f.store.acknowledgeRelay(session, "relay");
    await f.store.releaseSnapshots(session, "relay", f.temp);
    expect(await stat(relay.path).then(() => true, () => false)).toBe(false);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("normal send_file records sent/uncertain before fallback, deduplicates identical bytes and never retries an uncertain send", async () => {
  const f = await setup();
  const api = { conversationId: 1, snapshot: async (doc: unknown) => doc === InboxDoc ? { items: [{ requestId: "normal-send", startedAt: Date.now() }] } : { groupId: "group-a", phone: "1001" } };
  const member = { phone: "1001", conversationId: 1 as never, places: { tempDir: f.temp, workspaceDir: join(f.root, "group-a/workspace"), indexPath: "", venvDir: "" } };
  try {
    const deliver = await fileDelivery(f.store, member, { api, context } as unknown as MemberCall);
    let sends = 0;
    const send = async (_source: unknown, begin: () => void) => { sends++; begin(); return { mode: "direct" as const }; };
    await deliver({ kind: "local", path: f.path, size: 16 }, "report.txt", undefined, send);
    expect(f.store.files(session)[0]!.state).toBe("sent");
    await deliver({ kind: "local", path: f.path, size: 16 }, "report.txt", undefined, send); expect(sends).toBe(1);
    await writeFile(f.path, "another version");
    await expect(deliver({ kind: "local", path: f.path, size: 15 }, "report.txt", undefined, async (_source, begin) => { sends++; begin(); throw new Error("lost response"); })).rejects.toThrow("lost response");
    expect(f.store.files(session).map(x => x.state)).toEqual(["sent", "uncertain"]);
    await expect(deliver({ kind: "local", path: f.path, size: 15 }, "report.txt", undefined, send)).rejects.toThrow("结果不确定");
    const guidance = await deliver({ kind: "local", path: f.path, size: 15 }, "report.txt", undefined, send).catch(error => String(error));
    expect(guidance).toContain("新消息中明确要求重新发送"); expect(guidance).not.toContain("/deliver");
    expect(f.outbox.pending(session)).toEqual([]);
    expect(sends).toBe(2);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test.each([true, false].flatMap(registered => ["none", "text", "refresh"].map(failure => ({ registered, failure }))))(
  "relay notes survive failure with registration=$registered, initial failure=$failure; refreshed notes acknowledge the file only once", async ({ registered, failure }) => {
    const f = await setup(), delivered: string[] = []; let uploads = 0, refreshes = 0, broken = failure !== "none";
    const note = "large file: https://relay.example/old", attachment = { original: note, reference: { backend: "fixture", url: "https://relay.example/object", name: "report.txt", size: 16 } };
    const sendText = f.options.outbound!.sendText;
    f.options.outbound!.sendText = async (...args) => {
      f.states.failText = broken && failure === "text";
      const sent = await sendText(...args); if (sent) delivered.push(args[0]); return sent;
    };
    f.options.outbound!.refresh = async row => {
      refreshes++; expect(row.attachments).toEqual([attachment]);
      if (broken && failure === "refresh") throw new Error("temporary signing failure");
      return row.text.replace("https://relay.example/old", "https://relay.example/fresh");
    };
    let requestId = "";
    const failAfterLink: FauxResponseFactory = async () => {
      const storage = await openGroupStorage(groupDatabasePath(f.root, "group-a")), view = createSession(storage);
      try {
        const owner = await view.snapshot(MemberDirectory, "1001", context);
        requestId = (await view.snapshot(InboxDoc, owner!.conversationId as never, context))!.items[0]!.requestId;
      } finally { await view.close(context); }
      const api = { conversationId: 1, snapshot: async (doc: unknown) => doc === InboxDoc
        ? { items: [{ requestId, startedAt: Date.now() }] } : { groupId: "group-a", phone: "1001" } };
      const member = { phone: "1001", conversationId: 1 as never, places: { tempDir: f.temp, workspaceDir: join(f.root, "group-a/workspace"), indexPath: "", venvDir: "" } };
      const deliver = await fileDelivery(f.store, member, { api, context } as unknown as MemberCall);
      const transport = async () => { uploads++; return { mode: "relay" as const, note, attachment, url: "https://relay.example/old", size: 16 }; };
      await deliver({ kind: "local", path: f.path, size: 16 }, "report.txt", undefined, transport);
      f.outbox.put(session, `notes:${requestId}`, note, [attachment]);
      return failModel();
    };
    f.faux.setResponses(registered ? [f.register(), failAfterLink] : [failAfterLink]);
    try {
      await f.service.admit("1001", "group-a", "send large report", callback);
      if (failure !== "none") {
        await until(() => f.sent.some(x => x.text.includes("已保存交付内容")), "retry notice");
        expect(f.outbox.pending(session)[0]!.attachments).toEqual([attachment]);
        expect(f.outbox.pending(session)[0]!.text).toContain(note);
        expect(f.store.files(session)[0]!.state).toBe("planned");
        expect(delivered.some(x => x.includes("relay.example/fresh"))).toBe(false);
        broken = false; await f.service.control("1001", "group-a", "/deliver", callback);
      }
      await until(() => f.store.files(session)[0]?.state === "sent" && f.outbox.pending(session).length === 0, "relay acknowledgement");
      expect(delivered.filter(x => x.includes("relay.example/fresh"))).toHaveLength(1);
      expect(f.sent.filter(x => x.kind === "file")).toEqual([]);
      expect(uploads).toBe(1); expect(refreshes).toBe(failure === "none" ? 1 : 2);
    } finally { await f.service.close(); f.stateDb.close(); }
  });

test.each(["case", "link"] as const)("delivery through a %s root cleans canonical snapshots without false retry notices", async alias => {
  const f = await setup(alias); f.faux.setResponses([f.register(), failModel()]);
  try {
    await f.service.admit("1001", "group-a", "report", callback);
    await until(() => f.store.files(session)[0]?.state === "sent" && f.outbox.pending(session).length === 0, "acknowledgement");
    const path = f.store.files(session)[0]!.path;
    await until(() => !Bun.file(path).size, "canonical snapshot cleanup");
    await Bun.sleep(30);
    expect(f.sent.some(x => x.text.includes("已保存交付内容"))).toBe(false);
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("cleanup failure after acknowledgement does not report a nonexistent retry plan", async () => {
  const f = await setup(); f.faux.setResponses([f.register(), failModel()]);
  const cleanup = spyOn(CloseoutStore.prototype, "releaseSnapshots").mockRejectedValue(new Error("fixture cleanup failure"));
  try {
    await f.service.admit("1001", "group-a", "report", callback);
    await until(() => f.sent.some(x => x.kind === "file") && f.outbox.pending(session).length === 0, "acknowledgement");
    await Bun.sleep(30);
    expect(f.sent.some(x => x.text.includes("已保存交付内容"))).toBe(false);
  } finally { cleanup.mockRestore(); await f.service.close(); f.stateDb.close(); }
});

test("expired fallback plans notify once across restarts on the next ordinary message; cancelled plans stay quiet", async () => {
  const f = await setup(); await f.service.close();
  for (const id of ["expired", "cancelled"]) {
    const plan = f.store.createPlan(session, id, "saved explanation", [], 2000);
    f.store.savePlan({ ...plan, deadline: Date.now() - 1000, withdrawn: id === "cancelled" });
  }
  let service = new DurableService(f.options);
  try {
    await service.start(); f.faux.setResponses([fauxAssistantMessage("hello")]);
    await service.admit("1001", "group-a", "hello", callback);
    await until(() => f.sent.some(x => x.kind === "reply"), "ordinary reply"); await service.close();
    expect(f.sent.filter(x => x.text.includes("上次任务的交付未完成"))).toHaveLength(1);
    expect(f.store.plan(session, "fallback:expired")!.expiredNoticeAt).toBeGreaterThan(0);
    expect(f.store.plan(session, "fallback:cancelled")!.expiredNoticeAt).toBeUndefined();
    expect(f.outbox.pending(session)).toHaveLength(2); expect(f.sent.some(x => x.kind === "file")).toBe(false);
    service = new DurableService(f.options); await service.start(); f.faux.setResponses([fauxAssistantMessage("hello again")]);
    await service.admit("1001", "group-a", "another message", callback);
    await until(() => f.sent.filter(x => x.kind === "reply").length === 2, "second reply");
    expect(f.sent.filter(x => x.text.includes("上次任务的交付未完成"))).toHaveLength(1);
  } finally { await service.close(); f.stateDb.close(); }
});

test("bash always preserves delivery time, respects its configured default, and the clock has no ambiguous UTC timestamp", async () => {
  const t = { closeoutMs: 300000, reserveMs: 120000, fallbackMs: 120000 };
  let remaining = 400000;
  const api = { conversationId: 1, snapshot: async (doc: unknown) => doc === InboxDoc
    ? { items: [{ requestId: "bash-budget", startedAt: Date.now() - 7200000 + remaining }] } : { groupId: "group-a", phone: "1001" } };
  expect((await closeoutTool("bash", { timeout: 900 }, api as never, context, t, 7200000) as { timeout: number }).timeout).toBeLessThanOrEqual(280);
  remaining = 5000000;
  expect((await closeoutTool("bash", {}, api as never, context, t, 7200000) as { timeout: number }).timeout).toBe(BASH_DEFAULT_TIMEOUT);
  remaining = 2800000; const longCloseout = { ...t, closeoutMs: 3000000 };
  expect((await closeoutTool("bash", {}, api as never, context, longCloseout, 7200000) as { timeout: number }).timeout).toBe(BASH_DEFAULT_TIMEOUT);
  const f = await setup();
  try {
    const extension = closeoutExtension(f.store, t, 7200000), hooks = (extension.hooks![0] as { handlers: import("@earendil-works/pi-durable").GenerationHooks }).handlers;
    const result = await hooks.beforeRequest({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }, api as never, context);
    expect(JSON.stringify(result!.messages)).toContain("[任务计时] 剩余"); expect(JSON.stringify(result!.messages)).not.toContain("截止");
  } finally { await f.service.close(); f.stateDb.close(); }
});

test("send_file reuses registered snapshots and duplicates without copying, and checks a new copy only once", async () => {
  const f = await setup(), id = "reads", api = { conversationId: 1, snapshot: async (doc: unknown) => doc === InboxDoc
    ? { items: [{ requestId: id, startedAt: Date.now() }] } : { groupId: "group-a", phone: "1001" } };
  const member = { phone: "1001", conversationId: 1 as never, places: { tempDir: f.temp, workspaceDir: join(f.root, "group-a/workspace"), indexPath: "", venvDir: "" } };
  const frozen = await freezeFile(f.path, f.temp, id, 1024);
  f.store.register({ ...frozen, session, requestId: id, slot: "file", complete: true, status: "draft", checked: [], unchecked: [], issues: [] });
  const copying = spyOn(fs, "copyFile"), opening = spyOn(fs, "open"); let sends = 0;
  try {
    const deliver = await fileDelivery(f.store, member, { api, context } as unknown as MemberCall);
    const send = async () => { sends++; return { mode: "direct" as const }; };
    await deliver({ kind: "local", path: frozen.path, size: frozen.size }, "report.txt", undefined, send);
    await deliver({ kind: "local", path: f.path, size: frozen.size }, "report.txt", undefined, send);
    expect(copying).not.toHaveBeenCalled(); expect(sends).toBe(1); expect(f.store.files(session)[0]!.path).toBe(frozen.path);
    await writeFile(f.path, "new bytes"); opening.mockClear();
    await deliver({ kind: "local", path: f.path, size: 9 }, "report.txt", undefined, send);
    expect(copying).toHaveBeenCalledTimes(1); expect(opening).toHaveBeenCalledTimes(2); expect(sends).toBe(2);
  } finally { copying.mockRestore(); opening.mockRestore(); await f.service.close(); f.stateDb.close(); }
});
