#!/usr/bin/env bun
// Shared host entry. Shell and PowerShell translate their public argv and bootstrap Bun only.
import { resolve } from "node:path";
import { cliArgs } from "../lib/cli.ts";
import { publishJson } from "../../src/lib/atomic-file.ts";
import { createServiceHost } from "./service-host.ts";
import { runServiceCommand, type ServiceAction } from "./service.ts";
import type { OpsResult } from "./result.ts";
import { MaintenanceRefused, refusing } from "./maintenance.ts";
import { checkTaskPlan } from "./check-plan.ts";
import { TaskStore } from "./tasks.ts";
import { consoleDir } from "./console-state.ts";
import { codeDigest } from "./source-runtime.ts";
import { historyRequest, runHistory } from "./history.ts";
import type { MaintenanceHostOptions } from "./maintenance-host.ts";
import { operationArgs, operationObserver } from "./operations.ts";
import { PlanStore } from "./plans.ts";
import { recoverMaintenance } from "./maintenance-recovery.ts";
import { runStatsImport, statsImportRequest } from "./stats-import.ts";
import { runTmp, tmpRequest, TMP_ACTIONS } from "./tmp.ts";
import { TMP_OPTIONS } from "../lib/tmp-options.ts";
import { configurationRequest, runConfiguration } from "./configuration.ts";
import { runtimeRequest, runRuntime } from "./runtime-configure.ts";
import { backupRequest, runBackups } from "./backups.ts";
import { relayRequest, runRelay } from "./relay.ts";
import { relayLiteralArgs } from "../lib/relay-options.ts";
import { runDeploymentCli } from "./deployment-cli.ts";
import { configureLog } from "../../src/core/log.ts";
import { checkUninstall } from "./uninstall.ts";

interface Dependencies {
  env?: NodeJS.ProcessEnv;
  host?: typeof createServiceHost;
  source?: string;
  checkPlan?: typeof checkTaskPlan;
  history?: typeof runHistory;
  stats?: typeof runStatsImport;
  tmp?: typeof runTmp;
  configuration?: typeof runConfiguration;
  runtime?: typeof runRuntime;
  backups?: typeof runBackups;
  relay?: typeof runRelay;
  deployment?: typeof runDeploymentCli;
}

