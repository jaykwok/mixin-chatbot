// The console's push page (scripts/ops/console/push-page.ts) over the bot's real local control interface
// (src/server/http-app.ts `/_admin/push/*`) with a recording push service: masked people and their keys, the audit,
// refusals passed through, malformed requests refused by the bot, and the package download by a one-time ticket.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../../scripts/ops/console/audit.ts";
import { PushPage, servicePushSource } from "../../scripts/ops/console/push-page.ts";
import type { RouteContext } from "../../scripts/ops/console/routes.ts";
import { PushRefused, type PushAdmin, type PushDetail, type PushListItem } from "../../src/push/service.ts";
import { createApp } from "../../src/server/http-app.ts";
import { tempFixture } from "../helpers/temp.ts";

const ZHANG = "13800000001", LI = "13800000002", WANG = "13800000003", PUSHER = "13800000009";
const ITEM: PushListItem = { id: "abcd2345", subject: "机房盘点", mode: "reply", state: "open", pusher: PUSHER, pusherName: "推送人", createdAt: 1, confirmedAt: 2,
  deadline: 3, closedAt: null, closeReason: null, summaryState: null, followUp: null, of: null, counts: { total: 2, groups: 0, delivered: 2, failed: 0, answered: 1, replying: 0 } };
const TOTALS = { sent: 3, followUps: 1, live: 1, delivered: 4, acked: 3, replyDelivered: 2, replied: 1 };
const DETAIL: PushDetail = {
  push: { ...ITEM, body: "请回复", options: [], defaultDeadline: true, target: { people: [{ phone: ZHANG, name: "张三" }], departments: [{ id: "10", path: "技术部", children: true }],
    everyone: false }, cc: [{ phone: WANG, name: "王五" }], summaryError: null, summaryAt: null },
  recipients: [ZHANG, LI].map((member, index) => ({ member, name: index ? "李四" : "张三", sendState: "sent", sendError: null, sentAt: 2, ackedAt: index ? null : 2, clicks: 0,
    choice: null, choiceAt: null, replyState: index ? "none" : "submitted", submittedAt: index ? null : 3, answered: !index,
    reply: index ? null : { text: "已盘点", files: [{ name: "清单.xlsx", size: 20, kind: "file" }], senders: [] }, drafting: null })),
};

