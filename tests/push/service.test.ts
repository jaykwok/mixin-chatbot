// The push service (src/push/service.ts) over a fresh state database: settings, push_prepare's checks, the preview and
// its confirmation, card sends and retries, clicks and replies (text, attachments, /完成 and /取消), the deadline and
// the summary with its package, held attachments, conversation notes, restarts. A recording platform, a fake address
// book and a fake message service; no network.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { PUSH_LIMITS, PushRefused, PushService, type PushHost, type PushLimits, type PrepareInput } from "../../src/push/service.ts";
import { type Grants, PushStore } from "../../src/push/store.ts";
import { scopeKey } from "../../src/core/layout.ts";
import { DepartmentTree, emptyWalk } from "../../src/integrations/open-platform/department-tree.ts";
import type { CardButton, CardContent, OutboundMessage, SendOptions, SendOutcome } from "../../src/integrations/open-platform/messages.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import type { Attachment, MemberRecords, ReplyContext } from "../../src/durable/records.ts";
import type { AttachResult, InboundAttachment } from "../../src/durable/service.ts";
import type { DirectoryIdentity } from "../../src/integrations/open-platform/identity-directory.ts";
import { tempFixture } from "../helpers/temp.ts";
import { readZip } from "../helpers/zip-reader.ts";

const fixture = await tempFixture("push-service-");
afterAll(() => fixture.cleanup());
let counter = 0;

const PUSHER = "13800000009", ZHANG = "13800000001", LI = "13800000002", WANG = "13800000003";
const PEOPLE: DirectoryIdentity[] = [[PUSHER, "推送人"], [ZHANG, "张三"], [LI, "李四"], [WANG, "王五"]]
  .map(([phone, name]) => ({ phone: phone!, name: name!, imUserId: `im-${phone}` }));
const im = (phone: string) => `im-${phone}`;
const START = new Date(2026, 10, 3, 9, 0).getTime();

type Sent = { to: string; kind: "direct" | "group"; message: OutboundMessage; options?: SendOptions };

function harness(options: { dailyLimit?: number | null; limits?: Partial<PushLimits>; people?: DirectoryIdentity[] } = {}) {
  const root = join(fixture.root, `h-${++counter}`);
  const db = new Database(":memory:");
  const store = new PushStore(db);
  // The address book: the valid mappings (as the identity directory keeps them) and the department tree over them.
  const people = [...PEOPLE, ...options.people ?? []];
  db.exec("CREATE TABLE member_directory (phone TEXT PRIMARY KEY, im_user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_verified_at INTEGER NOT NULL) STRICT");
  for (const person of people) db.query("INSERT INTO member_directory VALUES (?, ?, ?, 0)").run(person.phone, person.imUserId, person.name);
  const departments = new DepartmentTree(db);
  const sent: Sent[] = [], uploads: { name: string; data: Buffer }[] = [], reports: unknown[] = [];
  const clock = { now: START };
  const failing: { when?: (item: Sent) => SendOutcome | undefined } = {};
  /** Recipients' card sends: a wait each, clock time each, and how many were under way at once. */
  const gate = { delayMs: 0, advanceMs: 0, inFlight: 0, max: 0 };
  const outbound: Outbound = {
    async send(target, message, sendOptions) {
      const item: Sent = { to: target.receiveId, kind: target.kind, message, ...(sendOptions ? { options: sendOptions } : {}) };
      sent.push(item);
      if (message.msgType === "card" && target.receiveId !== im(PUSHER) && gate.delayMs) {
        gate.max = Math.max(gate.max, ++gate.inFlight);
        await Bun.sleep(gate.delayMs);
        gate.inFlight--;
        clock.now += gate.advanceMs;
      }
      return failing.when?.(item) ?? { status: "sent" };
    },
    sequence(target, work) { return work((message, sendOptions) => outbound.send(target, message, sendOptions)); },
    async upload(source) { uploads.push({ name: source.fileName, data: readFileSync(source.path) }); return `file-${uploads.length}`; },
    links: async () => "",
  };
  const byPhone = new Map(people.map(person => [person.phone, person])), byIm = new Map(people.map(person => [person.imUserId, person]));
  const directory = { lookup: (id: string) => byIm.get(id), byPhone: (phone: string) => byPhone.get(phone), departments };
  /** Replace the tree: TREE's departments (`shape` overrides them) with these members. */
  const tree = (members: Record<string, readonly string[]>, shape: { nodes?: Record<string, readonly [string, string]> } = {}) => {
    const walk = emptyWalk();
    for (const [id, name] of Object.entries(TREE.tops)) walk.tops.set(id, { name, path: name });
    for (const [id, [name, parent]] of Object.entries(shape.nodes ?? TREE.nodes)) walk.nodes.set(id, { name, parent });
    for (const [id, phones] of Object.entries(members)) walk.members.set(id, phones);
    departments.replace(walk, clock.now);
  };
  const grant = (grants: Grants) => store.replaceRoles([{ phone: PUSHER, admin: false, pusher: true, grants, dailyLimit: options.dailyLimit ?? null }], clock.now);
  // The message service: attachment records per member, released holds, passive notes (deduplicated by request ID).
  const records = new Map<string, MemberRecords>();
  const notes: { scope: string; phone: string; requestId: string; entry: EntryDraft }[] = [];
  const attached: InboundAttachment[] = [], released: { phone: string; holder: string; ids: string[] }[] = [];
  const host: PushHost = {
    async attach(message): Promise<AttachResult> {
      attached.push(message);
      const id = `att-${message.reply.msgUid}`, path = join(root, "files", `${id}.bin`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `content of ${message.attachment.name}`);
      const own = records.get(message.phone) ?? { requests: {}, attachments: {} };
      own.attachments[id] = { id, msgUid: message.reply.msgUid, receivedAt: clock.now, epoch: 0, fileId: message.attachment.fileId, kind: message.attachment.kind,
        name: message.attachment.name, reply: message.reply, state: "ready", path, at: clock.now, ...(message.hold ? { heldBy: message.hold } : {}) } satisfies Attachment;
      records.set(message.phone, own);
      return { status: "accepted", attachment: id };
    },
    records: async (_scope, phone) => structuredClone(records.get(phone) ?? { requests: {}, attachments: {} }),
    async releaseAttachments(_scope, phone, holder, ids) {
      released.push({ phone, holder, ids: [...ids] });
      const own = records.get(phone);
      let count = 0;
      for (const id of ids) if (own?.attachments[id]?.heldBy === holder) { delete own.attachments[id]; count++; }
      return count;
    },
    async note(scope, phone, requestId, entry) {
      const key = scopeKey(scope);
      if (!notes.some(note => note.scope === key && note.requestId === requestId && note.phone === phone)) notes.push({ scope: key, phone, requestId, entry });
    },
  };
  const abort = new AbortController();
  const make = () => {
    const service = new PushService({ store, directory, outbound, layout: { tmp: join(root, "tmp") }, relay: null, signal: abort.signal,
      now: () => clock.now, limits: { tickMs: 3_600_000, ...options.limits }, onReport: error => reports.push(error) });
    service.bind(host);
    service.start();
    return service;
  };
  grant({});
  let service = make();

  let uid = 0;
  const reply = (phone: string): ReplyContext => ({ kind: "direct", receiveId: im(phone), senderImUserId: im(phone), msgUid: `msg-${++uid}`, summary: "", receivedAt: clock.now });
  const identity = (phone: string) => byPhone.get(phone)!;
  const cards = (phone: string) => sent.filter(item => item.to === im(phone) && item.message.msgType === "card").map(item => item.message.content as CardContent);
  const texts = (phone: string) => sent.filter(item => item.to === im(phone) && item.message.msgType === "text").map(item => (item.message.content as { content: string }).content);
  const files = (phone: string) => sent.filter(item => item.to === im(phone) && item.message.msgType === "file").map(item => (item.message.content as { fileName: string }).fileName);
  /** The latest card sent to `phone` (optionally only cards of one push). */
  const card = (phone: string, push?: string) => cards(phone).filter(each => push === undefined || each.content.includes(`推送编号 ${push}`)).at(-1)!;
  const buttonOf = (content: CardContent, name: string): CardButton => {
    const found = content.tailFields.find(each => each.name === name);
    if (!found) throw new Error(`no button ${name} on ${content.status.name}: ${content.tailFields.map(each => each.name).join(", ")}`);
    return found;
  };
  let stamp = 0;
  /** A click on the named button of `content`, by `phone`, on card `cardId`. */
  const click = (phone: string, content: CardContent, name: string, cardId: string) => service.click({
    payload: { eventType: "callback:card_interaction", userId: im(phone), msgUid: cardId, groupId: "", type: "api",
      content: { url: "", method: "POST", headers: {}, data: JSON.stringify(buttonOf(content, name).value.data) } },
    sentAt: START + ++stamp, receivedAt: clock.now,
  });
  const settle = async () => {
    for (let round = 0; round < 50; round++) { await Bun.sleep(5); }
    // Summaries write workbooks and archives: on a busy Windows runner they can outlast the rounds.
    await service.idle();
  };
  const prepare = (input: Partial<PrepareInput> = {}) => service.prepare({ phone: PUSHER, reply: reply(PUSHER) }, {
    recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }], subject: "机房盘点", body: "请回复本周机房盘点结果。", mode: "ack", ...input });
  const pushId = (text: string) => /推送编号 ([a-z0-9]{8})/.exec(text)![1]!;
  // Groups: a group's messages, its cards and texts, and a click there (the clicker's ID is not a person's).
  const groupReply = (groupId: string, phone: string): ReplyContext => ({ kind: "group", receiveId: groupId, senderImUserId: im(phone), msgUid: `msg-${++uid}`,
    summary: "", receivedAt: clock.now });
  const groupCards = (groupId: string) => sent.filter(item => item.kind === "group" && item.to === groupId && item.message.msgType === "card").map(item => item.message.content as CardContent);
  // Texts the service sends, and notices answering a message (markdown with the message's excerpt in a group).
  const groupTexts = (groupId: string) => sent.filter(item => item.kind === "group" && item.to === groupId && ["text", "markdown"].includes(item.message.msgType))
    .map(item => (item.message.content as { content: string }).content);
  const groupClick = (groupId: string, content: CardContent, name: string, cardId: string, userId = "group-clicker") => service.click({
    payload: { eventType: "callback:card_interaction", userId, msgUid: cardId, groupId, type: "api",
      content: { url: "", method: "POST", headers: {}, data: JSON.stringify(buttonOf(content, name).value.data) } },
    sentAt: START + ++stamp, receivedAt: clock.now,
  });
  const groupText = (groupId: string, phone: string, value: string, context = groupReply(groupId, phone)) => service.groupText(groupId, byPhone.get(phone)!, context, value);
  return {
    root, store, sent, uploads, reports, clock, failing, gate, records, notes, attached, released, abort, reply, identity, cards, texts, files, card, buttonOf, click,
    settle, prepare, pushId, tree, grant, groupReply, groupCards, groupTexts, groupClick, groupText, get service() { return service; },
    async restart() { await service.close(); service = make(); },
    async close() { await service.close(); },
  };
}

