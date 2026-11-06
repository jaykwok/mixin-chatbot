// Whitelisted argv builders. Values remain opaque data through the PowerShell base64 request / Bash argv boundary.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { opsCommand, SOURCE_DIR } from "./platform.ts";
import { codeDigest } from "./source-runtime.ts";
import { runCommand } from "./hosting.ts";
import type { Runner } from "./hosting.ts";
import { planDigest } from "./plans.ts";
import type { ObservePlan } from "./plans.ts";
import { historyScope, relayScope, statsFileScope } from "../../src/lib/operation-scope.ts";
import { readTmpPlan, readReclaimPlan, readRemovalPlan } from "../lib/tmp-plan.ts";
import { readRuntimeSettings } from "../config/runtime-draft.ts";
import { previewStatsImport } from "../tools/stats-import-core.ts";
import { apply as previewBackups } from "../tools/backup-cleanup.ts";
import { redactSecrets } from "../../src/lib/redact.ts";
import type { PlanFacts } from "./plans.ts";
import { spaceName } from "../../src/durable/read/protocol.ts";
import { ConfigurationDrafts } from "./configuration-drafts.ts";
import { configurationDigest } from "../config/configuration-draft.ts";
import { assertConfigurationBase } from "../config/configuration-form.ts";
import { readConfigurationState, configurationStateDigest } from "../../src/core/configuration-state.ts";
import { recoveryPlan, assertLifecycleTarget } from "./recovery-plan.ts";
import { deploymentOptions, deploymentEnvironment, deploymentScope, repairScope, repairEnvironment } from "./deployment-options.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { readOpsDeploymentRecord } from "../../src/core/ops-deployment-state.ts";
import { loadPendingTransaction } from "./pending-transaction.ts";
import { readRelayIndex } from "../../src/integrations/relay-index.ts";
import { spaceLabel } from "../lib/format.ts";
import { runtimeOption } from "./runtime-options.ts";
import { RUNTIME_DEFAULTS } from "../../src/core/runtime-schema.ts";

export const OPERATIONS = ["start", "stop", "restart", "maintenance-recover", "history-clear", "history-compact", "tmp-purge", "tmp-reclaim", "tmp-discard", "runtime-configure", "stat-import", "relay-test", "relay-purge", "backup-clean", "configuration-apply", "configuration-restore", "resume", "rollback", "update", "deploy", "repair"] as const;
export type Operation = typeof OPERATIONS[number];
export const OPERATION_LABELS: Record<Operation, string> = { start: "启动", stop: "停止", restart: "重启", "maintenance-recover": "恢复中断的维护", update: "升级", deploy: "重新部署", repair: "修复部署", resume: "继续上次操作", rollback: "回滚上次操作", "history-clear": "清空会话", "history-compact": "登记会话压缩",
  "tmp-purge": "归档临时文件", "tmp-reclaim": "物理回收临时文件", "tmp-discard": "永久删除归档", "runtime-configure": "应用运行参数",
  "stat-import": "导入统计", "relay-test": "测试外链存储", "relay-purge": "清理外链", "backup-clean": "清理备份", "configuration-apply": "应用配置", "configuration-restore": "恢复上次配置" };
const DIGEST = /^[a-f0-9]{64}$/;
const redactPhones = (value: string) => redactSecrets(value).replace(/\+?\d{5,20}/g, number => `${number.slice(0, 3)}****${number.slice(-2)}`);
export function fields(params: Record<string, unknown>, allowed: string[]): void {
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))) throw new Error("操作含有未允许的参数");
}
export function textParam(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f]/.test(value) || (pattern && !pattern.test(value))) throw new Error("操作参数无效");
  return value;
}
export function tmpReader(operation: string) { return operation === "tmp-purge" ? readTmpPlan : operation === "tmp-reclaim" ? readReclaimPlan : readRemovalPlan; }

