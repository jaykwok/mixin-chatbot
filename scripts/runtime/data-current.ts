#!/usr/bin/env bun
// Current-format release gate. No historical configuration/session readers or data converters.
// Preview checks configuration offline; the executing release supplies its installed dependencies.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_VERSION, VERSION_FILE, RELEASE_FILE, GROUP_ROOT_LEASE, readDataVersion, readMetadata, readRelease } from "../../src/core/data-version.ts";
import { digest, publishJson } from "../lib/atomic-file.ts";
import { readFileSync } from "node:fs";
import { openOperationLog, operationError } from "../lib/operation-log.ts";
import { applyReset, finishReset, makeResetPlan, prepareResetDraft, resetArchiveName, resetVersion, rollbackReset, verifyReset, type ResetPlan } from "./data-reset.ts";

const args = process.argv.slice(2), action = args.shift();
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const project = resolve(option("--project") ?? process.cwd());
const groups = resolve(option("--groups") ?? join(project, "data/groups"));
const deployment = option("--deployment") ?? process.env.BOT_DEPLOY_BACKUP_ID ?? "";
const planPath = option("--plan");
const resetDraft = option("--reset-config");
const localPath = join(project, "data/state", VERSION_FILE), groupPath = join(groups, VERSION_FILE);
const releasePath = join(project, "data/state", RELEASE_FILE);
const operation = openOperationLog(project, "deploy");
if (operation.ownsLog && operation.name) console.error(`本次操作日志：${operation.name}`);
const fingerprint = (path: string) => digest(existsSync(path) ? readFileSync(path) : null);

