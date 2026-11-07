/** @jsxImportSource preact */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { TaskAction, TasksPage, readTaskEvents, resetTasks, RecoveryActions, UpgradeForm, DeployForm } = await import("../../console/ui/src/tasks.tsx");
const { DirectoryForm, RuntimeForm } = await import("../../console/ui/src/write-forms.tsx");
afterAll(async () => { if (registered) await GlobalRegistrator.unregister(); });
const until = async (check: () => boolean) => { const limit = Date.now() + 3000; while (!check() && Date.now() < limit) await Bun.sleep(10); expect(check()).toBe(true); };
const find = (root: Element, text: string) => [...root.querySelectorAll("button")].find(button => button.textContent === text)!;

test.each(["history-clear", "stat-import", "tmp-purge", "tmp-reclaim", "tmp-discard", "configuration-apply", "configuration-restore", "runtime-configure", "backup-clean", "relay-test", "relay-purge"])("中断 %s 任务可预览恢复且不重复提交原动作；只读结果页不提供恢复写入口", async operation => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root); resetTasks();
  const requests: unknown[] = [], task = { id: "task-fixture", operation, state: "interrupted", needsRecovery: true, createdAt: Date.now() };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/tasks") return Response.json({ tasks: [task] });
    if (String(url) === "/api/tasks/task-fixture") return Response.json(task);
    if (String(url) === "/api/tasks/task-fixture/events") return new Response("");
    if (String(url) === "/api/lifecycle") return Response.json({ pending: null });
    if (String(url) === "/api/plans") { requests.push(JSON.parse(String(options?.body))); return Response.json({ id: "plan-fixture", summary: ["不重复原数据操作"], expiresAt: Date.now() + 60000 }); }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    render(<TasksPage />, root); await until(() => !!root.querySelector(".task-list button"));
    root.querySelector<HTMLButtonElement>(".task-list button")!.click(); await until(() => !!find(root, "预览恢复中断的维护"));
    find(root, "预览恢复中断的维护").click(); await until(() => !!root.querySelector('[role="dialog"]'));
    expect(requests).toEqual([{ operation: "maintenance-recover", params: {} }]); expect(root.textContent).toContain("不重复原数据操作");
    find(root, "返回").click(); render(<TasksPage resultsOnly />, root);
    await until(() => !find(root, "预览恢复中断的维护")); expect(requests).toHaveLength(1);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; resetTasks(); }
});