test("推送页：经本机控制接口读列表和详情，页面只见打码号码和随机键；补推送、抄送、删除按键找回号码并记审计；拒绝原样转达", async () => {
  const f = await tempFixture("console-push-page-");
  const calls: unknown[][] = [];
  let refuseDelete = false;
  const push = {
    list: query => { calls.push(["list", query]); return { pushes: [ITEM], more: false, totals: TOTALS }; },
    detail: id => { calls.push(["detail", id]); if (id !== ITEM.id) throw new PushRefused("推送不存在"); return DETAIL; },
    remind: async (id, members) => { calls.push(["remind", id, members]); return { resent: members?.length ?? 1 }; },
    setCc: (id, people) => { calls.push(["cc", id, people]); },
    remove: async id => { calls.push(["delete", id]); if (refuseDelete) throw new PushRefused("推送还没有结束，不能删除"); },
  } as Partial<PushAdmin> as PushAdmin;
  const service = createApp({ isStopping: () => false, adminToken: "push-token", shutdown: () => {}, push });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "push-token", instanceId: "i", pid: 1, startedAt: 1 }));
    const page = new PushPage(f.root, new AuditLog(join(f.root, "audit")));
    const routes = page.routes();
    const run = (route: string, body: unknown, session = "s") => routes[route]!.run({ body, signal: new AbortController().signal, session: { label: session } } as RouteContext);
    const list = await run("POST /api/push/list", { group: "live" }) as { pushes: { pusher: string }[]; totals: unknown };
    expect(list.pushes[0]!.pusher).toBe("推送人 · 138****0009");
    expect(list.totals).toEqual(TOTALS);
    expect(calls.at(-1)).toEqual(["list", { group: "live", before: null, limit: 50 }]);
    await expect(run("POST /api/push/list", { group: "other" })).rejects.toThrow("筛选无效");
    const detail = await run("POST /api/push/detail", { id: ITEM.id }) as { view: string; push: { target: string[]; cc: { key: string; phone: string }[] };
      recipients: { key: string; name: string; phone: string }[] };
    const text = JSON.stringify(detail);
    for (const phone of [ZHANG, LI, WANG, PUSHER]) expect(text).not.toContain(phone);
    expect(detail.push.target).toEqual(["部门 技术部（含下级）", "个人 张三 · 138****0001"]);
    expect(detail.recipients.map(each => [each.name, each.phone])).toEqual([["张三", "138****0001"], ["李四", "138****0002"]]);
    // A push the bot does not have: its refusal reaches the page.
    await expect(run("POST /api/push/detail", { id: "zzzzzzzz" })).rejects.toMatchObject({ status: 409, message: "推送不存在" });
    // 补推送 by keys of this view only, and only for this login.
    const li = detail.recipients[1]!.key;
    expect(await run("POST /api/push/remind", { view: detail.view, id: ITEM.id, people: [li] })).toMatchObject({ resent: 1 });
    expect(calls.at(-1)).toEqual(["remind", ITEM.id, [LI]]);
    await expect(run("POST /api/push/remind", { view: detail.view, id: ITEM.id, people: ["nope"] })).rejects.toThrow("名单已过期");
    await expect(run("POST /api/push/remind", { view: detail.view, id: ITEM.id }, "other")).rejects.toMatchObject({ status: 410 });
    await run("POST /api/push/remind", { view: detail.view, id: ITEM.id });
    expect(calls.at(-1)).toEqual(["remind", ITEM.id, undefined]);
    // CCs: the one kept by key, a new one by the number typed in.
    await run("POST /api/push/cc", { view: detail.view, id: ITEM.id, cc: [{ key: detail.push.cc[0]!.key }, { phone: "139 0000 0004", name: "赵六" }] });
    expect(calls.find(call => call[0] === "cc")).toEqual(["cc", ITEM.id, [{ phone: WANG, name: "王五" }, { phone: "13900000004", name: "赵六" }]]);
    await run("POST /api/push/delete", { id: ITEM.id });
    refuseDelete = true;
    await expect(run("POST /api/push/delete", { id: ITEM.id })).rejects.toMatchObject({ status: 409, message: "推送还没有结束，不能删除" });
    const audit = readdirSync(join(f.root, "audit")).map(name => readFileSync(join(f.root, "audit", name), "utf8")).join("");
    for (const action of ["push-view", "push-remind", "push-cc", "push-delete"]) expect(audit).toContain(`"action":"${action}"`);
    expect(audit).toContain(`"scope":"push:${ITEM.id},people:1"`);
    expect(audit).toContain(`"scope":"push:${ITEM.id},people:all"`);
    for (const phone of [ZHANG, LI, WANG, "13900000004"]) expect(audit).not.toContain(phone);
    // The bot refuses malformed requests itself.
    const source = servicePushSource(join(f.root, "data/state/instance.json"));
    await expect(source.call("remind", { id: ITEM.id, members: "all" })).rejects.toThrow("members 必须是");
    await expect(source.call("detail", { id: "../x" })).rejects.toThrow("推送编号无效");
    await expect(source.call("list", { limit: 1000 })).rejects.toThrow("limit 超出范围");
  } finally { await server.stop(true); await f.cleanup(); }
});