type Harness = ReturnType<typeof harness>;

/** Prepare, then confirm on the preview card: the push is out. */
async function confirmed(h: Harness, input: Partial<PrepareInput> = {}): Promise<string> {
  const id = h.pushId(await h.prepare(input));
  h.click(PUSHER, h.card(PUSHER, id), "确认推送", `preview-${id}`);
  await h.settle();
  return id;
}

test("settings: only people in the synced address book; neither role drops a person; the list starts empty", async () => {
  const h = harness();
  try {
    h.service.saveSettings([]);
    expect(h.service.settings()).toEqual({ roles: [], departments: [] });
    expect(h.service.isPusher(PUSHER)).toBe(false);
    expect(() => h.service.saveSettings([{ phone: "13900000000", admin: true, pusher: false }])).toThrow("不在同步的通讯录里");
    expect(() => h.service.saveSettings([{ phone: ZHANG, admin: true, pusher: true, dailyLimit: 0 }])).toThrow("频次上限");
    expect(() => h.service.saveSettings([{ phone: ZHANG, admin: true, pusher: true }, { phone: ZHANG, admin: false, pusher: true }])).toThrow("重复");
    h.service.saveSettings([{ phone: ZHANG, admin: true, pusher: false }, { phone: LI, admin: false, pusher: true, dailyLimit: 3 }, { phone: WANG, admin: false, pusher: false }]);
    expect(h.service.settings().roles.map(role => [role.phone, role.name, role.admin, role.pusher, role.dailyLimit]))
      .toEqual([[ZHANG, "张三", true, false, null], [LI, "李四", false, true, 3]]);
    expect([h.service.isPusher(LI), h.service.isPusher(ZHANG), h.service.isAdmin(ZHANG)]).toEqual([true, false, true]);
  } finally { await h.close(); }
});

test("push_prepare refuses with every reason and sends nothing; a good request sends only the preview card to the pusher", async () => {
  const h = harness();
  try {
    await expect(h.service.prepare({ phone: ZHANG, reply: h.reply(ZHANG) }, { recipients: [{ name: "李四", phone: LI }], subject: "s", body: "b", mode: "ack" }))
      .rejects.toThrow("没有推送权限");
    const refused = await h.prepare({ recipients: [{ name: "张四", phone: ZHANG }, { name: "外人", phone: "13900000000" }, { name: "无号", phone: "" }],
      mode: "options", options: ["只有一个"], deadline: "2026-11-03 09:05" }).then(() => undefined, (error: unknown) => error as Error);
    expect(refused).toBeInstanceOf(PushRefused);
    for (const reason of ["与「张四」不符", "不在机器人同步的通讯录范围内", "缺少手机号", "选项必须有 2 到 6 个", "至少要在 10 分钟之后"]) expect(refused!.message).toContain(reason);
    await expect(h.prepare({ deadline: "下周五" })).rejects.toThrow("无法识别");
    await expect(h.prepare({ deadline: "2026-12-31" })).rejects.toThrow("不能超过 30 天");
    await expect(h.prepare({ body: "长".repeat(PUSH_LIMITS.bodyChars + 1) })).rejects.toThrow("正文必须是");
    expect(h.sent).toEqual([]);
    const answer = await h.prepare({ deadline: "2026-11-05", cc: [{ name: "王五", phone: WANG }] });
    expect(answer).toContain("点「确认推送」才会发出");
    const id = h.pushId(answer);
    expect(h.sent.map(item => [item.to, item.message.msgType])).toEqual([[im(PUSHER), "card"]]);
    const preview = h.card(PUSHER);
    expect(preview.status.name).toBe("待确认");
    expect(preview.content).toContain("张三（尾号 0001）、李四（尾号 0002），共 2 人");
    expect(preview.content).toContain("王五（尾号 0003）");
    expect(preview.content).toContain("11-05 23:59");
    expect(preview.tailFields.map(button => button.name)).toEqual(["确认推送", "取消"]);
    expect(h.store.push(id)!.state).toBe("preview");
  } finally { await h.close(); }
});

