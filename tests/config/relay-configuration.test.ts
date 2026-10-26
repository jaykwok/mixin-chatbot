import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRelayConfig, validateRelayConfig } from "../../src/integrations/relay.ts";
import { runCommand, ScenarioProcesses } from "../helpers/concurrent-scenarios.ts";
import { tempFixture } from "../helpers/temp.ts";
import { openRelayIndex } from "../../src/integrations/relay-index.ts";

const wizard = fileURLToPath(new URL("../../scripts/config/configure-relay.ts", import.meta.url));
const base = validateRelayConfig({ provider: "s3", endpoint: "https://s3.example.test", region: "test-region", bucket: "test-bucket", accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk" });
const answers = { "S3 服务端点": "s3.example.test", "S3 区域": "test-region", "私有存储桶": "test-bucket", "Access Key ID": "fixture-ak", "Secret Access Key": "fixture-sk" };
const file = (root: string) => join(root, "data/config/relay.json");
const draft = (root: string) => join(root, "data/config/draft.json");
const hungPid = (root: string) => join(root, "hung.pid");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 一次向导运行的上限。到期后结束其进程树并等它退出，才报错返回，夹具在此之后才清理。
const WIZARD_LIMIT_MS = 10000;
// 每个流程用例的预算：在向导上限之外留出结束进程和清理夹具的时间。全局默认时限不变。
const FLOW_BUDGET_MS = 30000;

async function run(root: string, mode: "--draft" | "--apply", answers: Record<string, string | boolean> = {},
  faults: { cancelAt?: string; failPublish?: boolean; hangAt?: string; unreadableLedger?: boolean } = {}) {
  const preload = join(root, "prompts.ts");
  await writeFile(preload, [
    'import { mock } from "bun:test";',
    'import { writeFileSync } from "node:fs";',
    "import * as maintenance from " + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) + ";",
    "import * as ledger from " + JSON.stringify(import.meta.resolve("../../src/integrations/relay-index.ts")) + ";",
    "const answers = " + JSON.stringify(answers) + ", faults = " + JSON.stringify(faults) + ";",
    'const cancelled = Symbol("cancelled");',
    'globalThis.fetch = () => { throw new Error("configuration must not access the network"); };',
    "if (faults.failPublish) mock.module(" + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) +
      ', () => ({ ...maintenance, replaceFile: async () => { throw new Error("injected publish failure"); } }));',
    "if (faults.unreadableLedger) mock.module(" + JSON.stringify(import.meta.resolve("../../src/integrations/relay-index.ts")) +
      ', () => ({ ...ledger, readRelayIndex: () => { throw Object.assign(new Error("injected access denied"), { code: "EACCES" }); } }));',
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
    // 与 clack 一致：清空后提交会换回 defaultValue。
    '  const value = match ? (match[1] === "" && options.defaultValue !== undefined ? options.defaultValue : match[1])',
    '    : secret ? "" : options.initialValue ?? options.defaultValue;',
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

async function seedLedger(root: string, kind: "empty" | "invalid" | "corrupt") {
  await mkdir(join(root, "data/state"), { recursive: true });
  const path = join(root, "data/state/relay.sqlite");
  if (kind === "corrupt") await writeFile(path, "invalid SQLite content: preserve for recovery");
  else {
    const db = new Database(path);
    try {
      // The invalid table has rows but lacks the deadline columns.
      db.exec(kind === "invalid" ? "CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT)"
        : "CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT, expiresAt TEXT, deleteAfter TEXT)");
      if (kind === "invalid") db.exec("INSERT INTO objects VALUES ('row', 'https://s3.invalid/file', 'private.pdf', 4, '2026-01-01', 'uploaded')");
    } finally { db.close(); }
  }
  return { path, bytes: await readFile(path) };
}

for (const kind of ["invalid", "corrupt"] as const) {
  test("账本保存门禁：没有 relay.json 时拒绝无效账本，直接提交也不能绕过：" + kind, async () => {
    const fixture = await tempFixture("relay-gate-" + kind + "-");
    try {
      const ledger = await seedLedger(fixture.root, kind);
      const prepared = await run(fixture.root, "--draft", answers);
      expect(prepared.code, prepared.output).toBe(1);
      expect(prepared.output).toContain("拒绝保存 S3 外链配置");
      expect(prepared.output).toContain(kind === "invalid" ? "外链账本结构无效" : "外链账本已损坏");
      expect(prepared.output).not.toContain("PROMPT 保存并应用");
      expect(existsSync(draft(fixture.root))).toBe(false);
      expect(existsSync(file(fixture.root))).toBe(false);
      expect(await readFile(ledger.path)).toEqual(ledger.bytes);
      await mkdir(join(fixture.root, "data/config"), { recursive: true });
      await writeFile(draft(fixture.root), JSON.stringify({ expectedHash: null, config: base }));
      const applied = await run(fixture.root, "--apply");
      expect(applied.code, applied.output).toBe(1);
      expect(applied.output).toContain("拒绝保存 S3 外链配置");
      expect(existsSync(file(fixture.root))).toBe(false);
      expect(await readdir(join(fixture.root, "data/config"))).toEqual(["draft.json"]);
      expect(await readFile(ledger.path)).toEqual(ledger.bytes);
    } finally { await fixture.cleanup(); }
  }, FLOW_BUDGET_MS);
}

test("账本保存门禁：草稿确认后账本变为无效，维护锁内复核拒绝覆盖原配置", async () => {
  const fixture = await tempFixture("relay-gate-changed-");
  try {
    const original = await seed(fixture.root, base);
    expect((await run(fixture.root, "--draft", { "私有存储桶": "new-bucket" })).code).toBe(0);
    const ledger = await seedLedger(fixture.root, "invalid");
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(1);
    expect(applied.output).toContain("外链账本结构无效");
    expect(await readFile(file(fixture.root), "utf8")).toBe(original);
    expect(await readFile(ledger.path)).toEqual(ledger.bytes);
    expect((await readdir(join(fixture.root, "data/config"))).some(name => name.endsWith(".tmp"))).toBe(false);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("账本保存门禁：空账本允许启用，向导和提交均不修改账本", async () => {
  const fixture = await tempFixture("relay-gate-empty-");
  try {
    const ledger = await seedLedger(fixture.root, "empty");
    const prepared = await run(fixture.root, "--draft", answers);
    expect(prepared.code, prepared.output).toBe(0);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
    expect(await readFile(ledger.path)).toEqual(ledger.bytes);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("账本保存门禁：读取权限错误仍提示警告，允许确认保存", async () => {
  const fixture = await tempFixture("relay-gate-unreadable-");
  try {
    const prepared = await run(fixture.root, "--draft", answers, { unreadableLedger: true });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("外链账本无法只读核验");
    expect(prepared.output.indexOf("外链账本无法只读核验")).toBeLessThan(prepared.output.indexOf("PROMPT 保存并应用"));
    const applied = await run(fixture.root, "--apply", {}, { unreadableLedger: true });
    expect(applied.code, applied.output).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("账本保存门禁：无效账本不阻止停用，原账本完整保留", async () => {
  const fixture = await tempFixture("relay-gate-disable-");
  try {
    await seed(fixture.root, base);
    const ledger = await seedLedger(fixture.root, "invalid");
    const prepared = await run(fixture.root, "--draft", { "外链设置": "disable", "保存并应用": true });
    expect(prepared.code, prepared.output).toBe(0);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(existsSync(file(fixture.root))).toBe(false);
    expect(await readFile(ledger.path)).toEqual(ledger.bytes);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("S3 向导先形成草稿，保存后使用默认两小时下载和独立删除余量", async () => {
  const fixture = await tempFixture("relay-configure-basic-");
  try {
    const prepared = await run(fixture.root, "--draft", answers);
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("超过 30 MiB 的本地文件可上传到私有 S3 存储桶，再发送限时下载链接。");
    expect(prepared.output).toContain("保存预览");
    expect(prepared.output).toContain("下载有效期：2 小时");
    expect(prepared.output).toContain("再保留 30 分钟");
    expect(prepared.output).toContain("对象路径：日期-UUID/原文件名（桶根目录）");
    expect(prepared.output).not.toContain(base.accessKeyId);
    expect(prepared.output).not.toContain(base.secretAccessKey);
    expect(existsSync(file(fixture.root))).toBe(false);
    expect(existsSync(draft(fixture.root))).toBe(true);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
    if (process.platform !== "win32") expect((await stat(file(fixture.root))).mode & 0o777).toBe(0o600);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("跳过高级设置保留已有配置和隐藏凭据，临时 Token 不输出", async () => {
  const fixture = await tempFixture("relay-configure-existing-");
  const expected = { ...base, expireHours: 12, cleanupGraceMinutes: 45, prefix: "private/relay/", sessionToken: "fixture-private-token", customNote: "preserve" };
  try {
    await seed(fixture.root, expected);
    const prepared = await run(fixture.root, "--draft");
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("留空沿用已保存值");
    expect(prepared.output).toContain("下载有效期：12 小时");
    expect(prepared.output).toContain("再保留 45 分钟");
    for (const secret of [base.accessKeyId, base.secretAccessKey, expected.sessionToken]) expect(prepared.output).not.toContain(secret);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(JSON.parse(await readFile(file(fixture.root), "utf8"))).toEqual(expected);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("高级设置支持 Path style、中文目录、有限期与删除余量，能清除临时 Token", async () => {
  const fixture = await tempFixture("relay-configure-advanced-");
  try {
    await seed(fixture.root, { ...base, sessionToken: "old-token" });
    const prepared = await run(fixture.root, "--draft", {
      "S3 寻址方式": "path", "临时凭据": "none", "调整高级": true,
      "对象目录": "临时/分发", "单文件外链上限": "512", "链接有效期": "3", "删除余量": "60",
    });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("下载有效期：3 小时");
    expect(prepared.output).toContain("再保留 60 分钟");
    expect(prepared.output).toContain("对象路径：临时/分发/日期-UUID/原文件名");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual({ ...base, forcePathStyle: true, prefix: "临时/分发/", maxBytes: 512 * 1024 ** 2, expireHours: 3, cleanupGraceMinutes: 60 });
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("腾讯 COS 端点预填区域；粘贴桶域名时先确认改用服务端点，拒绝则不留草稿", async () => {
  const fixture = await tempFixture("relay-configure-cos-");
  const cos = { "S3 服务端点": "bot-1250000000.cos.ap-chengdu.myqcloud.com", "私有存储桶": "bot-1250000000",
    "Access Key ID": "fixture-ak", "Secret Access Key": "fixture-sk" };
  try {
    const declined = await run(fixture.root, "--draft", { ...cos, "服务端点已包含桶名": false });
    expect(declined.code, declined.output).toBe(1);
    expect(declined.output).toContain("PROMPT 服务端点已包含桶名，Virtual hosted 会自动加桶名；改用 https://cos.ap-chengdu.myqcloud.com？");
    expect(declined.output).toContain("服务端点不能包含桶名");
    expect(declined.output).not.toContain("PROMPT Access Key ID");
    expect(existsSync(draft(fixture.root))).toBe(false);
    const prepared = await run(fixture.root, "--draft", { ...cos, "服务端点已包含桶名": true });
    expect(prepared.code, prepared.output).toBe(0);
    const applied = await run(fixture.root, "--apply");
    expect(applied.code, applied.output).toBe(0);
    expect(applied.output).toContain("数据 → 外链 → 测试外链");
    expect(loadRelayConfig(file(fixture.root))).toEqual({ ...base, endpoint: "https://cos.ap-chengdu.myqcloud.com",
      region: "ap-chengdu", bucket: "bot-1250000000" });
    // 同一端点再次配置时沿用已保存的区域，不被预填覆盖。
    // 运维包装器提交后会删除草稿，这里手工删除。
    await rm(draft(fixture.root));
    await seed(fixture.root, { ...base, endpoint: "https://cos.ap-chengdu.myqcloud.com", region: "custom-region", bucket: "bot-1250000000" });
    const again = await run(fixture.root, "--draft");
    expect(again.code, again.output).toBe(0);
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))!.region).toBe("custom-region");
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS * 2);

test("高级设置清空已有对象目录即改用桶根目录", async () => {
  const fixture = await tempFixture("relay-configure-root-");
  try {
    await seed(fixture.root, { ...base, prefix: "relay/" });
    const prepared = await run(fixture.root, "--draft", { "调整高级": true, "对象目录": "" });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("PROMPT 对象目录 Prefix（清空表示桶根目录）");
    expect(prepared.output).toContain("对象路径：日期-UUID/原文件名（桶根目录）");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(JSON.parse(await readFile(file(fixture.root), "utf8")).prefix).toBe("");
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("无法通过校验的配置必须重新填写，保存后不带回原字段或凭据", async () => {
  const fixture = await tempFixture("relay-configure-replace-");
  try {
    const before = await seed(fixture.root, { provider: "s3", endpoint: "ftp://old.invalid/", region: "old", bucket: "old-bucket",
      accessKeyId: "old", secretAccessKey: "old-secret", note: "old-field" });
    const prepared = await run(fixture.root, "--draft", answers);
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).toContain("重新填写");
    expect(await readFile(file(fixture.root), "utf8")).toBe(before);
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual(base);
    expect(await readFile(file(fixture.root), "utf8")).not.toContain("old-secret");
    expect(await readFile(file(fixture.root), "utf8")).not.toContain("old-field");
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("切换服务端点必须重新提供凭据，不能沿用旧 Token", async () => {
  const fixture = await tempFixture("relay-configure-endpoint-");
  try {
    await seed(fixture.root, { ...base, sessionToken: "old-token" });
    const prepared = await run(fixture.root, "--draft", { ...answers, "S3 服务端点": "other.example.test", "Secret Access Key": "new-secret" });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.output).not.toContain("old-token");
    expect((await run(fixture.root, "--apply")).code).toBe(0);
    expect(loadRelayConfig(file(fixture.root))).toEqual({ ...base, endpoint: "https://other.example.test", secretAccessKey: "new-secret" });
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

// 每个场景一个用例，各有自己的预算。
for (const scenario of ["cancel", "decline", "bad-url", "bad-size", "bad-path", "bad-grace", "changed-account", "publish"] as const) {
  test("取消、无效输入及发布失败保留原配置，未确认不留下草稿：" + scenario, async () => {
    const fixture = await tempFixture("relay-configure-" + scenario + "-");
    try {
      const original = await seed(fixture.root, base);
      const prepared = await run(fixture.root, "--draft", {
        ...(scenario === "decline" ? { "保存并应用": false } : {}),
        ...(scenario === "bad-url" ? { "S3 服务端点": "ftp://invalid.test/" } : {}),
        ...(scenario === "changed-account" ? { "Access Key ID": "someone-else" } : {}),
        ...(scenario === "bad-size" ? { "调整高级": true, "单文件外链上限": "25" } : {}),
        ...(scenario === "bad-path" ? { "调整高级": true, "对象目录": "../other" } : {}),
        ...(scenario === "bad-grace" ? { "调整高级": true, "删除余量": "0" } : {}),
      }, scenario === "cancel" ? { cancelAt: "Secret Access Key" } : {});
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

test("保存前提示新设置无法清理的在册对象数，不修改账本或提前切换配置", async () => {
  const fixture = await tempFixture("relay-configure-orphan-");
  try {
    const original = await seed(fixture.root, base);
    const path = join(fixture.root, "data/state/relay.sqlite"), index = await openRelayIndex(path);
    await index.remember({ key: "previous-backend:key", name: "private.pdf", url: "https://old.invalid/file", size: 1,
      at: new Date().toISOString(), state: "uploaded", expiresAt: new Date().toISOString() });
    index.close();
    const before = await readFile(path);
    const result = await run(fixture.root, "--draft", { "保存并应用": false });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("账本仍有 1 个对象不属于新设置");
    expect(result.output.indexOf("账本仍有")).toBeLessThan(result.output.indexOf("PROMPT 保存并应用"));
    expect(await readFile(file(fixture.root), "utf8")).toBe(original);
    expect(await readFile(path)).toEqual(before);
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);

test("向导卡住时到上限即结束并等待其进程，不留下进程，报错说明阶段、耗时、退出码和已收集的输出", async () => {
  const fixture = await tempFixture("relay-configure-hung-");
  try {
    const failure = await run(fixture.root, "--draft", {}, { hangAt: "S3 服务端点" }).then(() => "exited", (error: Error) => error.message);
    // 报错返回时进程已经结束，夹具在这之后才清理。
    expect(alive(Number(await readFile(hungPid(fixture.root), "utf8")))).toBe(false);
    expect(failure).toContain(`外链向导在生成草稿（${basename(fixture.root)}）阶段超过 10 秒未退出，已结束并等待其进程树：`);
    const [, seconds, code] = /用时 ([\d.]+) 秒，退出码 (\d+)。已收集的输出：\n/.exec(failure) ?? [];
    expect(Number(seconds)).toBeGreaterThanOrEqual(10);
    expect(Number(seconds)).toBeLessThan(FLOW_BUDGET_MS / 1000);
    expect(code).toBeDefined();
    expect(failure).toContain("PROMPT S3 服务端点");
  } finally { await fixture.cleanup(); }
}, FLOW_BUDGET_MS);
