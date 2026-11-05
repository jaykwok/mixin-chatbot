// Export file formats: JSON that stays valid wherever it stops, Markdown that message text cannot break out of, CSV cells
// a spreadsheet will not run, and file names and headers that survive any title.
import { expect, test } from "bun:test";
import {
  attachment, csvCell, csvRow, fenced, inline, isoLocal, jsonWriter, markdownWriter, personalMark, safeFileName, type ConversationHeader,
} from "../../scripts/ops/console/export-format.ts";
import type { EntryView } from "../../ui/console/src/contract.ts";

const AT = new Date(2026, 9, 27, 15, 30, 12, 345).getTime();
const header: ConversationHeader = {
  mode: "default", exportedAt: AT, space: "groups/100", title: "群 100", generation: "g", scope: "space", members: 1, truncatedMembers: false,
  since: null, until: null, fixedAt: AT, names: { state: "ok", observedAt: AT },
};
const member = { identity: { number: "A3", label: "张三（138****0001）", phone: "138****0001", name: "张三", nameState: "named", nameObservedAt: AT }, memberSince: AT, upperEntry: 9 };
const entry: EntryView = { id: 4, kind: "pi.user", at: AT, chars: 10, role: "user", parts: [{ type: "text", text: "```\n# 标题\n<b>x</b>" }], data: { internal: true } };
const reset: EntryView = { id: 5, kind: "pi.reset", at: null, chars: 10, head: 5, parts: [] };

test("JSON is a valid document when complete and wherever an export stops", () => {
  const complete = jsonWriter();
  const text = complete.header(header) + complete.member(member) + complete.entry(entry) + complete.entry(reset)
    + complete.memberEnd({ observedAt: AT, total: 0, items: [] }) + complete.end({ complete: true, endedAt: AT, members: 1, entries: 2 });
  const file = JSON.parse(text);
  expect(file).toMatchObject({ schemaVersion: 1, identityMode: "default", complete: true, counts: { members: 1, entries: 2 } });
  expect(file.exportedAt).toBe(isoLocal(AT));
  expect(file.members[0].member.nameObservedAt).toBe(isoLocal(AT));
  expect(file.members[0].entries.map((item: { id: number }) => item.id)).toEqual([4, 5]);
  // Internal entry data and stored sizes are not exported.
  expect(file.members[0].entries[0].data).toBeUndefined();
  expect(file.members[0].entries[0].chars).toBeUndefined();

  const stops = [
    (w = jsonWriter()) => w.header(header) + w.end({ complete: false, endedAt: AT, members: 0, entries: 0, error: "停了" }),
    (w = jsonWriter()) => w.header(header) + w.member(member) + w.end({ complete: false, endedAt: AT, members: 1, entries: 0, error: "停了" }),
    (w = jsonWriter()) => w.header(header) + w.member(member) + w.entry(entry) + w.end({ complete: false, endedAt: AT, members: 1, entries: 1, error: "停了" }),
    (w = jsonWriter()) => w.header(header) + w.member(member) + w.memberEnd(null) + w.member(member) + w.end({ complete: false, endedAt: AT, members: 2, entries: 0, error: "停了" }),
  ];
  for (const stop of stops) expect(JSON.parse(stop())).toMatchObject({ complete: false, error: "停了" });
  expect(JSON.parse(jsonWriter().header({ ...header, fixedAt: null }) + jsonWriter().end({ complete: false, endedAt: AT, members: 0, entries: 0 })).history.fixedAt).toBeNull();
});

