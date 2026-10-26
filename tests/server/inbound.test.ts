// The inbound router (plan 5.2): event checks, identity, notices, late commands, in-process dedupe and ordering.
import { expect, test } from "bun:test";
import type { DirectoryIdentity } from "../../src/integrations/open-platform/identity-directory.ts";
import type { OutboundMessage, Target } from "../../src/integrations/open-platform/messages.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import { DIRECT_SCOPE, groupScope } from "../../src/core/layout.ts";
import type { AdmitResult, Inbound, InboundAttachment } from "../../src/durable/service.ts";
import { InboundRouter, type InboundService } from "../../src/server/inbound.ts";

type Call = { kind: "admit" | "control"; message: Inbound } | { kind: "attach"; message: InboundAttachment };

function harness(options: { initializing?: boolean; scoped?: boolean; admit?: (message: Inbound) => Promise<AdmitResult>; control?: (message: Inbound) => Promise<string>;
  attach?: (message: InboundAttachment) => Promise<AdmitResult> } = {}) {
  const calls: Call[] = [], notices: { target: Target; text: string; replyMsgId?: string }[] = [], reports: unknown[] = [];
  const durable = new Set<string>();
  let unknown = 0;
  const identities: Record<string, DirectoryIdentity> = {
    "im-alice": { phone: "13800000001", imUserId: "im-alice", name: "Alice" },
    "im-bad": { phone: "not a phone!", imUserId: "im-bad", name: "Bad" },
  };
  const service: InboundService = {
    seen: msgUid => durable.has(msgUid),
    admit: message => { calls.push({ kind: "admit", message }); return options.admit?.(message) ?? Promise.resolve({ status: "accepted" }); },
    control: message => { calls.push({ kind: "control", message }); return options.control?.(message) ?? Promise.resolve("ok"); },
    attach: message => { calls.push({ kind: "attach", message }); return options.attach?.(message) ?? Promise.resolve({ status: "accepted" }); },
  };
  const outbound: Outbound = {
    async send(target: Target, message: OutboundMessage, sendOptions) {
      const content = message.content as { content?: string };
      notices.push({ target, text: content.content ?? "", ...(sendOptions?.replyMsgId ? { replyMsgId: sendOptions.replyMsgId } : {}) });
      return { status: "sent" };
    },
    sequence(target, work) { return work((message, sendOptions) => this.send(target, message, sendOptions)); },
    upload: async () => "file", links: async () => "",
  };
  const abort = new AbortController();
  const router = new InboundRouter({
    service, outbound, signal: abort.signal, onUnknown: () => { unknown++; }, onReport: error => reports.push(error),
    directory: { lookup: id => identities[id], initializing: options.initializing ?? false, scoped: options.scoped ?? false },
  });
  let serial = 0;
  const event = (payload: Record<string, unknown>, timing: { sentAt?: number; receivedAt?: number } = {}) => ({
    payload: { eventType: "callback:alt", groupId: "100", userId: "im-alice", msgUid: `uid-${++serial}`, type: "text", content: { content: "hello" }, extraContent: "", ...payload },
    sentAt: timing.sentAt, receivedAt: timing.receivedAt ?? Date.now(),
  });
  return { router, calls, notices, reports, durable, abort, event, unknown: () => unknown };
}

test("events of other types, without identifiers or with a group that does not match the chat are dropped silently", async () => {
  const h = harness();
  for (const payload of [{ eventType: "callback:other" }, { msgUid: "" }, { userId: undefined }, { type: 7 }, { groupId: "abc" },
    { eventType: "callback:direct", groupId: "100" }, { msgUid: "x".repeat(200) }]) h.router.handle(h.event(payload));
  await h.router.drain();
  expect(h.calls).toEqual([]); expect(h.notices).toEqual([]);
});

