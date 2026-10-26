#!/usr/bin/env bun
// Release gate of the current data format: the deployment record (data/state/data-version.json), which also binds the
// whole data directory to one application. No historical readers, resets or converters; another format is deployed
// fresh in a new directory. check and preview are read-only; the executing release supplies its installed dependencies.
// --workspace names the final workspace of the deployment (the service reads it from runtime.json only after preview).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VERSION_FILE, RELEASE_FILE, applicationBinding, assertApplication, deploymentRecord, readDataVersion, readMetadata, readRelease,
  type DataVersion } from "../../src/core/data-version.ts";
import { APP_BUILD, APP_VERSION, DATA_VERSION } from "../../src/core/version.ts";
import { digest, publishJson } from "../lib/atomic-file.ts";
import { openOperationLog, operationError } from "../lib/operation-log.ts";

const args = process.argv.slice(2), action = args.shift();
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const project = resolve(option("--project") ?? process.cwd());
const deployment = option("--deployment") ?? process.env.BOT_DEPLOY_BACKUP_ID ?? "";
const planPath = option("--plan");
const workspace = option("--workspace");
const validation = workspace === undefined ? {} : { workspace };
const data = join(project, "data");
const markerPath = join(data, "state", VERSION_FILE), releasePath = join(data, "state", RELEASE_FILE);
const operation = openOperationLog(project, "deploy");
if (operation.ownsLog && operation.name) console.error(`本次操作日志：${operation.name}`);
const fingerprint = (path: string) => digest(existsSync(path) ? readFileSync(path) : null);
const label = (version: string, build: string) => `v${version}${build ? `（构建 ${build.slice(0, 7)}${build.endsWith("-dirty") ? "-dirty" : ""}）` : ""}`;

/** New install or upgrade (see deploymentRecord): data without a valid record is refused, never initialised over. */
function inspect(): { record: DataVersion | null; marker: string | null } {
  return { record: deploymentRecord(project), marker: fingerprint(markerPath) };
}
function describe(record: DataVersion | null): string {
  const target = `程序 ${label(APP_VERSION, APP_BUILD)}，数据格式 ${DATA_VERSION}`;
  return record ? `${target}：已部署 ${label(record.appVersion, record.build)}，数据格式一致` : `${target}：全新安装`;
}

async function withLease<T>(work: () => Promise<T>): Promise<T> {
  const { acquireLease } = await import("../../src/core/maintenance.ts");
  const release = await acquireLease("current-data", join(data, "state/service"));
  try { return await work(); } finally { await release(); }
}

async function main(): Promise<void> {
  if (action === "committed") {
    const release = readRelease(project);
    process.exitCode = release?.deployment === deployment && release.phase === "committed" ? 0 : 1;
    return;
  }
  if (action === "check") {
    const { record } = inspect();
    // Before the stop: the configuration (when already written) must belong to the recorded application.
    const { readAppBotConfig } = await import("../../src/integrations/open-platform/config.ts");
    const app = readAppBotConfig(join(data, "config/app-bot.json"));
    if (app) assertApplication(record, app);
    if (workspace !== undefined) (await import("../../src/core/layout.ts")).checkProjectLayout(project, workspace);
    console.log(describe(record));
    return;
  }
  if (action === "preview") {
    const state = inspect();
    // An upgrade needs the record of a deployment; an empty directory is a fresh install, never an upgrade.
    if (args.includes("--upgrade") && !state.record) throw new Error("目录没有部署记录，不能升级；请先用部署命令全新安装（现场已保留）");
    const { validateConfiguration } = await import("../../src/core/data-validation.ts");
    await validateConfiguration(project, validation);
    if (planPath) await publishJson(resolve(planPath), { format: 1, dataVersion: DATA_VERSION, marker: state.marker });
    console.log(describe(state.record));
    return;
  }
  if (action === "validate") {
    inspect();
    const { validateCurrentData } = await import("../../src/core/data-validation.ts");
    await validateCurrentData(project, validation);
    return;
  }
  if (!/^deploy-[A-Za-z0-9]+$/.test(deployment)) throw new Error("数据准备需要本次发布事务 ID");
  await withLease(async () => {
    const release = readRelease(project);
    if (action === "rollback") {
      if (release?.deployment !== deployment) return;
      if (release.phase === "committed") { process.exitCode = 42; return; }
      // A commit interrupted before the release was marked committed may have written this deployment's record already:
      // put back the record from before the release (none for a fresh install).
      if (readDataVersion(markerPath)?.transaction === deployment) {
        if (release.previous) await publishJson(markerPath, release.previous);
        else await (await import("node:fs/promises")).unlink(markerPath);
      }
      await (await import("node:fs/promises")).unlink(releasePath);
      return;
    }
    if (action === "apply") {
      const state = inspect();
      if (release?.phase === "prepared" && release.deployment !== deployment) throw new Error("另一次发布尚未完成，请先继续或回滚该事务");
      if (release?.deployment === deployment) return;
      if (planPath) {
        const plan = readMetadata(resolve(planPath)) as { format?: number; dataVersion?: number; marker?: unknown } | null;
        if (plan?.format !== 1 || plan.dataVersion !== DATA_VERSION || plan.marker !== state.marker)
          throw new Error("版本标记已变化，请重新预检；尚未写入运行数据");
      }
      await publishJson(releasePath, { format: 1, deployment, phase: "prepared", previous: state.record });
      return;
    }
    if (action === "commit") {
      if (release?.deployment !== deployment) throw new Error("没有本次发布的数据准备记录");
      if (release.phase === "committed") return;
      const current = readDataVersion(markerPath);
      if (current?.transaction !== deployment) inspect();
      const { validateCurrentData } = await import("../../src/core/data-validation.ts");
      await validateCurrentData(project, validation);
      const { readAppBotConfig } = await import("../../src/integrations/open-platform/config.ts");
      const app = readAppBotConfig(join(data, "config/app-bot.json"))!;
      // The record names the program actually deployed and the application the data now belongs to (validated above
      // against the previous record): written only now, by the release being committed.
      await publishJson(markerPath, { dataVersion: DATA_VERSION, appVersion: APP_VERSION, build: APP_BUILD, transaction: deployment,
        application: applicationBinding(app) } satisfies DataVersion);
      await publishJson(releasePath, { ...release, phase: "committed" });
      return;
    }
    throw new Error("usage: data-current.ts check|preview|apply|validate|commit|committed|rollback --project PATH [--deployment ID] [--plan PATH] [--workspace PATH] [--upgrade]");
  });
}

try { operation.event("info", "current-data", `action=${action}`); await main(); }
catch (error) { operation.event("error", "current-data", operationError(error)); console.error((error as Error).message); process.exitCode = 1; }
finally {
  operation.event("info", "current-data", `data-finished: exit=${process.exitCode ?? 0}`);
  if (process.exitCode && operation.ownsLog && operation.name) console.error(`本次操作日志：${operation.name}`);
}
