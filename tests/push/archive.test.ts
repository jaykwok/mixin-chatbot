// The push summary's archives (src/push/zip.ts, xlsx.ts, summary.ts): every archive reads back strictly (tests/helpers/
// zip-reader.ts), the workbook carries the rows, and a package splits into parts no larger than one send may carry.
import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipWriter } from "../../src/push/zip.ts";
import { writeWorkbook } from "../../src/push/xlsx.ts";
import { buildSummary, type HeldFile } from "../../src/push/summary.ts";
import type { Push, Recipient, ReplyItem } from "../../src/push/store.ts";
import { readZip } from "../helpers/zip-reader.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("push-archive-");
afterAll(() => fixture.cleanup());
let counter = 0;
const dir = async () => { const path = join(fixture.root, `case-${++counter}`); await mkdir(path, { recursive: true }); return path; };

test("entries read back exactly: deflated when smaller, stored otherwise, files copied in chunks, UTF-8 names", async () => {
  const root = await dir();
  const big = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
  await writeFile(join(root, "big.bin"), big);
  const zip = await ZipWriter.create(join(root, "a.zip"));
  const text = new TextEncoder().encode("回复内容 ".repeat(200));
  const random = crypto.getRandomValues(new Uint8Array(4096));
  await zip.addBuffer("回复/001-张三-0001/回复.txt", text);
  await zip.addBuffer("random.bin", random);
  await zip.addFile("回复/001-张三-0001/01-big.bin", join(root, "big.bin"));
  await zip.addBuffer("empty.txt", new Uint8Array());
  await zip.close();
  const entries = readZip(join(root, "a.zip"));
  expect(entries.map(entry => [entry.name, entry.method, entry.flags & 0x0800])).toEqual([
    ["回复/001-张三-0001/回复.txt", 8, 0x0800], ["random.bin", 0, 0x0800], ["回复/001-张三-0001/01-big.bin", 0, 0x0800], ["empty.txt", 0, 0x0800]]);
  expect(Buffer.from(entries[0]!.data).equals(Buffer.from(text))).toBe(true);
  expect(entries[0]!.compressed).toBeLessThan(text.length);
  expect(Buffer.from(entries[1]!.data).equals(Buffer.from(random))).toBe(true);
  expect(entries[2]!.data.equals(big)).toBe(true);
});

test("names that would escape or repeat (in any case) are refused", async () => {
  const root = await dir();
  const zip = await ZipWriter.create(join(root, "b.zip"));
  await zip.addBuffer("a/Report.txt", new Uint8Array([1]));
  for (const name of ["a/report.TXT", "../x", "/abs", "a//b", "a/./b", ""]) {
    await expect(zip.addBuffer(name, new Uint8Array([1]))).rejects.toThrow();
  }
  await zip.close();
  expect(readZip(join(root, "b.zip")).map(entry => entry.name)).toEqual(["a/Report.txt"]);
});

test("the workbook: the parts a spreadsheet needs, a frozen bold header, escaped text and dropped control characters", async () => {
  const root = await dir();
  await writeWorkbook(join(root, "w.xlsx"), { name: "汇总/1", columns: [{ title: "姓名", width: 12 }, { title: "回复", width: 40 }],
    rows: [["张三", "a < b & \"c\"\u0001\u000b ok\n第二行"], ["李四", null], ["王五", 42]] });
  const entries = new Map(readZip(join(root, "w.xlsx")).map(entry => [entry.name, entry.data.toString("utf8")]));
  expect([...entries.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml",
    "xl/worksheets/sheet1.xml"]);
  const sheet = entries.get("xl/worksheets/sheet1.xml")!;
  expect(sheet).toContain('state="frozen"');
  expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">姓名</t></is></c>');
  expect(sheet).toContain("a &lt; b &amp; &quot;c&quot; ok\n第二行");
  expect(sheet).not.toMatch(/[\u0001\u000b]/);
  expect(sheet).toContain('<c r="B4" s="2"><v>42</v></c>');
  // The sheet name loses the characters Excel forbids.
  expect(entries.get("xl/workbook.xml")).toContain('<sheet name="汇总 1"');
});

function push(mode: Push["mode"], options: string[] = []): Push {
  return { id: "abcd2345", pusher: "13800000009", pusherName: "推送人", pusherIm: "im-9", subject: "机房盘点", body: "请回复", mode, options,
    deadline: 2_000_000_000_000, defaultDeadline: false, target: { people: [], departments: [], everyone: false }, cc: [], state: "closed", createdAt: 1, confirmedAt: 1,
    closedAt: 2, closeReason: "deadline", previewCard: null, previewVersion: 0, summaryState: "pending", summaryAttempts: 0, summaryAt: null,
    summaryError: null, summaryDone: [], summaryText: null, summaryCard: null, summaryVersion: 0, followUp: null, released: false };
}

