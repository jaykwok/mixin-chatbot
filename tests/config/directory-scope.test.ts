// The deployment's directory-scope tool (ops/config/directory-scope.ts). Departments are only ticked in its terminal
// wizard; BOT_DIRECTORY_SCOPE takes only the whole directory. The tool's own processes get the whole directory, another
// value it refuses before any client is made, or a project without application credentials, so they never reach a platform.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installScopePlan, parseScopeArgs, scopeFromEnvironment, stagedAppBotConfig } from "../../ops/config/directory-scope.ts";
import { serializeConfigurationStage } from "../../ops/config/configuration-stage.ts";
import { WHOLE_DIRECTORY } from "../../src/integrations/open-platform/directory-scope.ts";
import { tempFixture } from "../helpers/temp.ts";

const TOOL = fileURLToPath(new URL("../../ops/config/directory-scope.ts", import.meta.url));
const fixture = await tempFixture("directory-scope-tool-");
afterAll(() => fixture.cleanup());

let serial = 0;
/** A project without data/config/app-bot.json: the tool cannot build a platform client in it. */
async function project() {
  const root = join(fixture.root, `project-${++serial}`);
  await mkdir(join(root, "data", "config"), { recursive: true });
  return { root, scope: join(root, "data", "config", "directory.json"), plan: join(root, "plan.json") };
}

