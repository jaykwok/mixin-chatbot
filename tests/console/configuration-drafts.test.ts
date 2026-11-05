import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configurationForm, configurationSnapshot, editConfiguration, CONFIGURATION_FILES } from "../../scripts/config/configuration-form.ts";
import { ConfigurationDrafts } from "../../scripts/ops/console/configuration-drafts.ts";
import { configurationDigest } from "../../scripts/config/configuration-draft.ts";
import { TaskStore } from "../../scripts/ops/console/tasks.ts";
import { applicationBinding } from "../../src/core/data-version.ts";
import { DATA_VERSION } from "../../src/core/version.ts";
import { tempFixture } from "../helpers/temp.ts";

const write = (project: string, file: string, value: unknown) => { const path = join(project, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const modelPatch = { provider: "gateway", mode: "custom", api: "openai-completions", baseUrl: "https://example.test/v1", key: { mode: "keep" }, thinking: "low",
  model: { id: "fixture", contextWindow: 64000, maxTokens: 8000, input: ["text"], reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } };

test("模型表单不回显凭据或未知原生字段，编辑保留其他服务商、模型、缓存和环境引用", async () => {
  const f = await tempFixture("console-config-model-");
  try {
    const model = { id: "fixture", contextWindow: 32000, maxTokens: 4000, compat: { secretNative: "must-not-display" }, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ upTo: 1000, input: 1 }] } };
    const providers = { gateway: { api: modelPatch.api, baseUrl: modelPatch.baseUrl, apiKey: "$PRIVATE_KEY", headers: { authorization: "hidden-header" },
      native: { password: "unknown-secret" }, models: [model, { id: "other", untouched: true }] }, other: { apiKey: "hidden-other" } };
    write(f.root, CONFIGURATION_FILES.models, { $schema: "models-schema", providers, nativeTop: { token: "hidden-top" } });
    write(f.root, CONFIGURATION_FILES.settings, { defaultProvider: "gateway", defaultModel: "fixture", defaultThinkingLevel: "high", native: { value: 1 }, modelThinkingLevels: { "gateway/fixture": "high", "other/fixture": "low" } });
    write(f.root, CONFIGURATION_FILES.catalog, { opaque: { token: "hidden-cache" }, openrouter: { etag: "hidden-etag", models: [{ id: "cached", contextWindow: 32000, maxTokens: 4000, headers: { Authorization: "hidden-cached-header" }, baseUrl: "https://hidden-endpoint.test", cost: { input: 1, output: 2 } }] } });
    const before = configurationSnapshot(f.root, "models"), form = JSON.stringify(configurationForm(before));
    for (const value of ["PRIVATE_KEY", "hidden-", "unknown-secret", "must-not-display"]) expect(form).not.toContain(value);
    expect(JSON.parse(form).catalogModels).toEqual([{ provider: "openrouter", id: "cached", contextWindow: 32000, maxTokens: 4000, cost: { input: 1, output: 2 } }]);
    const next = editConfiguration(before, modelPatch), changed = JSON.parse(next.files.models!);
    expect(changed.providers.other).toEqual(providers.other); expect(changed.nativeTop).toEqual({ token: "hidden-top" });
    expect(changed.providers.gateway.apiKey).toBe("$PRIVATE_KEY"); expect(changed.providers.gateway.headers).toEqual(providers.gateway.headers);
    const selected = changed.providers.gateway.models.find((value: { id: string }) => value.id === "fixture");
    expect(selected.compat).toEqual(model.compat); expect(selected.cost).toEqual(model.cost); expect(selected.contextWindow).toBe(64000);
    expect(changed.providers.gateway.models.find((value: { id: string }) => value.id === "other")).toEqual({ id: "other", untouched: true });
    expect(next.files.catalog).toBe(before.files.catalog);
    expect(JSON.parse(next.files.settings!)).toMatchObject({ native: { value: 1 }, defaultThinkingLevel: "low", modelThinkingLevels: { "other/fixture": "low" } });
    expect(JSON.parse(next.files.settings!).modelThinkingLevels["gateway/fixture"]).toBeUndefined();
    expect(configurationSnapshot(f.root, "models")).toEqual(before);
    expect(() => editConfiguration(before, { ...modelPatch, baseUrl: "https://other.test/v1" })).toThrow("新的服务商 ID");
    expect(() => editConfiguration(before, { ...modelPatch, provider: "__proto__" })).toThrow("ID 无效");
  } finally { await f.cleanup(); }
});

