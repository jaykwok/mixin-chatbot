import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationSnapshot, CONFIGURATION_FILES } from "../../scripts/config/configuration-form.ts";
import { installConfigurationStage, parseConfigurationStage, sameConfiguration, serializeConfigurationStage, stageName,
  type ConfigurationStage } from "../../scripts/config/configuration-stage.ts";
import { tempFixture } from "../helpers/temp.ts";

const installer = fileURLToPath(new URL("../../scripts/config/configuration-install.ts", import.meta.url));
const app = (secret: string) => JSON.stringify({ appId: "fixture", appSecret: secret, environment: "production" });
const models = (key: string) => JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: key,
  models: [{ id: "fixture", name: "合成模型", contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ["text"] }] } } });
const settings = (model = "fixture") => JSON.stringify({ defaultProvider: "fixture", defaultModel: model, defaultThinkingLevel: "low" });
const appStage = (base: string | null, next: string): ConfigurationStage<"app"> => ({ version: 1,
  base: { kind: "app", binding: null, files: { app: base } }, next: { kind: "app", binding: null, files: { app: next } } });
const modelsStage = (next: { models: string; settings: string; catalog: string | null }, base = { models: null, settings: null, catalog: null } as Record<string, string | null>):
  ConfigurationStage<"models"> => ({ version: 1, base: { kind: "models", binding: null, files: base }, next: { kind: "models", binding: null, files: next } });

