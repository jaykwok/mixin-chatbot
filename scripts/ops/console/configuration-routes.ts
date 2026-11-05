import { capture } from "../shared/query.ts";
import type { ConfigurationDrafts } from "./configuration-drafts.ts";
import { configurationKind } from "../../config/configuration-form.ts";
import type { ConfigurationCheckResult } from "../../config/configuration-check.ts";
import { fields, textParam } from "./operations.ts";
import { ApiProblem, type Route } from "./routes.ts";
import { readConfigurationState } from "../../../src/core/configuration-state.ts";
import { readOpsMaintenanceRecord } from "../../../src/core/ops-maintenance-state.ts";
import { runtimeQuery } from "./runtime-query.ts";
import { redactSecrets } from "../../lib/redact.ts";

export type ConfigurationQuery = (action: "check" | "catalog", input: unknown, signal?: AbortSignal) => Promise<unknown>;

const UNCHANGED = "正式配置未修改";
/**
 * The project's own refusals are short Chinese sentences that name fields, never their values (the models check already
 * replaces Pi's text). Library, runtime and system errors are English and may quote input: those stay generic.
 */
function configurationReason(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!line || line.length > 400 || !/[㐀-鿿]/.test(line)) return undefined;
  const clean = redactSecrets(line).replace(/\b1[3-9]\d{9}\b/g, value => `${value.slice(0, 3)}****${value.slice(-4)}`);
  return /未修改|尚未写入|没有覆盖/.test(clean) ? clean : `${clean}；${UNCHANGED}`;
}
const ownReason = (error: unknown) => error instanceof Error && error.constructor === Error && !("code" in error) ? configurationReason(error.message) : undefined;

/** Same installed runtime and service identity on Docker hosts, without stopping the service or mounting the console. */
export function configurationQuery(project: string, query = capture): ConfigurationQuery {
  return async (action, input, signal) => {
    const result = await runtimeQuery(project, "configuration-check", action, action === "check" ? input : undefined, signal, query);
    if (result.timedOut) throw new ApiProblem(504, "timeout", `配置校验超时，请检查网络和镜像依赖；${UNCHANGED}`);
    if (result.code !== 0) throw new ApiProblem(409, "input", configurationReason(result.stderr) ?? `配置校验未完成，请检查字段、凭据引用、镜像依赖和网络；${UNCHANGED}`);
    try {
      const value = JSON.parse(result.stdout);
      if (value.version !== 1 || value.protocol !== (action === "check" ? "mixin-configuration" : "mixin-configuration-catalog") || (action === "check" && value.success !== true)) throw new Error();
      return value;
    } catch { throw new Error("配置校验返回了不完整或不支持的结果"); }
  };
}

export function configurationRoutes(drafts: ConfigurationDrafts, query = configurationQuery(drafts.project)): Record<string, Route> {
  const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
    try { return await run(context); } catch (error) {
      if (error instanceof ApiProblem) throw error;
      throw new ApiProblem(409, "input", ownReason(error) ?? `配置请求未完成：请检查字段、草稿期限、凭据及校验环境，必要时重新读取。${UNCHANGED}`);
    }
  } });
  const revision = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("草稿版本无效"); return Number(value); };
  return {
    "GET /api/configuration/state": { run: async () => {
      try {
        const state = readConfigurationState(drafts.project), maintenance = readOpsMaintenanceRecord(drafts.project);
        return { transaction: state ? { id: state.id, phase: state.phase, kind: state.kind } : null,
          maintenancePending: !!maintenance && !maintenance.result };
      } catch { throw new ApiProblem(409, "input", "恢复状态无法读取或格式不支持；请保留记录并检查运维日志，不能据此判断配置是否已修改"); }
    } },
    "POST /api/configuration/open": wrap(async ({ body, session }) => {
      const params = body as Record<string, unknown>; fields(params, ["kind"]); return drafts.create(configurationKind(params.kind), session.label);
    }),
    "POST /api/configuration/edit": wrap(async ({ body, session }) => {
      const params = body as Record<string, unknown>; fields(params, ["id", "revision", "patch"]);
      return drafts.edit(textParam(params.id), session.label, revision(params.revision), params.patch);
    }),
    "POST /api/configuration/check": wrap(async ({ body, session, signal }) => {
      const params = body as Record<string, unknown>; fields(params, ["id", "revision", "network", "refresh"]);
      if (typeof params.network !== "boolean" || typeof params.refresh !== "boolean" || (params.refresh && !params.network)) throw new Error("请明确选择校验方式");
      const id = textParam(params.id), rev = revision(params.revision), input = drafts.validationInput(id, session.label, rev);
      const result = await query("check", { version: 1, snapshot: input.snapshot, network: params.network, refresh: params.refresh }, signal) as ConfigurationCheckResult;
      signal.throwIfAborted();
      if (result?.protocol !== "mixin-configuration" || result.version !== 1 || result.success !== true) throw new Error("校验结果无效");
      return drafts.validated(id, session.label, rev, input.digest, result.summary, result.catalog);
    }),
    "POST /api/configuration/discard": wrap(async ({ body, session }) => {
      const params = body as Record<string, unknown>; fields(params, ["id"]); drafts.discard(textParam(params.id), session.label); return { discarded: true };
    }),
    "GET /api/configuration/catalog": wrap(async ({ signal }) => query("catalog", undefined, signal)),
  };
}