export function operationArgs(operation: string, params: Record<string, unknown>, expected?: string): string[] {
  if (!OPERATIONS.includes(operation as Operation)) throw new Error("不支持这个管理操作");
  const argv = [operation];
  switch (operation) {
    case "repair":
      if (process.platform === "win32") fields(params, []); else deploymentOptions("deploy", params); break;
    case "update": case "deploy": {
      const options = deploymentOptions(operation, params); if ("target" in options) argv.push(options.target); break;
    }
    case "resume": case "rollback":
      fields(params, ["confirmation"]); argv.push("--confirmed-transaction", textParam(params.confirmation, /^[A-Za-z0-9+/]+={0,2}$/)); break;
    case "configuration-apply":
      fields(params, ["draft", "digest"]); argv.push(textParam(params.draft, /^config-[a-f0-9]{32}$/), "--digest", textParam(params.digest, DIGEST)); break;
    case "configuration-restore":
      fields(params, ["draft"]); argv.push(textParam(params.draft, /^config-[a-f0-9]{32}$/)); break;
    case "history-clear": case "history-compact": {
      fields(params, operation === "history-clear" ? ["space"] : ["space", "phone", "memberLabel"]);
      const space = params.space === "all" ? "all" : spaceName(params.space);
      if (operation === "history-compact" && space === "all") throw new Error("压缩需要单个空间和成员");
      argv.push(space === "all" ? "--all" : space === "direct" ? "--direct" : space.slice(7));
      if (operation === "history-compact") argv.push(textParam(params.phone, /^\+?\d{5,20}$/));
      if (params.memberLabel !== undefined) textParam(params.memberLabel);
      if (space.startsWith("groups/")) argv.push("--storage-segment");
      break;
    }
    case "tmp-purge": case "tmp-reclaim": case "tmp-discard":
      fields(params, ["plan", "digest", "scopeLabel"]); if (params.scopeLabel !== undefined) textParam(params.scopeLabel); argv.push("--plan", textParam(params.plan, /^[a-f0-9-]{36}$/), "--digest", textParam(params.digest, DIGEST)); break;
    case "runtime-configure":
      fields(params, ["draft"]); argv.push(textParam(params.draft, /^\.runtime-draft-[a-f0-9-]{36}\.json$/)); break;
    case "stat-import": fields(params, ["path", "upload"]); if (params.upload !== undefined) textParam(params.upload, /^upload-[a-f0-9]{32}$/); argv.push(textParam(params.path)); if (argv[1]!.startsWith("-")) throw new Error("请选择统计文件的绝对路径"); break;
    case "relay-purge":
      fields(params, ["all", "keyword"]);
      if (params.all === true && params.keyword === undefined) argv.push("--all");
      else if (params.all === undefined && typeof params.keyword === "string") argv.push("--keyword", textParam(params.keyword));
      else throw new Error("选择全部外链或填写筛选关键字");
      break;
    case "backup-clean":
      fields(params, ["report", "confirm"]); argv.push(textParam(params.report, /^[A-Za-z0-9_-]+$/), "--confirm", textParam(params.confirm, /^[a-f0-9]{16}$/)); break;
    default: fields(params, []);
  }
  if (expected !== undefined && ["history-clear", "history-compact", "stat-import", "relay-test", "relay-purge", "configuration-restore"].includes(operation)) argv.push("--expect", textParam(expected, DIGEST));
  return argv;
}

export function operationCommand(project: string, operation: string, params: Record<string, unknown>, facts?: PlanFacts): ReturnType<typeof opsCommand> {
  const command = opsCommand(process.platform === "win32" ? "windows" : "linux", operationArgs(operation, params, facts?.scope), project, SOURCE_DIR, "console");
  return { ...command, env: { ...command.env, ...(operation === "update" || operation === "deploy" ? deploymentEnvironment(operation, params, project)
    : operation === "repair" ? repairEnvironment(project, params) : {}), MIXIN_OPS_BUN: process.execPath,
    MIXIN_OPS_GUARD: join(SOURCE_DIR, "ops/core/check-plan.ts"), MIXIN_OPS_EXPECT_CODE: codeDigest(SOURCE_DIR),
    MIXIN_CONSOLE_PROJECT_ROOT: resolve(project), MIXIN_CONSOLE_SOURCE_ROOT: SOURCE_DIR,
    ...(facts ? { MIXIN_OPS_EXPECT_STATE: facts.runState } : {}) } };
}

