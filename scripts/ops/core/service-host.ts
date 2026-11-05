import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assessMaintenanceAction, readMaintenanceState } from "../../../src/core/maintenance-state.ts";
import { assertDataVersion, readRelease } from "../../../src/core/data-version.ts";
import { withDeploymentLock, type DeploymentLock } from "./deployment-lock.ts";
import { DockerPlatform } from "./docker-host.ts";
import { WindowsPlatform } from "./windows-host.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import { serviceReady } from "./readiness.ts";
import type { ServiceControlHost } from "./service.ts";
import type { OpsResult } from "./result.ts";
import { readOpsMaintenanceRecord } from "../../../src/core/ops-maintenance-state.ts";
import { readOpsDeploymentRecord } from "../../../src/core/ops-deployment-state.ts";

export interface Platform {
  inspect(): Promise<{ identity: string; state: "running" | "stopped" | "absent" | "unsupported"; owned: boolean; rawState?: string }>;
  start(identity: string): Promise<void>;
  stop(identity: string): Promise<void>;
}
export interface ServiceHostOptions {
  project: string;
  source: string;
  verify(): Promise<void>;
  finish(result: OpsResult): Promise<void>;
  platform?(): Promise<Platform>;
  readyTimeoutMs?: number;
  expectedState?: string;
  /** Only the lock-held orchestrator can authorize its own restart after the writer is reaped. */
  maintenanceId?: string;
  allowPendingMaintenance?: boolean;
  locked?(lock: DeploymentLock, platform: Platform): Promise<void>;
}
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Shared host for CLI and web tasks. Only native effects differ by platform. All hooks run inside deploy.lock. */
export function createServiceHost(options: ServiceHostOptions): ServiceControlHost {
  let lock: DeploymentLock | undefined, platform: Platform | undefined, expected: string | undefined;
  const held = () => { if (!lock) throw new Error("未持有部署锁"); lock.assertHeld(); if (!platform) throw new Error("平台未初始化"); return platform; };
  return {
    async locked(body) {
      if (lock) throw new Error("同一个服务控制宿主不能并发使用");
      return withDeploymentLock(options.project, async acquired => {
        lock = acquired;
        try {
          platform = await (options.platform?.() ?? (process.platform === "win32"
            ? Promise.resolve(new WindowsPlatform(options.project, options.source)) : DockerPlatform.connect(options.project)));
          await options.locked?.(lock, platform);
          return await body();
        } finally { lock = undefined; platform = undefined; expected = undefined; }
      });
    },
    async verify() {
      const adapter = held(); await options.verify();
      // Explicit stop needs ownership and the deployment lock, not permission to start. Recovery reads the complete
      // record itself before and inside the lock; allowing it here never converts a corrupt record into absence.
      if (!options.allowPendingMaintenance) {
        const record = readOpsMaintenanceRecord(options.project);
        if (record && !record.result) throw new MaintenanceRefused("上次运维尚未收尾，请先运行 ops maintenance-recover");
        const deployment = readOpsDeploymentRecord(options.project);
        if (deployment && !deployment.completion) throw new MaintenanceRefused("上次部署执行尚未收尾，请先继续或回滚原部署（数据已提交时只能继续）");
      }
      if (options.expectedState && (await adapter.inspect()).rawState !== options.expectedState) throw new MaintenanceRefused("运行状态已变化，请重新预览");
    },
    async inspect() {
      const facts = await held().inspect(); expected ??= facts.identity;
      return { ...facts, pending: ["deploy-transaction", "upgrade-transaction"].some(name => present(join(options.project, "data/state", name))),
        ready: facts.state === "running" && await serviceReady(options.project) };
    },
    async assess(intent) {
      held();
      try { assertDataVersion(options.project); }
      catch (error) { throw new MaintenanceRefused((error as Error).message); }
      if (present(join(options.project, "data/state/verify-only")) || readRelease(options.project)?.phase === "prepared") throw new MaintenanceRefused("部署仍处于只验证阶段，请继续或回滚");
      const state = readMaintenanceState(options.project), record = readOpsMaintenanceRecord(options.project);
      // Do not bypass unreadable records or an unreaped writer. Other storage blockers are always assessed unchanged.
      if (options.maintenanceId && record?.checkpoint.request.id === options.maintenanceId && !record.result
        && (!record.writer || record.writer.phase === "reaped")) delete state.orchestration;
      const result = assessMaintenanceAction(state, intent);
      if (!result.allowed) throw new MaintenanceRefused(result.reasons.join("；"));
    },
    async stop() { const adapter = held(); if (!expected) throw new Error("尚未核对部署身份"); await adapter.stop(expected); },
    async start() { const adapter = held(); if (!expected) throw new Error("尚未核对部署身份"); await adapter.start(expected); },
    async waitReady() {
      const until = performance.now() + (options.readyTimeoutMs ?? 30_000);
      do {
        const facts = await held().inspect();
        if (!facts.owned || facts.identity !== expected) throw new MaintenanceRefused("等待就绪期间部署身份发生变化");
        if (facts.state === "running" && await serviceReady(options.project, Math.min(2500, Math.max(1, until - performance.now())))) return true;
        if (performance.now() >= until) return false;
        await Bun.sleep(Math.min(500, until - performance.now()));
      } while (performance.now() < until);
      return false;
    },
    async finish(result) { held(); await options.finish(result); },
  };
}
