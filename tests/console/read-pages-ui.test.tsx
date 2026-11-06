/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:11012/" });
const { render } = await import("preact");
const { ReadOnlyPage } = await import("../../console/ui/src/read-pages.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const limit = Date.now() + 2000; while (!check() && Date.now() < limit) await Bun.sleep(10); expect(check()).toBe(true); };

test("只读页面显示空态/错误并能重试，日志筛选不把内容当 HTML", async () => {
  const fetchBefore = globalThis.fetch, container = document.createElement("div"); document.body.append(container);
  let failed = true; const calls: string[] = [];
  globalThis.fetch = (async (path: string) => {
    // Components of earlier files in the same process finish asynchronously after their unmount (a stats view closes, a
    // configuration draft is discarded); only read requests are this page's.
    if (!String(path).startsWith("/api/read/")) return new Response("{}");
    calls.push(String(path)); return new Response(JSON.stringify(failed ? { error: "读取失败", code: "internal" }
    : { checkedAt: Date.now(), columns: ["级别", "内容"], rows: [["info", "<img src=x onerror=alert(1)> 合成日志"]], note: "脱敏" }), { status: failed ? 503 : 200 }); }) as typeof fetch;
  try {
    render(<ReadOnlyPage page="logs" />, container);
    await until(() => !!container.querySelector('[role="alert"]'));
    failed = false;
    [...container.querySelectorAll("button")].find(button => button.textContent === "重试")!.click();
    await until(() => container.textContent!.includes("合成日志"));
    expect(container.querySelector("img") === null).toBe(true);
    expect(container.querySelectorAll("input").length).toBe(2);
    expect(calls).toEqual(["/api/read/logs", "/api/read/logs"]);
  } finally { render(null, container); container.remove(); globalThis.fetch = fetchBefore; }
});
