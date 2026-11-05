/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:11012/" });
const { render } = await import("preact");
const { PushSettingsForm } = await import("../../ui/console/src/push.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
const button = (root: Element, text: string) => [...root.querySelectorAll("button")].find(value => value.textContent === text)!;
const type = (input: HTMLInputElement | HTMLSelectElement, value: string, event = "input") => {
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
};

const SETTINGS = {
  view: "v1",
  departments: [{ key: "d1", path: "技术部" }, { key: "d2", path: "技术部/研发组" }, { key: "d9", path: "已不在同步范围的部门", gone: true }],
  roles: [{ key: "p1", name: "张三", phone: "138****0001", admin: false, pusher: true, dailyLimit: null, grants: { all: false, group: true, department: ["d1", "d9"] }, updatedAt: 1 }],
};

test("推送设置的授权：全员勾选，部门可选不能/任意/指定，指定时按路径挑部门、至少一个；非推送人不带授权", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const saved: unknown[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    // Components of earlier files in the same process may still finish; only this page's requests are answered.
    if (!String(url).startsWith("/api/push/settings")) return new Response("{}");
    if (options?.method === "POST") saved.push(JSON.parse(String(options.body)));
    return Response.json(SETTINGS);
  }) as typeof fetch;
  try {
    render(<PushSettingsForm />, root);
    button(root, "读取名单").click();
    await until(() => root.textContent!.includes("张三"));
    const chips = () => [...root.querySelectorAll(".push-grant .chip")].map(chip => [chip.textContent!.replace("×", ""), chip.classList.contains("warn")]);
    expect(chips()).toEqual([["技术部", false], ["已不在同步范围的部门", true]]);
    // Swap 技术部 for 技术部/研发组, picked by its path; a path that is not a department adds nothing.
    root.querySelector<HTMLButtonElement>('.push-grant .chip button[aria-label="移除部门"]')!.click();
    await until(() => chips().length === 1);
    const picker = () => root.querySelector<HTMLInputElement>('input[aria-label="添加部门"]')!;
    type(picker(), "研发组");
    await Bun.sleep(20);
    expect(chips()).toHaveLength(1);
    type(picker(), "技术部/研发组");
    await until(() => chips().length === 2);
    expect(picker().value).toBe("");
    root.querySelector<HTMLInputElement>('input[aria-label="全员授权"]')!.click();
    // A new member: 指定部门 without a department blocks the save.
    type(root.querySelector<HTMLInputElement>('input[inputmode="tel"]')!, "139 0000 0004");
    await until(() => !button(root, "加入名单").disabled);
    button(root, "加入名单").click();
    await until(() => root.querySelectorAll('select[aria-label="部门授权"]').length === 2);
    const second = () => root.querySelectorAll<HTMLSelectElement>('select[aria-label="部门授权"]')[1]!;
    type(second(), "some", "change");
    await until(() => root.textContent!.includes("至少要选一个部门"));
    expect(button(root, "保存").disabled).toBe(true);
    type(second(), "any", "change");
    root.querySelectorAll<HTMLInputElement>('input[aria-label="群授权"]')[1]!.click();
    await until(() => !button(root, "保存").disabled);
    button(root, "保存").click();
    await until(() => saved.length === 1);
    expect(saved[0]).toEqual({ view: "v1", roles: [
      { key: "p1", admin: false, pusher: true, dailyLimit: null, grants: { all: true, group: true, department: ["d9", "d2"] } },
      { phone: "13900000004", admin: false, pusher: true, dailyLimit: null, grants: { all: false, group: true, department: "any" } }] });
    await until(() => root.textContent!.includes("已保存"));
    // Not a pusher (an admin only): no grants go with the row, and its grant controls are off.
    const pusher = root.querySelector<HTMLInputElement>('input[aria-label="推送人"]')!;
    root.querySelector<HTMLInputElement>('input[aria-label="管理员"]')!.click();
    pusher.click();
    await until(() => root.querySelector<HTMLSelectElement>('select[aria-label="部门授权"]')!.disabled);
    expect(root.querySelector<HTMLInputElement>('input[aria-label="群授权"]')!.disabled).toBe(true);
    button(root, "保存").click();
    await until(() => saved.length === 2);
    expect(saved[1]).toEqual({ view: "v1", roles: [{ key: "p1", admin: true, pusher: false, dailyLimit: null, grants: { all: false, group: false, department: "none" } }] });
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
