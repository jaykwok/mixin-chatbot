import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { enginePolicy, validateEngineSettings } from "../../src/core/engine-policy.ts";
import { tempFixture } from "../helpers/temp.ts";
import { migrationBudget } from "../helpers/migration-budget.ts";

async function fixture(settings: Record<string, unknown>) {
  const f = await tempFixture("migration-v4-");
  const groups = join(f.root, "groups");
  await mkdir(groups); await mkdir(join(f.root, "data/state"), { recursive: true });
  await publishJson(join(f.root, "data/config/runtime.json"), { GROUP_DATA_ROOT: groups });
  await publishJson(join(f.root, "data/config/models.json"), { providers: { fixture: {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } });
  const settingsPath = join(f.root, "data/runtime/pi/settings.json");
  await publishJson(settingsPath, { defaultProvider: "fixture", defaultModel: "test", ...settings });
  for (const path of [join(f.root, "data/state/data-version.json"), join(groups, "data-version.json")])
    await publishJson(path, { dataVersion: 3, transaction: "fixture-v3" });
  const bill = join(f.root, "data/state/historical-bill.sqlite"), db = new Database(bill);
  db.exec("CREATE TABLE bill (amount REAL NOT NULL); INSERT INTO bill VALUES (1.741503)"); db.close();
  return { ...f, groups, settingsPath, bill, context: { project: f.root, groups, decisions: {} } };
}

test("v4 previews the effective retry budget, preserves per-model compaction and bills, and rolls back exact bytes", async () => {
  const f = await fixture({ retry: { maxRetries: 99 }, cacheWarming: "idle", enableSkillCommands: true,
    compaction: { reserveTokens: 8000, keepRecentTokens: 9000, modelOverrides: { "fixture/test": { keepRecentTokens: 1234 } } },
    modelThinkingLevels: { "fixture/test": "low" } });
  try {
    const original = await readFile(f.settingsPath), bill = await readFile(f.bill);
    const plan = (await preview(f.context)).plan!;
    expect(plan.target).toBe(4); expect(DATA_VERSION).toBe(4);
    expect(plan.steps.join("\n")).toContain("retry、cacheWarming、enableSkillCommands");
    expect(await readFile(f.settingsPath)).toEqual(original);
    await apply(f.context, plan);
    const settings = (await json(f.settingsPath))!; validateEngineSettings(settings);
    expect(settings).toMatchObject({ format: 1, defaultProvider: "fixture", defaultModel: "test", modelThinkingLevels: { "fixture/test": "low" } });
    expect(settings.retry).toBeUndefined(); expect(settings.cacheWarming).toBeUndefined();
    expect(enginePolicy(settings.durable)).toMatchObject({ retry: { maxRetries: 3 }, stream: { maxRetries: 0, timeoutMs: 120000 },
      compaction: { reserveTokens: 8000, keepRecentTokens: 9000, modelOverrides: { "fixture/test": { keepRecentTokens: 1234 } } }, contextRetentionMs: 600000 });
    expect(await readFile(f.bill)).toEqual(bill);
    expect((await json(join(f.groups, "data-version.json")))!.dataVersion).toBe(3);
    expect(await rollback(f.context)).toBe(true);
    expect(await readFile(f.settingsPath)).toEqual(original); expect(await readFile(f.bill)).toEqual(bill);
    expect((await json(join(f.root, "data/state/data-version.json")))!.dataVersion).toBe(3);
    await apply(f.context, (await preview(f.context)).plan!); await commit(f.context);
    const native = await readFile(f.settingsPath);
    expect(inspectDataVersion(f.root, f.groups)).toMatchObject({ current: true });
    expect(await rollback(f.context)).toBe(false);
    await apply(f.context, (await preview(f.context)).plan!); await commit(f.context);
    expect(await readFile(f.settingsPath)).toEqual(native); expect(await readFile(f.bill)).toEqual(bill);
  } finally { await f.cleanup(); }
}, migrationBudget(8));

test.each([
  { compaction: { keepRecentTokens: -1 } },
  { durable: {}, retry: { maxRetries: 1 } },
  { format: 1, durable: { stream: { maxRetries: 2 } } },
  { format: 1, defaultThinkingLevel: "typo", durable: {} },
])("v4 rejects malformed or mixed policies during read-only preview: %j", async settings => {
  const f = await fixture(settings);
  try {
    const before = await readFile(f.settingsPath);
    await expect(preview(f.context)).rejects.toThrow();
    expect(await readFile(f.settingsPath)).toEqual(before);
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, migrationBudget(1));

test("v4 refuses a stale plan without changing settings or version markers", async () => {
  const f = await fixture({});
  try {
    const plan = (await preview(f.context)).plan!;
    await publishJson(f.settingsPath, { defaultProvider: "fixture", defaultModel: "test", compaction: { reserveTokens: 777 } });
    const before = await readFile(f.settingsPath);
    await expect(apply(f.context, plan)).rejects.toThrow("变化");
    expect(await readFile(f.settingsPath)).toEqual(before);
    expect((await json(join(f.groups, "data-version.json")))!.dataVersion).toBe(3);
  } finally { await f.cleanup(); }
}, migrationBudget(2));

test("native policy rejects hidden SDK retries, zero timeouts and legacy warming", () => {
  expect(() => enginePolicy({ stream: { maxRetries: 1 } })).toThrow("独立开始回执");
  expect(() => enginePolicy({ stream: { timeoutMs: 0 } })).toThrow("大于 0");
  expect(() => validateEngineSettings({ cacheWarming: "off" })).toThrow("旧配置请通过升级迁移");
  const overrides = JSON.parse('{"__proto__":{"reserveTokens":123}}');
  expect(enginePolicy({ compaction: { modelOverrides: overrides } }).compaction.modelOverrides!["__proto__"]).toEqual({ reserveTokens: 123 });
});