test("推送页下载：先领一次性票据，浏览器取到机器人打的包，结果记审计；用过或别的登录不能再用；打包失败说明原因", async () => {
  const f = await tempFixture("console-push-download-");
  const archive = join(f.root, "pack.zip"), data = Buffer.from("PK\u0003\u0004 a package");
  writeFileSync(archive, data);
  let done = 0, fail = false;
  const asked: unknown[] = [];
  const push = {
    detail: () => DETAIL,
    package: async (id, member) => {
      asked.push([id, member]);
      if (fail) throw new PushRefused("这条推送没有发出");
      return { path: archive, name: "x.zip", size: data.length, done: async () => { done++; } };
    },
  } as Partial<PushAdmin> as PushAdmin;
  const service = createApp({ isStopping: () => false, adminToken: "push-token", shutdown: () => {}, push });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "push-token", instanceId: "i", pid: 1, startedAt: 1 }));
    const page = new PushPage(f.root, new AuditLog(join(f.root, "audit")));
    const routes = page.routes();
    const run = (route: string, body: unknown) => routes[route]!.run({ body, signal: new AbortController().signal, session: { label: "s" } } as RouteContext);
    const detail = await run("POST /api/push/detail", { id: ITEM.id }) as { view: string; recipients: { key: string }[] };
    const whole = await run("POST /api/push/package", { view: detail.view, id: ITEM.id }) as { url: string; filename: string };
    expect(whole.filename).toBe(`推送汇总-机房盘点-${ITEM.id}.zip`);
    const ticket = whole.url.slice("/download/".length);
    const context = (label = "s") => ({ session: { label }, signal: new AbortController().signal });
    expect((await page.download(ticket, context("other"))).status).toBe(404);
    const response = await page.download(ticket, context());
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent(whole.filename));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(done).toBe(1);
    expect((await page.download(ticket, context())).status).toBe(404);
    // One recipient's package: the bot gets the phone behind the key.
    const one = await run("POST /api/push/package", { view: detail.view, id: ITEM.id, person: detail.recipients[1]!.key }) as { url: string; filename: string };
    expect(one.filename).toBe(`推送汇总-机房盘点-${ITEM.id}-李四-0002.zip`);
    fail = true;
    const refused = await page.download(one.url.slice("/download/".length), context());
    expect([refused.status, await refused.text()]).toEqual([409, "汇总包没有生成：这条推送没有发出"]);
    expect(asked).toEqual([[ITEM.id, undefined], [ITEM.id, LI]]);
    const audit = readdirSync(join(f.root, "audit")).map(name => readFileSync(join(f.root, "audit", name), "utf8")).join("");
    expect(audit.match(/"action":"export-request"/g)).toHaveLength(2);
    expect(audit).toContain(`"action":"export-sent"`);
    expect(audit).toContain(`"bytes":${data.length}`);
    expect(audit).toContain(`"action":"export-failed"`);
    expect(audit).toContain(`"scope":"push:${ITEM.id},member:138****0002"`);
    expect(audit).not.toContain(LI);
  } finally { await server.stop(true); await f.cleanup(); }
});