/** Existing stores are accepted only with the exact paired current markers. Unmarked roots must be fresh. */
function inspect(): { fresh: boolean; markers: (string | null)[] } {
  const local = readDataVersion(localPath), group = readDataVersion(groupPath);
  const pending = readRelease(project);
  const interruptedFresh = pending?.phase === "prepared" && pending.deployment === deployment && resolve(pending.groups) === groups
    && ((!local && group?.dataVersion === DATA_VERSION && group.transaction === deployment)
      || (!group && local?.dataVersion === DATA_VERSION && local.transaction === deployment));
  if ((local || group) && !interruptedFresh) {
    if (!local || !group || local.dataVersion !== DATA_VERSION || group.dataVersion !== DATA_VERSION || local.transaction !== group.transaction)
      throw new Error(`仅支持当前数据格式 ${DATA_VERSION}。旧版请通过 update 确认保留统计并重置；标记不成对时先恢复一致状态。参见 docs/data-migrations.md。`);
  } else if (existsSync(groups)) {
    for (const entry of readdirSync(groups, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("群根不能包含链接");
      if (["stats.sqlite", "stats.sqlite-wal", "stats.sqlite-shm", ...(interruptedFresh ? [VERSION_FILE] : [])].includes(entry.name) && entry.isFile() || entry.name === GROUP_ROOT_LEASE) continue;
      if (pending?.phase === "prepared" && pending.deployment === deployment && entry.name === resetArchiveName(deployment) && entry.isDirectory()) continue;
      if (!entry.isDirectory() || entry.name.startsWith(".")) throw new Error("未登记的群根含未知文件；请手动准备新群根");
      // A fresh root may carry the same group's reference workspace, but never runtime state or old tasks.
      for (const child of readdirSync(join(groups, entry.name), { withFileTypes: true })) if (child.name !== "workspace" || !child.isDirectory() || child.isSymbolicLink())
        throw new Error("未登记的群根含运行数据；请手动准备新群根，仅承接 stats.sqlite 和 workspace");
    }
  }
  return { fresh: interruptedFresh || !local && !group, markers: [fingerprint(localPath), fingerprint(groupPath)] };
}

async function withLease<T>(work: () => Promise<T>): Promise<T> {
  const { acquireLease, acquireGroupRootLease } = await import("../../src/core/maintenance.ts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(groups, { recursive: true });
  const release = await acquireLease("current-data", join(project, "data/state/service"));
  try {
    const releaseGroups = await acquireGroupRootLease("current-data", groups);
    try { return await work(); } finally { await releaseGroups(); }
  } finally { await release(); }
}

async function main(): Promise<void> {
  if (action === "probe") {
    const from = resetVersion(project, groups);
    if (from !== null) {
      console.log(`数据格式 ${from} → ${DATA_VERSION}：需要重新配置并清理旧会话；保留全部统计和 webhook / Cloudflare 入口凭证。`);
      process.exitCode = 20;
    } else console.log(`数据格式兼容 ${DATA_VERSION}，正常升级，不清理会话。`);
    return;
  }
  if (action === "prepare-reset") {
    if (!resetDraft) throw new Error("prepare-reset requires --reset-config");
    await prepareResetDraft(project, groups, resolve(resetDraft)); return;
  }
  if (action === "committed") {
    const release = readRelease(project);
    process.exitCode = release?.deployment === deployment && resolve(release.groups) === groups && release.phase === "committed" ? 0 : 1;
    return;
  }
  if (action === "preview") {
    if (resetDraft) {
      const reset = makeResetPlan(project, groups, resolve(resetDraft));
      const { validateConfiguration } = await import("../../src/core/data-validation.ts");
      await validateConfiguration(resolve(resetDraft));
      if (!planPath) throw new Error("重置预览必须保存计划");
      await publishJson(resolve(planPath), { format: 1, dataVersion: DATA_VERSION, reset });
      console.log("新配置已验证；停机后补账并备份统计，再重置会话。核对失败会回滚。"); return;
    }
    const state = inspect();
    const { validateConfiguration } = await import("../../src/core/data-validation.ts");
    await validateConfiguration(project);
    if (planPath) await publishJson(resolve(planPath), { format: 1, dataVersion: DATA_VERSION, ...state });
    console.log(`当前格式 ${DATA_VERSION}：${state.fresh ? "新实例（统计 schema 2 直接沿用）" : "校验现有实例"}；无历史转换。`);
    return;
  }
  if (action === "validate") {
    inspect();
    const { validateCurrentData } = await import("../../src/core/data-validation.ts");
    await validateCurrentData(project, groups);
    return;
  }
  if (!/^deploy-[A-Za-z0-9]+$/.test(deployment)) throw new Error("当前格式准备需要本次发布事务 ID");
  // Activation already owns the service/group leases. Only the committed transaction's offline
  // rollback copies are removed here; no active data, marker or statistics file is touched.
  if (action === "finish-reset") {
    const release = readRelease(project);
    if (release?.deployment !== deployment || release.phase !== "committed" || resolve(release.groups) !== groups)
      throw new Error("未提交的数据不能清理回滚副本");
    await finishReset(project, groups, deployment); return;
  }
  await withLease(async () => {
    const release = readRelease(project);
    if (action === "rollback") {
      if (release?.deployment !== deployment) { await rollbackReset(project, groups, deployment); return; }
      if (release.phase === "committed") { process.exitCode = 42; return; }
      if (resolve(release.groups) !== groups) throw new Error("发布记录的群根不一致");
      const { unlink } = await import("node:fs/promises");
      // Only this fresh registration's markers can be removed. A crash between the two
      // writes must remain reversible; existing instance markers belong to an earlier release.
      for (const path of [localPath, groupPath]) if (readDataVersion(path)?.transaction === deployment) await unlink(path);
      await unlink(releasePath);
      await rollbackReset(project, groups, deployment);
      return;
    }
    if (action === "apply") {
      const planned = planPath ? readMetadata(resolve(planPath)) as { format?: number; dataVersion?: number; reset?: ResetPlan } | null : null;
      if (planned?.reset) {
        if (planned.format !== 1 || planned.dataVersion !== DATA_VERSION) throw new Error("重置计划与当前数据版本不匹配");
        if (release?.phase === "prepared" && release.deployment !== deployment) throw new Error("另一次发布尚未完成");
        if (release?.deployment === deployment && release.phase === "committed") return;
        await applyReset(project, groups, deployment, planned.reset);
        await publishJson(releasePath, { format: 1, deployment, groups, phase: "prepared" });
        return;
      }
      const state = inspect();
      if (release?.phase === "prepared" && release.deployment !== deployment) throw new Error("另一次发布尚未完成，请先继续或回滚该事务");
      if (release?.deployment === deployment) {
        if (resolve(release.groups) !== groups) throw new Error("发布记录的群根不一致");
        return;
      }
      if (planPath) {
        const plan = readMetadata(resolve(planPath)) as { format?: number; dataVersion?: number; markers?: unknown } | null;
        if (plan?.format !== 1 || plan.dataVersion !== DATA_VERSION || JSON.stringify(plan.markers) !== JSON.stringify(state.markers))
          throw new Error("当前数据标记已变化，请重新预检；尚未写入运行数据");
      }
      await publishJson(releasePath, { format: 1, deployment, groups, phase: "prepared" });
      return;
    }
    if (action === "commit") {
      if (release?.deployment !== deployment || resolve(release.groups) !== groups) throw new Error("没有本次发布的当前格式准备记录");
      if (release.phase === "committed") return;
      const state = inspect();
      verifyReset(project, groups, deployment);
      const { validateCurrentData } = await import("../../src/core/data-validation.ts");
      await validateCurrentData(project, groups);
      if (state.fresh) {
        const marker = { dataVersion: DATA_VERSION, transaction: deployment };
        await publishJson(groupPath, marker);
        await publishJson(localPath, marker);
      }
      await publishJson(releasePath, { ...release, phase: "committed" });
      return;
    }
    throw new Error("usage: data-current.ts probe|prepare-reset|preview|apply|validate|commit|committed|rollback|finish-reset --project PATH --groups PATH [--plan PATH] [--reset-config PATH]");
  });
}

try { operation.event("info", "current-data", `action=${action}`); await main(); }
catch (error) { operation.event("error", "current-data", operationError(error)); console.error((error as Error).message); process.exitCode = 1; }
finally {
  operation.event("info", "current-data", `data-finished: exit=${process.exitCode ?? 0}`);
  if (process.exitCode && operation.ownsLog && operation.name) console.error(`本次操作日志：${operation.name}`);
}
