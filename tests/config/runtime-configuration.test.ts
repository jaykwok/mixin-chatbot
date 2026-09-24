import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardRuntimeDraft, readRuntimeSettings, writeRuntimeDraft } from "../../scripts/config/runtime-settings.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";

const script = fileURLToPath(new URL("../../scripts/config/runtime-settings.ts", import.meta.url));
const configFile = (root: string) => join(root, "data/config/runtime.json");

async function run(root: string, mode: string, draft: string, overrides: Record<string, string> = {}, preload?: string) {
  const env = { ...process.env };
  for (const key of RUNTIME_KEYS) delete env[key];
  const child = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), script, mode, basename(draft)], {
    cwd: root, env: { ...env, ...overrides }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: output + error };
}

async function seed(root: string, value: object | string) {
  await mkdir(join(root, "data/config"), { recursive: true });
  await writeFile(configFile(root), typeof value === "string" ? value : JSON.stringify(value));
  return readRuntimeSettings(configFile(root));
}

test("运行参数按需读取、形成独立草稿，预检不写配置，应用保留部署字段和未编辑项", async () => {
  const fixture = await tempFixture("runtime-draft-");
  try {
    expect(await readRuntimeSettings(configFile(fixture.root))).toEqual({ hash: null, values: {} });
    expect(existsSync(configFile(fixture.root))).toBe(false);
    const old = { BOT_PORT: 8888, BOT_HOST: "127.0.0.1", GROUP_DATA_ROOT: "/app/group-data", BOT_DEBUG: "1", BOT_INDEX_MAX_DEPTH: 14 };
    const snapshot = await seed(fixture.root, old);
    const draft = await writeRuntimeDraft(snapshot, { BOT_MAX_ACTIVE_REQUESTS: "64", PI_CACHE_RETENTION: "long" }, configFile(fixture.root));
    const checked = await run(fixture.root, "--check", draft);
    expect(checked.code, checked.output).toBe(0);
    expect(JSON.parse(await readFile(configFile(fixture.root), "utf8"))).toEqual(old);
    const applied = await run(fixture.root, "--apply", draft, { BOT_PORT: "1234", BOT_ATTACHMENT_CONCURRENCY: "8" });
    expect(applied.code, applied.output).toBe(0);
    expect((await readRuntimeSettings(configFile(fixture.root))).values).toEqual({
      BOT_PORT: "8888", BOT_HOST: "127.0.0.1", GROUP_DATA_ROOT: "/app/group-data", BOT_DEBUG: "1", BOT_INDEX_MAX_DEPTH: "14",
      BOT_MAX_ACTIVE_REQUESTS: "64", PI_CACHE_RETENTION: "long",
    });
    await rm(draft + ".rollback");
    await discardRuntimeDraft(draft);
    expect(existsSync(draft)).toBe(false);
  } finally { await fixture.cleanup(); }
}, 30000);

test("恢复默认会删除该覆盖值；环境冲突在停机前校验，取消草稿不影响原配置", async () => {
  const fixture = await tempFixture("runtime-reset-");
  try {
    const snapshot = await seed(fixture.root, { BOT_MAX_ACTIVE_REQUESTS: "64", BOT_DEBUG: "1", BOT_DOCUMENT_ENV: "/app/custom-env" });
    const draft = await writeRuntimeDraft(snapshot, { BOT_MAX_ACTIVE_REQUESTS: null, BOT_DOCUMENT_ENV: null }, configFile(fixture.root));
    const conflict = await run(fixture.root, "--check", draft, { BOT_MAX_ACTIVE_REQUESTS: "64" });
    expect(conflict.code).toBe(1);
    expect(conflict.output).toContain("被显式环境变量覆盖");
    expect((await readRuntimeSettings(configFile(fixture.root))).hash).toBe(snapshot.hash);
    const applied = await run(fixture.root, "--apply", draft, { BOT_MAX_ACTIVE_REQUESTS: "032" });
    expect(applied.code, applied.output).toBe(0);
    expect((await readRuntimeSettings(configFile(fixture.root))).values).toEqual({ BOT_DEBUG: "1" });
    const rollback = await run(fixture.root, "--rollback", draft);
    expect(rollback.code, rollback.output).toBe(0);
    expect(await readRuntimeSettings(configFile(fixture.root))).toEqual(snapshot);
    await discardRuntimeDraft(draft);
    expect(existsSync(draft)).toBe(false);
  } finally { await fixture.cleanup(); }
}, 30000);

