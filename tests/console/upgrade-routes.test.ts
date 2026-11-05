import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upgradeRoutes } from "../../scripts/ops/console/upgrade-routes.ts";
import type { RouteContext } from "../../scripts/ops/console/routes.ts";
import { tempFixture } from "../helpers/temp.ts";

const context = (body: unknown = {}): RouteContext => ({ body, signal: new AbortController().signal, session: {} as RouteContext["session"] });

test("重部署设置来自状态文件，读取不联网；损坏和未完成事务阻止填写旧默认值", async () => {
  const f = await tempFixture("redeploy-settings-");
  try {
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/bot-port"), "12011\n"); writeFileSync(join(f.root, "data/state/workspace-root"), "");
    const routes = upgradeRoutes(f.root, async argv => {
      expect(argv).toEqual(["git", "-C", f.root, "rev-parse", "--abbrev-ref", "HEAD"]);
      return { code: 0, stdout: "main", stderr: "" };
    });
    const get = () => routes["GET /api/lifecycle/deploy"]!.run(context());
    expect(await get()).toMatchObject({ port: 12011, workspace: "", hasDirectory: false });
    writeFileSync(join(f.root, "data/state/bot-port"), "oops"); await expect(get()).rejects.toThrow("无法读取");
    writeFileSync(join(f.root, "data/state/bot-port"), "12011");
    writeFileSync(join(f.root, "data/state/workspace-root"), "relative"); await expect(get()).rejects.toThrow("无法读取");
    writeFileSync(join(f.root, "data/state/workspace-root"), f.root); expect(await get()).toMatchObject({ workspace: f.root });
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "corrupt"); await expect(get()).rejects.toThrow("无法读取");
  } finally { await f.cleanup(); }
});
test("检查版本只在明确请求时获取固定 origin/main；网络失败、未知参数和并发检查拒绝", async () => {
  const f = await tempFixture("upgrade-version-");
  const commands: string[][] = [], target = "b".repeat(40); let network = true, unblock: (() => void) | undefined, wait = false;
  try {
    const routes = upgradeRoutes(f.root, async (argv, env) => {
      commands.push(argv);
      if (argv[3] === "fetch") {
        expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
        if (wait) await new Promise<void>(resolve => { unblock = resolve; });
        return { code: network ? 0 : 1, stdout: "", stderr: "synthetic-secret-in-remote" };
      }
      if (argv[3] === "show") return { code: 0, stdout: '{"protocol":"mixin-console-lifecycle","version":1}', stderr: "" };
      return { code: 0, stdout: argv.includes("origin/main^{commit}") ? target : "feature", stderr: "" };
    });
    expect(await routes["GET /api/lifecycle/upgrade"]!.run(context())).toEqual({ branch: "feature", hasDirectory: false });
    expect(commands.some(argv => argv[3] === "fetch")).toBe(false);
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context({ remote: "evil" }))).rejects.toThrow("未允许");
    expect(commands.some(argv => argv[3] === "fetch")).toBe(false);
    network = false;
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context())).rejects.toThrow("检查版本失败");
    network = true;
    mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/directory.json"), '{"format":1,"all":true}');
    expect(await routes["POST /api/lifecycle/check-update"]!.run(context())).toEqual({ branch: "feature", hasDirectory: true, target });
    expect(commands.filter(argv => argv[3] === "fetch")).toEqual(Array(2).fill(["git", "-C", f.root, "fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]));
    wait = true; const pending = routes["POST /api/lifecycle/check-update"]!.run(context());
    while (!unblock) await Bun.sleep(1);
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context())).rejects.toThrow("正在检查版本");
    unblock!(); await pending;
  } finally { unblock?.(); await f.cleanup(); }
});
