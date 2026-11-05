import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeConfigurationStage, stageName } from "../../scripts/config/configuration-stage.ts";
import { parseRuntimeValues, RUNTIME_VALUES_FILE, runtimeDigest, runtimeText, serializeRuntimeValues } from "../../scripts/config/runtime-values.ts";
import { DEPLOY_CHOICES_FILE, readDeployStage, STAGE_UNCHANGED } from "../../scripts/ops/core/deploy-stage.ts";
import { DeploymentGit } from "../../scripts/ops/core/deployment-git.ts";
import { MaintenanceRefused } from "../../scripts/ops/core/maintenance.ts";
import { tempFixture } from "../helpers/temp.ts";

const head = "c".repeat(40), digest = "d".repeat(64);
const choices = { format: 1 as const, target: head, port: 1011, workspace: "", cleanup: "apply" as const };
const runtime = serializeRuntimeValues({ format: 1, base: null, values: { BOT_PORT: "1011" } });
const app = { version: 1, base: { kind: "app", binding: null, files: { app: null } },
  next: { kind: "app", binding: null, files: { app: JSON.stringify({ appId: "fixture", appSecret: "fixture-secret", environment: "production" }) } } } as const;

async function stage(root: string, name: string, files: Record<string, string | Uint8Array>) {
  const dir = join(root, name); await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  return dir;
}
function refusal(path: string): Error {
  try { readDeployStage(path); } catch (error) { return error as Error; }
  throw new Error("部署暂存被接受了");
}

test("部署暂存读出选择、运行参数、计划、配置暂存和平台记录；没有的文件为空", async () => {
  const f = await tempFixture("core-deploy-stage-");
  try {
    const minimal = readDeployStage(await stage(f.root, "minimal", { [DEPLOY_CHOICES_FILE]: JSON.stringify(choices), [RUNTIME_VALUES_FILE]: runtime }));
    expect(minimal).toEqual({ choices, runtime: { text: runtime, value: { format: 1, base: null, values: { BOT_PORT: "1011" } } }, plan: null,
      directoryPlan: null, configuration: {}, platform: {} });
    const workspace = join(f.root, "shared"), full = readDeployStage(await stage(f.root, "full", {
      [DEPLOY_CHOICES_FILE]: JSON.stringify({ ...choices, target: "", workspace, cleanup: "skip" }), [RUNTIME_VALUES_FILE]: runtime,
      "data-plan.json": '{"plan":1}', "directory-scope-plan.json": '{"kind":"all"}', [stageName("app")]: serializeConfigurationStage(app),
      "candidate-image": "image=sha256:x\n", facts: "format=1\n", unrelated: "ignored" }));
    expect(full).toMatchObject({ choices: { target: "", workspace, cleanup: "skip" }, plan: '{"plan":1}', directoryPlan: '{"kind":"all"}',
      configuration: { app: { text: serializeConfigurationStage(app), stage: app } }, platform: { "candidate-image": "image=sha256:x\n", facts: "format=1\n" } });
    expect(Object.keys(full.platform).sort()).toEqual(["candidate-image", "facts"]);
  } finally { await f.cleanup(); }
});

