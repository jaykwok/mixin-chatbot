/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { PushRecords } = await import("../../console/ui/src/push-records.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
const button = (root: Element, text: string) => [...root.querySelectorAll("button")].find(value => value.textContent === text)!;
const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };

const item = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ id, subject: `推送${id}`, mode: "reply", state, pusher: "推送人 · 138****0009", createdAt: 1,
  confirmedAt: 2, deadline: 3, closedAt: state === "closed" ? 4 : null, closeReason: state === "closed" ? "deadline" : null, summaryState: state === "closed" ? "sent" : null,
  of: null, followUp: null, counts: { total: 2, groups: 0, delivered: 2, failed: 0, answered: 1, replying: 0 }, ...extra });
const recipient = (key: string, name: string, answered: boolean) => ({ key, name, phone: `138****000${key.slice(-1)}`, group: false, sendState: "sent", sendError: null, sentAt: 2,
  ackedAt: answered ? 2 : null, clicks: 0, choice: null, choiceAt: null, replyState: answered ? "submitted" : "none", submittedAt: answered ? 3 : null, answered,
  reply: answered ? { text: "已盘点", files: [{ name: "清单.xlsx", size: 20, kind: "file" }], senders: [] } : null, drafting: null });
const detail = (id: string, state: string) => ({ view: `view-${id}`, push: { ...item(id, state), body: "请回复", options: [], defaultDeadline: true, target: ["部门 技术部（含下级）"],
  cc: [{ key: "cc1", name: "王五", phone: "138****0003" }], summaryError: null, summaryAt: state === "closed" ? 5 : null },
  recipients: [recipient("r1", "张三", true), recipient("r2", "李四", false)] });

test("推送记录：列表打开详情，按未答复筛选，补推送选中的人，修改抄送，下载汇总包，删除已截止的推送", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const calls: [string, unknown][] = [], clicked: string[] = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicked.push(this.getAttribute("href")!); };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    // Components of earlier files in the same process may still finish; only this page's requests are answered.
    if (!String(url).startsWith("/api/push/")) return new Response("{}");
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push([String(url), body]);
    switch (String(url)) {
      case "/api/push/list": return Response.json({ pushes: [item("aaaa2345", "open"), item("bbbb2345", "closed")], more: false,
        totals: { sent: 3, followUps: 1, live: 1, delivered: 4, acked: 3, replyDelivered: 2, replied: 1 } });
      case "/api/push/detail": case "/api/push/cc": return Response.json(detail(body.id, body.id === "aaaa2345" ? "open" : "closed"));
      case "/api/push/remind": return Response.json({ resent: body.people?.length ?? 1 });
      case "/api/push/package": return Response.json({ url: "/download/push-1", filename: "推送汇总.zip", expiresAt: Date.now() + 60_000 });
      default: return Response.json({ ok: true });
    }
  }) as typeof fetch;
  try {
    render(<PushRecords />, root);
    await until(() => root.textContent!.includes("推送aaaa2345"));
    expect(calls[0]).toEqual(["/api/push/list", { group: null }]);
    expect(root.textContent).toContain("已发出 3 条推送（含补推送 1 条，进行中 1 条）。已结束的推送按送达的人或群计：确认率 75%（3/4），回复率 50%（1/2）。");
    button(root, "查看").click();
    await until(() => root.textContent!.includes("已盘点"));
    expect(root.textContent).toContain("部门 技术部（含下级）");
    // Only 李四 is waiting; 补推送 the selection.
    [...root.querySelectorAll<HTMLButtonElement>('[aria-label="接收人筛选"] button')].find(each => each.textContent === "未答复")!.click();
    await until(() => !root.textContent!.includes("张三"));
    root.querySelector<HTMLInputElement>('input[aria-label="选择 李四"]')!.click();
    await until(() => !!button(root, "只给选中的 1 人"));
    button(root, "只给选中的 1 人").click();
    await until(() => root.textContent!.includes("已重新发出 1 张卡片"));
    expect(calls.find(call => call[0] === "/api/push/remind")![1]).toEqual({ view: "view-aaaa2345", id: "aaaa2345", people: ["r2"] });
    // CCs: keep 王五, add one by number.
    button(root, "修改").click();
    await until(() => !!root.querySelector('input[aria-label="抄送人手机号"]'));
    type(root.querySelector<HTMLInputElement>('input[aria-label="抄送人手机号"]')!, "139 0000 0004");
    type(root.querySelector<HTMLInputElement>('input[aria-label="抄送人姓名"]')!, "赵六");
    await until(() => !button(root, "加入").disabled);
    button(root, "加入").click();
    await until(() => root.textContent!.includes("赵六 · 13900000004"));
    button(root, "保存抄送").click();
    await until(() => root.textContent!.includes("抄送人已保存"));
    expect(calls.find(call => call[0] === "/api/push/cc")![1]).toEqual({ view: "view-aaaa2345", id: "aaaa2345", cc: [{ key: "cc1" }, { phone: "13900000004", name: "赵六" }] });
    button(root, "下载汇总包").click();
    await until(() => clicked.length === 1);
    expect(clicked).toEqual(["/download/push-1"]);
    expect(calls.find(call => call[0] === "/api/push/package")![1]).toEqual({ view: "view-aaaa2345", id: "aaaa2345" });
    // A live push cannot be deleted; a closed one asks once more.
    expect(button(root, "删除推送")).toBeUndefined();
    button(root, "收起").click();
    await until(() => !root.textContent!.includes("已盘点"));
    [...root.querySelectorAll("button")].filter(each => each.textContent === "查看")[1]!.click();
    await until(() => !!button(root, "删除推送"));
    button(root, "删除推送").click();
    await until(() => !!button(root, "确认删除"));
    const lists = () => calls.filter(call => call[0] === "/api/push/list").length, before = lists();
    button(root, "确认删除").click();
    await until(() => calls.some(call => call[0] === "/api/push/delete"));
    expect(calls.find(call => call[0] === "/api/push/delete")![1]).toEqual({ id: "bbbb2345" });
    // The list is read again (before the fetch stub goes).
    await until(() => lists() === before + 1);
    await until(() => !root.querySelector(".push-detail"));
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; HTMLAnchorElement.prototype.click = click; }
});