function recipient(member: string, name: string, change: Partial<Recipient> = {}): Recipient {
  return { pushId: "abcd2345", member, name, receiveId: `im-${member}`, sendState: "sent", sendAttempts: 1, sendError: null, sentAt: 1, retryAt: null,
    card: null, version: 0, ackedAt: null, clicks: 0, choice: null, choiceAt: null, replyState: "none", draft: 0, submitted: 0, submittedAt: null, activityAt: null,
    remindedAt: null, hintedAt: null, ...change };
}

let itemId = 0;
function item(member: string, revision: number, change: Partial<ReplyItem>): ReplyItem {
  return { id: ++itemId, pushId: "abcd2345", member, revision, msgUid: `m-${itemId}`, kind: "text", text: null, attachment: null, name: null, size: null,
    error: null, receivedAt: 1, path: null, sender: null, senderName: null, ...change };
}

test("a reply summary: the submission in effect per person, its files, and why a file is not packed", async () => {
  const root = await dir();
  await writeFile(join(root, "plan.xlsx"), "PLAN");
  await writeFile(join(root, "photo.jpg"), "PHOTO");
  const files = new Map<string, HeldFile>([["att-1", { state: "ready", path: join(root, "plan.xlsx") }], ["att-2", { state: "ready", path: join(root, "gone.jpg") }],
    ["att-3", { state: "failed", error: "平台拒绝" }], ["att-old", { state: "ready", path: join(root, "photo.jpg") }]]);
  const recipients = [recipient("13800000001", "张三", { submitted: 2, submittedAt: 5, ackedAt: 3 }), recipient("13800000002", "李四"),
    recipient("13800000003", "王五", { sendState: "failed" })];
  const items = [
    item("13800000001", 1, { kind: "image", attachment: "att-old", name: "旧照片.jpg" }),
    item("13800000001", 2, { text: "第一段" }), item("13800000001", 2, { text: "第二段" }),
    item("13800000001", 2, { kind: "file", attachment: "att-1", name: "盘点.xlsx" }),
    item("13800000001", 2, { kind: "image", attachment: "att-2", name: "照片.jpg" }),
    item("13800000001", 2, { kind: "file", attachment: "att-3", name: "坏.pdf" }),
  ];
  const out = join(root, "out"); await mkdir(out);
  const pack = await buildSummary({ push: push("reply"), recipients, items, files, dir: out, partBytes: 30 * 1024 * 1024, now: 10 });
  expect(pack.parts.map(part => part.name)).toEqual(["推送汇总-机房盘点-abcd2345.zip"]);
  expect(pack.missingFiles).toBe(2);
  const entries = readZip(pack.parts[0]!.path);
  expect(entries.map(entry => entry.name)).toEqual(["推送汇总-机房盘点-abcd2345.xlsx", "回复/001-张三-0001/01-盘点.xlsx", "回复/001-张三-0001/回复.txt"]);
  expect(entries[1]!.data.toString()).toBe("PLAN");
  const note = entries[2]!.data.toString("utf8");
  expect(note).toContain("第一段\n\n第二段");
  expect(note).toContain("照片.jpg：未打包，文件已被临时文件清理删除");
  expect(note).toContain("坏.pdf：未打包，下载失败：平台拒绝");
  // Revision 1 was replaced: its photo is not in the package.
  expect(note).not.toContain("旧照片");
  const sheet = readZip(join(out, "推送汇总-机房盘点-abcd2345.xlsx")).find(entry => entry.name === "xl/worksheets/sheet1.xml")!.data.toString("utf8");
  for (const text of ["回复文字", "张三", "第一段\n\n第二段", "李四", "王五", "发送失败"]) expect(sheet).toContain(text);
});

