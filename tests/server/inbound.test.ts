// The inbound router (plan 5.2): event checks, identity, notices, late commands, in-process dedupe and ordering.
import { expect, test } from "bun:test";
import type { DirectoryIdentity } from "../../src/integrations/open-platform/identity-directory.ts";
import type { OutboundMessage, Target } from "../../src/integrations/open-platform/messages.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import { DIRECT_SCOPE, groupScope } from "../../src/core/layout.ts";
import type { AdmitResult, AttachResult, Inbound, InboundAttachment } from "../../src/durable/service.ts";
import { type InboundPush, InboundRouter, type InboundService } from "../../src/server/inbound.ts";

type Call = { kind: "admit" | "control"; message: Inbound } | { kind: "attach"; message: InboundAttachment };

function harness(options: { initializing?: boolean; scoped?: boolean; applying?: boolean; unset?: boolean; admit?: (message: Inbound) => Promise<AdmitResult>;
  control?: (message: Inbound) => Promise<string>;
  attach?: (message: InboundAttachment) => Promise<AttachResult>; push?: InboundPush } = {}) {
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
    attach: message => { calls.push({ kind: "attach", message }); return options.attach?.(message) ?? Promise.resolve({ status: "accepted", attachment: "att" }); },
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
    service, outbound, ...(options.push ? { push: options.push } : {}), signal: abort.signal, onUnknown: () => { unknown++; }, onReport: error => reports.push(error),
    directory: { lookup: id => identities[id], initializing: options.initializing ?? false, scoped: options.scoped ?? false, applying: options.applying ?? false,
      unset: options.unset ?? false },
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
  // While a saved scope is being applied the previous list still answers; a sender not on it is asked to retry later.
  const applying = harness({ scoped: true, applying: true });
  applying.router.handle(applying.event({ userId: "im-stranger" }));
  applying.router.handle(applying.event({ userId: "im-alice", msgUid: "known" }));
  await applying.router.drain();
  expect(applying.notices.map(notice => notice.text)).toEqual([expect.stringContaining("通讯录同步范围正在更新，完成前暂时无法确认你的身份，请稍后重发。")]);
  expect(applying.calls.map(call => call.message.phone)).toEqual(["13800000001"]);
  // Without a saved scope nothing is synced: a stranger is sent to the administrator, and mapped members still get through.
  const unset = harness({ unset: true });
  unset.router.handle(unset.event({ userId: "im-stranger" }));
  unset.router.handle(unset.event({ userId: "im-alice", msgUid: "mapped" }));
  await unset.router.drain();
  expect(unset.notices.map(notice => notice.text)).toEqual([expect.stringContaining("机器人还没有设置通讯录同步范围，暂时无法确认你的身份，请联系管理员。")]);
  expect(unset.calls.map(call => call.message.phone)).toEqual(["13800000001"]);
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
  const h = harness({ attach: async () => { if (fail) throw new Error("storage down"); return { status: "accepted", attachment: "att" }; } });
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

/** A push service stand-in: members (and `group:<ID>`) in `replying` have their texts (and direct attachments) taken as reply items. */
function fakePush(replying: Set<string>) {
  const calls: string[] = [];
  const items = new Set<string>();
  const push: InboundPush = {
    seen: msgUid => items.has(msgUid),
    click: event => { calls.push(`click ${String(event.payload.msgUid)}`); },
    directText: (identity, reply, text) => {
      calls.push(`text ${text}`);
      if (text === "/完成" || text === "/取消") return true;
      if (!replying.has(identity.phone) || text.startsWith("/")) return false;
      items.add(reply.msgUid);
      return true;
    },
    directAttachment: (identity, reply, attachment) => {
      calls.push(`attachment ${attachment.fileId}`);
      if (!replying.has(identity.phone)) return false;
      items.add(reply.msgUid);
      return true;
    },
    groupText: (groupId, _identity, reply, text) => {
      calls.push(`group ${groupId} ${text}`);
      if (["/完成", "/取消"].includes(text) || text.startsWith("/登记群")) return true;
      if (!replying.has(`group:${groupId}`) || text.startsWith("/")) return false;
      items.add(reply.msgUid);
      return true;
    },
  };
  return { push, calls };
}

test("card clicks go to the push service only; without one they are dropped", async () => {
  const fake = fakePush(new Set());
  const h = harness({ push: fake.push });
  h.router.handle(h.event({ eventType: "callback:card_interaction", msgUid: "card-1", content: { data: "{}" } }));
  await h.router.drain();
  expect(fake.calls).toEqual(["click card-1"]);
  expect(h.calls).toEqual([]); expect(h.notices).toEqual([]);
  const bare = harness();
  bare.router.handle(bare.event({ eventType: "callback:card_interaction", msgUid: "card-2" }));
  await bare.router.drain();
  expect(bare.calls).toEqual([]); expect(bare.notices).toEqual([]);
});

test("a member replying to a push has direct texts and attachments taken by it; commands and other members are not; a group text is asked too", async () => {
  const fake = fakePush(new Set(["13800000001"]));
  const h = harness({ push: fake.push });
  const direct = { eventType: "callback:direct", groupId: "" };
  h.router.handle(h.event({ ...direct, msgUid: "r-1", content: { content: " my reply " } }));
  h.router.handle(h.event({ ...direct, type: "file", msgUid: "r-2", content: { fileId: "file-9", filename: "r.pdf" } }));
  h.router.handle(h.event({ ...direct, msgUid: "r-3", content: { content: "/status" } }));
  h.router.handle(h.event({ msgUid: "g-1", content: { content: "group question" } }));
  await h.router.drain();
  expect(fake.calls).toEqual(["text my reply", "attachment file-9", "text /status", "group 100 group question"]);
  expect(h.calls.map(call => [call.kind, call.message.reply.msgUid])).toEqual([["control", "r-3"], ["admit", "g-1"]]);
  // A redelivered reply item is recognised by the push service and never reaches it or the model again.
  h.router.handle(h.event({ ...direct, msgUid: "r-1", content: { content: " my reply " } }));
  await h.router.drain();
  expect(fake.calls).toHaveLength(4); expect(h.calls).toHaveLength(2);
  // Without a reply in progress the push service declines and the message is admitted as usual.
  const idle = fakePush(new Set());
  const other = harness({ push: idle.push });
  other.router.handle(other.event({ ...direct, msgUid: "q-1", content: { content: "question" } }));
  other.router.handle(other.event({ ...direct, type: "image", msgUid: "q-2", content: { fileId: "file-8" } }));
  await other.router.drain();
  expect(idle.calls).toEqual(["text question", "attachment file-8"]);
  expect(other.calls.map(call => [call.kind, call.message.reply.msgUid])).toEqual([["admit", "q-1"], ["attach", "q-2"]]);
});

test("/完成 and /取消 go to the push service in direct chats and groups, /登记群 in groups; all are ignored when late", async () => {
  const fake = fakePush(new Set());
  const h = harness({ push: fake.push }), now = Date.now();
  const direct = { eventType: "callback:direct", groupId: "" };
  h.router.handle(h.event({ ...direct, content: { content: "/完成" } }));
  h.router.handle(h.event({ ...direct, content: { content: "/取消" } }, { sentAt: now - 5 * 60_000, receivedAt: now }));
  h.router.handle(h.event({ content: { content: "/取消" } }));
  h.router.handle(h.event({ content: { content: "/登记群 销售一部" } }));
  h.router.handle(h.event({ content: { content: "/登记群 客服" } }, { sentAt: now - 5 * 60_000, receivedAt: now }));
  h.router.handle(h.event({ content: { content: "/stop" } }));
  await h.router.drain();
  expect(fake.calls).toEqual(["text /完成", "group 100 /取消", "group 100 /登记群 销售一部", "group 100 /stop"]);
  expect(h.notices.map(n => n.text)).toEqual([expect.stringContaining("这条命令是 5 分钟前发的，已忽略"), expect.stringContaining("这条命令是 5 分钟前发的，已忽略")]);
  expect(h.calls.map(call => [call.kind, call.message.scope, (call.message as Inbound).content])).toEqual([["control", groupScope("100"), "/stop"]]);
});

test("a group replying to a push has its members' texts taken by it; group media are still refused", async () => {
  const fake = fakePush(new Set(["group:100"]));
  const h = harness({ push: fake.push });
  h.router.handle(h.event({ msgUid: "gr-1", content: { content: "我们组已盘点" } }));
  h.router.handle(h.event({ msgUid: "gr-2", content: { content: "/status" } }));
  h.router.handle(h.event({ msgUid: "gr-3", type: "file", content: { fileId: "file-7", filename: "x.pdf" } }));
  h.router.handle(h.event({ msgUid: "gr-4", groupId: "200", content: { content: "其他群的问题" } }));
  await h.router.drain();
  expect(fake.calls).toEqual(["group 100 我们组已盘点", "group 100 /status", "group 200 其他群的问题"]);
  expect(h.calls.map(call => [call.kind, call.message.reply.msgUid])).toEqual([["control", "gr-2"], ["admit", "gr-4"]]);
  expect(h.notices.map(n => n.text)).toEqual([expect.stringContaining("群里暂不支持接收图片、文件和视频")]);
  // Redelivered: the push service has it.
  h.router.handle(h.event({ msgUid: "gr-1", content: { content: "我们组已盘点" } }));
  await h.router.drain();
  expect(fake.calls).toHaveLength(3);
});
