import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextRuntimeDraft, readRuntimeSettings, sweepRuntimeDrafts, validateRuntimeDraft, writeRuntimeDraft } from "../../scripts/config/runtime-draft.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";

const script = fileURLToPath(new URL("../../scripts/config/runtime-settings.ts", import.meta.url));
const configFile = (root: string) => join(root, "data/config/runtime.json");

async function seed(root: string, value: object | string) {
  await mkdir(join(root, "data/config"), { recursive: true });
  await writeFile(configFile(root), typeof value === "string" ? value : JSON.stringify(value));
  return readRuntimeSettings(configFile(root));
}
/** The draft as runtime-apply.ts reads it, and the runtime.json it would publish. */
const saved = async (path: string) => validateRuntimeDraft(JSON.parse(await readFile(path, "utf8")));
const values = (text: string) => JSON.parse(text) as Record<string, string>;

test("运行参数按需读取、形成独立草稿；结果保留部署字段和未编辑项，放弃的草稿一天后只删草稿", async () => {
  const fixture = await tempFixture("runtime-draft-");
  try {
    expect(await readRuntimeSettings(configFile(fixture.root))).toEqual({ hash: null, values: {} });
    expect(existsSync(configFile(fixture.root))).toBe(false);
    // A first runtime.json: the draft expects none, and one that appeared meanwhile is not overwritten.
    const first = await saved(await writeRuntimeDraft({ hash: null, values: {} }, { BOT_BASH_TIMEOUT: "333" }, configFile(fixture.root)));
    expect(nextRuntimeDraft(null, first, {})).toBe('{\n  "BOT_BASH_TIMEOUT": "333"\n}\n');
    expect(() => nextRuntimeDraft("{}", first, {})).toThrow("已被其他操作修改");

    const old = { BOT_PORT: 8888, BOT_HOST: "127.0.0.1", WORKSPACE_ROOT: "/srv/materials", BOT_DOCUMENT_WORK_ENABLED: "1", BOT_INDEX_MAX_DEPTH: 14 };
    const snapshot = await seed(fixture.root, old), raw = await readFile(configFile(fixture.root), "utf8");
    const draft = await writeRuntimeDraft(snapshot, { BOT_MAX_ACTIVE_REQUESTS: "64", PI_CACHE_RETENTION: "long" }, configFile(fixture.root));
    // Explicit environment values of keys the draft leaves alone neither block it nor enter the result.
    expect(values(nextRuntimeDraft(raw, await saved(draft), { BOT_PORT: "1234", BOT_ATTACHMENT_CONCURRENCY: "8" }))).toEqual({
      BOT_PORT: "8888", BOT_HOST: "127.0.0.1", WORKSPACE_ROOT: "/srv/materials", BOT_DOCUMENT_WORK_ENABLED: "1", BOT_INDEX_MAX_DEPTH: "14",
      BOT_MAX_ACTIVE_REQUESTS: "64", PI_CACHE_RETENTION: "long",
    });
    expect(await readFile(configFile(fixture.root), "utf8")).toBe(raw);
    // An abandoned preview's draft goes on a later preview once it is a day old; newer drafts and runtime.json stay.
    const abandoned = new Date(Date.now() - 25 * 3600_000);
    await utimes(draft, abandoned, abandoned);
    await utimes(configFile(fixture.root), abandoned, abandoned);
    const fresh = await writeRuntimeDraft(snapshot, { BOT_MAX_ACTIVE_REQUESTS: "32" }, configFile(fixture.root));
    await sweepRuntimeDrafts(configFile(fixture.root));
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(await readFile(configFile(fixture.root), "utf8")).toBe(raw);
  } finally { await fixture.cleanup(); }
});