test("Markdown fences outgrow any backtick run in the text, and inline text cannot start markup", () => {
  expect(fenced("plain")).toBe("```text\nplain\n```");
  expect(fenced("a ```` b")).toBe("`````text\na ```` b\n`````");
  expect(inline("# 标题\n*粗* [链接](x) <img> & |")).toBe("\\# 标题 \\*粗\\* \\[链接\\]\\(x\\) &lt;img&gt; &amp; \\|");

  const w = markdownWriter();
  const text = w.header(header) + w.member(member) + w.entry(entry) + w.entry(reset) + w.memberEnd(null) + w.end({ complete: true, endedAt: AT, members: 1, entries: 2 });
  expect(text).toContain("> **含个人信息 · 默认（姓名＋打码号码）**");
  expect(text).toContain("## 张三（138\\*\\*\\*\\*0001）");
  expect(text).toContain("````text\n```\n# 标题\n<b>x</b>\n````");
  expect(text).toContain("/clear：此后开始新的上下文");
  expect(text).toContain("<!-- mixin-console-export: complete; members=1; entries=2 -->");
  const stopped = markdownWriter().end({ complete: false, endedAt: AT, members: 0, entries: 0, error: "机器人<停了>" });
  expect(stopped).toContain("机器人&lt;停了&gt;");
  expect(stopped).toContain("<!-- mixin-console-export: incomplete -->");
});

test("Markdown run records tell sent from failed, retried, uncertain and given up, and never claim a message was read", () => {
  const delivery = (abandonedReason?: string) => ({
    kind: "reply", abandoned: abandonedReason !== undefined, ...(abandonedReason === undefined ? {} : { abandonedReason }),
    parts: [
      { id: "p1", kind: "markdown", state: "sent", attempts: 1, at: AT },
      { id: "p2", kind: "markdown", state: "failed", attempts: 1, retryAt: AT + 60_000, error: "平台|拒绝" },
      { id: "p3", kind: "file", state: "failed", attempts: 5 },
      { id: "p4", kind: "links", state: "uncertain", attempts: 1 },
    ],
  });
  const item = (abandonedReason?: string) => ({
    requestId: "r", createdAt: AT, closedAt: null, cancelled: false, summary: "", receivedAt: AT, sentAt: AT, entry: 4, answer: 6, status: "done",
    delivery: delivery(abandonedReason), files: [], deliverables: [],
  });
  const text = markdownWriter().memberEnd({ observedAt: AT, total: 3, items: [item(), item("withdrawn"), item("unknown")] });
  const rows = text.split("\n").filter(line => line.startsWith("| ") && line.includes("done"));
  expect(rows.length).toBe(3);
  expect(rows[0]).toContain("平台已接收；失败，计划 2026-10-27 15:31:12 重试（平台\\|拒绝）；失败，不再重试；结果不确定");
  expect(rows[0]).not.toContain("已放弃");
  expect(rows[1]).toContain("已放弃（/stop 或 /clear 撤回）；");
  expect(rows[2]).toContain("已放弃（原因未记录）；");
  expect(text).toContain("交付（没有平台已读证据）");
  expect(text).not.toContain("已读 ");
});

test("anonymous exports never call themselves anonymised; personal ones say so in the name and the header", () => {
  expect(personalMark("anonymous").banner).toContain("不是匿名化数据");
  expect(personalMark("anonymous").banner).not.toContain("已匿名化");
  expect(personalMark("default").file).toBe("含个人信息-默认身份");
  expect(personalMark("full").file).toBe("含个人信息-完整身份");
});

test("CSV cells are quoted, and text a spreadsheet would run gets a leading apostrophe", () => {
  expect(csvCell("张三")).toBe('"张三"');
  expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
  for (const formula of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(formula)).toBe(`"'${formula}"`);
  expect(csvCell(-3)).toBe('"-3"');
  expect(csvRow(["a", 1])).toBe('"a","1"\r\n');
});

test("file names drop characters Windows refuses; the header keeps the name in UTF-8 with an ASCII fallback", () => {
  expect(safeFileName('会话-群 a/b:c*?"<>|.json')).toBe("会话-群 a_b_c______.json");
  expect(attachment("会话 #1.json", "mixin.json")).toBe(`attachment; filename="mixin.json"; filename*=UTF-8''${encodeURIComponent("会话 #1.json")}`);
});