test("升级缺少范围时可直接选部门；取消不提交，预览只传当前树键", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? "{}")); requests.push({ url: String(url), body });
    if (String(url) === "/api/lifecycle/check-update") return Response.json({ target: "e".repeat(40), branch: "main", hasDirectory: false });
    if (String(url) === "/api/lifecycle/directory/open") return Response.json({ view: "tree-one", children: [{ key: "opaque-one", name: "研发部" }] });
    if (String(url) === "/api/lifecycle/directory/children") return Response.json({ children: [{ key: "opaque-two", name: "测试部" }] });
    if (String(url) === "/api/plans") return Response.json({ id: "plan-one", summary: ["测试部，包含子部门"], expiresAt: Date.now() + 60000 });
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  const choose = (label: string, value: string) => { const select = root.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
  try {
    render(<UpgradeForm />, root); find(root, "检查可升级版本").click(); await until(() => !!find(root, "预览升级"));
    choose("升级通讯录范围", "departments"); await until(() => !!find(root, "读取部署部门树"));
    expect(find(root, "预览升级").disabled).toBe(true); find(root, "读取部署部门树").click(); await until(() => root.textContent!.includes("研发部"));
    root.querySelector<HTMLInputElement>('.department-tree input[type="checkbox"]')!.click(); await until(() => !find(root, "预览升级").disabled);
    find(root, "取消部门选择").click(); await until(() => find(root, "预览升级").disabled);
    expect(requests.some(item => item.url === "/api/plans")).toBe(false);
    find(root, "读取部署部门树").click(); await until(() => !!find(root, "下级部门")); find(root, "下级部门").click(); await until(() => root.textContent!.includes("测试部"));
    root.querySelectorAll<HTMLInputElement>('.department-tree input[type="checkbox"]')[1]!.click(); await until(() => !find(root, "预览升级").disabled);
    find(root, "预览升级").click(); await until(() => !!root.querySelector('[role="dialog"]'));
    expect(requests.at(-1)).toEqual({ url: "/api/plans", body: { operation: "update", params: { target: "e".repeat(40), switchMain: false, directory: { view: "tree-one", selected: ["opaque-two"] } } } });
    expect(requests.some(item => item.url === "/api/directory/apply")).toBe(false);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("重部署表单保留显式端口和目录选择，Linux 重建修复与 Windows 本机修复参数分开", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  let platform = "linux"; const requests: unknown[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/lifecycle/deploy") return Response.json({ port: 12011, workspace: "/fixture/workspace", hasDirectory: true, platform });
    requests.push(JSON.parse(String(options?.body))); return Response.json({ id: "plan-deploy", summary: ["重新部署后启动"], expiresAt: Date.now() + 60000 });
  }) as typeof fetch;
  try {
    render(<DeployForm />, root); find(root, "读取部署设置").click(); await until(() => !!find(root, "预览重新部署"));
    expect(find(root, "预览重新部署").disabled).toBe(true);
    const choose = (label: string, value: string) => { const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; input.value = value;
      input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
    choose("部署操作", "repair"); choose("机器人端口", "2022"); choose("共享资料目录", ""); choose("重部署通讯录范围", "saved");
    await until(() => !!find(root, "预览重建修复") && !find(root, "预览重建修复").disabled); find(root, "预览重建修复").click();
    await until(() => !!root.querySelector('[role="dialog"]'));
    expect(requests[0]).toEqual({ operation: "repair", params: { port: 2022, workspace: "", directory: "saved" } });
    find(root, "返回").click(); platform = "windows"; find(root, "读取部署设置").click(); await until(() => !!find(root, "预览本机修复"));
    expect(root.querySelector('[aria-label="部署操作"]')).toBeNull(); find(root, "预览本机修复").click(); await until(() => requests.length === 2);
    expect(requests[1]).toEqual({ operation: "repair", params: {} });
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("升级表单没有隐式选择，确认绑定检查到的 SHA；版本检查失败清除旧目标", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  let offline = false; const requests: unknown[] = [], target = "c".repeat(40);
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/lifecycle/check-update") return offline ? Response.json({ error: "网络失败", code: "input" }, { status: 409 })
      : Response.json({ target, branch: "feature", hasDirectory: true });
    requests.push(JSON.parse(String(options?.body))); return Response.json({ id: "plan-upgrade", summary: [target], expiresAt: Date.now() + 60000 });
  }) as typeof fetch;
  try {
    render(<UpgradeForm />, root); expect(requests).toEqual([]); find(root, "检查可升级版本").click();
    await until(() => !!find(root, "预览升级")); expect(find(root, "预览升级").disabled).toBe(true);
    const choose = (selector: string, value: string) => { const select = root.querySelector<HTMLSelectElement>(selector)!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
    choose('[aria-label="升级通讯录范围"]', "saved");
    await Bun.sleep(20); expect(find(root, "预览升级").disabled).toBe(true);
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await until(() => !find(root, "预览升级").disabled); find(root, "预览升级").click(); await until(() => !!root.querySelector('[role="dialog"]'));
    expect(requests).toEqual([{ operation: "update", params: { target, switchMain: true, directory: "saved" } }]);
    find(root, "返回").click(); offline = true; find(root, "检查可升级版本").click(); await until(() => root.textContent!.includes("网络失败"));
    expect(find(root, "预览升级")).toBeUndefined(); expect(root.textContent).not.toContain(target);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("恢复页限制已提交和已开始回滚的动作，失败读取不显示可执行按钮", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  let state = "committed"; const requests: unknown[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/lifecycle") return state === "corrupt" ? Response.json({ code: "input", error: "事务记录无法读取" }, { status: 409 })
      : Response.json({ pending: { subject: "合成部署", record: ["端口 2022"], committed: state === "committed", canResume: state === "committed", canRollback: state !== "committed" } });
    if (String(url) === "/api/plans") { requests.push(JSON.parse(String(options?.body))); return Response.json({ id: "p", summary: ["完成已开始的回滚"], expiresAt: Date.now() + 60000 }); }
    return Response.json({});
  }) as typeof fetch;
  try {
    render(<RecoveryActions />, root); await until(() => !!find(root, "预览回滚上次操作"));
    expect(find(root, "预览回滚上次操作").disabled).toBe(true); expect(find(root, "预览继续上次操作").disabled).toBe(false);
    state = "rolling-back"; find(root, "刷新恢复状态").click(); await until(() => root.textContent!.includes("已经开始回滚"));
    expect(find(root, "预览继续上次操作").disabled).toBe(true); find(root, "预览回滚上次操作").click();
    await until(() => !!root.querySelector('[role="dialog"]')); expect(requests).toEqual([{ operation: "rollback", params: {} }]);
    find(root, "返回").click(); state = "corrupt"; find(root, "刷新恢复状态").click(); await until(() => root.textContent!.includes("事务记录无法读取"));
    expect(find(root, "预览回滚上次操作")).toBeUndefined(); expect(find(root, "预览继续上次操作")).toBeUndefined();
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("任务对话框呈现范围、过期和拒绝；断线后重试保留同一幂等键，双击不重复；控制台拒绝后只能重新预览", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  let expired = true, reply: "offline" | "refused" | "ok" = "offline", plans = 0; const submissions: Record<string, string>[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/views/close") return new Response("{}");
    if (String(url) === "/api/plans") { plans++; return Response.json({ id: "plan-fixture", operation: "stop", summary: ["范围：此机器人", "<script>合成说明</script>"], expiresAt: Date.now() + (expired ? -1 : 60_000) }); }
    submissions.push(JSON.parse(String(options?.body)));
    await Bun.sleep(20);
    if (reply === "offline") throw new TypeError("Failed to fetch");
    return reply === "refused" ? Response.json({ error: "运行状态已变化，请重新预览", code: "input" }, { status: 409 }) : Response.json({ id: "task-fixture", state: "queued" });
  }) as typeof fetch;
  try {
    render(<TaskAction operation="stop" params={{}}>停止</TaskAction>, root); find(root, "停止").click();
    await until(() => root.textContent!.includes("预览已过期"));
    expect(root.querySelector("script")).toBeNull(); expect(root.textContent).toContain("范围：此机器人");
    expired = false; find(root, "重新预览").click(); await until(() => !!find(root, "确认执行"));
    find(root, "确认执行").click(); find(root, "确认执行").click(); await until(() => root.textContent!.includes("可以用同一预览重试"));
    expect(submissions).toHaveLength(1); reply = "refused"; find(root, "确认执行").click();
    await until(() => root.textContent!.includes("这份预览不能再执行")); expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1]);
    expect(find(root, "确认执行")).toBeUndefined(); expect(root.textContent).not.toContain("可以用同一预览重试");
    expect(root.querySelector('[role="dialog"] [role="alert"]')!.textContent).toBe("运行状态已变化。这份预览不能再执行，请重新预览。");
    reply = "ok"; find(root, "重新预览").click(); await until(() => plans === 3 && !!find(root, "确认执行"));
    expect(root.textContent).not.toContain("这份预览不能再执行"); find(root, "确认执行").click();
    await until(() => !root.querySelector('[role="dialog"]')); expect(submissions).toHaveLength(3); expect(submissions[2]!.key).not.toBe(submissions[0]!.key);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; resetTasks(); location.hash = ""; }
});

test("SSE 使用来源保护请求头和 Last-Event-ID，跨分块 UTF-8 和重复事件不重复显示", async () => {
  const previous = globalThis.fetch, seen: string[] = [], controller = new AbortController();
  const wire = new TextEncoder().encode('id: 2\nevent: task\ndata: {"seq":2,"text":"旧记录","kind":"output","at":1}\n\nid: 3\nevent: task\ndata: {"seq":3,"text":"中文进度","kind":"output","at":2}\n\n');
  globalThis.fetch = (async (_url: string, options?: RequestInit) => {
    expect(options?.headers).toEqual({ "X-Console-Request": "1", "Last-Event-ID": "2" });
    return new Response(new ReadableStream({ start(stream) { for (let i = 0; i < wire.length; i += 3) stream.enqueue(wire.slice(i, i + 3)); stream.close(); } }));
  }) as typeof fetch;
  try { await readTaskEvents("task-fixture", 2, controller.signal, event => seen.push(event.text)); expect(seen).toEqual(["中文进度"]); }
  finally { globalThis.fetch = previous; controller.abort(); }
});

test("事件流按空闲计时：保活数据续期，停顿后报告没有响应", async () => {
  const previous = globalThis.fetch, controller = new AbortController(), keepalive = new TextEncoder().encode(": keepalive\n\n");
  let stalled = false, opened = 0;
  globalThis.fetch = (async (_url: string, options?: RequestInit) => new Response(new ReadableStream({ start(stream) {
    // As in a browser, the aborted request errors the body.
    options?.signal?.addEventListener("abort", () => { try { stream.error(options.signal!.reason); } catch {} }, { once: true });
    if (stalled) { stream.enqueue(keepalive); return; }
    let sent = 0; const timer = setInterval(() => { if (++sent > 15) { clearInterval(timer); stream.close(); } else stream.enqueue(keepalive); }, 40);
  } }))) as typeof fetch;
  try {
    // 15 keepalives 40 ms apart outlast the 300 ms idle limit: only silence counts.
    await readTaskEvents("task-fixture", 0, controller.signal, () => {}, { idleMs: 300, onOpen: () => opened++ });
    stalled = true;
    await expect(readTaskEvents("task-fixture", 0, controller.signal, () => {}, { idleMs: 300, onOpen: () => opened++ })).rejects.toThrow("事件连接没有响应");
    expect(opened).toBe(2);
  } finally { globalThis.fetch = previous; controller.abort(); }
});

test("任务详情的读取失败和事件连接中断在恢复后清除提示", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root); resetTasks();
  const task = { id: "task-fixture", operation: "stop", state: "succeeded", needsRecovery: false, createdAt: Date.now() }, failUntil = Date.now() + 1500;
  let events = 0;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/tasks") return Response.json({ tasks: [task] });
    if (String(url) === "/api/tasks/task-fixture") return Date.now() < failUntil ? Response.json({ error: "任务记录暂时无法读取" }, { status: 500 }) : Response.json(task);
    if (String(url) === "/api/tasks/task-fixture/events") {
      if (++events === 1) throw new TypeError("Failed to fetch");
      return new Response(new ReadableStream({ start(stream) {
        const timer = setInterval(() => stream.enqueue(new TextEncoder().encode(": keepalive\n\n")), 100);
        options?.signal?.addEventListener("abort", () => { clearInterval(timer); try { stream.error(options.signal!.reason); } catch {} }, { once: true });
      } }));
    }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  try {
    render(<TasksPage resultsOnly />, root); await until(() => !!root.querySelector(".task-list button"));
    root.querySelector<HTMLButtonElement>(".task-list button")!.click();
    const alerts = () => [...root.querySelectorAll('.task-detail [role="alert"]')].map(node => node.textContent);
    await until(() => alerts().length === 2);
    expect(alerts()).toEqual(["任务记录暂时无法读取", "事件连接中断，正在重连…"]);
    // The next poll and the reconnect, both 3 s later, succeed.
    const limit = Date.now() + 6000; while (alerts().length && Date.now() < limit) await Bun.sleep(50);
    expect(alerts()).toEqual([]); expect(events).toBe(2);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; resetTasks(); }
}, 15_000);