test("恢复默认会删除该覆盖值；显式环境与结果不同时拒绝，数值相同则放行", async () => {
  const fixture = await tempFixture("runtime-reset-");
  try {
    const snapshot = await seed(fixture.root, { BOT_MAX_ACTIVE_REQUESTS: "64", BOT_DOCUMENT_WORK_ENABLED: "1", BOT_DOCUMENT_ENV: "/app/custom-env" });
    const raw = await readFile(configFile(fixture.root), "utf8");
    const draft = await saved(await writeRuntimeDraft(snapshot, { BOT_MAX_ACTIVE_REQUESTS: null, BOT_DOCUMENT_ENV: null }, configFile(fixture.root)));
    expect(() => nextRuntimeDraft(raw, draft, { BOT_MAX_ACTIVE_REQUESTS: "64" })).toThrow("被显式环境变量覆盖");
    // The default is 32.
    expect(values(nextRuntimeDraft(raw, draft, { BOT_MAX_ACTIVE_REQUESTS: "032" }))).toEqual({ BOT_DOCUMENT_WORK_ENABLED: "1" });
  } finally { await fixture.cleanup(); }
});

test("拒绝非法值、部署字段、格式不符和过期的草稿，避免覆盖并发修改", async () => {
  const fixture = await tempFixture("runtime-conflict-");
  try {
    const snapshot = await seed(fixture.root, { BOT_INDEX_TTL_MINUTES: "5" });
    for (const changes of [{ BOT_ATTACHMENT_CONCURRENCY: "9" }, { BOT_DOCUMENT_WORK_ENABLED: "true" }, { BOT_INDEX_MAX_FILES: "99" }, { BOT_PORT: "8080" }, {}]) {
      await expect(writeRuntimeDraft(snapshot, changes, configFile(fixture.root))).rejects.toThrow();
    }
    const draft = await saved(await writeRuntimeDraft(snapshot, { BOT_INDEX_TTL_MINUTES: "10" }, configFile(fixture.root)));
    const changed = await seed(fixture.root, { BOT_INDEX_TTL_MINUTES: "15" }), raw = await readFile(configFile(fixture.root), "utf8");
    expect(() => nextRuntimeDraft(raw, draft, {})).toThrow("已被其他操作修改");
    expect(() => validateRuntimeDraft({ expectedHash: changed.hash, changes: { BOT_HOST: "0.0.0.0" } })).toThrow("不可在高级运行参数中修改");
    for (const value of [null, [], { expectedHash: "x", changes: { BOT_INDEX_TTL_MINUTES: "10" } }, { expectedHash: changed.hash, changes: {} },
      { expectedHash: changed.hash, changes: { BOT_INDEX_TTL_MINUTES: "10" }, extra: 1 }]) expect(() => validateRuntimeDraft(value)).toThrow();
  } finally { await fixture.cleanup(); }
});

test("不带参数按当前环境保存（Windows 本机运行）；多余参数或 Docker 主机上的调用不写入", async () => {
  const fixture = await tempFixture("runtime-save-cli-");
  try {
    await seed(fixture.root, { BOT_INDEX_TTL_MINUTES: "5" });
    const raw = await readFile(configFile(fixture.root), "utf8");
    const run = async (...args: string[]) => {
      const env = { ...process.env };
      for (const key of RUNTIME_KEYS) delete env[key];
      const child = Bun.spawn([process.execPath, "--no-env-file", script, ...args], {
        cwd: fixture.root, env: { ...env, BOT_BASH_TIMEOUT: "456" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: output + error };
    };
    for (const args of [["--apply", ".runtime-draft-11111111-1111-1111-1111-111111111111.json"], ["--check"], ["extra"]]) {
      const refused = await run(...args);
      expect(refused.code, refused.output).toBe(1);
      expect(await readFile(configFile(fixture.root), "utf8")).toBe(raw);
    }
    const result = await run();
    if (process.platform === "win32") {
      expect(result.code, result.output).toBe(0);
      expect((await readRuntimeSettings(configFile(fixture.root))).values).toEqual({ BOT_INDEX_TTL_MINUTES: "5", BOT_BASH_TIMEOUT: "456" });
    } else {
      expect(result.code).toBe(1);
      expect(result.output).toContain("由部署入口写入");
      expect(await readFile(configFile(fixture.root), "utf8")).toBe(raw);
    }
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
