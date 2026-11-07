/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { ConfigurationForm, ConfigurationRecovery } = await import("../../console/ui/src/configuration.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const end = Date.now() + 3000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true); };
const button = (root: Element, text: string) => [...root.querySelectorAll("button")].find(value => value.textContent === text)!;

test("配置恢复先收尾宿主维护，发布前中断也可见；运行参数显示正确名称，状态读取失败隐藏动作", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const calls: any[] = []; let state: unknown, broken = false;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url).endsWith("/state")) return broken ? Response.json({ message: "状态不可读取" }, { status: 409 }) : Response.json(state);
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ id: "plan-test", summary: ["恢复"], expiresAt: Date.now() + 60000 });
  }) as typeof fetch;
  try {
    const transaction = { id: "config-test", phase: "ready", kind: "runtime" };
    for (const current of [null, transaction]) {
      render(null, root); calls.length = 0; state = { transaction: current, maintenancePending: true };
      render(<ConfigurationRecovery />, root); await until(() => !!button(root, "预览恢复中断的维护"));
      expect(button(root, "预览恢复原配置")).toBeUndefined();
      if (current) expect(root.textContent).toContain("高级运行参数");
      button(root, "预览恢复中断的维护").click(); await until(() => !!root.querySelector('[role="dialog"]'));
      expect(calls).toEqual([{ operation: "maintenance-recover", params: {} }]);
    }
    render(null, root); state = { transaction, maintenancePending: false }; calls.length = 0;
    render(<ConfigurationRecovery />, root); await until(() => !!button(root, "预览恢复原配置"));
    expect(root.textContent).toContain("高级运行参数");
    button(root, "预览恢复原配置").click(); await until(() => !!root.querySelector('[role="dialog"]'));
    expect(calls).toEqual([{ operation: "configuration-restore", params: { draft: "config-test" } }]);
    button(root, "返回").click(); broken = true; button(root, "检查配置事务").click();
    await until(() => !!root.querySelector('[role="alert"]'));
    expect(button(root, "预览恢复原配置")).toBeUndefined();
    expect(button(root, "预览恢复中断的维护")).toBeUndefined();
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("配置表单只提交草稿编号供预览；凭据保持/替换明确，校验成功后清空新密码，取消不调用应用", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const calls: { path: string; body: any }[] = [], draft = { id: "config-test", revision: 0, validated: false, summary: [], expiresAt: Date.now() + 60000,
    form: { kind: "app", appId: "fixture", environment: "staging", hasSecret: true, bound: true } };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined; calls.push({ path, body });
    if (path.endsWith("/open")) return Response.json(draft);
    if (path.endsWith("/edit")) return Response.json({ ...draft, revision: 1 });
    if (path.endsWith("/check")) return Response.json({ ...draft, revision: 1, validated: true, summary: ["已校验，未联网"] });
    if (path === "/api/plans") return Response.json({ id: "plan-test", summary: ["应用配置"], expiresAt: Date.now() + 60000 });
    return Response.json({});
  }) as typeof fetch;
  try {
    render(<ConfigurationForm kind="app" />, root); button(root, "编辑配置").click(); await until(() => !!root.querySelector("select"));
    expect(root.querySelector('input[type="password"]')).toBeNull(); expect((root.querySelector("select") as HTMLSelectElement).value).toBe("staging");
    const mode = root.querySelector('[aria-label="应用密钥处理方式"]') as HTMLSelectElement;
    mode.value = "set"; mode.dispatchEvent(new Event("change", { bubbles: true })); await until(() => !!root.querySelector('input[type="password"]'));
    const input = root.querySelector('input[type="password"]') as HTMLInputElement; input.value = "new-fixture-secret"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await Bun.sleep(10); button(root, "保存草稿并校验").click(); await until(() => !!button(root, "预览应用配置"));
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(calls.find(value => value.path.endsWith("/edit"))?.body.patch.secret).toEqual({ mode: "set", value: "new-fixture-secret" });
    expect(calls.find(value => value.path.endsWith("/check"))?.body).toMatchObject({ network: false, refresh: false, revision: 1 });
    button(root, "预览应用配置").click(); await until(() => !!root.querySelector('[role="dialog"]'));
    expect(calls.find(value => value.path === "/api/plans")?.body).toEqual({ operation: "configuration-apply", params: { draft: "config-test" } });
    button(root, "返回").click(); button(root, "取消草稿").click(); await until(() => !root.querySelector("fieldset"));
    expect(calls.some(value => value.path === "/api/tasks")).toBe(false); expect(calls.some(value => value.path.endsWith("/discard"))).toBe(true);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("取消后迟到的配置校验不会重新显示可应用草稿；恢复入口区分回滚和已提交收尾", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root); let resolveCheck: (response: Response) => void = () => {};
  const draft = { id: "config-test", revision: 1, validated: false, summary: [], form: { kind: "relay", enabled: false } };
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/check")) return await new Promise(resolve => { resolveCheck = resolve; });
    if (String(url).endsWith("/state")) return Response.json({ transaction: { id: "config-test", phase: "committed", kind: "relay" } });
    return Response.json(draft);
  }) as typeof fetch;
  try {
    render(<ConfigurationForm kind="relay" />, root); button(root, "编辑配置").click(); await until(() => !!button(root, "保存草稿并校验"));
    button(root, "保存草稿并校验").click(); await Bun.sleep(30); button(root, "取消草稿").click();
    resolveCheck(Response.json({ ...draft, validated: true })); await Bun.sleep(30); expect(button(root, "预览应用配置")).toBeUndefined();
    render(<ConfigurationRecovery />, root); await until(() => !!button(root, "预览完成配置收尾"));
    expect(button(root, "预览恢复原配置")).toBeUndefined();
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("模型目录同时显示内置和私有缓存的安全投影，选择缓存模型不触发联网；外链停用保留凭据不发送新秘密", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const calls: { path: string; body: any }[] = []; let kind = "models";
  const form = () => kind === "models" ? { kind, provider: "openrouter", model: "builtin", thinking: "off", providers: [{ id: "openrouter", hasKey: true, models: [] }],
    catalogModels: [{ provider: "openrouter", id: "cached", name: "缓存模型", contextWindow: 64000, maxTokens: 8000 }] }
    : { kind, enabled: true, endpoint: "https://example.test", region: "test", bucket: "fixture", prefix: "", hasSecret: true, hasAccessKey: true, hasToken: true,
      maxBytes: 1000, expireHours: 1, cleanupGraceMinutes: 30 };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined; calls.push({ path, body });
    if (path.endsWith("/catalog")) return Response.json({ providers: [{ id: "openrouter", name: "OpenRouter" }], apis: ["openai-completions"], models: [{ provider: "openrouter", id: "builtin", contextWindow: 32000, maxTokens: 4000 }] });
    return Response.json({ id: "config-test", revision: 1, validated: path.endsWith("/check"), summary: [], form: form() });
  }) as typeof fetch;
  try {
    render(<ConfigurationForm kind="models" />, root); button(root, "编辑配置").click();
    await until(() => [...root.querySelectorAll("option")].some(value => value.value === "builtin"));
    const selected = [...root.querySelectorAll("select")].find(value => [...value.options].some(option => option.value === "cached"))!;
    selected.value = "cached"; selected.dispatchEvent(new Event("change", { bubbles: true })); await Bun.sleep(10);
    button(root, "保存草稿并校验").click(); await until(() => !!button(root, "预览应用配置"));
    expect(calls.find(value => value.path.endsWith("/edit"))?.body.patch).toMatchObject({ mode: "builtin", model: "cached", key: { mode: "keep" } });
    expect(calls.find(value => value.path.endsWith("/check"))?.body).toMatchObject({ network: false, refresh: false });
    render(null, root); kind = "relay"; calls.length = 0;
    render(<ConfigurationForm kind="relay" />, root); button(root, "编辑配置").click(); await until(() => !!root.querySelector('input[type="checkbox"]'));
    expect(root.querySelector('input[type="password"]')).toBeNull();
    const enabled = root.querySelector('input[type="checkbox"]') as HTMLInputElement; enabled.checked = false; enabled.dispatchEvent(new Event("change", { bubbles: true })); await Bun.sleep(10);
    button(root, "保存草稿并校验").click(); await until(() => !!button(root, "预览应用配置"));
    expect(calls.find(value => value.path.endsWith("/edit"))?.body.patch).toMatchObject({ enabled: false, secret: { mode: "keep" }, accessKey: { mode: "keep" }, token: { mode: "keep" } });
    expect(calls.some(value => value.path === "/api/tasks")).toBe(false);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
