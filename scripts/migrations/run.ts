#!/usr/bin/env bun
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DATA_VERSION, inspectDataVersion, serviceGroupRoot } from "../../src/core/data-version.ts";
import { apply, commit, committedDeployment, preview, rollback, type Plan } from "./lib/runner.ts";
import { json, publishJson } from "./lib/io.ts";
import type { Context } from "./lib/types.ts";

async function main() {
  const args = process.argv.slice(2), command = args.shift() ?? "status";
  let project = process.cwd(), groups: string | undefined, planPath: string | undefined, deployment = "", interactive = false, validatePreview = true;
  const decisions: Context["decisions"] = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--interactive") { interactive = true; continue; }
    if (arg === "--decisions-only") { validatePreview = false; continue; }
    if (arg === "--accept-native-cache") { decisions.acceptNativeCache = true; continue; }
    if (!["--project", "--groups", "--plan", "--provider", "--model", "--deployment"].includes(arg)) throw new Error(`未知参数 ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
    if (arg === "--project") project = resolve(value);
    if (arg === "--groups") groups = value;
    if (arg === "--plan") planPath = resolve(value);
    if (arg === "--provider") decisions.provider = value;
    if (arg === "--model") decisions.model = value;
    if (arg === "--deployment") deployment = value;
  }
  const context: Context = { project: resolve(project), groups: groups ? resolve(project, groups) : serviceGroupRoot(project), decisions };
  if (command === "status") { console.log(JSON.stringify(inspectDataVersion(context.project, context.groups))); return; }
  if (command === "committed") { process.exitCode = await committedDeployment(context, deployment) ? 0 : 1; return; }
  if (command === "preview") {
    let result = await preview(context, validatePreview);
    if (result.decisions.length && interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const decision of result.decisions) {
          console.log(decision.message);
          if (decision.key === "acceptNativeCache") {
            if (!/^(y|yes)$/i.test((await rl.question("接受原生缓存？[y/N] ")).trim())) throw new Error("已取消，服务尚未停止");
            decisions.acceptNativeCache = true;
          } else {
            decisions.provider = (await rl.question("provider: ")).trim();
            decisions.model = (await rl.question("model: ")).trim();
          }
        }
      } finally { rl.close(); }
      result = await preview(context, validatePreview);
    }
    console.log(JSON.stringify({ target: DATA_VERSION, pending: result.pending, steps: result.plan?.steps, files: result.plan?.files, decisions: result.decisions }, null, 2));
    if (result.decisions.length) { process.exitCode = 2; return; }
    if (planPath) await publishJson(planPath, result.plan ?? { pending: true });
    return;
  }
  if (command === "apply") await apply(context, planPath ? await json(planPath) as Plan : undefined);
  else if (command === "commit") await commit(context);
  else if (command === "rollback") { if (!await rollback(context, deployment || undefined)) { console.error("迁移已提交；保留新代码和数据，禁止自动回退"); process.exitCode = 42; } }
  else throw new Error("用法：bun run scripts/migrations/run.ts status|preview|apply|commit|rollback [--groups PATH] [--plan PATH] [--interactive]");
}
if (import.meta.main) main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