test("配置暂存严格解析：多余字段、类型不符、缺启动必需的文件或应用身份不一致都拒绝，错误不引用内容", () => {
  const good = appStage(null, app("fixture-secret"));
  expect(parseConfigurationStage(serializeConfigurationStage(good), "app")).toEqual(good);
  const full = modelsStage({ models: models("fixture-private-key"), settings: settings(), catalog: null });
  expect(parseConfigurationStage(serializeConfigurationStage(full), "models")).toEqual(full);
  const binding = "a".repeat(64), bound = { ...good, base: { ...good.base, binding }, next: { ...good.next, binding } };
  expect(parseConfigurationStage(JSON.stringify(bound), "app")).toEqual(bound);
  const refused: [string, unknown, "app" | "models"][] = [
    ["多余字段", { ...good, extra: 1 }, "app"], ["版本", { ...good, version: 2 }, "app"],
    ["结果缺应用配置", { ...good, next: { ...good.next, files: { app: null } } }, "app"],
    ["类型与动作不符", good, "models"], ["快照类型不符", { ...good, base: { ...good.base, kind: "models" } }, "app"],
    ["多出的文件", { ...good, base: { ...good.base, files: { app: null, relay: null } } }, "app"],
    ["文件不是文本", { ...good, next: { ...good.next, files: { app: 1 } } }, "app"],
    ["应用身份不一致", { ...good, base: { ...good.base, binding } }, "app"],
    ["应用身份格式", { ...good, base: { ...good.base, binding: "A".repeat(64) }, next: { ...good.next, binding: "A".repeat(64) } }, "app"],
    ["结果缺模型设置", { ...full, next: { ...full.next, files: { ...full.next.files, settings: null } } }, "models"],
    ["缺模型目录键", { ...full, next: { ...full.next, files: { models: models("k"), settings: settings() } } }, "models"],
  ];
  for (const [label, value, kind] of refused) expect(() => parseConfigurationStage(JSON.stringify(value), kind), label).toThrow("格式不支持");
  let message = "";
  try { parseConfigurationStage('{"version":1,"base":"secret-in-broken-json', "app"); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("暂存的应用机器人配置无法读取");
  expect(sameConfiguration(bound.next, good.next)).toBe(false);
});

test("安装只覆盖停机前读到的配置：中断后再装不重复写，现场被改动时不覆盖，模型目录缓存随结果删除", async () => {
  const f = await tempFixture("configuration-stage-");
  try {
    const path = join(f.root, CONFIGURATION_FILES.app), stage = appStage(null, app("new-secret"));
    expect(await installConfigurationStage(f.root, stage)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(app("new-secret"));
    expect(await installConfigurationStage(f.root, stage)).toBe(false);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, app("someone-else"));
    await expect(installConfigurationStage(f.root, appStage(app("new-secret"), app("newer-secret")))).rejects.toThrow("在停机前确认之后被改动");
    expect(await readFile(path, "utf8")).toBe(app("someone-else"));

    const before = { models: models("old-key"), settings: settings(), catalog: "{}\n" };
    for (const key of ["models", "settings", "catalog"] as const) {
      await mkdir(dirname(join(f.root, CONFIGURATION_FILES[key])), { recursive: true });
      await writeFile(join(f.root, CONFIGURATION_FILES[key]), before[key]);
    }
    const next = modelsStage({ models: models("new-key"), settings: settings(), catalog: null }, before);
    expect(await installConfigurationStage(f.root, next)).toBe(true);
    expect(existsSync(join(f.root, CONFIGURATION_FILES.catalog))).toBe(false);
    expect(sameConfiguration(configurationSnapshot(f.root, "models"), next.next)).toBe(true);
    expect(await installConfigurationStage(f.root, next)).toBe(false);

    // Interrupted between two files: models.json already new, settings.json still old. Resuming writes only the rest;
    // a file that is neither is still refused.
    const current = configurationSnapshot(f.root, "models").files as Record<string, string | null>;
    const mixed = modelsStage({ models: models("newer-key"), settings: settings("other"), catalog: null }, current);
    await writeFile(join(f.root, CONFIGURATION_FILES.models), models("newer-key"));
    expect(await installConfigurationStage(f.root, mixed)).toBe(true);
    expect(sameConfiguration(configurationSnapshot(f.root, "models"), mixed.next)).toBe(true);
    const third = modelsStage({ models: models("third-key"), settings: settings("third"), catalog: null }, configurationSnapshot(f.root, "models").files as Record<string, string | null>);
    await writeFile(join(f.root, CONFIGURATION_FILES.settings), settings("someone-else"));
    await expect(installConfigurationStage(f.root, third)).rejects.toThrow("在停机前确认之后被改动");
    expect(await readFile(join(f.root, CONFIGURATION_FILES.models), "utf8")).toBe(models("newer-key"));
  } finally { await f.cleanup(); }
});

test("安装 CLI 先做离线校验再写入，只输出 JSON 结果，不打印凭据", async () => {
  const f = await tempFixture("configuration-install-");
  try {
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, installer, ...args], { cwd: f.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_OFFLINE: "1" } });
      const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(out + error).not.toMatch(/fixture-private-key|fixture-secret|secret-that-must-stay-private/);
      return { code, error, result: JSON.parse(out) as Record<string, unknown> & { outcome: string; result?: unknown; message?: string } };
    };
    const write = async (kind: "app" | "models", stage: ConfigurationStage) => {
      const file = join(f.root, "stage", stageName(kind));
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, serializeConfigurationStage(stage));
      return file;
    };
    const modelsFile = await write("models", modelsStage({ models: models("fixture-private-key"), settings: settings(), catalog: null }));
    const done = await run("--kind", "models", "--stage", modelsFile, "--json");
    expect(done.code, done.error).toBe(0);
    expect(done.result).toEqual({ protocol: "mixin-maintenance", version: 1, command: "install", outcome: "success", result: { installed: true } });
    expect((await run("--kind", "models", "--stage", modelsFile, "--json")).result.result).toEqual({ installed: false });

    const appFile = await write("app", appStage(null, app("fixture-secret")));
    expect((await run("--kind", "app", "--stage", appFile, "--json")).result.result).toEqual({ installed: true });
    expect(await readFile(join(f.root, CONFIGURATION_FILES.app), "utf8")).toBe(app("fixture-secret"));

    // Pi refuses a default model the providers do not have: nothing is written.
    const bad = await write("models", modelsStage({ models: models("secret-that-must-stay-private"), settings: settings("missing"), catalog: null },
      { models: models("fixture-private-key"), settings: settings(), catalog: null }));
    const failed = await run("--kind", "models", "--stage", bad, "--json");
    expect([failed.code, failed.result.outcome]).toEqual([1, "failed"]); expect(failed.result.message).toContain("没有安装");
    expect(await readFile(join(f.root, CONFIGURATION_FILES.models), "utf8")).toBe(models("fixture-private-key"));

    for (const args of [["--kind", "app", "--stage", appFile], ["--kind", "relay", "--stage", appFile, "--json"], ["--kind", "app", "--json"],
      ["--kind", "app", "--stage", appFile, "--json", "--extra"]]) {
      const usage = await run(...args);
      expect([usage.code, usage.result.outcome], args.join(" ")).toEqual([1, "refused"]);
    }
    const wrongKind = await run("--kind", "app", "--stage", modelsFile, "--json");
    expect(wrongKind.result.outcome).toBe("failed"); expect(wrongKind.result.message).toContain("格式不支持");
  } finally { await f.cleanup(); }
});
