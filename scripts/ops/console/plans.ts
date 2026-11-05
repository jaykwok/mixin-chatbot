import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAtomic } from "./state.ts";
import type { TaskRequest } from "./tasks.ts";

export interface PlanFacts { project: string; platform: string; identity: string; head: string; protocol: 1; scope: string; runState: string; container?: string }
export interface OperationPlan {
  version: 1; id: string; operation: string; params: Record<string, unknown>; facts: PlanFacts;
  createdAt: number; expiresAt: number; summary: string[];
}
export type ObservePlan = (operation: string, params: Record<string, unknown>) => Promise<{ facts: PlanFacts; summary: string[] }>;

/** Stable digests for structured parameters and read sets, independent of JSON key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const planDigest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export class PlanStore {
  constructor(readonly consoleDir: string, readonly observe: ObservePlan, readonly now: () => number = Date.now) {}

  async create(operation: string, params: Record<string, unknown>): Promise<OperationPlan> {
    const { facts, summary } = await this.observe(operation, params), at = this.now();
    const plan: OperationPlan = { version: 1, id: `plan-${randomUUID().replaceAll("-", "")}`, operation, params,
      facts, summary, createdAt: at, expiresAt: at + 600_000 };
    mkdirSync(join(this.consoleDir, "plans"), { recursive: true, mode: 0o700 });
    this.prune();
    writeAtomic(join(this.consoleDir, "plans", `${plan.id}.json`), JSON.stringify(plan) + "\n");
    return plan;
  }

  read(id: string): OperationPlan {
    if (!/^plan-[a-f0-9]{32}$/.test(id)) throw new Error("计划编号无效");
    const path = join(this.consoleDir, "plans", `${id}.json`), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("计划文件无效");
    const plan = JSON.parse(readFileSync(path, "utf8")) as OperationPlan;
    if (plan?.version !== 1 || plan.id !== id || !plan.facts || plan.facts.protocol !== 1 || !plan.params || !Array.isArray(plan.summary)
      || !Number.isSafeInteger(plan.createdAt) || plan.expiresAt !== plan.createdAt + 600_000 || typeof plan.operation !== "string") throw new Error("计划文件损坏或版本不支持");
    return plan;
  }

  async verify(id: string, request?: TaskRequest): Promise<OperationPlan> {
    const plan = this.read(id);
    if (this.now() >= plan.expiresAt || this.now() < plan.createdAt) throw new Error("计划已过期，请重新预览");
    if (request && (request.operation !== plan.operation || canonical(request.params) !== canonical(plan.params)
      || resolve(request.project) !== resolve(plan.facts.project))) throw new Error("任务与确认过的计划不符");
    const { facts } = await this.observe(plan.operation, plan.params);
    if (canonical(facts) !== canonical(plan.facts)) throw new Error("部署身份、版本、运行状态或操作范围已变化，请重新预览");
    return plan;
  }

  /**
   * A plan holds the confirmed parameters, member numbers included. Once expired it can no longer be verified, so it is
   * removed an hour later, as is the temporary file of an interrupted write; an unreadable plan is kept for inspection.
   */
  prune(): void {
    const dir = join(this.consoleDir, "plans");
    let names: string[];
    try { names = readdirSync(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      const match = /^(plan-[a-f0-9]{32})\.json(\.[a-f0-9-]{36}\.tmp)?$/.exec(name);
      if (!match) continue;
      try {
        const expiresAt = match[2] ? lstatSync(join(dir, name)).mtimeMs + 600_000 : this.read(match[1]!).expiresAt;
        if (this.now() >= expiresAt + 3_600_000) rmSync(join(dir, name));
      } catch { /* unreadable, or the removal failed: kept, and retried by the next prune */ }
    }
  }
}