test("a package larger than one send splits into numbered parts within the limit; a file that alone cannot fit is listed", async () => {
  const root = await dir();
  const files = new Map<string, HeldFile>();
  const items: ReplyItem[] = [];
  const recipients: Recipient[] = [];
  for (let n = 1; n <= 4; n++) {
    const phone = `1380000000${n}`;
    await writeFile(join(root, `f${n}.bin`), Buffer.alloc(n === 4 ? 200_000 : 60_000, n));
    files.set(`att-${n}`, { state: "ready", path: join(root, `f${n}.bin`) });
    items.push(item(phone, 1, { kind: "file", attachment: `att-${n}`, name: `文件${n}.bin` }));
    recipients.push(recipient(phone, `成员${n}`, { submitted: 1, submittedAt: 5 }));
  }
  const out = join(root, "out"); await mkdir(out);
  const partBytes = 150_000;
  const pack = await buildSummary({ push: push("reply"), recipients, items, files, dir: out, partBytes, now: 10 });
  expect(pack.parts.length).toBeGreaterThan(1);
  expect(pack.parts.map(part => part.name)).toEqual(pack.parts.map((_, at) => `推送汇总-机房盘点-abcd2345-${at + 1}of${pack.parts.length}.zip`));
  for (const part of pack.parts) expect(part.size).toBeLessThanOrEqual(partBytes);
  const names = pack.parts.flatMap(part => readZip(part.path).map(entry => entry.name));
  expect(names[0]).toBe("推送汇总-机房盘点-abcd2345.xlsx");
  expect(names.filter(name => name.endsWith(".bin"))).toEqual(["回复/001-成员1-0001/01-文件1.bin", "回复/002-成员2-0002/01-文件2.bin", "回复/003-成员3-0003/01-文件3.bin"]);
  expect(pack.missingFiles).toBe(1);
  const note = pack.parts.flatMap(part => readZip(part.path)).find(entry => entry.name === "回复/004-成员4-0004/回复.txt")!.data.toString("utf8");
  expect(note).toContain("文件4.bin：未打包，195.3KB，超过单个文件的发送上限");
});

test("a group is one row: no phone, its clicks and who replied; its folder holds the texts with their senders", async () => {
  const root = await dir();
  const recipients = [recipient("13800000001", "张三", { submitted: 1, submittedAt: 5 }),
    recipient("group:1001", "销售一部", { receiveId: "1001", submitted: 2, submittedAt: 6, ackedAt: 3, clicks: 4 })];
  const items = [item("13800000001", 1, { text: "张三的回复" }), item("group:1001", 1, { text: "被替换的", sender: "13800000003", senderName: "王五" }),
    item("group:1001", 2, { text: "第一组已盘点", sender: "13800000003", senderName: "王五" }),
    item("group:1001", 2, { text: "第二组缺一台", sender: "13800000002", senderName: "李四" }),
    item("group:1001", 2, { text: "补充", sender: "13800000003", senderName: "王五" })];
  const out = join(root, "out"); await mkdir(out);
  const pack = await buildSummary({ push: push("reply"), recipients, items, files: new Map(), dir: out, partBytes: 1 << 20, now: 10 });
  const entries = readZip(pack.parts[0]!.path);
  expect(entries.map(entry => entry.name)).toEqual(["推送汇总-机房盘点-abcd2345.xlsx", "回复/001-张三-0001/回复.txt", "回复/002-销售一部/回复.txt"]);
  const note = entries[2]!.data.toString("utf8");
  expect(note).toStartWith("群「销售一部」的回复");
  expect(note).toContain("王五：第一组已盘点\n\n李四：第二组缺一台\n\n王五：补充");
  expect(note).not.toContain("被替换的");
  const sheet = readZip(join(out, "推送汇总-机房盘点-abcd2345.xlsx")).find(entry => entry.name === "xl/worksheets/sheet1.xml")!.data.toString("utf8");
  for (const text of ["姓名或群", "群里点击次数", "群里的回复人", "王五、李四", "<v>4</v>"]) expect(sheet).toContain(text);
  expect(sheet).toContain('<t xml:space="preserve">群</t>');
});

test("an aborted build stops at the copying", async () => {
  const root = await dir(), out = join(root, "out"); await mkdir(out);
  const reason = new Error("service closing");
  await expect(buildSummary({ push: push("ack"), recipients: [], items: [], files: new Map(), dir: out, partBytes: 1 << 20, now: 10, signal: AbortSignal.abort(reason) }))
    .rejects.toBe(reason);
});

test("ack and options summaries have their own columns and no reply folders", async () => {
  const root = await dir();
  const pack = await buildSummary({ push: push("options", ["参加", "不参加"]), dir: root, partBytes: 1 << 20, now: 10, files: new Map(), items: [],
    recipients: [recipient("13800000001", "张三", { choice: 1, choiceAt: 4, ackedAt: 4 }), recipient("13800000002", "李四")] });
  const entries = readZip(pack.parts[0]!.path);
  expect(entries.map(entry => entry.name)).toEqual(["推送汇总-机房盘点-abcd2345.xlsx"]);
  const sheet = readZip(join(root, "推送汇总-机房盘点-abcd2345.xlsx")).find(entry => entry.name === "xl/worksheets/sheet1.xml")!.data.toString("utf8");
  expect(sheet).toContain("选择时间");
  expect(sheet).toContain("不参加");
  expect(sheet).not.toContain("回复文字");
});