/** Exposed for real CLI-contract tests; production always uses the native service host. */
export async function runCore(args: string[], dependencies: Dependencies = {}, signal?: AbortSignal): Promise<{ result: OpsResult; json: boolean }> {
  if (args[0] === "deployment") return (dependencies.deployment ?? runDeploymentCli)(args.slice(1), {
    env: dependencies.env, source: dependencies.source, checkPlan: dependencies.checkPlan,
  }, signal);
  const { values, positionals, tokens } = cliArgs(relayLiteralArgs(args), { ...TMP_OPTIONS, project: { type: "string" }, json: { type: "boolean" }, keyword: { type: "string" },
    all: { type: "boolean" }, direct: { type: "boolean" }, "storage-segment": { type: "boolean" }, "group-id": { type: "boolean" }, expect: { type: "string" },
    confirm: { type: "string" }, stage: { type: "string" } });
  const service = positionals[0] === "service" && ["start", "stop", "restart", "repair"].includes(positionals[1]!);
  const history = positionals[0] === "maintenance" && ["history-clear", "history-compact"].includes(positionals[1]!);
  const stats = positionals[0] === "maintenance" && positionals[1] === "stat-import";
  const tmp = positionals[0] === "maintenance" && TMP_ACTIONS.includes(positionals[1] as typeof TMP_ACTIONS[number]);
  const configuration = positionals[0] === "maintenance" && ["configuration-apply", "configuration-restore"].includes(positionals[1]!);
  const runtime = positionals[0] === "maintenance" && positionals[1] === "runtime-configure";
  const backups = positionals[0] === "maintenance" && ["backup-scan", "backup-clean"].includes(positionals[1]!);
  const relay = positionals[0] === "maintenance" && ["relay-ls", "relay-test", "relay-purge"].includes(positionals[1]!);
  const recovery = positionals.length === 1 && positionals[0] === "maintenance-recover";
  const uninstall = positionals.length === 1 && positionals[0] === "uninstall-check";
  const allowed = ["project", "json", ...(history ? ["all", "direct", "storage-segment", "group-id", "expect"] : stats ? ["expect"] : tmp ? Object.keys(TMP_OPTIONS)
    : configuration ? positionals[1] === "configuration-apply" ? ["digest", "stage"] : ["expect"] : backups ? ["confirm"] : relay ? ["all", "keyword", "expect"] : [])];
  if (!service && !history && !recovery && !stats && !tmp && !configuration && !runtime && !backups && !relay && !uninstall || service && positionals.length !== 2
    || tokens.some(token => token.kind === "option" && !allowed.includes(token.name)))
    throw new Error("用法：ops core service <start|stop|restart|repair>、maintenance <history-clear|history-compact|stat-import|tmp-ls|tmp-preview|tmp-purge|tmp-reclaim|tmp-discard|configuration-apply|configuration-restore|runtime-configure|backup-scan|backup-clean|relay-ls|relay-test|relay-purge>、maintenance-recover 或 uninstall-check；--project <目录> [--json]");
  if (!values.project) throw new Error("缺少 --project，未执行操作");
  const project = resolve(values.project), source = dependencies.source ?? resolve(import.meta.dir, "../.."), action = recovery ? "maintenance-recover" : positionals[1]!;
  // Read-only, under the lock the uninstalling entry holds; never a console task.
  if (uninstall) return { result: await checkUninstall(project, dependencies.env ?? process.env), json: !!values.json };
  const historyInput = history ? historyRequest(action, [...positionals.slice(2),
    ...["all", "direct", "storage-segment", "group-id"].filter(key => values[key as "all"]).map(key => "--" + key),
    ...(values.expect ? ["--expect", values.expect] : [])]) : undefined;
  const statsInput = stats ? statsImportRequest([...positionals.slice(2), ...(values.expect ? ["--expect", values.expect] : [])]) : undefined;
  const tmpInput = tmp ? tmpRequest(action, [...positionals.slice(2), ...tokens.flatMap(token => token.kind === "option" && Object.hasOwn(TMP_OPTIONS, token.name)
    ? ["--" + token.name + (token.value === undefined ? "" : "=" + token.value)] : [])]) : undefined;
  const configurationInput = configuration ? configurationRequest(action, [...(values.stage !== undefined ? ["--stage", values.stage] : []),
    ...positionals.slice(2), ...(values.digest ? ["--digest", values.digest] : []), ...(values.expect ? ["--expect", values.expect] : [])]) : undefined;
  const runtimeInput = runtime ? runtimeRequest(positionals.slice(2)) : undefined;
  const backupInput = backups ? backupRequest(action, [...positionals.slice(2), ...(values.confirm ? ["--confirm", values.confirm] : [])]) : undefined;
  const relayInput = relay ? relayRequest(action, [...positionals.slice(2), ...(values.keyword !== undefined ? ["--keyword", values.keyword] : []),
    ...(values.all ? ["--all"] : []), ...(values.expect ? ["--expect", values.expect] : [])]) : undefined;
  const env = dependencies.env ?? process.env;
  const options: MaintenanceHostOptions = { project, source,
    expectedState: env.MIXIN_OPS_EXPECT_STATE,
    allowPendingMaintenance: action === "stop",
    // Under the lock and before any change: a task or plan that cannot be confirmed refuses the operation.
    verify: () => refusing(async () => {
      if (env.MIXIN_OPS_CONSOLE === "1" && !env.MIXIN_OPS_TASK_ID) throw new MaintenanceRefused("控制台任务缺少接单记录，未执行操作");
      if (!env.MIXIN_OPS_TASK_ID) return;
      const expected = env.MIXIN_OPS_EXPECT_CODE;
      if (!expected || codeDigest(source) !== expected) throw new MaintenanceRefused("控制台任务执行版本不符，未执行操作");
      const request = new TaskStore(consoleDir(project)).request(env.MIXIN_OPS_TASK_ID);
      if (request.operation !== action || (service || recovery) && Object.keys(request.params).length) throw new MaintenanceRefused("命令与确认的控制台任务不符");
      await (dependencies.checkPlan ?? checkTaskPlan)(project, request.id, expected);
      if (historyInput || statsInput || tmpInput || configurationInput || runtimeInput || backupInput || relayInput) {
        const plan = new PlanStore(consoleDir(project), operationObserver(project)).read(request.planId);
        const args = operationArgs(action, request.params, plan.facts.scope).slice(1);
        const selected = historyInput ? historyRequest(action, args) : tmpInput ? tmpRequest(action, args) : configurationInput ? configurationRequest(action, args)
          : runtimeInput ? runtimeRequest(args) : backupInput ? backupRequest(action, args) : relayInput ? relayRequest(action, args) : statsImportRequest(args);
        if (JSON.stringify(selected) !== JSON.stringify(historyInput ?? statsInput ?? tmpInput ?? configurationInput ?? runtimeInput ?? backupInput ?? relayInput)) throw new MaintenanceRefused("数据范围与确认过的控制台任务不符");
      }
    }),
    async finish(result) { if (env.MIXIN_OPS_RESULT_FILE) await publishJson(env.MIXIN_OPS_RESULT_FILE, result); },
    ...(values.json ? { output: (text: string) => { process.stderr.write(text); } } : {}),
  };
  const result = recovery ? await recoverMaintenance(options)
    : statsInput ? await (dependencies.stats ?? runStatsImport)(statsInput, options, signal)
    : tmpInput ? await (dependencies.tmp ?? runTmp)(tmpInput, options, signal)
    : configurationInput ? await (dependencies.configuration ?? runConfiguration)(configurationInput, options, signal)
    : runtimeInput ? await (dependencies.runtime ?? runRuntime)(runtimeInput, options, signal)
    : backupInput ? await (dependencies.backups ?? runBackups)(backupInput, options, signal)
    : relayInput ? await (dependencies.relay ?? runRelay)(relayInput, options, signal)
    : historyInput ? await (dependencies.history ?? runHistory)(historyInput, options, signal)
    : await runServiceCommand(action as ServiceAction, (dependencies.host ?? createServiceHost)(options), signal);
  return { result, json: !!values.json };
}

if (import.meta.main) {
  const abort = new AbortController(), cancel = () => abort.abort(new Error("用户取消了服务操作"));
  // A disconnected operator's upgrade still rolls back instead of dying between two effects.
  const hangup = process.platform === "win32" ? [] : ["SIGHUP"] as const;
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel); for (const name of hangup) process.on(name, cancel);
  // After a hangup the terminal is gone: a failed progress write must not end a rollback; the logs and result file keep the record.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  // With --json stdout carries only the result: log lines of the modules the core runs go to stderr.
  if (process.argv.includes("--json")) configureLog({ stream: "stderr" });
  try {
    const { result, json } = await runCore(process.argv.slice(2), {}, abort.signal);
    if (json) console.log(JSON.stringify(result));
    else (result.exitCode === 0 ? console.log : console.error)(result.message);
    process.exitCode = result.exitCode;
  } catch (error) { console.error(error instanceof Error ? error.message : "运维入口失败"); process.exitCode = 1; }
  finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); for (const name of hangup) process.off(name, cancel); }
}
