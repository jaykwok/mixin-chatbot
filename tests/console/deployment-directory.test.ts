import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeploymentDirectory, type DepartmentQuery } from "../../scripts/ops/console/deployment-directory.ts";
import { directoryAppHash } from "../../scripts/lib/directory-choice.ts";
import { deploymentEnvironment } from "../../scripts/ops/console/deployment-options.ts";
import { operationPreparer } from "../../scripts/ops/console/prepare-operation.ts";
import { Views } from "../../scripts/ops/console/views.ts";
import type { RouteContext } from "../../scripts/ops/console/routes.ts";
import { tempFixture } from "../helpers/temp.ts";

const context = (body: unknown = {}, label = "one"): RouteContext => ({ body, session: { label } as RouteContext["session"], signal: new AbortController().signal });
interface Opened { view: string; children: { key: string; name: string }[] }
async function fixture() {
  const f = await tempFixture("deployment-directory-");
  mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/app-bot.json"), '{"secret":"synthetic-private"}');
  const calls: { action: string; ids: string[] }[] = [], state = { time: 1000, fail: false, incomplete: false, during: () => {} };
  const query: DepartmentQuery = async (action, ids) => {
    calls.push({ action, ids }); const appHash = directoryAppHash(f.root); state.during();
    if (state.fail) throw new Error("合成平台不可用");
    const departments = action === "children" ? [{ id: ids[0] === "1" ? "dept-root" : "dept-child", name: "研发部" }] : ids.map(id => ({ id, name: "已核对部门" }));
    return { appHash, departments: state.incomplete ? [] : departments };
  };
  const picker = new DeploymentDirectory(f.root, query, () => state.time), routes = picker.routes();
  const open = (label = "one") => routes["POST /api/lifecycle/directory/open"]!.run(context({}, label)) as Promise<Opened>;
  return { ...f, picker, routes, open, calls, state };
}

test("机器人停止时直接查部门；只接受当前登录的树键，预览重新核对且不写配置", async () => {
  const f = await fixture();
  try {
    const opened = await f.open(), key = opened.children[0]!.key;
    expect(JSON.stringify(opened)).not.toContain("dept-root"); expect(JSON.stringify(opened)).not.toContain("synthetic-private");
    expect(f.calls).toEqual([{ action: "children", ids: ["1"] }]);
    const children = await f.routes["POST /api/lifecycle/directory/children"]!.run(context({ view: opened.view, parent: key })) as { children: { key: string }[] };
    const prepare = operationPreparer(f.root, new Views(), undefined, undefined, undefined, undefined, undefined, f.picker);
    const input = { port: 2022, workspace: "", cleanup: "skip", directory: { view: opened.view, selected: [children.children[0]!.key] } };
    const params = await prepare("deploy", input, "one");
    expect(params.directory).toEqual({ departments: ["dept-child"], names: ["已核对部门"], appHash: directoryAppHash(f.root) });
    expect(f.calls.at(-1)).toEqual({ action: "verify", ids: ["dept-child"] });
    const env = deploymentEnvironment("deploy", params, f.root);
    expect(env.MIXIN_OPS_DIRECTORY).toBe("selected"); expect(env.BOT_DIRECTORY_SCOPE).toBe("");
    expect(JSON.parse(env.MIXIN_OPS_DIRECTORY_INPUT!)).toEqual({ format: 1, departments: ["dept-child"] });
    expect(env.MIXIN_OPS_DIRECTORY_INPUT).not.toContain("已核对部门");
    await expect(prepare("deploy", params, "one")).rejects.toThrow("参数无效"); // Browser cannot bypass the tree with normalized task data.
    await expect(prepare("deploy", input, "two")).rejects.toThrow("过期");
    await expect(f.picker.prepare({ view: opened.view, selected: ["dept-root"] }, "one")).rejects.toThrow("手填");
    await expect(f.picker.prepare({ view: opened.view, selected: [key, key] }, "one")).rejects.toThrow("重复");
    await expect(f.picker.prepare({ view: opened.view, selected: [] }, "one")).rejects.toThrow("请选择");
    expect(existsSync(join(f.root, "data/config/directory.json"))).toBe(false);
    expect(existsSync(join(f.root, "data/state"))).toBe(false);
    expect(existsSync(join(f.root, ".console"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("部署部门草稿拒绝过期、配置变化、平台拒绝和不完整核对", async () => {
  const f = await fixture();
  try {
    let opened = await f.open(); let input = { view: opened.view, selected: [opened.children[0]!.key] };
    f.state.fail = true; await expect(f.picker.prepare(input, "one")).rejects.toThrow("不可用"); f.state.fail = false;
    f.state.incomplete = true; await expect(f.picker.prepare(input, "one")).rejects.toThrow("不完整"); f.state.incomplete = false;
    f.state.time += 600_000; await expect(f.picker.prepare(input, "one")).rejects.toThrow("过期");
    opened = await f.open(); input = { view: opened.view, selected: [opened.children[0]!.key] };
    writeFileSync(join(f.root, "data/config/app-bot.json"), "{}"); await expect(f.picker.prepare(input, "one")).rejects.toThrow("已变化");
    opened = await f.open(); input = { view: opened.view, selected: [opened.children[0]!.key] };
    f.state.during = () => writeFileSync(join(f.root, "data/config/app-bot.json"), '{"updated":true}');
    await expect(f.picker.prepare(input, "one")).rejects.toThrow("已变化"); f.state.during = () => {};
    opened = await f.open(); f.picker.end("one");
    await expect(f.picker.prepare({ view: opened.view, selected: [opened.children[0]!.key] }, "one")).rejects.toThrow("过期");
    f.state.during = () => f.picker.end("one"); await expect(f.open()).rejects.toThrow("过期"); f.state.during = () => {};
    writeFileSync(join(f.root, "data/config/directory.json"), '{"format":1,"all":true}'); await expect(f.open()).rejects.toThrow("已有同步范围");
  } finally { await f.cleanup(); }
});