test("应用表单可轮换同一应用密钥但不可跨应用沿用数据，未知参数被拒绝", async () => {
  const f = await tempFixture("console-config-app-");
  try {
    const app = { appId: "fixture-app", appSecret: "fixture-secret", environment: "production" };
    write(f.root, CONFIGURATION_FILES.app, app);
    write(f.root, "data/state/data-version.json", { dataVersion: DATA_VERSION, appVersion: "1.0.1", build: "a".repeat(40), transaction: "deploy-fixture", application: applicationBinding(app) });
    const base = configurationSnapshot(f.root, "app");
    expect(JSON.stringify(configurationForm(base))).not.toContain(app.appSecret);
    const patch = { appId: app.appId, environment: app.environment, secret: { mode: "set", value: "replacement-secret" } };
    expect(JSON.parse(editConfiguration(base, patch).files.app!).appSecret).toBe("replacement-secret");
    expect(() => editConfiguration(base, { ...patch, appId: "another-app" })).toThrow("另一个应用");
    expect(() => editConfiguration(base, { ...patch, extra: true })).toThrow("未允许");
  } finally { await f.cleanup(); }
});

test("外链保留未知字段，换端点和账户必须重新填写凭据，停用不修改账本", async () => {
  const f = await tempFixture("console-config-relay-");
  try {
    const config = { provider: "s3", endpoint: "https://example.test", region: "test", bucket: "fixture-bucket", prefix: "", forcePathStyle: false,
      maxBytes: 2 * 1024 ** 3, expireHours: 2, cleanupGraceMinutes: 30, accessKeyId: "access-private", secretAccessKey: "secret-private", sessionToken: "token-private", custom: { secret: "unknown-private" } };
    write(f.root, CONFIGURATION_FILES.relay, config);
    const base = configurationSnapshot(f.root, "relay"), form = configurationForm(base);
    expect(JSON.stringify(form)).not.toContain("private");
    const patch = { enabled: true, endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: "new/", forcePathStyle: false,
      maxBytes: config.maxBytes, expireHours: 3, cleanupGraceMinutes: 40, accessKey: { mode: "keep" }, secret: { mode: "keep" }, token: { mode: "keep" } };
    expect(JSON.parse(editConfiguration(base, patch).files.relay!)).toMatchObject({ custom: config.custom, secretAccessKey: config.secretAccessKey, prefix: "new/" });
    expect(() => editConfiguration(base, { ...patch, endpoint: "https://elsewhere.test" })).toThrow("不能沿用");
    expect(() => editConfiguration(base, { ...patch, accessKey: { mode: "set", value: "another" } })).toThrow("不能沿用");
    expect(editConfiguration(base, { enabled: false }).files.relay).toBeNull();
    expect(configurationSnapshot(f.root, "relay")).toEqual(base);
  } finally { await f.cleanup(); }
});