test("confirm: only the pusher's click counts; cards go to every recipient; notes record the push for the recipients and the pusher", async () => {
  const h = harness();
  try {
    const id = h.pushId(await h.prepare());
    h.click(ZHANG, h.card(PUSHER), "确认推送", "preview-card");
    await h.settle();
    expect(h.cards(ZHANG)).toEqual([]);
    h.click(PUSHER, h.card(PUSHER), "确认推送", "preview-card");
    await h.settle();
    expect(h.store.push(id)!.state).toBe("open");
    expect(h.card(ZHANG).status.name).toBe("待确认");
    expect(h.card(ZHANG).tailFields.map(button => button.name)).toEqual(["已收到"]);
    expect(h.card(LI).title).toBe("推送：机房盘点");
    // The preview card is updated in place (its ID came with the click) and shows the outcome.
    const preview = h.card(PUSHER);
    expect([preview.msgUid, preview.status.name]).toEqual(["preview-card", "已发出"]);
    expect(preview.content).toContain("已发出 2 人");
    // A second confirmation (an old card version) sends nothing more.
    h.click(PUSHER, h.cards(PUSHER)[0]!, "确认推送", "preview-card");
    await h.settle();
    expect(h.cards(ZHANG).length).toBe(1);
    // One note per conversation, written as a user message the model reads as a record.
    const noteTexts = h.notes.map(note => [note.phone, note.entry.kind, (note.entry.model![0] as { role: string }).role,
      (note.entry.model![0] as { content: { text: string }[] }).content[0]!.text]);
    expect(noteTexts.map(([phone, kind, role]) => [phone, kind, role]).sort()).toEqual([[LI, "mixin.push-note", "user"], [PUSHER, "mixin.push-note", "user"],
      [ZHANG, "mixin.push-note", "user"]].sort());
    expect(noteTexts.find(note => note[0] === ZHANG)![3]).toMatch(/^\[推送\] 推送人 11-03 09:00 推送「机房盘点」：请回复本周机房盘点结果。；要求：确认收到；截止 11-06 09:00。推送编号 [a-z0-9]{8}$/);
    expect(noteTexts.find(note => note[0] === PUSHER)![3]).toMatch(/^\[推送已发出\]「机房盘点」11-03 09:00 发出，共 2 人；要求：确认收到；截止 11-06 09:00。推送编号/);
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("ack: a click updates the card in place; a stale click only refreshes; all confirmed closes early and the summary goes to the pusher and the CC", async () => {
  const h = harness();
  try {
    const id = await confirmed(h, { cc: [{ name: "王五", phone: WANG }] });
    const first = h.card(ZHANG);
    h.click(ZHANG, first, "已收到", "card-zhang");
    await h.settle();
    const updated = h.card(ZHANG);
    expect([updated.msgUid, updated.status.name]).toEqual(["card-zhang", "已确认收到"]);
    const acked = h.store.recipient(id, ZHANG)!.ackedAt;
    h.clock.now += 60_000;
    h.click(ZHANG, first, "已收到", "card-zhang");
    await h.settle();
    expect(h.store.recipient(id, ZHANG)!.ackedAt).toBe(acked);
    expect(h.store.push(id)!.state).toBe("open");
    h.click(LI, h.card(LI), "已收到", "card-li");
    await h.settle();
    const push = h.store.push(id)!;
    expect([push.state, push.closeReason, push.summaryState, push.summaryDone]).toEqual(["closed", "complete", "sent", [PUSHER, WANG]]);
    expect(summaryOf(h).content).toContain("已全部答复");
    expect(summaryOf(h).tailFields).toEqual([]);
    expect(h.texts(WANG)[0]).toContain("推送人 推送的汇总抄送给你");
    expect(h.texts(WANG)[0]).toContain("已确认 2，未确认 0");
    expect(h.files(PUSHER)).toEqual([`推送汇总-机房盘点-${id}.zip`]);
    expect(h.files(WANG)).toEqual([`推送汇总-机房盘点-${id}.zip`]);
    const zip = join(fixture.root, `zip-${id}.zip`);
    await writeFile(zip, h.uploads[0]!.data);
    expect(readZip(zip).map(entry => entry.name)).toEqual([`推送汇总-机房盘点-${id}.xlsx`]);
    // The recipients' cards show the end; the pusher and the CC get summary notes.
    expect(h.card(ZHANG).invalid).toBe(true);
    expect(h.notes.filter(note => note.requestId === `push-note:summary:${id}`).map(note => note.phone).sort()).toEqual([PUSHER, WANG].sort());
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("reply: 回复 starts collecting; texts and attachments are recorded, not handed on; 已回复 submits; 修改回复 replaces it; /完成 submits", async () => {
  const h = harness();
  try {
    const id = await confirmed(h, { mode: "reply" });
    // Before 回复: a question, with a hint once (not again within 12 hours).
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "这个推送是什么意思？")).toBe(false);
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "还有一个问题")).toBe(false);
    await h.settle();
    expect(h.texts(ZHANG).filter(text => text.includes("推送待回复"))).toHaveLength(1);
    h.click(ZHANG, h.card(ZHANG), "回复", "card-zhang");
    await h.settle();
    expect(h.card(ZHANG).status.name).toBe("回复中");
    expect(h.texts(ZHANG).at(-1)).toContain("请发送「机房盘点」的回复内容");
    const text1 = h.reply(ZHANG);
    expect(h.service.directText(h.identity(ZHANG), text1, "A 机房正常")).toBe(true);
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "B 机房缺一台")).toBe(true);
    // A redelivered message is known and recorded once.
    expect(h.service.seen(text1.msgUid)).toBe(true);
    expect(h.service.directText(h.identity(ZHANG), text1, "A 机房正常")).toBe(true);
    const file = h.reply(ZHANG);
    expect(h.service.directAttachment(h.identity(ZHANG), file, { fileId: "f-1", kind: "file", name: "盘点.xlsx", size: 20 })).toBe(true);
    // Other commands keep their meaning while replying.
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "/stop")).toBe(false);
    await h.settle();
    expect(h.attached.map(each => [each.hold, each.attachment.name])).toEqual([[`push:${id}`, "盘点.xlsx"]]);
    expect(h.texts(ZHANG).filter(text => text.includes("已记入"))).toHaveLength(1);
    expect(h.card(ZHANG).content).toContain("已收到 文字 2 段，附件 1 个");
    h.click(ZHANG, h.card(ZHANG), "已回复", "card-zhang");
    await h.settle();
    expect(h.card(ZHANG).status.name).toBe("已回复");
    expect(h.card(ZHANG).content).toContain("已回复（文字 2 段，附件 1 个）");
    // 修改回复: a new revision; /完成 submits it and the replaced revision's attachment is released.
    h.click(ZHANG, h.card(ZHANG), "修改回复", "card-zhang");
    await h.settle();
    expect(h.card(ZHANG).status.name).toBe("修改中");
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "更正：B 机房已补齐")).toBe(true);
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "/完成")).toBe(true);
    await h.settle();
    expect(h.texts(ZHANG).at(-1)).toContain("已提交「机房盘点」的回复（文字 1 段）");
    expect(h.released).toEqual([{ phone: ZHANG, holder: `push:${id}`, ids: [`att-${file.msgUid}`] }]);
    expect(h.service.status(PUSHER, id)).toContain("张三（尾号 0001）：已回复：更正：B 机房已补齐");
    const notes = h.notes.filter(note => note.phone === ZHANG).map(note => (note.entry.model![0] as { content: { text: string }[] }).content[0]!.text);
    expect(notes.some(text => text.startsWith("[推送回复] 已回复 推送人 推送的「机房盘点」：A 机房正常 B 机房缺一台；附件：盘点.xlsx"))).toBe(true);
    expect(notes.some(text => text.startsWith("[推送回复] 已修改回复"))).toBe(true);
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("deadline: an open draft with content counts as replied, one without content does not; the package holds the replies; holds are released", async () => {
  const h = harness();
  try {
    const id = await confirmed(h, { mode: "reply", deadline: "2026-11-04 18:00", recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }, { name: "王五", phone: WANG }] });
    h.click(ZHANG, h.card(ZHANG), "回复", "card-zhang");
    h.click(LI, h.card(LI), "回复", "card-li");
    await h.settle();
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "张三的回复")).toBe(true);
    expect(h.service.directAttachment(h.identity(ZHANG), h.reply(ZHANG), { fileId: "f-2", kind: "image", name: "图片" })).toBe(true);
    await h.settle();
    // Idle with content: one reminder.
    h.clock.now += PUSH_LIMITS.idleReminderMs + 1000;
    h.service.tick();
    h.service.tick();
    await h.settle();
    expect(h.texts(ZHANG).filter(text => text.includes("还没有提交"))).toHaveLength(1);
    expect(h.texts(LI).filter(text => text.includes("还没有提交"))).toHaveLength(0);
    h.clock.now = new Date(2026, 10, 4, 18, 0, 1).getTime();
    h.service.tick();
    await h.settle();
    const push = h.store.push(id)!;
    expect([push.state, push.closeReason, push.summaryState]).toEqual(["closed", "deadline", "sent"]);
    expect([h.store.recipient(id, ZHANG)!.submitted, h.store.recipient(id, LI)!.submitted]).toEqual([1, 0]);
    expect(h.texts(ZHANG).at(-1)).toContain("按已回复提交");
    expect(summaryOf(h).content).toContain("未回复：李四、王五");
    const zip = join(fixture.root, `zip-${id}.zip`);
    await writeFile(zip, h.uploads.at(-1)!.data);
    const entries = readZip(zip);
    expect(entries.map(entry => entry.name)).toEqual([`推送汇总-机房盘点-${id}.xlsx`, "回复/001-张三-0001/01-图片", "回复/001-张三-0001/回复.txt"]);
    expect(entries[2]!.data.toString("utf8")).toContain("张三的回复");
    await h.settle();
    expect(h.store.push(id)!.released).toBe(true);
    expect(Object.values(h.records.get(ZHANG)!.attachments).filter(attachment => attachment.heldBy)).toEqual([]);
    // A click after the end only shows the end.
    h.click(LI, h.cards(LI)[0]!, "回复", "card-li");
    await h.settle();
    expect(h.card(LI).status.name).toBe("未回复");
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("one reply at a time: an empty draft switches to the other push; one with content refuses until ended; /取消 keeps the earlier submission", async () => {
  const h = harness();
  try {
    const a = await confirmed(h, { mode: "reply", subject: "甲", recipients: [{ name: "张三", phone: ZHANG }] });
    // Two recipients: a single one replying would complete the push and close it early.
    const b = await confirmed(h, { mode: "reply", subject: "乙", recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }] });
    h.click(ZHANG, h.card(ZHANG, a), "回复", "card-a");
    await h.settle();
    h.click(ZHANG, h.card(ZHANG, b), "回复", "card-b");
    await h.settle();
    expect([h.store.recipient(a, ZHANG)!.replyState, h.store.recipient(b, ZHANG)!.replyState]).toEqual(["none", "replying"]);
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "给乙的")).toBe(true);
    h.click(ZHANG, h.card(ZHANG, a), "回复", "card-a");
    await h.settle();
    expect(h.texts(ZHANG).at(-1)).toContain("你正在回复「乙」");
    expect(h.store.recipient(a, ZHANG)!.replyState).toBe("none");
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "/完成")).toBe(true);
    // Edit, then /取消: the submission stays.
    h.click(ZHANG, h.card(ZHANG, b), "修改回复", "card-b");
    await h.settle();
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "不要了")).toBe(true);
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "/取消")).toBe(true);
    await h.settle();
    expect(h.texts(ZHANG).at(-1)).toContain("之前提交的回复仍然有效");
    const recipient = h.store.recipient(b, ZHANG)!;
    expect([recipient.replyState, recipient.submitted]).toEqual(["submitted", 1]);
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "/完成")).toBe(true);
    await h.settle();
    expect(h.texts(ZHANG).at(-1)).toBe("当前没有回复中的推送。");
  } finally { await h.close(); }
});