test("通讯录表单没有手填 ID，勾选部门后保存直接应用，失败后保留选择", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root); let rejected = true;
  const saves: unknown[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/views/close") return new Response("{}");
    if (String(url) === "/api/directory/selection") return Response.json({ view: "v", mode: "departments", state: "effective", selected: [], unavailable: 0, children: [{ key: "opaque", name: "技术部" }] });
    saves.push(JSON.parse(String(options?.body)));
    return rejected ? Response.json({ error: "暂未保存", code: "input" }, { status: 409 }) : Response.json({ status: "started" });
  }) as typeof fetch;
  try {
    render(<DirectoryForm />, root); find(root, "选择同步范围").click(); await until(() => !!root.querySelector('input[type="checkbox"]'));
    expect(root.querySelector('input[type="text"]')).toBeNull(); (root.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await until(() => !find(root, "保存并立即应用").disabled); find(root, "保存并立即应用").click();
    await until(() => root.textContent!.includes("暂未保存")); expect(root.querySelector('[role="dialog"]')).toBeNull();
    rejected = false; find(root, "保存并立即应用").click(); await until(() => root.textContent!.includes("已保存，正在应用"));
    expect(saves).toEqual([{ view: "v", mode: "departments", selected: ["opaque"] }, { view: "v", mode: "departments", selected: ["opaque"] }]);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("通讯录表单重新读取部门树时保留未保存的勾选；保存后跟踪应用进度，结束时说明结果并通知刷新状态", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const departments = { tech: { key: "tech", name: "技术部" }, sales: { key: "sales", name: "销售部" } };
  let saved = [departments.tech], directory: Record<string, unknown> = { mappings: 3, scope: "", state: "applying", stateText: "", running: "应用新范围：遍历部门" };
  const overviews: number[] = [];
  let hold: PromiseWithResolvers<void> | undefined;
  globalThis.fetch = (async (url: string) => {
    if (String(url) === "/api/views/close") return new Response("{}");
    if (String(url) === "/api/directory/selection") { await hold?.promise; return Response.json({ view: "v", mode: "departments", state: "effective", unavailable: 0, selected: saved,
      children: Object.values(departments) }); }
    if (String(url) === "/api/directory/apply") return Response.json({ status: "started" });
    if (String(url) === "/api/overview") { overviews.push(Date.now()); return Response.json({ service: { state: "ready", attention: [], directory } }); }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  const box = (name: string) => [...root.querySelectorAll("label")].find(label => label.textContent!.startsWith(name))!.querySelector("input") as HTMLInputElement;
  const slowly = async (check: () => boolean) => { const limit = Date.now() + 8000; while (!check() && Date.now() < limit) await Bun.sleep(20); expect(check()).toBe(true); };
  // Held until the button reads 正在读取…, then until the tree is back.
  const reread = async () => {
    hold = Promise.withResolvers<void>(); find(root, "重新读取部门树").click();
    await until(() => root.textContent!.includes("正在读取…"));
    hold.resolve(); hold = undefined;
    await until(() => find(root, "重新读取部门树")?.disabled === false);
  };
  let settled = 0;
  try {
    render(<DirectoryForm onSettled={() => settled++} />, root); find(root, "选择同步范围").click();
    await until(() => root.textContent!.includes("已选择：技术部"));
    // Nothing changed here: reading again takes what the service has saved now.
    saved = [departments.sales];
    await reread(); expect(root.textContent).toContain("已选择：销售部移除");
    // Ticked but not saved: reading again keeps the ticks.
    box("技术部").click(); await until(() => root.textContent!.includes("已选择：销售部、技术部"));
    await reread(); expect(root.textContent).toContain("已选择：销售部、技术部");
    find(root, "保存并立即应用").click();
    await slowly(() => root.textContent!.includes("已保存，正在应用新范围（应用新范围：遍历部门）"));
    expect(settled).toBe(0);
    directory = { mappings: 7, scope: "", state: "effective", stateText: "已生效" };
    await slowly(() => root.textContent!.includes("新范围已生效：在册成员 7 名。"));
    expect(settled).toBe(1);
    // Followed no further once it has ended.
    const polls = overviews.length; await Bun.sleep(2500); expect(overviews).toHaveLength(polls);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
}, 30_000);

// Rules carried over from the retired terminal picker (W5): a department includes its subdepartments, mixed selections across branches, at most 200.
test("通讯录表单跨分支混选；已选部门之下标出已包含，选上级时并入已单独勾选的下级；最多 200 个部门", async () => {
  const { MAX_DEPARTMENTS } = await import("../../console/ui/src/write-forms.tsx");
  const { MAX_SCOPE_DEPARTMENTS } = await import("../../src/integrations/open-platform/directory-scope.ts");
  expect(MAX_DEPARTMENTS).toBe(MAX_SCOPE_DEPARTMENTS);
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root);
  const saves: unknown[] = [];
  const children: Record<string, { key: string; name: string }[]> = { tech: [{ key: "dev", name: "研发组" }, { key: "ops", name: "运维组" }], dev: [{ key: "web", name: "前端" }] };
  let many = false;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/views/close") return new Response("{}");
    if (String(url) === "/api/directory/selection") return Response.json({ view: "v", mode: "departments", state: "effective", unavailable: 0,
      selected: many ? Array.from({ length: 201 }, (_, i) => ({ key: `d${i}`, name: `部门${i}` })) : [],
      children: [{ key: "tech", name: "技术部" }, { key: "sales", name: "销售部" }] });
    const body = JSON.parse(String(options?.body));
    if (String(url) === "/api/directory/children") return Response.json({ children: children[body.parent] ?? [] });
    saves.push(body);
    return Response.json({ status: "started" });
  }) as typeof fetch;
  const box = (name: string) => [...root.querySelectorAll("label")].find(label => label.textContent!.startsWith(name))!.querySelector("input") as HTMLInputElement;
  const expand = async (index: number, name: string) => {
    ([...root.querySelectorAll("button")].filter(button => button.textContent === "下级部门")[index] as HTMLButtonElement).click();
    await until(() => [...root.querySelectorAll("label")].some(label => label.textContent!.startsWith(name)));
  };
  try {
    render(<DirectoryForm />, root); find(root, "选择同步范围").click(); await until(() => !!root.querySelector('input[type="checkbox"]'));
    await expand(0, "研发组"); await expand(1, "前端");
    // Across branches: a subdepartment of one and another top-level department.
    box("前端").click(); box("销售部").click();
    await until(() => root.textContent!.includes("已选择：前端、销售部"));
    // Selecting 研发组 takes in 前端 chosen on its own; below it the box is shown as included and cannot be changed.
    box("研发组").click();
    await until(() => root.textContent!.includes("已选择：销售部、研发组"));
    expect(box("前端").checked).toBe(true); expect(box("前端").disabled).toBe(true);
    expect(root.textContent).toContain("（已包含在「研发组」中）");
    expect(box("运维组").disabled).toBe(false);
    find(root, "保存并立即应用").click(); await until(() => saves.length === 1);
    expect(saves[0]).toEqual({ view: "v", mode: "departments", selected: ["sales", "dev"] });
    render(null, root);
    many = true;
    render(<DirectoryForm />, root); find(root, "选择同步范围").click(); await until(() => root.textContent!.includes("最多选 200 个部门"));
    expect(find(root, "保存并立即应用").disabled).toBe(true);
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});

test("运行参数表单带原始摘要和明确修改项生成预览", async () => {
  const previous = globalThis.fetch, root = document.createElement("div"); document.body.append(root); let sent: unknown;
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url) === "/api/views/close") return new Response("{}");
    if (String(url) === "/api/forms/runtime") return Response.json({ hash: "base", values: {}, groups: [{ label: "并发", description: "合成说明", options: [{ key: "BOT_MAX_ACTIVE_REQUESTS", label: "请求并发上限", default: "32", range: [1, 1000], description: "并发" }] }] });
    sent = JSON.parse(String(options?.body)); return Response.json({ id: "p", summary: ["并发改为 16"], expiresAt: Date.now() + 60000 });
  }) as typeof fetch;
  try {
    render(<RuntimeForm />, root); await until(() => !!root.querySelector('input[type="number"]'));
    const input = root.querySelector("input")!; input.value = "16"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => !find(root, "校验并预览").disabled); find(root, "校验并预览").click(); await until(() => !!root.querySelector('[role="dialog"]'));
    expect(sent).toEqual({ operation: "runtime-configure", params: { hash: "base", changes: { BOT_MAX_ACTIVE_REQUESTS: "16" } } });
  } finally { render(null, root); root.remove(); globalThis.fetch = previous; }
});
