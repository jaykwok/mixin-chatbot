import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRelayConfig } from "../../src/integrations/relay.ts";
import { runCommand, ScenarioProcesses } from "../helpers/concurrent-scenarios.ts";
import { tempFixture } from "../helpers/temp.ts";

const wizard = fileURLToPath(new URL("../../scripts/config/configure-relay.ts", import.meta.url));
const base = { webdavUrl: "http://127.0.0.1:5244/dav/relay/", publicBaseUrl: "https://files.example.test/d/relay/", maxBytes: 2 * 1024 ** 3 };
const file = (root: string) => join(root, "data/config/relay.json");
const draft = (root: string) => join(root, "data/config/draft.json");
const hungPid = (root: string) => join(root, "hung.pid");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 一次向导运行的上限。到期后结束其进程树并等它退出，才报错返回，夹具在此之后才清理。
const WIZARD_LIMIT_MS = 10000;
// 每个流程用例的预算：在向导上限之外留出结束进程和清理夹具的时间。全局默认时限不变。
const FLOW_BUDGET_MS = 30000;

async function run(root: string, mode: "--draft" | "--apply", answers: Record<string, string | boolean> = {},
  faults: { cancelAt?: string; failPublish?: boolean; hangAt?: string } = {}) {
  const preload = join(root, "prompts.ts");
  await writeFile(preload, [
    'import { mock } from "bun:test";',
    'import { writeFileSync } from "node:fs";',
    "import * as maintenance from " + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) + ";",
    "const answers = " + JSON.stringify(answers) + ", faults = " + JSON.stringify(faults) + ";",
    'const cancelled = Symbol("cancelled");',
    'globalThis.fetch = () => { throw new Error("configuration must not access the network"); };',
    "if (faults.failPublish) mock.module(" + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) +
      ', () => ({ ...maintenance, replaceFile: async () => { throw new Error("injected publish failure"); } }));',
    "function pick(options, secret = false) {",
    '  console.log("PROMPT " + options.message);',
    // 卡在这个提示上永不返回，进程也不会自行退出。
    "  if (faults.hangAt && String(options.message).includes(faults.hangAt)) {",
    "    writeFileSync(" + JSON.stringify(hungPid(root)) + ", String(process.pid));",
    "    setInterval(() => {}, 60000);",
    "    return new Promise(() => {});",
    "  }",
    "  if (String(options.message).includes(faults.cancelAt ?? '\\0')) return cancelled;",
    '  if (secret && (options.initialValue || options.defaultValue)) throw new Error("secret prefilled visibly");',
    "  const match = Object.entries(answers).find(([key]) => options.message.includes(key));",
    '  const value = match ? match[1] : secret ? "" : options.initialValue ?? options.defaultValue;',
    '  const error = options.validate?.(value); if (error) throw new Error(error);',
    '  return value;',
    "}",
    "mock.module(" + JSON.stringify(import.meta.resolve("@clack/prompts")) + ", () => ({",
    "  isCancel: value => value === cancelled,",
    "  intro: console.log, outro: console.log, cancel: console.log, note: console.log,",
    "  log: { warn: console.log, info: console.log },",
    "  text: async options => pick(options), select: async options => pick(options),",
    "  confirm: async options => pick(options), password: async options => pick(options, true),",
    "}));",
  ].join("\n"));
  const stage = `${mode === "--draft" ? "生成草稿" : "提交草稿"}（${basename(root)}）`;
  const processes = new ScenarioProcesses();
  const started = performance.now();
  try {
    const { code, text, limited } = await runCommand(processes, root, [process.execPath, "--preload", preload, wizard, mode, draft(root)],
      { FORCE_COLOR: "0" }, undefined, WIZARD_LIMIT_MS);
    if (limited) {
      throw new Error(`外链向导在${stage}阶段超过 ${WIZARD_LIMIT_MS / 1000} 秒未退出，已结束并等待其进程树：`
        + `用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒，退出码 ${code}。已收集的输出：\n${text}`);
    }
    return { code, output: text };
  } finally { await processes.stop(); }
}

async function seed(root: string, contents: unknown) {
  await mkdir(join(root, "data/config"), { recursive: true });
  await writeFile(file(root), typeof contents === "string" ? contents : JSON.stringify(contents, null, 2) + "\n");
  return readFile(file(root), "utf8");
}