test("推送页的群：群名单按随机键登记、改名和停用并记审计，拒绝原样转达；接收人里的群按群名列出，补推送和下载按键找回群", async () => {
  const f = await tempFixture("console-push-groups-");
  const G1 = "1001", G2 = "1002";
  const groups = [
    { id: G1, name: "销售一部", state: "registered", firstSeenAt: 1, lastSeenAt: 5, registeredAt: 2, registeredBy: ZHANG, registeredByName: "张三" },
    { id: G2, name: null, state: "seen", firstSeenAt: 3, lastSeenAt: 4, registeredAt: null, registeredBy: null, registeredByName: null },
  ];
  const detail: PushDetail = {
    push: { ...DETAIL.push, counts: { ...ITEM.counts, groups: 1 }, target: { people: [{ phone: ZHANG, name: "张三" }], departments: [], everyone: false,
      groups: [{ id: G1, name: "销售一部" }] } },
    recipients: [DETAIL.recipients[0]!, { ...DETAIL.recipients[1]!, member: `group:${G1}`, name: "销售一部", ackedAt: 4, clicks: 3, answered: false,
      reply: { text: "王五：第一组已盘点", files: [], senders: ["王五"] } }],
  };
  const calls: unknown[][] = [];
  const push = {
    detail: () => detail,
    remind: async (id, members) => { calls.push(["remind", id, members]); return { resent: 1 }; },
    package: async (id, member) => { calls.push(["package", id, member]); throw new PushRefused("x"); },
    groups: () => ({ groups, steps: "登记方法：……" }),
    saveGroup: (id, change) => {
      calls.push(["group", id, change]);
      if (change.name === "销售一部" && id !== G1) throw new PushRefused("群名「销售一部」已经用于另一个群，请换一个");
      const group = groups.find(each => each.id === id)!;
      Object.assign(group, { state: change.state, ...(change.name ? { name: change.name } : {}), registeredAt: group.registeredAt ?? 9 });
      return group;
    },
  } as Partial<PushAdmin> as PushAdmin;
  const service = createApp({ isStopping: () => false, adminToken: "push-token", shutdown: () => {}, push });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/instance.json"), JSON.stringify({ port: server.port, token: "push-token", instanceId: "i", pid: 1, startedAt: 1 }));
    const page = new PushPage(f.root, new AuditLog(join(f.root, "audit")));
    const routes = page.routes();
    const run = (route: string, body: unknown, session = "s") => routes[route]!.run({ body, signal: new AbortController().signal, session: { label: session } } as RouteContext);
    type List = { view: string; steps: string; groups: { key: string; name: string | null; state: string; registeredBy: string | null }[] };
    const list = await run("POST /api/push/groups", {}) as List;
    expect(list.groups.map(group => [group.name, group.state, group.registeredBy])).toEqual([["销售一部", "registered", "张三 · 138****0001"], [null, "seen", null]]);
    expect(list.steps).toBe("登记方法：……");
    for (const id of [G1, G2, ZHANG]) expect(JSON.stringify(list)).not.toContain(`"${id}"`);
    // Registering the second one under a name in use: the bot's refusal reaches the page and the view stays usable.
    await expect(run("POST /api/push/group", { view: list.view, key: list.groups[1]!.key, name: "销售一部", state: "registered" }))
      .rejects.toMatchObject({ status: 409, message: "群名「销售一部」已经用于另一个群，请换一个" });
    const after = await run("POST /api/push/group", { view: list.view, key: list.groups[1]!.key, name: "客服", state: "registered" }) as List;
    expect(after.groups.map(group => [group.name, group.state, group.registeredBy])).toEqual([["销售一部", "registered", "张三 · 138****0001"], ["客服", "registered", "控制台"]]);
    // The list read before is spent; another login cannot use this one.
    await expect(run("POST /api/push/group", { view: list.view, key: list.groups[0]!.key, state: "disabled" })).rejects.toMatchObject({ status: 410 });
    await expect(run("POST /api/push/group", { view: after.view, key: after.groups[0]!.key, state: "disabled" }, "other")).rejects.toMatchObject({ status: 410 });
    await expect(run("POST /api/push/group", { view: after.view, key: after.groups[0]!.key, state: "gone" })).rejects.toThrow("群的状态无效");
    await run("POST /api/push/group", { view: after.view, key: after.groups[0]!.key, state: "disabled" });
    expect(calls.filter(call => call[0] === "group")).toEqual([["group", G2, { state: "registered", name: "销售一部" }], ["group", G2, { state: "registered", name: "客服" }],
      ["group", G1, { state: "disabled" }]]);
    // The bot checks the group itself.
    const source = servicePushSource(join(f.root, "data/state/instance.json"));
    await expect(source.call("group", { id: "abc", state: "registered" })).rejects.toThrow();
    await expect(source.call("group", { id: G1, state: "registered", extra: 1 })).rejects.toThrow("群设置含未知项");
    // A group among the recipients: by name, "群" for the number; its key brings the group back for 补推送 and 下载.
    const shown = await run("POST /api/push/detail", { id: ITEM.id }) as { view: string; push: { target: string[] };
      recipients: { key: string; name: string; phone: string; group: boolean; clicks: number; reply: { senders: string[] } | null }[] };
    expect(shown.push.target).toEqual(["个人 张三 · 138****0001", "群 销售一部"]);
    expect(shown.recipients.map(each => [each.name, each.phone, each.group, each.clicks])).toEqual([["张三", "138****0001", false, 0], ["销售一部", "群", true, 3]]);
    expect(shown.recipients[1]!.reply?.senders).toEqual(["王五"]);
    expect(JSON.stringify(shown)).not.toContain(G1);
    await run("POST /api/push/remind", { view: shown.view, id: ITEM.id, people: [shown.recipients[1]!.key] });
    expect(calls.at(-1)).toEqual(["remind", ITEM.id, [`group:${G1}`]]);
    const ticket = await run("POST /api/push/package", { view: shown.view, id: ITEM.id, person: shown.recipients[1]!.key }) as { url: string; filename: string };
    expect(ticket.filename).toBe(`推送汇总-机房盘点-${ITEM.id}-群-销售一部.zip`);
    await page.download(ticket.url.slice("/download/".length), { session: { label: "s" }, signal: new AbortController().signal });
    expect(calls.at(-1)).toEqual(["package", ITEM.id, `group:${G1}`]);
    const audit = readdirSync(join(f.root, "audit")).map(name => readFileSync(join(f.root, "audit", name), "utf8")).join("");
    expect(audit).toContain(`"action":"push-group","session":"s","scope":"group:${G2},state:registered"`);
    expect(audit).toContain(`"scope":"group:${G1},state:disabled"`);
    expect(audit).toContain(`"scope":"push:${ITEM.id},group:${G1}"`);
    expect(audit).not.toContain("客服");
  } finally { await server.stop(true); await f.cleanup(); }
});
