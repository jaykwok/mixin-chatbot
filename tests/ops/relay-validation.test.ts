import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { validateCurrentData } from "../../src/core/data-validation.ts";
import { readRelayIndex } from "../../src/integrations/relay-index.ts";
import { executeProcess } from "../../scripts/lib/process.ts";

const s3 = { provider: "s3", endpoint: "https://s3.example.test", region: "test", bucket: "bucket", accessKeyId: "test", secretAccessKey: "test" };
async function fixture() {
  const f = await tempFixture("relay-validation-");
  const groups = join(f.root, "groups"); await mkdir(groups);
  await publishJson(join(f.root, "data/config/models.json"), { providers: { fixture: {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } });
  await publishJson(join(f.root, "data/runtime/pi/settings.json"), { defaultProvider: "fixture", defaultModel: "test" });
  await mkdir(join(f.root, "data/state"), { recursive: true });
  const config = join(f.root, "data/config/relay.json"), ledger = join(f.root, "data/state/relay.sqlite");
  return { ...f, config, ledger, context: { project: f.root, groups, decisions: {} } };
}

test("无效外链配置在预览阶段拒绝，配置在预览之后变化也不能执行迁移", async () => {
  const f = await fixture();
  try {
    await publishJson(f.config, { ...s3, provider: "ftp" });
    const before = await readFile(f.config);
    await expect(preview(f.context)).rejects.toThrow("provider 必须是 s3");
    expect(await readFile(f.config)).toEqual(before);
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
    await publishJson(f.config, s3);
    const plan = (await preview(f.context)).plan!;
    await publishJson(f.config, { ...s3, region: "changed" });
    await expect(apply(f.context, plan)).rejects.toThrow("配置在预览后变化");
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, 60000);

test("结构无效的账本在 apply 校验时失败，提交点之前可恢复，有效空账本只读验证不改文件", async () => {
  const f = await fixture();
  try {
    await publishJson(f.config, s3);
    const db = new Database(f.ledger);
    db.exec("CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT)");
    db.exec("INSERT INTO objects VALUES ('row', 'https://s3.invalid/file', 'file', 4, '2026-01-01', 'uploaded')");
    db.close();
    const original = await readFile(f.ledger);
    await expect(apply(f.context, (await preview(f.context)).plan!)).rejects.toThrow("外链账本结构无效");
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
    expect(await readFile(f.ledger)).toEqual(original);
    expect(await rollback(f.context)).toBe(true);
    expect(await readFile(f.ledger)).toEqual(original);
    const empty = new Database(f.ledger);
    empty.exec("DROP TABLE objects");
    empty.exec("CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT, expiresAt TEXT, deleteAfter TEXT)");
    empty.close();
    const bytes = await readFile(f.ledger);
    expect(readRelayIndex(f.ledger)).toEqual([]);
    await validateCurrentData(f.root, f.context.groups);
    expect(await readFile(f.ledger)).toEqual(bytes);
    expect(await readdir(join(f.root, "data/state"))).not.toContain("relay.sqlite-wal");
  } finally { await f.cleanup(); }
}, 60000);

test("验证实例和 commit 共用只读外链校验，正式服务启动前拒绝结构无效的账本", async () => {
  const f = await fixture();
  try {
    await publishJson(f.config, s3);
    await apply(f.context, (await preview(f.context)).plan!);
    const db = new Database(f.ledger);
    db.exec("CREATE TABLE objects (key TEXT PRIMARY KEY, url TEXT, name TEXT, size INTEGER, at TEXT, state TEXT)");
    db.exec("INSERT INTO objects VALUES ('row', 'https://s3.invalid/file', 'file', 4, '2026-01-01', 'uploaded')"); db.close();
    const before = await readFile(f.ledger);
    const entry = fileURLToPath(new URL("../../src/server/index.ts", import.meta.url));
    const result = await executeProcess({ command: process.execPath, args: [entry, "--verify-only"], cwd: f.root,
      env: { ...process.env, GROUP_DATA_ROOT: f.context.groups }, timeoutMs: 30000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("外链账本结构无效");
    await expect(commit(f.context)).rejects.toThrow("外链账本结构无效");
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
    expect(await readFile(f.ledger)).toEqual(before);
  } finally { await f.cleanup(); }
}, 60000);
