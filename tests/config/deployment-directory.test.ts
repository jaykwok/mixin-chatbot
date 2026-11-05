import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { directoryAppHash, consoleDirectoryScope } from "../../scripts/lib/directory-choice.ts";
import { deploymentEnvironment } from "../../scripts/ops/console/deployment-options.ts";
import { parseDirectoryQuery, queryDeploymentDirectory } from "../../scripts/config/directory-query.ts";
import { tempFixture } from "../helpers/temp.ts";
import { FakePlatform, json } from "../helpers/fake-platform.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";

test("真实平台客户端通过本机合成平台查询部门，不连接 Stream 或读取成员；拒绝权限与配置变化", async () => {
  const f = await tempFixture("deployment-directory-platform-"), platform = new FakePlatform();
  try {
    mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/app-bot.json"), JSON.stringify(platform.config));
    platform.directory = { children: { "1": ["d2"], "d2": ["d3"] }, members: {}, ids: {}, info: { d2: { name: "研发部" }, d3: { name: "测试部" } } };
    const make = (config: typeof platform.config) => new PlatformClient(config, { endpoints: platform.endpoints, retryDelaysMs: [] });
    const root = await queryDeploymentDirectory(f.root, "children", { ids: ["1"] }, make);
    expect(root.departments.map(item => item.id)).toEqual(["d2"]);
    const verified = await queryDeploymentDirectory(f.root, "verify", { ids: ["d2", "d3"] }, make);
    expect(verified.departments.map(item => item.id)).toEqual(["d2", "d3"]);
    expect(verified.appHash).toBe(directoryAppHash(f.root));
    platform.route("POST /open/v2/dept/get", () => json({ code: 422010, message: "synthetic refusal" }));
    await expect(queryDeploymentDirectory(f.root, "verify", { ids: ["d2"] }, make)).rejects.toThrow();
    platform.route("POST /open/v2/dept/get", () => { writeFileSync(join(f.root, "data/config/app-bot.json"), JSON.stringify({ ...platform.config, appId: "changed" })); return platform.encrypted({ dept_id: "d2", name: "合成部门" }); });
    await expect(queryDeploymentDirectory(f.root, "verify", { ids: ["d2"] }, make)).rejects.toThrow("配置已变化");
    expect(platform.requestsTo("/open/v2/dept/users/list")).toHaveLength(0); expect(platform.sockets.size).toBe(0);
    expect(platform.requestsTo("/open-apis/v1/events/stream")).toHaveLength(0); expect(existsSync(join(f.root, "data/config/directory.json"))).toBe(false);
  } finally { platform.stop(); await f.cleanup(); }
});

test("部门查询 CLI 的 stdout 只留结果，失败时不在部署目录或当前目录留下日志", async () => {
  const f = await tempFixture("directory-query-cli-"), project = join(f.root, "project"), cwd = join(f.root, "cwd");
  try {
    mkdirSync(join(project, "data/config"), { recursive: true }); mkdirSync(cwd);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/config/directory-query.ts"), "children", project],
      { cwd, stdin: Buffer.from(JSON.stringify({ ids: ["1"] })), stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(out).toBe(""); expect(err).toContain("部门查询未完成");
    for (const dir of [project, cwd]) expect(existsSync(join(dir, "logs"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("内部部门查询严格限制动作、根别名和数量；不接受任意平台路径或成员查询", () => {
  expect(parseDirectoryQuery("children", { ids: ["1"] })).toEqual(["1"]);
  expect(parseDirectoryQuery("verify", { ids: ["d_1"] })).toEqual(["d_1"]);
  for (const [action, input] of [["members", { ids: ["d1"] }], ["verify", { ids: ["1"] }], ["children", { ids: ["1", "2"] }],
    ["children", { ids: ["1"], path: "/elsewhere" }], ["verify", { ids: [] }], ["verify", { ids: ["d1", "d1"] }]] as const) {
    expect(() => parseDirectoryQuery(action, input)).toThrow();
  }
});

test("真实 CLI 把已核对选择写入事务计划；配置变化或传输错误不保存，续做只读原计划", async () => {
  const f = await tempFixture("console-directory-cli-");
  try {
    mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/app-bot.json"), '{"synthetic":true}');
    const params = { port: 2022, workspace: "", cleanup: "skip", directory: { departments: ["department-a"], names: ["合成部门"], appHash: directoryAppHash(f.root) } };
    const env = { ...process.env, ...deploymentEnvironment("deploy", params, f.root), MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "fixture" };
    const path = join(f.root, "plan.json"), scope = join(f.root, "data/config/directory.json");
    const run = async (action: string, overrides: NodeJS.ProcessEnv = {}) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/config/directory-scope.ts"), action, "--project", f.root, "--plan", path],
        { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...env, ...overrides } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, out, err };
    };
    for (const overrides of [{ MIXIN_OPS_TASK_ID: "" }, { MIXIN_OPS_CONSOLE: "" }, { MIXIN_OPS_DIRECTORY_APP: "a".repeat(64) },
      { MIXIN_OPS_DIRECTORY_INPUT: '{"format":1,"departments":["1"]}' }, { MIXIN_OPS_DIRECTORY_INPUT: "{}" }, { BOT_DIRECTORY_SCOPE: "all" }]) {
      expect((await run("choose", overrides)).code).toBe(1); expect(existsSync(path)).toBe(false); expect(existsSync(scope)).toBe(false);
    }
    const chosen = await run("choose"); expect(chosen.code, chosen.out + chosen.err).toBe(0); expect(chosen.out).toContain("停止服务后写入");
    expect(existsSync(scope)).toBe(false); expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ format: 1, departments: ["department-a"] });
    writeFileSync(join(f.root, "data/config/app-bot.json"), '{"rotated":true}');
    expect(() => consoleDirectoryScope(f.root, env)).toThrow("已变化"); expect((await run("choose")).code).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ format: 1, departments: ["department-a"] });
    const installed = await run("install", { MIXIN_OPS_CONSOLE: "", MIXIN_OPS_TASK_ID: "", MIXIN_OPS_DIRECTORY: "", MIXIN_OPS_DIRECTORY_INPUT: "", MIXIN_OPS_DIRECTORY_APP: "" });
    expect(installed.code, installed.out + installed.err).toBe(0); expect(JSON.parse(readFileSync(scope, "utf8"))).toEqual({ format: 1, departments: ["department-a"] });
  } finally { await f.cleanup(); }
}, 30_000);