test("拒绝非法值、部署字段和过期草稿，避免覆盖并发修改", async () => {
  const fixture = await tempFixture("runtime-conflict-");
  try {
    const snapshot = await seed(fixture.root, { BOT_INDEX_TTL_MINUTES: "5" });
    for (const changes of [{ BOT_ATTACHMENT_CONCURRENCY: "9" }, { BOT_DEBUG: "true" }, { BOT_INDEX_MAX_FILES: "99" }, { BOT_PORT: "8080" }, {}]) {
      await expect(writeRuntimeDraft(snapshot, changes, configFile(fixture.root))).rejects.toThrow();
    }
    const draft = await writeRuntimeDraft(snapshot, { BOT_INDEX_TTL_MINUTES: "10" }, configFile(fixture.root));
    await seed(fixture.root, { BOT_INDEX_TTL_MINUTES: "15" });
    const conflict = await run(fixture.root, "--apply", draft);
    expect(conflict.code).toBe(1);
    expect(conflict.output).toContain("已被其他操作修改");
    expect((await readRuntimeSettings(configFile(fixture.root))).values).toEqual({ BOT_INDEX_TTL_MINUTES: "15" });
    expect(existsSync(draft + ".rollback")).toBe(false);
    await writeFile(draft, JSON.stringify({ expectedHash: (await readRuntimeSettings(configFile(fixture.root))).hash, changes: { BOT_HOST: "0.0.0.0" } }));
    const tampered = await run(fixture.root, "--apply", draft);
    expect(tampered.code).toBe(1);
    expect(tampered.output).toContain("不可在高级运行参数中修改");
  } finally { await fixture.cleanup(); }
}, 30000);

test("发布失败保留原文件并可恢复，首次创建的配置可以回滚为缺失", async () => {
  const fixture = await tempFixture("runtime-rollback-");
  try {
    const snapshot = await seed(fixture.root, '{\r\n  "BOT_BASH_TIMEOUT": 111\r\n}\r\n');
    const original = await readFile(configFile(fixture.root), "utf8");
    const draft = await writeRuntimeDraft(snapshot, { BOT_BASH_TIMEOUT: "222" }, configFile(fixture.root));
    const preload = join(fixture.root, "fault.ts");
    await writeFile(preload, [
      'import { mock } from "bun:test";',
      "import * as maintenance from " + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) + ";",
      "mock.module(" + JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts")) +
        ', () => ({ ...maintenance, replaceFile: async () => { throw new Error("injected publish failure"); } }));',
    ].join("\n"));
    const failed = await run(fixture.root, "--apply", draft, {}, preload);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("injected publish failure");
    expect(await readFile(configFile(fixture.root), "utf8")).toBe(original);
    expect((await run(fixture.root, "--rollback", draft)).code).toBe(0);
    expect(await readFile(configFile(fixture.root), "utf8")).toBe(original);
    await discardRuntimeDraft(draft);

    await rm(configFile(fixture.root));
    const fresh = await writeRuntimeDraft(await readRuntimeSettings(configFile(fixture.root)), { BOT_BASH_TIMEOUT: "333" }, configFile(fixture.root));
    expect((await run(fixture.root, "--apply", fresh)).code).toBe(0);
    expect(existsSync(configFile(fixture.root))).toBe(true);
    expect((await run(fixture.root, "--rollback", fresh)).code).toBe(0);
    expect(existsSync(configFile(fixture.root))).toBe(false);
  } finally { await fixture.cleanup(); }
}, 30000);

test("回滚遇到后续修改时保留现场；未恢复的草稿不会被 TUI 清理", async () => {
  const fixture = await tempFixture("runtime-rollback-conflict-");
  try {
    const snapshot = await seed(fixture.root, { BOT_DEBUG: "0" });
    const draft = await writeRuntimeDraft(snapshot, { BOT_DEBUG: "1" }, configFile(fixture.root));
    expect((await run(fixture.root, "--apply", draft)).code).toBe(0);
    await seed(fixture.root, { BOT_DEBUG: "1", BOT_BASH_TIMEOUT: "123" });
    const rollback = await run(fixture.root, "--rollback", draft);
    expect(rollback.code).toBe(1);
    expect(rollback.output).toContain("又被修改");
    await discardRuntimeDraft(draft);
    expect(existsSync(draft)).toBe(true);
    expect(existsSync(draft + ".rollback")).toBe(true);
    expect((await readRuntimeSettings(configFile(fixture.root))).values).toEqual({ BOT_DEBUG: "1", BOT_BASH_TIMEOUT: "123" });
  } finally { await fixture.cleanup(); }
}, 30000);

test("导入设置读取模块不读取 runtime.json，非法配置仅影响选中的设置项", async () => {
  const fixture = await tempFixture("runtime-lazy-import-");
  try {
    await mkdir(join(fixture.root, "data/config"), { recursive: true });
    await writeFile(configFile(fixture.root), "{ broken");
    const child = Bun.spawn([process.execPath, "-e", "await import(" + JSON.stringify(script) + '); console.log("loaded")'], {
      cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, output + error).toBe(0);
    expect(output).toContain("loaded");
    await expect(readRuntimeSettings(configFile(fixture.root))).rejects.toThrow();
  } finally { await fixture.cleanup(); }
}, 30000);
