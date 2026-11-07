import { readDirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { isAbsolute, join } from "node:path";
import { readFileSync, lstatSync } from "node:fs";
import { loadPendingTransaction } from "../../ops/core/pending-transaction.ts";
import { fields } from "../../ops/core/operations.ts";
import { assertLifecycleTarget } from "../../ops/core/recovery-plan.ts";
import { ApiProblem, type Route } from "./routes.ts";
import { runCommand, type Runner } from "../../ops/core/hosting.ts";
import { parsePort } from "../../ops/core/console-port.ts";
import { hostPlatform } from "../../ops/core/platform.ts";

function setting(project: string, name: string): string {
  const path = join(project, "data/state", name);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error("部署设置不是有效普通文件，请先检查部署记录");
  return readFileSync(path, "utf8").trim();
}

/** Fetch is explicit, bounded and never part of confirming an already previewed SHA. */
export function upgradeRoutes(project: string, run: Runner = runCommand): Record<string, Route> {
  let fetching = false;
  const settings = async () => {
    if (loadPendingTransaction(project)) throw new Error("请先继续或回滚未完成的部署或升级");
    const branch = await run(["git", "-C", project, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0 || !branch.stdout.trim()) throw new Error("无法读取当前分支");
    return { branch: branch.stdout.trim(), hasDirectory: !!readDirectoryScope(join(project, "data/config/directory.json")) };
  };
  return {
    "GET /api/lifecycle/deploy": { run: async () => {
      try {
        const saved = await settings(), port = parsePort(setting(project, "bot-port"), "机器人 "), workspace = setting(project, "workspace-root");
        if (workspace && !isAbsolute(workspace)) throw new Error("保存的共享目录不是绝对路径，请先检查部署记录");
        return { ...saved, port, workspace, platform: hostPlatform() };
      } catch { throw new ApiProblem(409, "input", "无法读取已有部署设置，请检查未完成的维护事务及 data/state 中的端口和共享目录记录"); }
    } },
    "GET /api/lifecycle/upgrade": { run: async () => {
      try { return await settings(); } catch (error) { throw new ApiProblem(409, "input", (error as Error).message); }
    } },
    "POST /api/lifecycle/check-update": { slow: true, run: async ({ body, signal }) => {
      if (fetching) throw new ApiProblem(409, "busy", "正在检查版本，请稍后重试");
      fetching = true;
      try {
        fields(body as Record<string, unknown>, []);
        const before = await settings(); signal.throwIfAborted();
        const result = await run(["git", "-C", project, "fetch", "origin", "refs/heads/main:refs/remotes/origin/main"],
          { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
        if (result.code !== 0) throw new Error("检查版本失败，请核对网络和本机 Git 配置后重试；未停止机器人");
        signal.throwIfAborted();
        const target = await run(["git", "-C", project, "rev-parse", "--verify", "origin/main^{commit}"]);
        if (target.code !== 0 || !/^[a-f0-9]{40}$/.test(target.stdout.trim())) throw new Error("无法确认 origin/main 的提交");
        await assertLifecycleTarget(project, target.stdout.trim(), run);
        const after = await settings();
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("检查版本期间部署状态已变化，请刷新后重试");
        return { ...after, target: target.stdout.trim() };
      } catch (error) { throw new ApiProblem(409, "input", (error as Error).message); }
      finally { fetching = false; }
    } },
  };
}