test("group and direct messages reach the service with their space, phone, trimmed text and reply context", async () => {
  const h = harness();
  h.router.handle(h.event({ content: { content: "  question  " }, msgUid: "g-1" }, { sentAt: 1000, receivedAt: 2000 }));
  h.router.handle(h.event({ eventType: "callback:direct", groupId: "", type: "reference", content: { contentText: "quoted question" }, msgUid: "d-1" }));
  await h.router.drain();
  expect(h.calls.map(call => [call.kind, call.message.scope, call.message.phone, "content" in call.message ? call.message.content : ""])).toEqual([
    ["admit", groupScope("100"), "13800000001", "question"], ["admit", DIRECT_SCOPE, "13800000001", "quoted question"]]);
  expect(h.calls[0]!.message.reply).toEqual({ kind: "group", receiveId: "100", senderImUserId: "im-alice", msgUid: "g-1", name: "Alice",
    summary: "question", sentAt: 1000, receivedAt: 2000 });
  expect(h.calls[1]!.message.reply).toMatchObject({ kind: "direct", receiveId: "im-alice", msgUid: "d-1" });
});

test("an unknown sender, or a mapping with an invalid phone, gets a notice once and triggers a directory scan", async () => {
  const h = harness();
  const stranger = h.event({ userId: "im-stranger", msgUid: "s-1" });
  h.router.handle(stranger); h.router.handle(stranger);
  h.router.handle(h.event({ userId: "im-bad" }));
  await h.router.drain();
  expect(h.calls).toEqual([]);
  expect(h.notices.map(n => n.text)).toEqual(["暂时无法确认你的身份，正在同步通讯录，请稍后重发。", "暂时无法确认你的身份，正在同步通讯录，请稍后重发。"]
    .map(text => expect.stringContaining(text)));
  expect(h.unknown()).toBe(2);
  const initializing = harness({ initializing: true });
  initializing.router.handle(initializing.event({ userId: "im-stranger" }));
  await initializing.router.drain();
  expect(initializing.notices[0]!.text).toContain("正在同步通讯录，完成前暂时无法确认你的身份");
  // With a department scope the sender may simply be outside it; the scan is still requested for new members.
  const scoped = harness({ scoped: true });
  scoped.router.handle(scoped.event({ userId: "im-stranger" }));
  await scoped.router.drain();
  expect(scoped.notices[0]!.text).toContain("你可能不在机器人同步的部门范围内");
  expect(scoped.unknown()).toBe(1);
});

test("quantum-session messages are skipped; unsupported, empty and overlong messages get a notice and never reach the service", async () => {
  const h = harness();
  h.router.handle(h.event({ extraContent: JSON.stringify({ sessionId: "q" }) }));
  h.router.handle(h.event({ extraContent: { sessionId: "q" } }));
  h.router.handle(h.event({ type: "image", content: { fileId: "f-1" } }));
  h.router.handle(h.event({ eventType: "callback:direct", groupId: "", type: "file", content: { filename: "a.txt" } }));
  h.router.handle(h.event({ type: "card", content: {} }));
  h.router.handle(h.event({ content: { content: "   " } }));
  h.router.handle(h.event({ content: { content: "长".repeat(6000) } }));
  await h.router.drain();
  expect(h.calls).toEqual([]);
  const texts = h.notices.map(n => n.text);
  expect(texts).toHaveLength(5);
  expect(texts[0]).toContain("群里暂不支持接收图片、文件和视频，请在单聊中发送。");
  expect(texts[1]).toContain("附件信息不完整，请重新发送。");
  expect(texts[2]).toContain("暂不支持该类型的消息，请发送文字。");
  expect(texts[3]).toContain("请输入问题");
  expect(texts[4]).toContain("消息过长");
});