test("card sends: a refused card is tried again after 1 and 5 minutes, then failed; an uncertain one counts as sent; failures stay out of completion", async () => {
  const h = harness();
  try {
    h.failing.when = item => item.message.msgType !== "card" ? undefined
      : item.to === im(LI) ? { status: "failed", reason: "HTTP 500" } : item.to === im(WANG) ? { status: "uncertain", reason: "timeout" } : undefined;
    const id = await confirmed(h, { recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }, { name: "王五", phone: WANG }] });
    expect(h.store.recipient(id, LI)!.sendState).toBe("failed");
    expect(h.store.recipient(id, WANG)!.sendState).toBe("uncertain");
    for (const wait of [60_000, 5 * 60_000]) {
      h.clock.now += wait;
      h.service.tick();
      await h.settle();
    }
    const li = h.store.recipient(id, LI)!;
    expect([li.sendState, li.sendAttempts, li.retryAt]).toEqual(["failed", 3, null]);
    expect(h.cards(LI)).toHaveLength(3);
    expect(h.card(PUSHER).content).toContain("已发出 2 人，失败 1 人");
    h.click(ZHANG, h.card(ZHANG), "已收到", "card-zhang");
    await h.settle();
    expect(h.store.push(id)!.state).toBe("open");
    h.click(WANG, h.card(WANG), "已收到", "card-wang");
    await h.settle();
    expect(h.store.push(id)!.closeReason).toBe("complete");
    expect(summaryOf(h).content).toContain("共 3 人（发送失败 1）；已确认 2，未确认 0");
    // The failed card's recipient has no answer: 「提醒未回复」 can reach them.
    expect(summaryOf(h).tailFields.map(button => button.name)).toEqual(["提醒未回复"]);
    expect(h.service.list({ group: "closed", before: null, limit: 10 }).pushes.map(push => push.counts))
      .toEqual([{ total: 3, groups: 0, delivered: 2, failed: 1, answered: 2, replying: 0 }]);
  } finally { await h.close(); }
});

test("the frequency limit counts confirmations within 24 hours, at prepare and again at confirm; an unconfirmed preview expires after a day", async () => {
  const h = harness({ dailyLimit: 1 });
  try {
    const first = h.pushId(await h.prepare());
    const second = h.pushId(await h.prepare());
    h.click(PUSHER, h.card(PUSHER, first), "确认推送", "preview-1");
    await h.settle();
    h.click(PUSHER, h.card(PUSHER, second), "确认推送", "preview-2");
    await h.settle();
    expect(h.store.push(second)!.state).toBe("preview");
    expect(h.texts(PUSHER).at(-1)).toContain("24 小时内最多推送 1 条");
    await expect(h.prepare()).rejects.toThrow("已达上限");
    h.clock.now += 24 * 3600_000 + 1;
    h.service.tick();
    await h.settle();
    expect(h.store.push(second)!.state).toBe("expired");
    expect(h.card(PUSHER, second).status.name).toBe("已失效");
    h.click(PUSHER, h.cards(PUSHER).find(each => each.content.includes(second) && each.status.name === "待确认")!, "确认推送", "preview-2");
    await h.settle();
    expect(h.store.push(second)!.state).toBe("expired");
    expect(h.pushId(await h.prepare())).toMatch(/^[a-z0-9]{8}$/);
  } finally { await h.close(); }
});

test("restart: a card left sending is uncertain and never resent; an attachment item left unregistered is matched by its message or marked failed", async () => {
  const h = harness();
  try {
    const id = await confirmed(h, { mode: "reply", recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }] });
    h.click(ZHANG, h.card(ZHANG), "回复", "card-zhang");
    await h.settle();
    h.store.updateRecipient(id, LI, { sendState: "sending" });
    // Two items whose registration did not finish: one the message service has, one it never got.
    const kept = h.store.addItem({ pushId: id, member: ZHANG, revision: 1, msgUid: "m-kept", kind: "file", text: null, attachment: null, name: "a.txt", size: 1, error: null, receivedAt: h.clock.now, sender: null, senderName: null })!;
    const lost = h.store.addItem({ pushId: id, member: ZHANG, revision: 1, msgUid: "m-lost", kind: "file", text: null, attachment: null, name: "b.txt", size: 1, error: null, receivedAt: h.clock.now, sender: null, senderName: null })!;
    h.records.set(ZHANG, { requests: {}, attachments: { "att-k": { id: "att-k", msgUid: "m-kept", receivedAt: 0, epoch: 0, fileId: "f", kind: "file", name: "a.txt",
      reply: h.reply(ZHANG), state: "ready", path: "x", at: 0, heldBy: `push:${id}` } } });
    const before = h.cards(LI).length;
    await h.restart();
    await h.settle();
    expect(h.store.recipient(id, LI)!.sendState).toBe("uncertain");
    expect(h.cards(LI).length).toBe(before);
    const items = new Map(h.store.items(id, ZHANG).map(item => [item.id, item]));
    expect([items.get(kept)!.attachment, items.get(lost)!.error]).toEqual(["att-k", "附件登记中断，请重新发送"]);
  } finally { await h.close(); }
});

/** The latest summary card the pusher got. */
const summaryOf = (h: Harness) => h.cards(PUSHER).filter(each => each.title.startsWith("推送汇总")).at(-1)!;
/** The latest preview card of a push (the summary card names its follow-up too). */
const previewOf = (h: Harness, id: string) => h.cards(PUSHER).filter(each => each.title.includes("预览") && each.content.includes(`推送编号 ${id}`)).at(-1)!;

// Departments: 技术部 (2) with 研发组 (4) below it, 财务部 (3) with its own 研发组 (5).
const TREE = { tops: { "2": "技术部", "3": "财务部" }, nodes: { "4": ["研发组", "2"], "5": ["研发组", "3"] } } as const;

