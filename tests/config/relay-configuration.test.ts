import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRelayConfig } from "../../src/integrations/relay.ts";
import { archiveFixture, tempFixture } from "../helpers/temp.ts";

const wizard = fileURLToPath(new URL("../../scripts/config/configure-relay.ts", import.meta.url));
const base = { webdavUrl: "http://127.0.0.1:5244/dav/relay/", publicBaseUrl: "https://files.example.test/d/relay/", maxBytes: 2 * 1024 ** 3 };
const file = (root: string) => join(root, "data/config/relay.json");
const draft = (root: string) => join(root, "data/config/draft.json");

async function run(root: string, mode: "--draft" | "--apply", answers: Record<string, string | boolean> = {},
  faults: { cancelAt?: string; failPublish?: boolean } = {}) {
  const preload = join(root, "prompts.ts");
  await writeFile(preload, [
    'import { mock } from "bun:test";',
    "import * as maintenance from " + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) + ";",
    "const answers = " + JSON.stringify(answers) + ", faults = " + JSON.stringify(faults) + ";",
    'const cancelled = Symbol("cancelled");',
    'globalThis.fetch = () => { throw new Error("configuration must not access the network"); };',
    "if (faults.failPublish) mock.module(" + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) +
      ', () => ({ ...maintenance, replaceFile: async () => { throw new Error("injected publish failure"); } }));',
    "function pick(options, secret = false) {",
    '  console.log("PROMPT " + options.message);',
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
  const child = Bun.spawn([process.execPath, "--preload", preload, wizard, mode, draft(root)], {
    cwd: root, env: { ...process.env, FORCE_COLOR: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
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
      "WebDAV 上传目录": base.webdavUrl, "公开下载目录": base.publicBaseUrl,
    });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("保存预览");
    expect(prepared.output).toContain("不自动过期");
    expect(existsSync(file(fixture.root))).toBe(false);
    expect(existsSync(draft(fixture.root))).toBe(true);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
    if (process.platform !== "win32") expect((await stat(file(fixture.root))).mode & 0o777).toBe(0o600);
  } finally { await fixture.cleanup(); }
});

test("修改时可留空沿用密码，跳过高级设置保留有效期、签名与自定义字段且不输出密钥", async () => {
  const fixture = await tempFixture("relay-configure-existing-");
  const secrets = { password: "fixture-password-private", signSecret: "fixture-signing-key-private" };
  try {
    await seed(fixture.root, { ...base, username: "operator", ...secrets, expireHours: 12, signPathPrefix: "/relay/", customNote: "preserve" });
    const prepared = await run(fixture.root, "--draft");
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
});

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
});

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
});

test("取消、无效输入及发布失败保留原配置，未确认不留下草稿", async () => {
  for (const scenario of ["cancel", "decline", "bad-url", "bad-size", "bad-path", "changed-account", "publish"] as const) {
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
  }
}, 30000);

test("提交拒绝覆盖填写期间的其他修改；停用只归档配置并保留账本", async () => {
  const fixture = await tempFixture("relay-configure-disable-");
  try {
    await seed(fixture.root, base);
    expect((await run(fixture.root, "--draft")).code).toBe(0);
    const changed = await seed(fixture.root, { ...base, maxBytes: 1024 ** 3 });
    const stale = await run(fixture.root, "--apply");
    expect(stale.code).toBe(1);
    expect(stale.output).toContain("已被其他操作修改");
    expect(await readFile(file(fixture.root), "utf8")).toBe(changed);
    // 每次向导使用独立草稿；此处归档上一轮测试草稿后重新配置。
    await archiveFixture(draft(fixture.root));
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
    expect(await readFile(join(fixture.root, "backup/rm", archived!), "utf8")).toBe(changed);
  } finally { await fixture.cleanup(); }
});