test("推送记录里的群：按群名列出，号码一栏写“群”，确认写首次时间和点击次数，人数和补推送按人和群分开说", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const counts = { total: 2, groups: 1, delivered: 2, failed: 0, answered: 1, replying: 0 };
  const group = { ...recipient("r2", "销售一部", false), phone: "群", group: true };
  const acked = { ...group, key: "r3", name: "客服", ackedAt: new Date(2026, 10, 3, 9, 30).getTime(), clicks: 3, answered: true };
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith("/api/push/")) return new Response("{}");
    if (String(url) === "/api/push/list") return Response.json({ pushes: [item("cccc2345", "open", { mode: "ack", counts })], more: false,
      totals: { sent: 1, followUps: 0, live: 1, delivered: 0, acked: 0, replyDelivered: 0, replied: 0 } });
    return Response.json({ view: "view-c", push: { ...item("cccc2345", "open", { mode: "ack", counts }), body: "请确认", options: [], defaultDeadline: false,
      target: ["个人 张三 · 138****0001", "群 销售一部、客服"], cc: [], summaryError: null, summaryAt: null },
      recipients: [{ ...recipient("r1", "张三", true), ackedAt: 2 }, group, acked] });
  }) as typeof fetch;
  try {
    render(<PushRecords />, root);
    await until(() => root.textContent!.includes("推送cccc2345"));
    // Nothing closed yet: no rates.
    expect(root.textContent).toContain("已发出 1 条推送（进行中 1 条）。");
    expect(root.textContent).not.toContain("确认率");
    button(root, "查看").click();
    await until(() => root.textContent!.includes("销售一部"));
    expect(root.textContent).toContain("群 销售一部、客服");
    expect(root.textContent).toContain("共 1 人、1 个群");
    expect([...root.querySelectorAll(".push-recipients th")].map(th => th.textContent)[1]).toBe("姓名或群");
    const rows = [...root.querySelectorAll(".push-recipients tbody tr")].map(row => [...row.querySelectorAll("td")].slice(1, 3).map(td => td.textContent));
    expect(rows).toEqual([["张三", "138****0001"], ["销售一部", "群"], ["客服", "群"]]);
    expect(root.textContent).toMatch(/已确认（首次 [^）]*09:30[^）]*，共点击 3 次）/);
    expect(button(root, "给没有答复的 1 个群重发卡片")).toBeDefined();
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