test("direct images, files and videos are registered in arrival order with what the event declares; failures are answered", async () => {
  let fail = false;
  const h = harness({ attach: async () => { if (fail) throw new Error("storage down"); return { status: "accepted" }; } });
  const direct = { eventType: "callback:direct", groupId: "" };
  h.router.handle(h.event({ ...direct, type: "file", msgUid: "a-1", content: { fileId: "file-1", filename: "report.pdf", size: 2048, mimeType: "application/pdf" } }));
  h.router.handle(h.event({ ...direct, type: "image", msgUid: "a-2", content: { fileId: "file-2", width: 10, height: 10 } }));
  h.router.handle(h.event({ ...direct, type: "video", msgUid: "a-3", content: { fileId: "file-3", duration: 3 } }));
  h.router.handle(h.event({ ...direct, msgUid: "a-4", content: { content: "summarise them" } }));
  h.router.handle(h.event({ ...direct, type: "file", msgUid: "a-1", content: { fileId: "file-1", filename: "report.pdf" } }));
  // Registration starts synchronously, before the question that follows.
  expect(h.calls.map(call => [call.kind, call.message.reply.msgUid])).toEqual([["attach", "a-1"], ["attach", "a-2"], ["attach", "a-3"], ["admit", "a-4"]]);
  await h.router.drain();
  expect(h.calls.slice(0, 3).map(call => (call.message as InboundAttachment).attachment)).toEqual([
    { fileId: "file-1", kind: "file", name: "report.pdf", size: 2048, mimeType: "application/pdf" },
    { fileId: "file-2", kind: "image", name: "图片" }, { fileId: "file-3", kind: "video", name: "视频" }]);
  expect(h.calls[0]!.message).toMatchObject({ scope: DIRECT_SCOPE, phone: "13800000001", reply: { kind: "direct", summary: "[文件]" } });
  fail = true;
  h.router.handle(h.event({ ...direct, type: "file", msgUid: "a-5", content: { fileId: "file-5", filename: "x" } }));
  await h.router.drain();
  expect(h.reports.map(String)).toEqual(["Error: storage down"]);
  expect(h.notices.map(n => n.text)).toEqual([expect.stringContaining("附件未能登记，请稍后重发。")]);
});

test("a late state-changing command is ignored with a notice; a late /status and late questions still run", async () => {
  const h = harness(), now = Date.now(), late = { sentAt: now - 5 * 60_000, receivedAt: now };
  for (const command of ["/stop", "/clear", "/compact"]) h.router.handle(h.event({ content: { content: command } }, late));
  h.router.handle(h.event({ content: { content: "/status" } }, late));
  h.router.handle(h.event({ content: { content: "late question" } }, late));
  await h.router.drain();
  expect(h.calls.map(call => [call.kind, (call.message as Inbound).content])).toEqual([["control", "/status"], ["admit", "late question"]]);
  expect(h.notices.filter(n => n.text.includes("这条命令是 5 分钟前发的，已忽略"))).toHaveLength(3);
});

test("arrival order reaches the service synchronously; a redelivery while one is queued, or one the service recorded, is dropped", async () => {
  const gate = Promise.withResolvers<void>();
  const h = harness({ admit: async () => { await gate.promise; return { status: "accepted" }; } });
  const first = h.event({ content: { content: "one" }, msgUid: "m-1" }), second = h.event({ content: { content: "two" }, msgUid: "m-2" });
  h.router.handle(first); h.router.handle(second);
  // Both admissions started in arrival order before any of them finished.
  expect(h.calls.map(call => (call.message as Inbound).content)).toEqual(["one", "two"]);
  h.router.handle(first);
  expect(h.calls).toHaveLength(2);
  gate.resolve(); await h.router.drain();
  // Admitted messages are deduplicated by the service's durable receipts, not by the router.
  h.durable.add("m-1");
  h.router.handle(first);
  h.router.handle(second);
  await h.router.drain();
  expect(h.calls.map(call => (call.message as Inbound).content)).toEqual(["one", "two", "two"]);
});

test("a full queue is answered with the service's message and remembered; failures are reported and answered unless shutting down", async () => {
  let mode: "full" | "throw" = "full";
  const h = harness({
    admit: async () => { if (mode === "full") return { status: "full", message: "排队已满" }; throw new Error("storage down"); },
    control: async () => { throw new Error("control down"); },
  });
  const full = h.event({ msgUid: "f-1" });
  h.router.handle(full); await h.router.drain();
  h.router.handle(full); await h.router.drain();
  expect(h.calls).toHaveLength(1); expect(h.notices.map(n => n.text)).toEqual([expect.stringContaining("排队已满")]);
  mode = "throw";
  h.router.handle(h.event({})); h.router.handle(h.event({ content: { content: "/stop" } }));
  await h.router.drain();
  expect(h.reports.map(String)).toEqual(["Error: storage down", "Error: control down"]);
  expect(h.notices.slice(1).map(n => n.text)).toEqual([expect.stringContaining("消息未能加入队列"), expect.stringContaining("指令未能执行")]);
  h.abort.abort();
  h.router.handle(h.event({})); h.router.handle(h.event({ content: { content: "/clear" } }));
  await h.router.drain();
  expect(h.reports).toHaveLength(2); expect(h.notices).toHaveLength(3);
});
