import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkConfiguration, configurationCatalog } from "../../ops/config/configuration-check.ts";
import type { ConfigurationSnapshot } from "../../ops/config/configuration-form.ts";
import { tempFixture } from "../helpers/temp.ts";

const source = fileURLToPath(new URL("../../ops/config/configuration-check.ts", import.meta.url));
const snapshot = (): ConfigurationSnapshot => ({ kind: "models", binding: null, files: {
  models: JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-private-key",
    models: [{ id: "fixture", name: "合成模型", contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ["text"] }] } } }),
  settings: JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "low" }), catalog: null,
} });

test("配置校验使用真实 Pi 启动路径，私有草稿目录无论成败均移除，不执行模型请求", async () => {
  const f = await tempFixture("configuration-check-");
  try {
    const temporaryRoot = join(f.root, "private-tmp");
    const valid = snapshot(), result = await checkConfiguration(valid, { root: f.root, temporaryRoot });
    expect(result.success).toBe(true); expect(result.summary.join()).toContain("fixture/fixture"); expect(JSON.stringify(result)).not.toContain("fixture-private-key");
    const invalid = snapshot(); invalid.files.settings = JSON.stringify({ defaultProvider: "fixture", defaultModel: "missing" });
    await expect(checkConfiguration(invalid, { root: f.root, temporaryRoot })).rejects.toThrow("Pi 校验");
    expect(await readdir(temporaryRoot)).toEqual([]);
    await expect(readFile(join(f.root, "data/config/models.json"))).rejects.toThrow();
  } finally { await f.cleanup(); }
});

test("模型配置让 auxiliary.json 的引用落空时，停机前就拒绝并指明引用；不带出凭据", async () => {
  const f = await tempFixture("configuration-check-auxiliary-");
  try {
    const temporaryRoot = join(f.root, "private-tmp");
    await mkdir(join(f.root, "data/config"), { recursive: true });
    await writeFile(join(f.root, "data/config/auxiliary.json"), JSON.stringify({ format: 1, classifier: { provider: "other-gw", modelId: "house-classifier" } }));
    const error = await checkConfiguration(snapshot(), { root: f.root, temporaryRoot }).then(() => null, (reason: Error) => reason);
    expect(error?.message).toContain("auxiliary.json 引用的 classifier 模型 other-gw/house-classifier");
    expect(error?.message).not.toContain("fixture-private-key");
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally { await f.cleanup(); }
});

test("应用和外链校验复用现有解析器，离线结果不声称凭据或云端已通过", async () => {
  const f = await tempFixture("configuration-parser-");
  try {
    const app: ConfigurationSnapshot = { kind: "app", binding: null, files: { app: JSON.stringify({ appId: "fixture", appSecret: "fixture-secret", environment: "production" }) } };
    const result = await checkConfiguration(app, { root: f.root }); expect(result.summary.join()).toContain("尚未在线验证"); expect(JSON.stringify(result)).not.toContain("fixture-secret");
    const off = await checkConfiguration({ kind: "relay", binding: null, files: { relay: null } }, { root: f.root });
    expect(off.summary.join()).toContain("停用"); expect(off.summary.join()).toContain("没有向云端上传");
    await expect(checkConfiguration({ kind: "relay", binding: null, files: { relay: '{"provider":"other"}' } }, { root: f.root })).rejects.toThrow("s3");
  } finally { await f.cleanup(); }
});

test("内部校验 CLI 只接受命名动作和严格协议，中文通过 stdin，错误不泄漏凭据", async () => {
  const f = await tempFixture("configuration-check-cli-");
  try {
    const run = async (args: string[], input: unknown) => {
      const child = Bun.spawn([process.execPath, source, ...args], { cwd: f.root, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
      const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, out, error };
    };
    const good = await run(["check"], { version: 1, snapshot: snapshot() }); expect(good.code).toBe(0); expect(JSON.parse(good.out).success).toBe(true);
    const bad = snapshot(); bad.files.models = JSON.stringify({ providers: { fixture: { apiKey: "secret-that-must-stay-private", models: [{ id: "fixture", contextWindow: "bad" }] } } });
    const failed = await run(["check"], { version: 1, snapshot: bad }); expect(failed.code).toBe(1); expect(failed.out).toBe(""); expect(failed.error).not.toContain("secret-that");
    expect((await run(["check", "--ignored"], {})).code).toBe(1); expect((await run(["check"], { version: 1, snapshot: snapshot(), unrecognised: true })).code).toBe(1);
  } finally { await f.cleanup(); }
});

test("内置服务商、协议和模型目录来自 Pi，不读取部署配置", async () => {
  const result = await configurationCatalog();
  expect(result.providers.some(value => value.id === "openai")).toBe(true);
  expect(result.apis).toContain("openai-completions"); expect(result.models.length).toBeGreaterThan(0);
  expect(result.models.some(value => value.provider === "openai")).toBe(true);
});