/** Existing saved manifests remain the authority for item-level changes. Never recreate one while verifying. */
export async function operationScope(project: string, operation: string, params: Record<string, unknown>, run: Runner = runCommand): Promise<{ scope: string; summary: string[] }> {
  operationArgs(operation, params);
  if (operation === "update" || operation === "deploy") return deploymentScope(project, operation, params, run);
  if (operation === "repair") return repairScope(project, params, run);
  const data = join(project, "data"), summary: string[] = []; let scope = planDigest([operation, params]);
  if (operation === "start" || operation === "restart") {
    // The core refuses these under its lock; say so before the confirmation, not after it. Stopping is always allowed.
    const record = readOpsMaintenanceRecord(project), deployment = readOpsDeploymentRecord(project);
    if (record && !record.result) throw new Error("上次运维任务尚未收尾：请先在任务详情里预览“恢复中断的维护”；停止不受影响");
    if (loadPendingTransaction(project) || (deployment && !deployment.completion)) {
      throw new Error("有未完成的部署或升级：请先在本页“部署恢复”中继续或回滚（数据已提交时只能继续）；停止不受影响");
    }
  }
  if (operation === "maintenance-recover") {
    const record = readOpsMaintenanceRecord(project);
    if (!record || record.result) throw new Error("没有需要恢复的运维任务");
    scope = planDigest(record);
    summary.push("核对并回收中断任务的写入者，不重复原数据操作。",
      record.checkpoint.original.state === "running" ? "只有磁盘维护状态允许、实例身份与就绪通过后，才恢复机器人运行。" : "维护前机器人未运行，恢复后仍保持停止。");
    if (record.checkpoint.request.configuration) summary.push("未提交的配置恢复到修改前；已提交的配置只收尾，不重复应用草稿。");
  }
  if (operation === "resume" || operation === "rollback") {
    const recovery = recoveryPlan(project, operation, String(params.confirmation));
    if (recovery.target) await assertLifecycleTarget(project, recovery.target, run);
    scope = recovery.scope; summary.push(...recovery.summary);
  } else if (operation === "configuration-apply") {
    const draft = new ConfigurationDrafts(project).read(String(params.draft)); assertConfigurationBase(project, draft.base);
    if (!draft.validated || draft.validated.digest !== params.digest || configurationDigest(draft) !== params.digest) throw new Error("配置草稿没有通过校验或已变化");
    scope = String(params.digest); summary.push(...draft.validated.summary, "短暂停止机器人以应用配置；失败时恢复原配置和原运行状态。");
  } else if (operation === "configuration-restore") {
    const state = readConfigurationState(project);
    if (!state || state.id !== params.draft) throw new Error("没有可处理的配置事务，请刷新任务状态");
    scope = configurationStateDigest(state); summary.push(`配置事务 ${state.id}；当前阶段：${CONFIGURATION_PHASES[state.phase] ?? state.phase}。`, state.phase === "committed" || state.phase === "rolled-back"
      ? "配置已完成提交或恢复，本次核对摘要后清除恢复材料。" : "核对恢复文件和当前配置后恢复原值；不覆盖其他操作修改过的文件。");
  } else if (operation === "history-clear" || operation === "history-compact") {
    scope = await historyScope(data, String(params.space), params.phone as string | undefined);
    summary.push(`范围：${params.space === "all" ? "全部会话（单聊和所有群组）" : spaceLabel(redactPhones(String(params.space)))}`, ...(params.phone ? [`成员：${params.memberLabel ?? redactPhones(String(params.phone))}`] : []),
      operation === "history-clear" ? "清空后无法撤销；统计保留。" : "登记压缩任务，机器人启动后生成摘要，聊天记录保留。");
  } else if (operation.startsWith("tmp-")) {
    const saved = await tmpReader(operation)(data, String(params.plan));
    if (saved.digest !== params.digest) throw new Error("清单摘要已变化，请重新预览");
    scope = planDigest(saved); summary.push(`可处理 ${saved.ready} 项，${saved.bytes} 字节；保留 ${saved.kept} 项，待处置 ${saved.deferred} 项。`, "执行前逐项检查；已变化或仍被引用的文件会保留。");
    if (params.scopeLabel) summary.unshift(`范围：${params.scopeLabel}`);
  } else if (operation === "runtime-configure") {
    const path = join(data, "config", String(params.draft)), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("运行参数草稿无效");
    const raw = readFileSync(path, "utf8"), draft = JSON.parse(raw), current = await readRuntimeSettings(join(data, "config/runtime.json"));
    if (draft.expectedHash !== current.hash) throw new Error("运行参数已变化，请重新填写");
    scope = planDigest([raw, current.hash]);
    summary.push(...Object.entries(draft.changes as Record<string, string | null>).map(([key, value]) => {
      const option = runtimeOption(key), unit = option?.unit ? " " + option.unit : "", shown = (text: string | undefined) => text === undefined || text === ""
        ? option?.empty ?? "默认" : (option?.choices?.find(choice => choice.value === text)?.label ?? text) + unit;
      const before = current.values[key as keyof typeof current.values] ?? RUNTIME_DEFAULTS[key as keyof typeof RUNTIME_DEFAULTS];
      return `${option?.label ?? key}：${shown(before)} → ${value === null ? `恢复默认（${shown(RUNTIME_DEFAULTS[key as keyof typeof RUNTIME_DEFAULTS])}）` : shown(value)}`;
    }));
  } else if (operation === "stat-import") {
    const path = String(params.path); scope = statsFileScope(path);
    const preview = previewStatsImport(path, data);
    if (scope !== statsFileScope(path)) throw new Error("读取期间统计文件发生变化，请使用一致快照");
    if (preview.status === "other") throw new Error("已导入另一份统计，拒绝重复计数");
    // Importing it again would stop the bot only to count nothing.
    if (preview.status === "already") throw new Error("这份统计已经导入，再次导入不会增加统计；没有需要执行的操作");
    summary.push(`${preview.asks} 次提问，${preview.usageRows} 行用量，${preview.totalTokens} tokens`, `日期：${preview.firstDay ?? "无"} 至 ${preview.lastDay ?? "无"}`,
      "只导入统计汇总，不导入会话。源文件必须是停止写入的一致快照。");
  } else if (operation.startsWith("relay-")) {
    // The task's own preflight refuses both without relay.json: say so before anything is confirmed.
    if (!existsSync(join(data, "config/relay.json"))) throw new Error("没有启用外链（data/config/relay.json 不存在）；请先在“设置”中启用外链");
    const keyword = params.keyword as string | undefined;
    scope = relayScope(data, keyword);
    if (operation === "relay-test") summary.push("连接已配置的外链存储，上传并删除一个测试对象。");
    else {
      const matched = readRelayIndex(join(data, "state/relay.sqlite")).filter(row => !keyword || row.name.includes(keyword) || row.url.includes(keyword)).length;
      if (!matched) throw new Error(keyword ? "没有匹配这个关键字的在册外链，无需清理" : "没有在册的外链，无需清理");
      summary.push(params.all ? `删除在册的全部 ${matched} 个外链对象；现有下载链接会失效。` : `清理匹配“${redactPhones(String(keyword))}”的 ${matched} 个外链。`,
        "不属于当前外链存储的记录保留，需用原来的存储设置处理。");
    }
  } else if (operation === "backup-clean") {
    const preview = previewBackups(project, String(params.report));
    if (preview.code !== params.confirm) throw new Error("备份清单已变化，请重新扫描");
    scope = planDigest(preview);
    const ready = preview.results.filter(item => item.outcome === "would-delete");
    summary.push(`可删除 ${ready.length} 项、${ready.reduce((total, item) => total + item.bytes, 0)} 字节；其他项目保留。`, "删除不可撤销；活动事务和当前发布依赖仍受保护。");
  }
  return { scope, summary };
}