test("部署暂存的每种缺陷都在停机前拒绝，并说明服务尚未停止", async () => {
  const f = await tempFixture("core-deploy-stage-refused-");
  try {
    const good = { [DEPLOY_CHOICES_FILE]: JSON.stringify(choices), [RUNTIME_VALUES_FILE]: runtime };
    await writeFile(join(f.root, "file"), "");
    const cases: [string, string | Record<string, string | Uint8Array>][] = [
      ["部署暂存目录不存在", join(f.root, "missing")], ["部署暂存目录不存在", join(f.root, "file")],
      ["部署暂存不完整", { [DEPLOY_CHOICES_FILE]: good[DEPLOY_CHOICES_FILE] }], ["部署暂存不完整", { [RUNTIME_VALUES_FILE]: runtime }],
      ["部署选择无法读取", { ...good, [DEPLOY_CHOICES_FILE]: "{" }],
      ...[{ ...choices, command: "deploy" }, { ...choices, format: 2 }, { ...choices, port: 0 }, { ...choices, port: "1011" }, { ...choices, workspace: "relative" },
        { ...choices, workspace: "/a\nb" }, { ...choices, cleanup: "no-backup" }, { ...choices, target: "c".repeat(39) }]
        .map(value => ["部署选择格式不支持", { ...good, [DEPLOY_CHOICES_FILE]: JSON.stringify(value) }] as [string, Record<string, string>]),
      ["端口与部署选择不一致", { ...good, [DEPLOY_CHOICES_FILE]: JSON.stringify({ ...choices, port: 1012 }) }],
      ["运行参数暂存格式不支持", { ...good, [RUNTIME_VALUES_FILE]: JSON.stringify({ format: 1, base: "x", values: { BOT_PORT: "1011" } }) }],
      ["未知运行配置", { ...good, [RUNTIME_VALUES_FILE]: JSON.stringify({ format: 1, base: null, values: { BOT_PORT: "1011", OTHER: "1" } }) }],
      ["暂存的应用机器人配置格式不支持", { ...good, [stageName("app")]: JSON.stringify({ ...app, version: 2 }) }],
      ["暂存的模型配置格式不支持", { ...good, [stageName("models")]: serializeConfigurationStage(app) }],
      ["部署输入文件无法完整读取", { ...good, facts: new Uint8Array([0xff, 0xfe]) }],
    ];
    let index = 0;
    for (const [expected, files] of cases) {
      const error = refusal(typeof files === "string" ? files : await stage(f.root, `case-${index++}`, files));
      expect(error, expected).toBeInstanceOf(MaintenanceRefused);
      expect(error.message, expected).toContain(expected); expect(error.message.endsWith(STAGE_UNCHANGED), expected).toBe(true);
      expect(error.message).not.toContain("fixture-secret");
    }
  } finally { await f.cleanup(); }
});

test("运行参数暂存严格解析；安装的文本与 runtime-settings 一直写出的格式一致", () => {
  expect(parseRuntimeValues(JSON.stringify({ format: 1, base: digest, values: { BOT_PORT: 1012, BOT_HOST: " ::1 " } })))
    .toEqual({ format: 1, base: digest, values: { BOT_PORT: "1012", BOT_HOST: "::1" } });
  for (const value of [{ format: 1, base: null }, { format: 2, base: null, values: {} }, { format: 1, base: null, values: {}, extra: 1 },
    { format: 1, base: digest.toUpperCase(), values: {} }, [], null])
    expect(() => parseRuntimeValues(JSON.stringify(value)), JSON.stringify(value)).toThrow("运行参数暂存格式不支持");
  expect(() => parseRuntimeValues("{")).toThrow("运行参数暂存无法读取");
  expect(() => parseRuntimeValues(JSON.stringify({ format: 1, base: null, values: { BOT_PORT: "0" } }))).toThrow("BOT_PORT 必须是 1-65535 的整数");
  expect(runtimeText({ BOT_PORT: "1011" })).toBe('{\n  "BOT_PORT": "1011"\n}\n');
  expect(() => runtimeText({ BOT_HOST: "0.0.0.0" })).toThrow("回环地址");
  expect(runtimeDigest(null)).toBeNull(); expect(runtimeDigest("x")).toMatch(/^[a-f0-9]{64}$/);
  expect(serializeRuntimeValues({ format: 1, base: digest, values: { BOT_PORT: "1011" } })).toBe(`{"format":1,"base":"${digest}","values":{"BOT_PORT":"1011"}}\n`);
});

test("部署读 HEAD：不是仓库或还没有提交时为空，读取失败时为空，取消时抛出", async () => {
  const f = await tempFixture("core-deploy-head-");
  try {
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-C", f.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0); return out.trim();
    };
    const core = new DeploymentGit(f.root);
    expect(await core.head()).toBe("");
    await git("init", "--quiet");
    expect(await core.head()).toBe("");
    await git("commit", "--quiet", "--allow-empty", "-m", "fixture");
    expect(await core.head()).toBe(await git("rev-parse", "HEAD"));
    expect(await new DeploymentGit(f.root, undefined, undefined, undefined, join(f.root, "missing-git")).head()).toBe("");
    const failing = new DeploymentGit(f.root, async () => { throw new Error("spawn failed"); });
    expect(await failing.head()).toBe("");
    const controller = new AbortController(); controller.abort();
    await expect(failing.head(controller.signal)).rejects.toThrow("spawn failed");
  } finally { await f.cleanup(); }
});
