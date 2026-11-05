/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:11012/" });
const { render } = await import("preact");
const { PushGroups } = await import("../../ui/console/src/push-groups.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
const button = (root: Element, text: string) => [...root.querySelectorAll("button")].find(value => value.textContent === text);
const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };

const group = (key: string, name: string | null, state: string, extra: Record<string, unknown> = {}) => ({ key, name, state, firstSeenAt: 1, lastSeenAt: 2,
  registeredAt: state === "seen" ? null : 3, registeredBy: state === "seen" ? null : "张三 · 138****0001", ...extra });

test("群名单：读取后按群名登记、改名、停用和重新启用，没写群名不能登记；服务的拒绝原样显示", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const sent: unknown[] = [];
  let groups = [group("g1", "销售一部", "registered"), group("g2", null, "seen"), group("g3", "旧群", "disabled")];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    // Components of earlier files in the same process may still finish; only this page's requests are answered.
    if (String(url) === "/api/push/groups") return Response.json({ view: "v1", groups, steps: "登记方法：在群里发送“@机器人 /登记群 群名”" });
    if (String(url) !== "/api/push/group") return new Response("{}");
    const body = JSON.parse(String(options!.body));
    sent.push(body);
    if (body.name === "销售一部") return Response.json({ code: "input", error: "群名「销售一部」已经用于另一个群，请换一个" }, { status: 409 });
    groups = groups.map(each => each.key !== body.key ? each : { ...each, state: body.state, ...(body.name ? { name: body.name } : {}) });
    return Response.json({ view: "v2", groups, steps: "登记方法：在群里发送“@机器人 /登记群 群名”" });
  }) as typeof fetch;
  try {
    render(<PushGroups />, root);
    button(root, "读取群名单")!.click();
    const names = () => [...root.querySelectorAll<HTMLInputElement>('input[aria-label="群名"]')];
    await until(() => names().length === 3);
    expect(names().map(input => input.value)).toEqual(["销售一部", "", "旧群"]);
    expect(root.textContent).toContain("登记方法：在群里发送");
    expect([...root.querySelectorAll(".chip")].map(chip => chip.textContent)).toEqual(["已登记", "未登记", "已停用"]);
    expect(root.textContent).toContain("张三 · 138****0001");
    // The unnamed one registers only once a name is written; a name in use is refused by the bot.
    expect(button(root, "登记")!.disabled).toBe(true);
    type(names()[1]!, "销售一部");
    await until(() => !button(root, "登记")!.disabled);
    button(root, "登记")!.click();
    await until(() => root.textContent!.includes("已经用于另一个群"));
    type(names()[1]!, " 客服 ");
    await until(() => !button(root, "登记")!.disabled);
    button(root, "登记")!.click();
    await until(() => root.textContent!.includes("已登记为 客服"));
    expect(sent.at(-1)).toEqual({ view: "v1", key: "g2", state: "registered", name: "客服" });
    // Rename the first (保存群名 shows only once the name differs), then disable it; enable the old one.
    expect(button(root, "保存群名")).toBeUndefined();
    type(names()[0]!, "销售1部");
    await until(() => !!button(root, "保存群名"));
    button(root, "保存群名")!.click();
    await until(() => root.textContent!.includes("群名已改为 销售1部"));
    expect(sent.at(-1)).toEqual({ view: "v2", key: "g1", state: "registered", name: "销售1部" });
    [...root.querySelectorAll("button")].find(each => each.textContent === "停用")!.click();
    await until(() => root.textContent!.includes("已停用：不能再推送到这个群"));
    expect(sent.at(-1)).toEqual({ view: "v2", key: "g1", state: "disabled" });
    [...root.querySelectorAll("button")].filter(each => each.textContent === "重新启用").at(-1)!.click();
    await until(() => root.textContent!.includes("已重新启用"));
    expect(sent.at(-1)).toEqual({ view: "v2", key: "g3", state: "registered" });
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
