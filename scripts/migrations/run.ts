#!/usr/bin/env bun
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DATA_VERSION, inspectDataVersion, serviceGroupRoot } from "../../src/core/data-version.ts";
import { apply, commit, committedDeployment, preview, rollback, type Plan } from "./lib/runner.ts";
import { json, publishJson } from "./lib/io.ts";
import type { Context } from "./lib/types.ts";
import { openOperationLog, operationError } from "../lib/operation-log.ts";
import { cliArgs } from "../lib/cli.ts";

let diagnostic: ReturnType<typeof openOperationLog> | undefined;

async function main() {
  const { values, positionals } = cliArgs(process.argv.slice(2), {
    project: { type: "string" }, groups: { type: "string" }, plan: { type: "string" }, deployment: { type: "string" },
    provider: { type: "string" }, model: { type: "string" }, interactive: { type: "boolean" },
    "decisions-only": { type: "boolean" }, "accept-native-cache": { type: "boolean" },
  });
  if (positionals.length > 1) throw new Error("只能指定一个迁移命令");
  const command = positionals[0] ?? "status", project = resolve(values.project ?? process.cwd()), groups = values.groups;
  const planPath = values.plan ? resolve(values.plan) : undefined, deployment = values.deployment ?? "";
  const interactive = values.interactive, validatePreview = !values["decisions-only"];
  const decisions: Context["decisions"] = { provider: values.provider, model: values.model, acceptNativeCache: values["accept-native-cache"] };
  // Start logging before configuration or group-root validation; status remains read-only.
  if (!["status", "committed"].includes(command)) {
    diagnostic = openOperationLog(resolve(project), "migration");
    diagnostic.event("info", command, `target=${DATA_VERSION}; deployment=${process.env.BOT_DEPLOY_BACKUP_ID ?? "manual"}`);
    if (diagnostic.path) console.error("迁移日志：" + diagnostic.path);
  }
  const context: Context = { project: resolve(project), groups: groups ? resolve(project, groups) : serviceGroupRoot(project), decisions,
    report: (stage, detail) => {
      diagnostic?.event("info", stage, detail);
      if (stage === "skip-migration") console.error(detail);
    } };
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
            if (!/^(y|yes)$/i.test((await rl.question("接受原生缓存？[y/N] ")).trim())) throw new Error("已取消，尚未写入迁移数据");
            decisions.acceptNativeCache = true;
          } else {
            decisions.provider = (await rl.question("provider: ")).trim();
            decisions.model = (await rl.question("model: ")).trim();
          }
        }
      } finally { rl.close(); }
      result = await preview(context, validatePreview);
    }
    console.log(JSON.stringify({ target: DATA_VERSION, kind: result.plan?.kind, pending: result.pending, steps: result.plan?.steps, files: result.plan?.files, decisions: result.decisions }, null, 2));
    if (result.decisions.length) { process.exitCode = 2; return; }
    if (planPath) await publishJson(planPath, result.plan ?? { pending: true });
    return;
  }
  if (command === "apply") await apply(context, planPath ? await json(planPath) as Plan : undefined);
  else if (command === "commit") await commit(context);
  else if (command === "rollback") { if (!await rollback(context, deployment || undefined)) { console.error("迁移已提交；保留新代码和数据，禁止自动回退"); process.exitCode = 42; } }
  else throw new Error("用法：bun run scripts/migrations/run.ts status|preview|apply|commit|rollback [--groups PATH] [--plan PATH] [--interactive]");
}
if (import.meta.main) main().catch(error => {
  diagnostic?.event("error", "migration", operationError(error));
  console.error((error as Error).message); process.exitCode = 1;
}).finally(() => {
  const code = Number(process.exitCode ?? 0);
  diagnostic?.event(code ? "error" : "info", "migration-finished", `exit=${code}`);
});