const CONFIGURATION_PHASES: Record<string, string> = { publishing: "正在写入", ready: "已写入、待确认", restoring: "正在恢复", committed: "已提交", "rolled-back": "已恢复原配置" };
/** Windows task and Docker container states, as the operator reads them. */
const RUN_STATES: Record<string, string> = { Running: "运行中", Ready: "已停止（计划任务就绪）", Disabled: "已停止（计划任务已禁用）",
  running: "运行中", exited: "已停止", created: "已创建、未启动", absent: "未部署" };

/** Observe metadata and the hosting manager, not the conversation bodies. Scripts repeat the check under their lock. */
export function operationObserver(project: string, run: Runner = runCommand): ObservePlan {
  return async (operation, params) => {
    const read = await operationScope(project, operation, params, run);
    const head = await run(["git", "-C", project, "rev-parse", "HEAD"]);
    if (head.code !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) throw new Error("无法核对代码版本");
    let identity: string, state: string, container: string | undefined;
    if (process.platform === "win32") {
      const owner = JSON.parse(readFileSync(join(project, ".console", "owner.json"), "utf8"));
      identity = owner.sid;
      const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName mixin-bot -ErrorAction SilentlyContinue; if ($task) { $task.State.ToString() } else { 'absent' }"]);
      if (result.code !== 0) throw new Error("无法核对机器人计划任务状态");
      state = result.stdout.trim();
      if (!["Running", "Ready", "Disabled", "absent"].includes(state)) throw new Error("机器人计划任务处于过渡状态");
    } else {
      identity = String(process.geteuid?.());
      // The container ID binds the plan to this container on this daemon: a recreated container or another daemon is a change.
      const result = await run(["docker", "ps", "-a", "--no-trunc", "--filter", "name=^/mixin-bot$", "--format", "{{.ID}} {{.State}}"]);
      if (result.code !== 0) throw new Error("无法核对机器人容器状态");
      const lines = result.stdout.trim() ? result.stdout.trim().split("\n") : [];
      const found = /^([a-f0-9]{64}) (\S+)$/.exec(lines[0]?.trim() ?? "");
      if (lines.length > 1 || lines.length && !found) throw new Error("机器人容器清单不唯一或无法核对");
      [container, state] = found ? [found[1]!, found[2]!] : [undefined, "absent"];
      if (!["running", "exited", "created", "absent"].includes(state)) throw new Error("机器人容器处于过渡状态");
    }
    return { facts: { project: resolve(project), platform: process.platform, identity, head: head.stdout.trim(), protocol: 1,
      scope: read.scope, runState: state, ...(container ? { container } : {}) }, summary: [`操作：${OPERATION_LABELS[operation as Operation]}`, `当前状态：${RUN_STATES[state] ?? state}`, ...read.summary] };
  };
}