/** Runs the tool in `cwd` with BOT_DIRECTORY_SCOPE set only when `scope` is given; stdin is no terminal. */
async function tool(cwd: string, args: string[], scope?: string) {
  const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  delete env.BOT_DIRECTORY_SCOPE;
  if (scope !== undefined) env.BOT_DIRECTORY_SCOPE = scope;
  const child = Bun.spawn([process.execPath, TOOL, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

test("arguments are strict: one command, known flags once each with a value; both commands need a plan", () => {
  expect(parseScopeArgs(["choose", "--plan", "p.json", "--project", "/srv/bot"])).toEqual({ command: "choose", plan: "p.json", project: "/srv/bot" });
  expect(parseScopeArgs(["install", "--project", "/srv/bot", "--plan", "p.json"])).toEqual({ command: "install", plan: "p.json", project: "/srv/bot" });
  expect(parseScopeArgs(["install", "--plan", "p.json", "--json"])).toEqual({ command: "install", plan: "p.json", json: true });
  for (const argv of [[], ["apply"], ["choose"], ["--plan", "p.json", "choose"], ["choose", "--plan"], ["choose", "--plan", "--project"], ["choose", "--plan", ""],
    ["choose", "--plan", "a", "--plan", "b"], ["choose", "--plan", "p.json", "--env-only"], ["choose", "--plan", "p.json", "extra"], ["choose", "--projects", "x"],
    ["install"], ["install", "--project", "x"], ["install", "--plan", "p.json", "--env-only"], ["choose", "--plan", "p.json", "--json"],
    ["install", "--plan", "p.json", "--json", "--json"]]) {
    expect(() => parseScopeArgs(argv)).toThrow("用法：");
  }
  expect(parseScopeArgs(["choose", "--app", "stage/configuration-app.json", "--plan", "p.json"]))
    .toEqual({ command: "choose", app: "stage/configuration-app.json", plan: "p.json" });
  for (const argv of [["install", "--plan", "p.json", "--app", "a.json"], ["choose", "--plan", "p.json", "--app", "a", "--app", "b"], ["choose", "--plan", "p.json", "--app"]])
    expect(() => parseScopeArgs(argv)).toThrow("用法：");
});

test("a first deployment checks departments with the application credentials staged before the stop; their content never shows in errors", async () => {
  const { root } = await project(), file = join(root, "configuration-app.json");
  const stage = (app: string) => serializeConfigurationStage({ version: 1, base: { kind: "app", binding: null, files: { app: null } },
    next: { kind: "app", binding: null, files: { app } } });
  await writeFile(file, stage(JSON.stringify({ appId: "fixture", appSecret: "fixture-secret", environment: "staging" })));
  expect(stagedAppBotConfig(file)).toEqual({ appId: "fixture", appSecret: "fixture-secret", environment: "staging" });
  const refusal = async (content: string | null, message: string) => {
    if (content === null) await rm(file, { force: true }); else await writeFile(file, content);
    let error: unknown;
    try { stagedAppBotConfig(file); } catch (caught) { error = caught; }
    expect((error as Error).message).toContain(message); expect((error as Error).message).not.toContain("secret-in-stage");
  };
  await refusal(stage('{"appId":"fixture","appSecret":"secret-in-stage"'), "暂存的 app-bot.json 不是有效的 JSON");
  await refusal(stage(JSON.stringify({ appId: "fixture", appSecret: "secret-in-stage", extra: 1 })), "未知字段");
  await refusal('{"version":1,"base":"secret-in-stage', "暂存的应用机器人配置无法读取");
  await refusal(null, "读不到暂存的应用机器人配置");
});

test("范围安装的 JSON 协议与中文日志分流，错误参数不写入范围", async () => {
  const { root, scope, plan } = await project();
  await writeFile(plan, JSON.stringify({ format: 1, all: true }));
  const run = await tool(root, ["install", "--project", root, "--plan", plan, "--json"]);
  expect(run.code).toBe(0); expect(JSON.parse(run.stdout)).toMatchObject({ protocol: "mixin-maintenance", version: 1, command: "install", outcome: "success", result: null });
  expect(run.stderr).toContain("已写入通讯录同步范围：整个通讯录");
  const before = await readFile(scope, "utf8");
  const failed = await tool(root, ["install", "--project", root, "--plan", plan, "--json", "--plans", plan]);
  expect(failed.code).toBe(1); expect(JSON.parse(failed.stdout)).toMatchObject({ command: "install", outcome: "failed" });
  expect(failed.stderr).toContain("用法："); expect(await readFile(scope, "utf8")).toBe(before);
});

test("BOT_DIRECTORY_SCOPE takes only all: department IDs, the root's alias and anything else are refused", () => {
  expect(scopeFromEnvironment("all")).toEqual(WHOLE_DIRECTORY);
  expect(scopeFromEnvironment(" all \n")).toEqual(WHOLE_DIRECTORY);
  for (const value of ["", "100", "100,200", "100，200", "all,100", "1", "ALL", "*"]) {
    expect(() => scopeFromEnvironment(value)).toThrow("BOT_DIRECTORY_SCOPE 只接受 all（整个通讯录），不接受部门 ID；只同步部分部门时请清除这个变量，在终端里运行，由向导逐层勾选");
  }
});

test("install writes a valid plan as the scope file; a malformed plan, a missing one or the root's alias leaves the scope file as it was", async () => {
  const { root, scope, plan } = await project();
  await writeFile(plan, JSON.stringify({ format: 1, departments: ["100", "200"] }));
  expect(await installScopePlan(plan, root)).toEqual({ kind: "departments", departments: ["100", "200"] });
  expect(JSON.parse(await readFile(scope, "utf8"))).toEqual({ format: 1, departments: ["100", "200"] });
  for (const bad of [{ format: 1, departments: ["1"] }, { format: 1, all: false }, { format: 1 }, { format: 2, all: true }, { format: 1, all: true, extra: 1 }]) {
    await writeFile(plan, JSON.stringify(bad));
    await expect(installScopePlan(plan, root)).rejects.toThrow();
  }
  await writeFile(plan, "{");
  await expect(installScopePlan(plan, root)).rejects.toThrow("读不到通讯录同步范围的计划文件");
  await expect(installScopePlan(join(root, "missing.json"), root)).rejects.toThrow("读不到通讯录同步范围的计划文件");
  expect(JSON.parse(await readFile(scope, "utf8"))).toEqual({ format: 1, departments: ["100", "200"] });
  await writeFile(plan, JSON.stringify({ format: 1, all: true }));
  expect(await installScopePlan(plan, root)).toEqual(WHOLE_DIRECTORY);
  expect(JSON.parse(await readFile(scope, "utf8"))).toEqual({ format: 1, all: true });
});

test("the tool: all from the environment goes to the plan; without a plan, a choice, a terminal or credentials it fails and writes nothing", async () => {
  const { root, scope, plan } = await project();
  // Before the stop: the choice goes to the plan only.
  let run = await tool(root, ["choose", "--plan", plan, "--project", root], "all");
  expect([run.code, run.stdout.trim(), run.stderr]).toEqual([0, "已选择通讯录同步范围：整个通讯录（停止服务后写入 data/config/directory.json）", ""]);
  expect(JSON.parse(await readFile(plan, "utf8"))).toEqual({ format: 1, all: true });
  expect(existsSync(scope)).toBe(false);
  // After the stop: install the plan.
  run = await tool(root, ["install", "--plan", plan, "--project", root]);
  expect([run.code, run.stdout.trim()]).toEqual([0, "已写入通讯录同步范围：整个通讯录"]);
  expect(JSON.parse(await readFile(scope, "utf8"))).toEqual({ format: 1, all: true });

  const empty = await project();
  const failures: [string[], string | undefined, string][] = [
    // The choice only ever goes to a plan: the deployment installs it after the stop.
    [["choose", "--project", empty.root], " all ", "用法："],
    // No terminal, no wizard.
    [["choose", "--plan", empty.plan, "--project", empty.root], undefined, "没有终端，不能运行通讯录同步范围的选择向导；请设置 BOT_DIRECTORY_SCOPE=all（整个通讯录）后重试；只同步部分部门时请在终端里运行，由向导逐层勾选"],
    // Department IDs are refused before anything reads the credentials (this project has none) or reaches a platform.
    [["choose", "--plan", empty.plan, "--project", empty.root], "100,200", "BOT_DIRECTORY_SCOPE 只接受 all（整个通讯录），不接受部门 ID"],
    [["choose", "--plan", empty.plan, "--project", empty.root], "all,100", "BOT_DIRECTORY_SCOPE 只接受 all"],
    [["choose", "--plan", empty.plan, "--project", empty.root], "1", "BOT_DIRECTORY_SCOPE 只接受 all"],
    [["install", "--plan", empty.plan, "--project", empty.root], undefined, "读不到通讯录同步范围的计划文件"],
    [["choose", "--plan"], "all", "用法："],
    [["install", "--project", empty.root], undefined, "用法："],
    [["choose", "--plan", empty.plan, "--project", empty.root, "--force"], "all", "用法："],
  ];
  for (const [args, value, message] of failures) {
    run = await tool(empty.root, args, value);
    expect(run.code, `${args.join(" ")}: ${run.stdout}${run.stderr}`).toBe(1);
    expect(run.stderr).toContain(message);
  }
  expect([existsSync(empty.plan), existsSync(empty.scope)]).toEqual([false, false]);
});