test("department and everyone pushes: grants, names and paths, duplicates and near misses; the pusher is left out", async () => {
  const h = harness();
  try {
    await expect(h.prepare({ recipients: [], departments: [{ name: "技术部" }] })).rejects.toThrow("没有按部门推送的权限");
    await expect(h.prepare({ recipients: [], everyone: true })).rejects.toThrow("没有推送给全员的权限");
    h.grant({ department: { departments: ["2"] } });
    await expect(h.prepare({ recipients: [], departments: [{ name: "技术部" }] })).rejects.toThrow("还没有同步到部门信息");
    h.tree({ "2": [PUSHER, ZHANG], "4": [LI], "3": [WANG] });
    const refused = await h.prepare({ recipients: [], departments: [{ name: "财务部" }, { name: "研发组" }, { name: "研发" }] }).then(() => undefined, (error: unknown) => error as Error);
    for (const reason of ["部门「财务部」不在你可以推送的部门里（可以推送：技术部，含下级）", "有 2 个部门叫「研发组」，请用完整路径说明是哪一个：技术部/研发组；财务部/研发组",
      "找不到部门「研发」，是不是：技术部/研发组、财务部/研发组"]) expect(refused!.message).toContain(reason);
    await expect(h.prepare({ recipients: [], departments: [{ name: "财务部/研发组" }] })).rejects.toThrow("不在你可以推送的部门里");
    expect(h.sent).toEqual([]);
    // 技术部 with its sub-departments: 张三 and 李四, not the pusher.
    const id = h.pushId(await h.prepare({ recipients: [], departments: [{ name: "技术部" }] }));
    let preview = h.card(PUSHER, id).content;
    expect(preview).toContain("**对象**：部门 技术部（含下级）");
    expect(preview).toContain("**名单**：张三（尾号 0001）、李四（尾号 0002），共 2 人（按点「确认推送」时的通讯录展开，不含你自己）");
    expect(h.store.recipients(id).map(each => each.member)).toEqual([ZHANG, LI]);
    // Without sub-departments, by path, and a person on top (no duplicates).
    const narrow = h.pushId(await h.prepare({ recipients: [{ name: "张三", phone: ZHANG }], departments: [{ name: "技术部 / 研发组", children: false }, { name: "技术部", children: false }] }));
    preview = h.card(PUSHER, narrow).content;
    expect(preview).toContain("**对象**：部门 技术部/研发组（不含下级）；部门 技术部（不含下级）；个人 张三（尾号 0001），共 1 人");
    expect(h.store.recipients(narrow).map(each => each.member).sort()).toEqual([ZHANG, LI].sort());
    // Everyone: the whole synced address book but the pusher.
    h.grant({ all: true });
    const all = h.pushId(await h.prepare({ recipients: [], everyone: true }));
    expect(h.card(PUSHER, all).content).toContain("**对象**：全员（同步范围内的所有人）");
    expect(h.store.recipients(all).map(each => each.member).sort()).toEqual([ZHANG, LI, WANG].sort());
    // A department grant of "any" reaches every department.
    h.grant({ department: { any: true } });
    expect(h.pushId(await h.prepare({ recipients: [], departments: [{ name: "财务部" }] }))).toMatch(/^[a-z0-9]{8}$/);
    // A department with nobody to reach but the pusher.
    h.tree({ "2": [PUSHER], "3": [WANG] });
    await expect(h.prepare({ recipients: [], departments: [{ name: "技术部" }] })).rejects.toThrow("展开后没有可以接收的人（不含你自己）");
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("confirm expands the list again: joiners and leavers count; a lost grant or an empty list cancels with a message", async () => {
  const h = harness();
  try {
    h.grant({ department: { any: true }, all: true });
    h.tree({ "2": [ZHANG, LI], "3": [WANG] });
    const id = h.pushId(await h.prepare({ recipients: [], departments: [{ name: "技术部" }] }));
    h.tree({ "2": [ZHANG, WANG], "3": [LI] });
    h.click(PUSHER, h.card(PUSHER, id), "确认推送", "preview-1");
    await h.settle();
    expect(h.store.recipients(id).map(each => each.member).sort()).toEqual([ZHANG, WANG].sort());
    expect([h.cards(ZHANG).length, h.cards(WANG).length, h.cards(LI).length]).toEqual([1, 1, 0]);
    expect(h.card(PUSHER, id).content).toContain("已发出 2 人");
    // The grant was taken away before 确认推送.
    const lost = h.pushId(await h.prepare({ recipients: [], departments: [{ name: "财务部" }] }));
    h.grant({ department: { departments: ["2"] } });
    h.click(PUSHER, h.card(PUSHER, lost), "确认推送", "preview-2");
    await h.settle();
    expect(h.store.push(lost)!.state).toBe("cancelled");
    expect(h.card(PUSHER, lost).status.name).toBe("已取消");
    expect(h.texts(PUSHER).at(-1)).toContain("这条推送没有发出，已取消：部门「财务部」不在你可以推送的部门里");
    expect(h.cards(LI)).toHaveLength(0);
    // Everyone left 技术部/研发组, or the department itself is gone.
    h.tree({ "2": [ZHANG], "4": [LI] });
    const empty = h.pushId(await h.prepare({ recipients: [], departments: [{ name: "技术部/研发组" }] }));
    h.tree({ "2": [ZHANG], "4": [] });
    h.click(PUSHER, h.card(PUSHER, empty), "确认推送", "preview-3");
    await h.settle();
    expect(h.store.push(empty)!.state).toBe("cancelled");
    expect(h.texts(PUSHER).at(-1)).toContain("按现在的通讯录没有可以接收的人");
    h.tree({ "2": [ZHANG], "4": [LI] });
    const gone = h.pushId(await h.prepare({ recipients: [], departments: [{ name: "技术部/研发组" }] }));
    h.tree({ "2": [ZHANG] }, { nodes: {} });
    h.click(PUSHER, h.card(PUSHER, gone), "确认推送", "preview-4");
    await h.settle();
    expect(h.texts(PUSHER).at(-1)).toContain("部门「技术部/研发组」已不在同步的通讯录里");
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("large pushes: limits on people, departments and the expanded list; four cards at a time; the preview's progress is throttled", async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ phone: `1370000${String(index).padStart(4, "0")}`, name: `成员${String(index).padStart(2, "0")}`, imUserId: `im-1370000${String(index).padStart(4, "0")}` }));
  const h = harness({ limits: { people: 2, departments: 1, recipients: 30 }, people: many });
  try {
    h.grant({ department: { any: true }, all: true });
    h.tree({ "2": many.slice(0, 20).map(each => each.phone), "3": many.slice(20).map(each => each.phone) });
    await expect(h.prepare({ recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }, { name: "王五", phone: WANG }] })).rejects.toThrow("一次最多列出 2 个人");
    await expect(h.prepare({ recipients: [], departments: [{ name: "技术部" }, { name: "财务部" }] })).rejects.toThrow("一次最多列出 1 个部门");
    await expect(h.prepare({ recipients: [], everyone: true })).rejects.toThrow("一次最多推送 30 人，现在是 43 人");
    // 20 people in 技术部; every card send takes a second of the clock.
    h.gate.advanceMs = 1000;
    h.gate.delayMs = 2;
    const id = h.pushId(await h.prepare({ recipients: [], departments: [{ name: "技术部" }] }));
    expect(h.card(PUSHER, id).content).toContain("成员19（尾号 0019），共 20 人");
    h.click(PUSHER, h.card(PUSHER, id), "确认推送", "preview-1");
    for (let round = 0; round < 40 && h.store.push(id)!.state !== "open"; round++) await h.settle();
    expect(h.store.push(id)!.state).toBe("open");
    await h.settle();
    expect(h.gate.max).toBe(PUSH_LIMITS.concurrency);
    const updates = h.cards(PUSHER).filter(each => each.msgUid === "preview-1");
    // 20 seconds of sends: a refresh every 5 seconds at most, plus the confirmation and the end.
    expect(updates.length).toBeLessThanOrEqual(20 / 5 + 3);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.at(-1)!.content).toContain("已发出 20 人");
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("re-push of a live push: a new card for the chosen people without an answer, failed cards included; nothing for the rest", async () => {
  const h = harness();
  try {
    h.failing.when = item => item.message.msgType === "card" && item.to === im(WANG) ? { status: "failed", reason: "HTTP 500" } : undefined;
    const id = await confirmed(h, { recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }, { name: "王五", phone: WANG }] });
    h.click(ZHANG, h.card(ZHANG), "已收到", "card-zhang");
    h.click(LI, h.card(LI), "已收到", "card-li-1");
    await h.settle();
    // 李四's acknowledgement is taken back to have someone to remind who has a card.
    h.store.updateRecipient(id, LI, { ackedAt: null });
    h.failing.when = undefined;
    expect(await h.service.remind(id, [ZHANG])).toEqual({ resent: 0 });
    expect(await h.service.remind(id)).toEqual({ resent: 2 });
    await h.settle();
    expect([h.cards(ZHANG).length, h.cards(LI).length]).toEqual([2, 3]);
    // A new card message (no ID yet), then a click makes it the one updated.
    const fresh = h.cards(LI).at(-1)!;
    expect(fresh.msgUid).toBeUndefined();
    expect(h.store.recipient(id, WANG)!.sendState).toBe("sent");
    h.click(LI, fresh, "已收到", "card-li-2");
    await h.settle();
    expect([h.card(LI).msgUid, h.card(LI).status.name]).toEqual(["card-li-2", "已确认收到"]);
    // While a card is still to go, a second re-push skips it.
    h.store.updateRecipient(id, WANG, { sendState: "pending" });
    expect(await h.service.remind(id, [WANG])).toEqual({ resent: 0 });
    const cancelled = h.pushId(await h.prepare());
    h.click(PUSHER, h.card(PUSHER, cancelled), "取消", "preview-x");
    await h.settle();
    await expect(h.service.remind(cancelled)).rejects.toThrow("没有发出");
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

/** The push's deadline has come and the service has seen it. */
async function pastDeadline(h: Harness, id: string): Promise<void> {
  h.clock.now = h.store.push(id)!.deadline;
  h.service.tick();
  await h.settle();
}
const summaryCards = (h: Harness) => h.cards(PUSHER).filter(each => each.title.startsWith("推送汇总"));

test("summary: an archive whose send is uncertain counts as sent; nothing goes out again and the push is not failed", async () => {
  const h = harness();
  try {
    h.failing.when = item => item.message.msgType === "file" ? { status: "uncertain", reason: "gateway timeout" } : undefined;
    const id = await confirmed(h);
    await pastDeadline(h, id);
    h.clock.now += 3_600_000;
    h.service.tick();
    await h.settle();
    const push = h.store.push(id)!;
    expect([push.summaryState, push.summaryAttempts, push.summaryDone]).toEqual(["sent", 0, [PUSHER]]);
    expect(summaryCards(h)).toHaveLength(1);
    expect(h.files(PUSHER)).toHaveLength(1);
  } finally { await h.close(); }
});

test("summary: a retry sends only what did not go out, and a failure of one person holds nobody else back", async () => {
  const h = harness();
  try {
    h.failing.when = item => item.to === im(PUSHER) && item.message.msgType === "file" ? { status: "failed", reason: "HTTP 400" } : undefined;
    const id = await confirmed(h, { cc: [{ name: "王五", phone: WANG }] });
    await pastDeadline(h, id);
    let push = h.store.push(id)!;
    expect([push.summaryState, push.summaryAttempts]).toEqual(["pending", 1]);
    expect(push.summaryError).toContain("推送人：");
    expect(push.summaryError).toContain("HTTP 400");
    expect(h.texts(WANG)).toHaveLength(1);
    expect(h.files(WANG)).toHaveLength(1);
    expect(h.notes.filter(note => note.requestId === `push-note:summary:${id}`).map(note => note.phone)).toEqual([WANG]);
    delete h.failing.when;
    h.clock.now = push.summaryAt!;
    h.service.tick();
    await h.settle();
    push = h.store.push(id)!;
    expect([push.summaryState, push.summaryError, push.summaryDone]).toEqual(["sent", null, [WANG, PUSHER]]);
    expect(summaryCards(h)).toHaveLength(1);
    expect(h.files(PUSHER)).toHaveLength(2);
    expect(h.texts(WANG)).toHaveLength(1);
    expect(h.files(WANG)).toHaveLength(1);
  } finally { await h.close(); }
});

test("summary: a person who cannot be reached fails the push after the retries, the others got theirs once", async () => {
  const h = harness();
  try {
    h.failing.when = item => item.to === im(PUSHER) && item.message.msgType === "card" && (item.message.content as CardContent).title.startsWith("推送汇总")
      ? { status: "failed", reason: "HTTP 400" } : undefined;
    const id = await confirmed(h, { cc: [{ name: "王五", phone: WANG }] });
    await pastDeadline(h, id);
    for (let attempt = 0; attempt < PUSH_LIMITS.summaryRetryMs.length; attempt++) {
      h.clock.now = h.store.push(id)!.summaryAt!;
      h.service.tick();
      await h.settle();
    }
    const push = h.store.push(id)!;
    expect([push.summaryState, push.summaryAttempts, push.summaryDone]).toEqual(["failed", 4, [WANG]]);
    expect(summaryCards(h)).toHaveLength(4);
    expect(h.texts(WANG)).toHaveLength(1);
    expect(h.files(WANG)).toHaveLength(1);
  } finally { await h.close(); }
});

test("the pusher named as a CC gets the pusher's one summary", async () => {
  const h = harness();
  try {
    const pusher = { name: "推送人", phone: PUSHER }, id = await confirmed(h, { cc: [pusher, { name: "王五", phone: WANG }] });
    expect(h.store.push(id)!.cc.map(each => each.phone)).toEqual([WANG]);
    h.service.setCc(id, [pusher]);
    expect(h.store.push(id)!.cc).toEqual([]);
    await pastDeadline(h, id);
    expect(summaryCards(h)).toHaveLength(1);
    expect(h.files(PUSHER)).toHaveLength(1);
    expect(h.texts(PUSHER).some(text => text.includes("抄送给你"))).toBe(false);
  } finally { await h.close(); }
});

test("confirming: a given deadline that has passed cancels the push; a default one starts now", async () => {
  const h = harness();
  try {
    const late = h.pushId(await h.prepare({ deadline: "2026-11-03 09:15" }));
    h.clock.now += 3_600_000;
    h.click(PUSHER, h.card(PUSHER, late), "确认推送", `preview-${late}`);
    await h.settle();
    expect(h.store.push(late)!.state).toBe("cancelled");
    expect(h.texts(PUSHER).at(-1)).toContain("截止时间已经过了");
    expect(h.cards(ZHANG)).toEqual([]);
    const byDefault = h.pushId(await h.prepare());
    h.clock.now += 20 * 3_600_000;
    h.click(PUSHER, h.card(PUSHER, byDefault), "确认推送", `preview-${byDefault}`);
    await h.settle();
    expect(h.store.push(byDefault)!.deadline).toBe(h.clock.now + PUSH_LIMITS.defaultDeadlineMs);
    expect(h.card(PUSHER, byDefault).status.name).toBe("已发出");
  } finally { await h.close(); }
});

test("push_status says how each push ended", async () => {
  const h = harness();
  try {
    const line = (id: string) => h.service.status(PUSHER, id).split("\n")[0]!;
    const cancelled = h.pushId(await h.prepare({ subject: "甲" }));
    h.click(PUSHER, h.card(PUSHER, cancelled), "取消", "preview-cancelled");
    await h.settle();
    expect(line(cancelled)).toContain("「甲」已取消");
    const expired = h.pushId(await h.prepare({ subject: "乙" }));
    h.clock.now += PUSH_LIMITS.previewMs;
    h.service.tick();
    await h.settle();
    expect(line(expired)).toContain("「乙」已失效");
    const complete = await confirmed(h, { subject: "丙", recipients: [{ name: "张三", phone: ZHANG }] });
    h.click(ZHANG, h.card(ZHANG), "已收到", "card-complete");
    await h.settle();
    expect(line(complete)).toContain("「丙」已全部答复");
    const late = await confirmed(h, { subject: "丁" });
    await pastDeadline(h, late);
    expect(line(late)).toContain("「丁」已截止");
  } finally { await h.close(); }
});

test("restart: a console package an ended process left is removed, and nothing else directly under the temp directory", async () => {
  const h = harness();
  try {
    const tmp = join(h.root, "tmp"), left = join(tmp, "push-console-0123456789abcdef"), other = join(tmp, "direct");
    await mkdir(left, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(left, "part-1.zip"), "partial");
    await h.restart();
    await h.settle();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(other)).toBe(true);
  } finally { await h.close(); }
});

test("summary card: 「提醒未回复」 prepares one follow-up for the people without an answer; a void one allows another; CCs change until the summary", async () => {
  const h = harness();
  try {
    const id = await confirmed(h, { deadline: "2026-11-04 18:00", recipients: [{ name: "张三", phone: ZHANG }, { name: "李四", phone: LI }] });
    h.service.setCc(id, [{ name: "王五", phone: WANG }]);
    expect(() => h.service.setCc(id, [{ name: "外人", phone: "13900000000" }])).toThrow("不在机器人同步的通讯录范围内");
    h.click(ZHANG, h.card(ZHANG), "已收到", "card-zhang");
    await h.settle();
    await expect(h.service.remind(id, [ZHANG])).resolves.toEqual({ resent: 0 });
    h.clock.now = new Date(2026, 10, 4, 18, 0, 1).getTime();
    h.service.tick();
    await h.settle();
    expect(h.store.push(id)!.summaryState).toBe("sent");
    expect(() => h.service.setCc(id, [])).toThrow("不能再改抄送人");
    // The pusher gets a card, the CC text.
    let summary = summaryOf(h);
    expect(summary.content).toContain("推送「机房盘点」已截止");
    expect(summary.content).toContain("未确认：李四");
    expect(summary.tailFields.map(button => button.name)).toEqual(["提醒未回复"]);
    expect(h.texts(WANG)[0]).toContain("推送人 推送的汇总抄送给你");
    expect(h.cards(WANG)).toHaveLength(0);
    // Only the pusher's click counts.
    h.click(ZHANG, summary, "提醒未回复", "summary-1");
    await h.settle();
    expect(h.cards(PUSHER).filter(each => each.title.startsWith("补推送预览"))).toHaveLength(0);
    h.click(PUSHER, summary, "提醒未回复", "summary-1");
    await h.settle();
    const followUp = h.store.push(id)!.followUp!;
    let preview = previewOf(h, followUp);
    expect(preview.title).toBe("补推送预览：机房盘点");
    expect(preview.content).toContain(`**对象**：推送编号 ${id} 中没有答复的人：李四（尾号 0002），共 1 人`);
    expect(preview.content).toContain("王五（尾号 0003）");
    expect([summaryOf(h).msgUid, summaryOf(h).tailFields.length]).toEqual(["summary-1", 0]);
    expect(summaryOf(h).content).toContain(`已准备补推送（推送编号 ${followUp}）`);
    // The old button again, and the console, prepare nothing more.
    h.click(PUSHER, summary, "提醒未回复", "summary-1");
    await h.settle();
    await expect(h.service.remind(id)).rejects.toThrow("已经准备过补推送");
    expect(h.cards(PUSHER).filter(each => each.title.startsWith("补推送预览") && !each.msgUid)).toHaveLength(1);
    // Cancelled: the button is back; the next one is confirmed and the card says why it came again.
    h.click(PUSHER, preview, "取消", "follow-1");
    await h.settle();
    summary = summaryOf(h);
    expect(summary.tailFields.map(button => button.name)).toEqual(["提醒未回复"]);
    h.click(PUSHER, summary, "提醒未回复", "summary-1");
    await h.settle();
    const second = h.store.push(id)!.followUp!;
    expect(second).not.toBe(followUp);
    preview = previewOf(h, second);
    h.click(PUSHER, preview, "确认推送", "follow-2");
    await h.settle();
    expect(h.store.push(second)!.state).toBe("open");
    expect(h.card(LI, second).content).toContain("（补推送：之前的推送还没有收到你的答复）");
    expect(h.cards(ZHANG).filter(each => each.content.includes(second))).toHaveLength(0);
    expect(summaryOf(h).content).toContain(`已补推送给没有答复的人（推送编号 ${second}）`);
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("console: the list pages newest first by state; one push shows every recipient's state and reply; only ended pushes are deleted", async () => {
  const h = harness();
  try {
    const a = await confirmed(h, { mode: "reply", subject: "甲" });
    h.click(ZHANG, h.card(ZHANG, a), "回复", "card-zhang");
    await h.settle();
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "已盘点")).toBe(true);
    expect(h.service.directAttachment(h.identity(ZHANG), h.reply(ZHANG), { fileId: "f-1", kind: "file", name: "清单.xlsx", size: 20 })).toBe(true);
    await h.settle();
    h.click(ZHANG, h.card(ZHANG, a), "已回复", "card-zhang");
    h.clock.now += 1000;
    const b = h.pushId(await h.prepare({ subject: "乙" }));
    h.clock.now += 1000;
    const c = h.pushId(await h.prepare({ subject: "丙" }));
    h.click(PUSHER, h.card(PUSHER, c), "取消", "preview-c");
    await h.settle();
    const first = h.service.list({ group: null, before: null, limit: 2 });
    expect([first.pushes.map(push => push.id), first.more]).toEqual([[c, b], true]);
    const rest = h.service.list({ group: null, before: first.pushes.at(-1)!.createdAt, limit: 2 });
    expect([rest.pushes.map(push => push.id), rest.more]).toEqual([[a], false]);
    expect(h.service.list({ group: "live", before: null, limit: 10 }).pushes.map(push => [push.id, push.counts]))
      .toEqual([[a, { total: 2, groups: 0, delivered: 2, failed: 0, answered: 1, replying: 0 }]]);
    expect(h.service.list({ group: "void", before: null, limit: 10 }).pushes.map(push => push.id)).toEqual([c]);
    // Totals: only a went out, and it is still live; rates count closed pushes only.
    expect(first.totals).toEqual({ sent: 1, followUps: 0, live: 1, delivered: 0, acked: 0, replyDelivered: 0, replied: 0 });
    const detail = h.service.detail(a);
    expect([detail.push.subject, detail.push.target.people.length, detail.push.state]).toEqual(["甲", 2, "open"]);
    const zhang = detail.recipients.find(recipient => recipient.member === ZHANG)!, li = detail.recipients.find(recipient => recipient.member === LI)!;
    expect([zhang.answered, zhang.reply, zhang.replyState]).toEqual([true, { text: "已盘点", files: [{ name: "清单.xlsx", size: 20, kind: "file" }], senders: [] }, "submitted"]);
    expect([li.answered, li.reply, li.sendState]).toEqual([false, null, "sent"]);
    expect(() => h.service.detail("zzzzzzzz")).toThrow("推送不存在");
    // Live and preview pushes stay; a cancelled one goes.
    await expect(h.service.remove(a)).rejects.toThrow("还没有结束");
    await expect(h.service.remove(b)).rejects.toThrow("还没有结束");
    await h.service.remove(c);
    expect(h.store.push(c)).toBeUndefined();
    // At the deadline a closes: 张三 confirmed (回复) and replied, 李四 neither.
    h.clock.now = h.store.push(a)!.deadline + 1;
    h.service.tick();
    await h.settle();
    expect(h.service.list({ group: null, before: null, limit: 10 }).totals)
      .toEqual({ sent: 1, followUps: 0, live: 0, delivered: 2, acked: 1, replyDelivered: 2, replied: 1 });
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("console package: the workbook and replies with phones masked, of the push or one recipient; attachments stay packable after the summary released them", async () => {
  const h = harness();
  try {
    const id = await confirmed(h, { mode: "reply", deadline: "2026-11-04 18:00" });
    h.click(ZHANG, h.card(ZHANG), "回复", "card-zhang");
    await h.settle();
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "张三的回复")).toBe(true);
    expect(h.service.directAttachment(h.identity(ZHANG), h.reply(ZHANG), { fileId: "f-1", kind: "file", name: "清单.txt", size: 20 })).toBe(true);
    await h.settle();
    h.click(ZHANG, h.card(ZHANG), "已回复", "card-zhang");
    await h.settle();
    const unpack = async (member?: string) => {
      const pack = await h.service.package(id, member);
      try {
        const entries = readZip(pack.path);
        const workbook = join(fixture.root, `book-${++counter}.xlsx`);
        await writeFile(workbook, entries[0]!.data);
        const sheet = readZip(workbook).find(entry => entry.name === "xl/worksheets/sheet1.xml")!.data.toString("utf8");
        return { name: pack.name, entries: entries.map(entry => entry.name), sheet, texts: entries.filter(entry => entry.name.endsWith(".txt")).map(entry => entry.data.toString("utf8")) };
      } finally { await pack.done(); }
    };
    const all = await unpack();
    expect(all.name).toBe(`推送汇总-机房盘点-${id}.zip`);
    expect(all.entries).toEqual([`推送汇总-机房盘点-${id}.xlsx`, "回复/001-张三-0001/01-清单.txt", "回复/001-张三-0001/回复.txt"]);
    expect(all.sheet).toContain("138****0001");
    expect(all.sheet).toContain("138****0002");
    expect(all.sheet).not.toContain(ZHANG);
    expect(all.texts.find(text => text.startsWith("张三"))).toContain("张三（138****0001）的回复");
    const one = await unpack(LI);
    expect(one.name).toBe(`推送汇总-机房盘点-${id}-李四-0002.zip`);
    expect(one.sheet).toContain("138****0002");
    expect(one.sheet).not.toContain("138****0001");
    await expect(h.service.package(id, WANG)).rejects.toThrow("没有这个接收人");
    // The deadline: the summary goes out and the hold is released; the file is still where the item recorded it.
    h.clock.now = new Date(2026, 10, 4, 18, 0, 1).getTime();
    h.service.tick();
    await h.settle();
    expect(h.store.push(id)!.released).toBe(true);
    expect(h.store.items(id, ZHANG).find(item => item.kind === "file")!.path).toEndWith(".bin");
    expect((await unpack()).entries).toContain("回复/001-张三-0001/01-清单.txt");
    // Over: it may be deleted now; nothing of it remains.
    await h.service.remove(id);
    expect([h.store.push(id), h.store.recipients(id), h.store.items(id)]).toEqual([undefined, [], []]);
    await expect(h.service.package(id)).rejects.toThrow("推送不存在");
    const never = h.pushId(await h.prepare());
    await expect(h.service.package(never)).rejects.toThrow("没有发出");
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

const G1 = "1001", G2 = "1002";
/** The pusher with these grants, and 张三 as the admin who registers groups. */
const roles = (h: Harness, grants: Grants) => h.store.replaceRoles([{ phone: PUSHER, admin: false, pusher: true, grants, dailyLimit: null },
  { phone: ZHANG, admin: true, pusher: false, grants: {}, dailyLimit: null }], h.clock.now);

test("groups: known once someone @-mentions the bot; admins register them by name there, the console names, renames and disables; only registered groups take pushes", async () => {
  const h = harness();
  try {
    expect(h.groupText(G1, LI, "大家好")).toBe(false);
    expect(h.store.group(G1)).toMatchObject({ state: "seen", name: null, firstSeenAt: START, lastSeenAt: START });
    // Seen again within ten minutes: not written; after that the time moves on.
    h.clock.now += 60_000;
    h.groupText(G1, LI, "还在");
    expect(h.store.group(G1)!.lastSeenAt).toBe(START);
    h.clock.now += PUSH_LIMITS.groupSeenMs;
    h.groupText(G1, LI, "还在");
    expect(h.store.group(G1)!.lastSeenAt).toBe(h.clock.now);
    // /登记群: admins only, with a name.
    expect(h.groupText(G1, LI, "/登记群 销售一部")).toBe(true);
    roles(h, {});
    expect(h.groupText(G1, ZHANG, "/登记群")).toBe(true);
    expect(h.groupText(G1, ZHANG, "/登记群  销售一部 ")).toBe(true);
    await h.settle();
    expect(h.groupTexts(G1)).toEqual([expect.stringContaining("只有推送管理员可以登记群"), expect.stringContaining("请在指令后写上群名"),
      expect.stringContaining("已登记为 销售一部。")]);
    expect(h.store.group(G1)).toMatchObject({ state: "registered", name: "销售一部", registeredBy: ZHANG });
    // In a direct chat /登记群 only says where to send it.
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "/登记群 销售二部")).toBe(true);
    await h.settle();
    expect(h.texts(ZHANG).at(-1)).toContain("请在要登记的群里发送");
    // Another group may not take the name (spaces and case aside).
    h.groupText(G2, WANG, "你好");
    expect(h.groupText(G2, ZHANG, "/登记群 销售 一部")).toBe(true);
    await h.settle();
    expect(h.groupTexts(G2).at(-1)).toContain("已经用于另一个群");
    // The console: name a seen group, refuse unknown groups and taken or long names, disable (the name stays).
    expect(h.service.saveGroup(G2, { name: "客服群", state: "registered" })).toMatchObject({ name: "客服群", state: "registered", registeredBy: null });
    expect(() => h.service.saveGroup("9999", { name: "x", state: "registered" })).toThrow("没有这个群的记录");
    expect(() => h.service.saveGroup(G2, { name: "销售一部", state: "registered" })).toThrow("已经用于另一个群");
    expect(() => h.service.saveGroup(G2, { name: "长".repeat(31), state: "registered" })).toThrow("不能超过 30 个字");
    h.service.saveGroup(G2, { state: "disabled" });
    expect(h.service.groups().groups.map(group => [group.id, group.name, group.state, group.registeredByName]))
      .toEqual([[G1, "销售一部", "registered", "张三"], [G2, "客服群", "disabled", null]]);
    // push_prepare: the grant, no options, registered names only.
    await expect(h.prepare({ groups: [{ name: "销售一部" }] })).rejects.toThrow("没有推送到群的权限");
    roles(h, { group: true });
    await expect(h.prepare({ groups: [{ name: "销售一部" }], mode: "options", options: ["参加", "不参加"] })).rejects.toThrow("推送到群不支持选项");
    const refused = await h.prepare({ groups: [{ name: "客服群" }] }).then(() => undefined, (error: unknown) => error as Error);
    expect(refused!.message).toContain("没有登记名为「客服群」的群（已登记：销售一部）");
    expect(refused!.message).toContain("/登记群 群名");
    const id = h.pushId(await h.prepare({ recipients: [], groups: [{ name: " 销售一部 " }] }));
    expect(h.store.push(id)!.target.groups).toEqual([{ id: G1, name: "销售一部" }]);
    expect(h.card(PUSHER, id).content).toContain("**对象**：群 销售一部");
    // Disabled before 确认推送: nothing goes out.
    h.service.saveGroup(G1, { state: "disabled" });
    h.click(PUSHER, h.card(PUSHER, id), "确认推送", "preview-g");
    await h.settle();
    expect(h.store.push(id)!.state).toBe("cancelled");
    expect(h.texts(PUSHER).at(-1)).toContain("群「销售一部」已停用");
    expect(h.groupCards(G1)).toEqual([]);
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("group limits: none registered yet, too many groups, and a group counting as one recipient", async () => {
  const h = harness({ limits: { groups: 1, recipients: 1 } });
  try {
    roles(h, { group: true });
    h.groupText(G1, LI, "你好"); h.groupText(G2, LI, "你好");
    const none = await h.prepare({ groups: [{ name: "销售一部" }] }).then(() => undefined, (error: unknown) => error as Error);
    expect(none!.message).toContain("还没有登记任何群。");
    expect(none!.message).toContain("/登记群 群名");
    h.service.saveGroup(G1, { name: "销售一部", state: "registered" });
    h.service.saveGroup(G2, { name: "客服", state: "registered" });
    await expect(h.prepare({ groups: [{ name: "销售一部" }, { name: "客服" }] })).rejects.toThrow("一次最多列出 1 个群");
    await expect(h.prepare({ recipients: [{ name: "张三", phone: ZHANG }], groups: [{ name: "客服" }] }))
      .rejects.toThrow("一次最多推送 1 人，现在是 1 人、1 个群（一个群算一人）");
  } finally { await h.close(); }
});

test("group push: one card in the group; 已收到 counts every click; anyone starts the reply, each @ text is a reply with its sender, anyone submits; notes go to the members' group conversations", async () => {
  const h = harness();
  try {
    roles(h, { group: true });
    h.groupText(G1, WANG, "你好");
    h.service.saveGroup(G1, { name: "销售一部", state: "registered" });
    const id = await confirmed(h, { mode: "reply", recipients: [{ name: "张三", phone: ZHANG }], groups: [{ name: "销售一部" }] });
    expect(h.card(PUSHER, id).content).toContain("已发出 1 人、1 个群");
    const card = h.groupCards(G1).at(-1)!;
    expect(card.content).toContain("推送到本群");
    expect(card.content).toContain("群里只能回复文字");
    expect(card.tailFields.map(button => button.name)).toEqual(["已收到", "回复"]);
    // A member's group conversation learns of the push when the member next speaks there, once.
    const groupNotes = () => h.notes.filter(note => note.scope === `group:${G1}`)
      .map(note => [note.phone, note.requestId, (note.entry.model![0] as { content: { text: string }[] }).content[0]!.text] as const);
    expect(groupNotes()).toEqual([]);
    expect(h.groupText(G1, LI, "这是什么推送？")).toBe(false);
    expect(h.groupText(G1, LI, "再问一次")).toBe(false);
    await h.settle();
    expect(groupNotes()).toEqual([[LI, `push-note:card:${id}`,
      expect.stringMatching(/^\[推送\] 推送人 11-03 09:00 推送到本群「机房盘点」：.*需要回复（群里只能回复文字）.*再 @机器人 发送文字。推送编号/)]]);
    // 已收到: every click counts, also on an older card version; the clickers are not named.
    h.groupClick(G1, card, "已收到", "group-card", "clicker-1");
    h.groupClick(G1, card, "已收到", "group-card", "clicker-2");
    await h.settle();
    expect(h.store.recipient(id, `group:${G1}`)).toMatchObject({ clicks: 2, ackedAt: START, card: "group-card" });
    expect(h.groupCards(G1).at(-1)!.content).toContain("已收到：首次 11-03 09:00，共点击 2 次");
    // 回复 by anyone: the group replies; every @ text is recorded with its sender and gets a receipt.
    h.groupClick(G1, h.groupCards(G1).at(-1)!, "回复", "group-card");
    await h.settle();
    expect(h.groupCards(G1).at(-1)!.status.name).toBe("回复中");
    expect(h.groupTexts(G1).at(-1)).toContain("推送「机房盘点」回复中");
    const first = h.groupReply(G1, WANG);
    expect(h.groupText(G1, WANG, "第一组已盘点", first)).toBe(true);
    expect(h.groupText(G1, LI, "第二组缺一台")).toBe(true);
    expect(h.groupText(G1, WANG, "第一组已盘点", first)).toBe(true);
    expect(h.groupText(G1, LI, "/status")).toBe(false);
    await h.settle();
    expect(h.groupTexts(G1).filter(text => text.includes("已记为「机房盘点」的回复"))).toHaveLength(2);
    expect(h.groupCards(G1).at(-1)!.content).toContain("已收到 王五等 2 人，2 段文字");
    // A member's direct texts are not the group's reply.
    expect(h.service.directText(h.identity(WANG), h.reply(WANG), "单聊的问题")).toBe(false);
    expect(h.groupText(G1, ZHANG, "/完成")).toBe(true);
    await h.settle();
    expect(h.groupTexts(G1).at(-1)).toContain("已提交「机房盘点」的群回复（王五等 2 人，2 段文字）");
    expect(h.groupCards(G1).at(-1)!.status.name).toBe("已回复");
    expect(h.service.status(PUSHER, id)).toContain("群 销售一部：已回复：王五：第一组已盘点 李四：第二组缺一台");
    // Each sender's group conversation has only what they sent.
    const replies = groupNotes().filter(([, requestId]) => requestId.startsWith("push-note:reply:"));
    expect(replies.map(([phone]) => phone).sort()).toEqual([LI, WANG].sort());
    expect(replies.find(([phone]) => phone === WANG)![2]).toContain("其中你发的：第一组已盘点。");
    expect(replies.find(([phone]) => phone === WANG)![2]).not.toContain("第二组");
    // 张三 answers in the direct chat: everyone answered; the console sees the group's clicks and repliers.
    h.click(ZHANG, h.card(ZHANG), "回复", "card-zhang");
    await h.settle();
    expect(h.service.directText(h.identity(ZHANG), h.reply(ZHANG), "张三的回复")).toBe(true);
    h.click(ZHANG, h.card(ZHANG), "已回复", "card-zhang");
    await h.settle();
    expect(h.store.push(id)!.state).toBe("closed");
    expect(summaryOf(h).content).toContain("共 1 人、1 个群；已确认 2，已回复 2，未回复 0");
    expect(h.service.list({ group: "closed", before: null, limit: 10 }).pushes.map(push => push.counts))
      .toEqual([{ total: 2, groups: 1, delivered: 2, failed: 0, answered: 2, replying: 0 }]);
    const group = h.service.detail(id).recipients.find(recipient => recipient.member === `group:${G1}`)!;
    expect([group.name, group.clicks, group.reply!.senders]).toEqual(["销售一部", 2, ["王五", "李四"]]);
    expect(h.groupCards(G1).at(-1)!.invalid).toBe(true);
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});

test("group push: /取消 drops the group's draft; the deadline submits one with content; 提醒未回复 reaches a group still registered", async () => {
  const h = harness();
  try {
    roles(h, { group: true });
    for (const group of [G1, G2]) h.groupText(group, WANG, "你好");
    h.service.saveGroup(G1, { name: "销售一部", state: "registered" });
    h.service.saveGroup(G2, { name: "客服群", state: "registered" });
    const id = await confirmed(h, { mode: "reply", recipients: [], groups: [{ name: "销售一部" }, { name: "客服群" }], deadline: "2026-11-04 18:00" });
    for (const [group, cardId] of [[G1, "card-g1"], [G2, "card-g2"]] as const) h.groupClick(group, h.groupCards(group).at(-1)!, "回复", cardId);
    await h.settle();
    expect(h.groupText(G1, WANG, "先发一段")).toBe(true);
    expect(h.groupText(G1, LI, "/取消")).toBe(true);
    await h.settle();
    expect(h.groupTexts(G1).at(-1)).toContain("已放弃这次对「机房盘点」的群回复");
    expect(h.store.recipient(id, `group:${G1}`)!.replyState).toBe("none");
    expect(h.notes.find(note => note.scope === `group:${G1}` && note.requestId.startsWith("push-note:abandon:"))!.phone).toBe(WANG);
    expect(h.groupText(G2, LI, "客服群的回复")).toBe(true);
    // No idle reminder in a group; at the deadline the draft with content is submitted.
    h.clock.now += PUSH_LIMITS.idleReminderMs + 1000;
    h.service.tick();
    await h.settle();
    expect(h.groupTexts(G2).filter(text => text.includes("还没有提交"))).toEqual([]);
    h.clock.now = new Date(2026, 10, 4, 18, 0, 1).getTime();
    h.service.tick();
    await h.settle();
    expect(h.store.recipient(id, `group:${G2}`)!.submitted).toBe(1);
    expect(h.groupTexts(G2).at(-1)).toContain("群里已发送的内容（李四，1 段文字）按已回复提交");
    expect(summaryOf(h).content).toContain("未回复：群 销售一部");
    // 提醒未回复: the unanswered group, while it is registered.
    h.click(PUSHER, summaryOf(h), "提醒未回复", "summary-g");
    await h.settle();
    const followUp = h.store.push(id)!.followUp!;
    expect(h.store.push(followUp)!.target.groups).toEqual([{ id: G1, name: "销售一部" }]);
    expect(previewOf(h, followUp).content).toContain(`**对象**：推送编号 ${id} 中没有答复的：群 销售一部`);
    expect(h.reports).toEqual([]);
  } finally { await h.close(); }
});