test("持久草稿绑定登录、修订、基础配置、期限；交接后退出或到期仍保留，迟到校验不能覆盖新编辑", async () => {
  const f = await tempFixture("console-config-draft-");
  try {
    let now = 1; const store = new ConfigurationDrafts(f.root, () => now);
    const opened = store.create("app", "session"), patch = { appId: "fixture", environment: "production", secret: { mode: "set", value: "fixture-secret" } };
    expect(() => store.view(opened.id, "other")).toThrow("过期");
    const edited = store.edit(opened.id, "session", opened.revision, patch), check = store.validationInput(opened.id, "session", edited.revision);
    expect(() => store.prepare(opened.id, "session")).toThrow("先校验");
    const changed = store.edit(opened.id, "session", edited.revision, { ...patch, secret: { mode: "set", value: "second-secret" } });
    expect(() => store.validated(opened.id, "session", edited.revision, check.digest, ["passed"])).toThrow("变化");
    const current = store.validationInput(opened.id, "session", changed.revision);
    store.validated(opened.id, "session", changed.revision, current.digest, ["应用凭据校验通过"]);
    const params = store.prepare(opened.id, "session"); expect(params.digest).toBe(configurationDigest(store.read(opened.id)));
    const task = "task-" + "a".repeat(32); store.bind(opened.id, params.digest, task); store.bind(opened.id, params.digest, task);
    expect(() => store.bind(opened.id, params.digest, "task-" + "b".repeat(32))).toThrow();
    store.end("session"); now += 31 * 60_000; store.prune(); expect(store.read(opened.id).next.files.app).toContain("second-secret");
    expect(() => store.edit(opened.id, "session", changed.revision, patch)).toThrow();
    const cancelled = store.create("app", "other"); store.discard(cancelled.id, "other"); expect(() => store.read(cancelled.id)).toThrow();
    const concurrent = store.create("app", "third"); write(f.root, CONFIGURATION_FILES.app, { appId: "fixture", appSecret: "some-secret", environment: "production" });
    expect(() => store.edit(concurrent.id, "third", 0, patch)).toThrow("已被其他操作修改");
    expect(readFileSync(join(f.root, CONFIGURATION_FILES.app), "utf8")).toContain("some-secret");
    now += 31 * 60_000; store.prune(); expect(() => store.read(concurrent.id)).toThrow();
  } finally { await f.cleanup(); }
});

test("控制台重开只清理已结束或未接单任务的私有草稿；活跃、未知和待恢复材料保留", async () => {
  const f = await tempFixture("console-config-reconcile-");
  try {
    let now = 1; const drafts = new ConfigurationDrafts(f.root, () => now), tasks = new TaskStore(join(f.root, ".console"), () => now);
    const make = (key: string) => {
      const view = drafts.create("app", key);
      const changed = drafts.edit(view.id, key, 0, { appId: "fixture", environment: "production", secret: { mode: "set", value: "private-fixture" } });
      const input = drafts.validationInput(view.id, key, changed.revision); drafts.validated(view.id, key, changed.revision, input.digest, ["校验通过"]);
      const params = drafts.prepare(view.id, key);
      const task = tasks.create({ project: f.root, planId: key, operation: "configuration-apply", params, mechanism: "systemd-system" }, key);
      drafts.bind(view.id, params.digest, task.id); return { draft: view.id, task: task.id };
    };
    const expired = make("expired"), finished = make("finished"), active = make("active"), blocked = make("blocked"), unknown = make("unknown");
    for (const item of [finished, active, blocked, unknown]) expect(tasks.accept(item.task, { pid: 1, startedAt: "fixture" })).toBe(true);
    for (const item of [finished, blocked]) tasks.finish(item.task, { outcome: "failed", exitCode: 1, finalState: "stopped", message: "已结束" });
    write(f.root, "data/state/configuration-change.json", { version: 1, id: blocked.draft, kind: "app", phase: "restoring", binding: null,
      rows: [{ key: "app", before: null, after: "a".repeat(64) }] });
    now += 31 * 60_000;
    await drafts.reconcile(tasks, { hosting: async request => request.id === active.task ? { state: "running", executor: { pid: 1, startedAt: "fixture" } } : { state: "unknown" }, needsRecovery: async () => true });
    for (const item of [expired, finished]) expect(() => drafts.read(item.draft)).toThrow();
    for (const item of [active, blocked, unknown]) expect(drafts.read(item.draft).next.files.app).toContain("private-fixture");
  } finally { await f.cleanup(); }
});
