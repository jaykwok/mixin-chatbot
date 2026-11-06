import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { codeDigest } from "./source-runtime.ts";
import { DockerPlatform } from "./docker-host.ts";
import { recoverDockerTask } from "./docker-task.ts";
import { recoverWindowsTask } from "./windows-task.ts";
import { MaintenanceRecord } from "./maintenance-record.ts";
import { createServiceHost, type Platform } from "./service-host.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { consoleDir, prepareConsoleDir } from "./console-state.ts";
import { removeStatsStage } from "./stats-stage.ts";
import { createMaintenanceHost, type MaintenanceHostOptions } from "./maintenance-host.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { configurationStep } from "./configuration.ts";
import { removeRuntimeInput } from "./runtime-input.ts";

/** Recovery settles the recorded writer and the original run state. It never repeats clear/compact to infer success. */
export async function recoverMaintenance(options: MaintenanceHostOptions): Promise<OpsResult> {
  let result: OpsResult = { protocol: "mixin-ops", version: 1, command: "maintenance-recover", outcome: "failed", exitCode: 1,
    wasRunning: false, finalState: "unknown", message: "维护恢复尚未完成" };
  try {
    const before = readOpsMaintenanceRecord(options.project);
    if (before && !before.result && before.checkpoint.request.runtime !== codeDigest(options.source)) {
      prepareConsoleDir(consoleDir(options.project));
      const pinned = join(consoleDir(options.project), "runtime", "source-" + before.checkpoint.request.runtime);
      try { if (codeDigest(pinned) !== before.checkpoint.request.runtime) throw new Error(); }
      catch { throw new MaintenanceRefused("原固定版本运行包缺失或摘要不符；恢复记录已保留"); }
      const original = await import(pathToFileURL(join(pinned, "ops/core/maintenance-recovery.ts")).href);
      if (typeof original.recoverMaintenance !== "function") throw new MaintenanceRefused("原固定运行包不支持此恢复协议");
      return await original.recoverMaintenance({ ...options, source: pinned });
    }
    let store: MaintenanceRecord | undefined, platform: Platform | undefined;
    const recoveryOptions: MaintenanceHostOptions = { ...options, maintenanceId: before?.checkpoint.request.id, allowPendingMaintenance: true,
      async locked(lock, adapter) {
        platform = adapter; store = new MaintenanceRecord(options.project, before?.checkpoint.request.id ?? "0".repeat(32), () => lock.assertHeld());
        await options.locked?.(lock, adapter);
      },
    };
    const context = before && !before.result ? createMaintenanceHost({ ...recoveryOptions, resuming: true }, before.checkpoint.request) : undefined;
    const host = context?.host ?? createServiceHost(recoveryOptions);
    return await host.locked(async () => {
      try {
        await host.verify(); const current = store!.read();
        if (JSON.stringify(current) !== JSON.stringify(before)) throw new MaintenanceRefused("取锁前恢复记录已变化，请重新执行恢复");
        const facts = await host.inspect();
        result.finalState = !facts.owned || facts.state === "unsupported" ? "unknown" : facts.state === "running" ? facts.ready ? "running" : "start-requested" : "stopped";
        if (!current || current.result) { result = { ...result, outcome: "success", exitCode: 0, message: "没有未完成的运维恢复" }; }
        else {
          const checkpoint = current.checkpoint, original = checkpoint.original;
          result.wasRunning = original.state === "running";
          if (!facts.owned || facts.identity !== original.identity || facts.state === "unsupported" || facts.pending) throw new MaintenanceRefused("部署身份、运行方式或事务已变化；保留运维恢复记录");
          if (checkpoint.request.runtime !== codeDigest(options.source)) throw new MaintenanceRefused("恢复必须使用原固定版本运行包；请从 .console/runtime/source-" + checkpoint.request.runtime + "/ops/core/cli.ts 执行 maintenance-recover");
          if (!["history-clear", "history-compact", "stat-import", "tmp-ls", "tmp-preview", "tmp-purge", "tmp-reclaim", "tmp-discard", "configuration-apply", "configuration-restore", "runtime-configure", "backup-scan", "backup-clean", "relay-ls", "relay-test", "relay-purge"].includes(checkpoint.request.command)) throw new MaintenanceRefused("此版本尚不支持该维护动作的恢复；记录已保留");
          if (current.writer && current.writer.phase !== "reaped" && facts.state === "running" && !checkpoint.request.online) await host.stop();
          if (current.writer?.kind === "docker") {
            if (!(platform instanceof DockerPlatform)) throw new Error("Docker 维护必须由原宿主恢复");
            await recoverDockerTask(platform.taskDriver(), current.writer, value => store!.writer(value));
          } else if (current.writer?.kind === "windows-job") await recoverWindowsTask(current.writer, value => store!.writer(value));
          if (current.staging) await removeStatsStage(options.project, current.staging, value => store!.staging(value));
          let after = await host.inspect();
          if (!after.owned || after.identity !== original.identity || after.state === "unsupported") throw new MaintenanceRefused("回收写入者后部署状态变化");
          let finishConfiguration = false;
          if (checkpoint.request.configuration) {
            const state = readConfigurationState(options.project);
            if (state && state.id !== checkpoint.request.configuration) throw new MaintenanceRefused("配置事务不属于中断的维护，已保留现场");
            if (state) {
              if (state.phase !== "committed" && after.state === "running") { await host.stop(); after = await host.inspect(); }
              await store!.checkpoint({ ...checkpoint, phase: "recovering" });
              await context!.prepare();
              // A committed publication only needs finish; never roll it back or repeat an apply after a hard kill.
              const action = state.phase === "committed" ? "finish" : "restore";
              if (await configurationStep(context!, state.id, action)) throw new Error("配置恢复未完成，保留维护和配置恢复材料");
              finishConfiguration = action === "restore";
            }
          }
          let blocked = "";
          if (result.wasRunning) {
            try { await host.assess("service"); }
            catch (error) { if (!(error instanceof MaintenanceRefused)) throw error; blocked = error.message; }
            if (!blocked) {
              await store!.checkpoint({ ...checkpoint, phase: "starting" });
              if (after.state !== "running") await host.start();
              if (!await host.waitReady()) throw new Error("恢复已请求启动，实例身份与就绪检查未通过；再次运行 maintenance-recover");
              after = await host.inspect();
              if (after.identity !== original.identity || after.state !== "running" || !after.ready) throw new Error("恢复后的运行状态无法确认");
            } else if (after.state === "running") { await host.stop(); after = await host.inspect(); }
          } else if (after.state === "running") throw new MaintenanceRefused("维护前停止的实例现在在运行，未擅自修改状态");
          if (finishConfiguration) {
            await store!.checkpoint({ ...checkpoint, phase: "completing" });
            if (await configurationStep(context!, checkpoint.request.configuration!, "finish")) throw new Error("配置收尾未完成，请再次执行维护恢复");
          }
          if (current.runtimeDraft) await removeRuntimeInput(options.project, current.runtimeDraft, checkpoint.request.configuration!, value => store!.runtimeDraft(value));
          result = { ...result, finalState: after.state === "running" ? "running" : "stopped", outcome: blocked ? "failed" : "success", exitCode: blocked ? 1 : 0,
            message: blocked ? "写入者已回收；数据维护状态禁止启动：" + blocked : checkpoint.request.configuration
              ? "中断的配置维护已收尾，恢复原运行状态；未重复应用草稿" : "中断的运维已收尾，恢复原运行状态；未重复执行数据操作" };
          // The original operation was interrupted, even if restoring its run state succeeded. Do not rewrite it as successful.
          await options.finish(result);
          await store!.finish({ ...result, command: checkpoint.request.command, outcome: "failed", exitCode: 1,
            message: "原操作中断，恢复已收尾写入者、处理恢复材料并核对运行状态；原动作未重复执行" });
          return result;
        }
      } catch (error) { result = { ...result, outcome: error instanceof MaintenanceRefused ? "refused" : "failed", exitCode: 1, message: (error as Error).message }; }
      await options.finish(result); return result;
    });
  } catch (error) { return { ...result, outcome: "failed", exitCode: 1, message: (error as Error).message }; }
}