test("外链先形成可审阅草稿，确认后提交并使用运行时的默认值和校验", async () => {
  const fixture = await tempFixture("relay-configure-basic-");
  try {
    const prepared = await run(fixture.root, "--draft", {
      "WebDAV 上传目录": "127.0.0.1:5244/dav/relay", "公开下载目录": "files.example.test",
    });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("保存预览");
    expect(prepared.output).toContain("上传目录：" + base.webdavUrl);
    expect(prepared.output).toContain("公开目录：" + base.publicBaseUrl);
    expect(prepared.output).toContain("不自动过期");
    expect(existsSync(file(fixture.root))).toBe(false);
    expect(existsSync(draft(fixture.root))).toBe(true);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
    if (process.platform !== "win32") expect((await stat(file(fixture.root))).mode & 0o777).toBe(0o600);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("仅填下载域名时，多级中文挂载目录会用于下载地址和签名路径", async () => {
  const fixture = await tempFixture("relay-configure-derived-");
  try {
    const prepared = await run(fixture.root, "--draft", {
      "WebDAV 上传目录": "127.0.0.1:5244/dav/网盘/relay", "公开下载目录": "files.example.test",
      "调整高级": true, "公开下载签名": "alist", "下载签名密钥": "fixture-signing-key",
    });
    const expectedPublic = "https://files.example.test/d/%E7%BD%91%E7%9B%98/relay/";
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("公开目录：" + expectedPublic);
    expect(prepared.output).not.toContain("fixture-signing-key");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual({
      ...base, webdavUrl: "http://127.0.0.1:5244/dav/%E7%BD%91%E7%9B%98/relay/", publicBaseUrl: expectedPublic,
      signSecret: "fixture-signing-key", signPathPrefix: "/网盘/relay/",
    });
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("修改时可留空沿用密码，跳过高级设置保留有效期、签名与自定义字段且不输出密钥", async () => {
  const fixture = await tempFixture("relay-configure-existing-");
  const secrets = { password: "fixture-password-private", signSecret: "fixture-signing-key-private" };
  try {
    await seed(fixture.root, { ...base, webdavUrl: base.webdavUrl.slice(0, -1),
      username: "operator", ...secrets, expireHours: 12, signPathPrefix: "/relay/", customNote: "preserve" });
    const prepared = await run(fixture.root, "--draft", { "WebDAV 上传目录": "127.0.0.1:5244/dav/relay" });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("留空沿用已保存值");
    expect(prepared.output).toContain("12 小时后签名失效");
    for (const secret of Object.values(secrets)) expect(prepared.output).not.toContain(secret);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(JSON.parse(await readFile(file(fixture.root), "utf8"))).toEqual({
      ...base, username: "operator", ...secrets, expireHours: 12, signPathPrefix: "/relay/", customNote: "preserve",
    });
    for (const secret of Object.values(secrets)) expect(applied.output).not.toContain(secret);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("高级设置说明到期删除与签名失效，并能清除旧认证及签名", async () => {
  const fixture = await tempFixture("relay-configure-advanced-");
  try {
    await seed(fixture.root, { ...base, username: "operator", password: "old-password", signSecret: "old-secret", signPathPrefix: "/relay/" });
    const prepared = await run(fixture.root, "--draft", {
      "WebDAV 认证方式": "none", "调整高级": true, "单文件外链上限": "512", "链接有效期": "2", "公开下载签名": "none",
    });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("2 小时后删除远端文件（不可恢复）");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual({ ...base, maxBytes: 512 * 1024 ** 2, expireHours: 2 });
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("新建签名配置会校验路径并使用隐藏输入，空有效期保持不自动过期", async () => {
  const fixture = await tempFixture("relay-configure-signing-");
  try {
    const prepared = await run(fixture.root, "--draft", {
      "WebDAV 上传目录": base.webdavUrl, "公开下载目录": "https://files.example.test/files/",
      "WebDAV 认证方式": "basic", "WebDAV 用户名": "operator", "WebDAV 密码": "fixture-password",
      "调整高级": true, "公开下载签名": "alist", "下载签名密钥": "fixture-key", "签名路径前缀": "/relay",
    });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).not.toContain("fixture-password");
    expect(prepared.output).not.toContain("fixture-key");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual({
      ...base, publicBaseUrl: "https://files.example.test/files/", username: "operator", password: "fixture-password",
      signSecret: "fixture-key", signPathPrefix: "/relay/",
    });
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

// 每个场景一个用例，各有自己的预算。
for (const scenario of ["cancel", "decline", "bad-url", "bad-size", "bad-path", "changed-account", "publish"] as const) {
  test("取消、无效输入及发布失败保留原配置，未确认不留下草稿：" + scenario, async () => {
    const fixture = await tempFixture("relay-configure-" + scenario + "-");
    try {
      const original = await seed(fixture.root, { ...base, username: "operator", password: "original-password" });
      const prepared = await run(fixture.root, "--draft", {
        ...(scenario === "decline" ? { "保存并应用": false } : {}),
        ...(scenario === "bad-url" ? { "WebDAV 上传目录": "ftp://invalid.test/" } : {}),
        ...(scenario === "changed-account" ? { "WebDAV 用户名": "someone-else" } : {}),
        ...(scenario === "bad-size" ? { "调整高级": true, "单文件外链上限": "25" } : {}),
        ...(scenario === "bad-path" ? { "公开下载目录": "https://files.example.test/files/", "调整高级": true,
          "公开下载签名": "alist", "下载签名密钥": "private-key" } : {}),
      }, scenario === "cancel" ? { cancelAt: "WebDAV 密码" } : {});
      if (scenario === "publish") {
        expect(prepared.code, prepared.output).toBe(0);
        const applied = await run(fixture.root, "--apply", {}, { failPublish: true });
        expect(applied.code).toBe(1);
        expect(applied.output).toContain("injected publish failure");
        expect((await readdir(join(fixture.root, "data/config"))).some(name => name.endsWith(".tmp"))).toBe(false);
      } else {
        expect(prepared.code, prepared.output).toBe(scenario === "cancel" || scenario === "decline" ? 0 : 1);
        expect(existsSync(draft(fixture.root))).toBe(false);
      }
      expect(await readFile(file(fixture.root), "utf8")).toBe(original);
    } finally { await fixture.cleanup(); }
  }, FLOW_BUDGET_MS);
}

test("提交拒绝覆盖填写期间的其他修改", async () => {
  const fixture = await tempFixture("relay-configure-conflict-");
  try {
    await seed(fixture.root, base);
    expect((await run(fixture.root, "--draft")).code).toBe(0);
    const changed = await seed(fixture.root, { ...base, maxBytes: 1024 ** 3 });
    const stale = await run(fixture.root, "--apply");
    expect(stale.code).toBe(1);
    expect(stale.output).toContain("已被其他操作修改");
    expect(await readFile(file(fixture.root), "utf8")).toBe(changed);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("停用只归档配置并保留账本", async () => {
  const fixture = await tempFixture("relay-configure-disable-");
  try {
    const saved = await seed(fixture.root, { ...base, maxBytes: 1024 ** 3 });
    await mkdir(join(fixture.root, "data/state"), { recursive: true });
    const ledger = join(fixture.root, "data/state/relay.sqlite");
    await writeFile(ledger, "ledger-sentinel");
    const prepared = await run(fixture.root, "--draft", { "外链设置": "disable", "保存并应用": true });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("停用期间机器人不会执行到期清理");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(existsSync(file(fixture.root))).toBe(false);
    expect(await readFile(ledger, "utf8")).toBe("ledger-sentinel");
    const archived = (await readdir(join(fixture.root, "backup/rm"))).find(name => name.endsWith("-relay.json"));
    expect(archived).toBeDefined();
    expect(await readFile(join(fixture.root, "backup/rm", archived!), "utf8")).toBe(saved);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("向导卡住时到上限即结束并等待其进程，不留下进程，报错说明阶段、耗时、退出码和已收集的输出", async () => {
  const fixture = await tempFixture("relay-configure-hung-");
  try {
    const failure = await run(fixture.root, "--draft", {}, { hangAt: "WebDAV 上传目录" }).then(() => "exited", (error: Error) => error.message);
    // 报错返回时进程已经结束，夹具在这之后才清理。
    expect(alive(Number(await readFile(hungPid(fixture.root), "utf8")))).toBe(false);
    expect(failure).toContain(`外链向导在生成草稿（${basename(fixture.root)}）阶段超过 10 秒未退出，已结束并等待其进程树：`);
    const [, seconds, code] = /用时 ([\d.]+) 秒，退出码 (\d+)。已收集的输出：\n/.exec(failure) ?? [];
    expect(Number(seconds)).toBeGreaterThanOrEqual(10);
    expect(Number(seconds)).toBeLessThan(FLOW_BUDGET_MS / 1000);
    expect(code).toBeDefined();
    expect(failure).toContain("PROMPT WebDAV 上传目录");
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);
