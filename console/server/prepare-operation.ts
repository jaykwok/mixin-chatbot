import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { capture } from "./query.ts";
import { hostPlatform, opsCommand, SOURCE_DIR } from "../../ops/core/platform.ts";
import { readRuntimeSettings, sweepRuntimeDrafts, writeRuntimeDraft, type RuntimeChanges } from "../../ops/config/runtime-draft.ts";
import { withRuntimeLabels } from "../../ops/core/runtime-options.ts";
import { fields, operationArgs, textParam, tmpReader } from "../../ops/core/operations.ts";
import type { Views } from "./views.ts";
import type { UploadStore } from "./uploads.ts";
import type { BackupForms } from "./backup-forms.ts";
import { identityOf } from "./identity.ts";
import type { FormRoutes } from "./form-routes.ts";
import { maskUser, spaceLabel } from "../../ops/lib/format.ts";
import type { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { recoveryPlan } from "../../ops/core/recovery-plan.ts";
import type { DeploymentDirectory } from "./deployment-directory.ts";

/** Converts form input to host-only immutable references. The browser cannot submit argv or its own saved manifest. */
export function operationPreparer(project: string, views: Views, query = capture, uploads?: UploadStore, backups?: BackupForms, forms?: FormRoutes, configurations?: ConfigurationDrafts, directory?: DeploymentDirectory) {
  return async (operation: string, params: Record<string, unknown>, session: string): Promise<Record<string, unknown>> => {
    if (["update", "deploy", "repair"].includes(operation) && params.directory && typeof params.directory === "object") {
      if (!directory) throw new Error("部署部门选择器不可用");
      const normalized = { ...params, directory: await directory.prepare(params.directory, session) };
      operationArgs(operation, normalized); return normalized;
    }
    if (operation === "resume" || operation === "rollback") {
      fields(params, []);
      return { confirmation: recoveryPlan(project, operation).confirmation };
    }
    if (operation === "configuration-apply") {
      fields(params, ["draft"]); if (!configurations) throw new Error("配置草稿不可用");
      return configurations.prepare(textParam(params.draft), session);
    }
    if (operation === "history-compact") {
      fields(params, ["view", "member"]);
      const view = views.get(session, params.view, "space"), member = view.members.get(textParam(params.member));
      if (!member) throw new Error("成员列表已变化，请重新打开会话");
      return { space: view.space, phone: member.phone, memberLabel: identityOf(view.mode, member.key, member.phone, view.names.get(member.phone), member.code).label };
    }
    if (operation.startsWith("tmp-")) {
      if (!["tmp-purge", "tmp-reclaim", "tmp-discard"].includes(operation)) throw new Error("不支持这个管理操作");
      fields(params, operation === "tmp-discard" ? [] : operation === "tmp-purge" ? ["days", "scope"] : ["days"]);
      if (operation !== "tmp-discard" && (!Number.isSafeInteger(params.days) || Number(params.days) < 0 || Number(params.days) > 36500)) throw new Error("天数应为 0 至 36500 的整数；0 表示不限时间");
      const id = randomUUID(), argv = [operation === "tmp-purge" ? "tmp-preview" : operation, "--plan", id];
      let scopeLabel = "全部空间与成员";
      if (operation !== "tmp-discard") argv.push(...(params.days === 0 ? ["--all"] : ["--days", String(params.days)]));
      if (params.scope !== undefined) {
        if (!forms) throw new Error("文件范围列表不可用");
        const selected = forms.storageScope(session, textParam(params.scope));
        scopeLabel = `${spaceLabel(selected.space)} · ${maskUser(selected.user)}`;
        argv.push("--user", selected.user, "--group", selected.space === "direct" ? "direct" : selected.space.slice(7));
        if (selected.space !== "direct") argv.push("--storage-segment");
      }
      const command = opsCommand(hostPlatform(), argv, project, SOURCE_DIR, "console");
      const result = await query(command.command, command.args, { env: command.env, timeout: 90_000 });
      if (result.code !== 0 || result.timedOut) throw new Error("生成文件清单失败，请查看运维日志并重新预览");
      const saved = await tmpReader(operation)(join(project, "data"), id);
      if (!saved.ready) {
        const why = saved.reasons.map(item => item.count > 1 ? `${item.reason}（${item.count} 项）` : item.reason).join("；");
        throw new Error(`没有可处理的文件；保留 ${saved.kept} 项，待处置 ${saved.deferred} 项${why ? `。原因：${why}` : ""}`);
      }
      return { plan: saved.id, digest: saved.digest, scopeLabel };
    }
    if (operation === "runtime-configure") {
      fields(params, ["hash", "changes"]);
      const path = join(project, "data/config/runtime.json"), snapshot = await readRuntimeSettings(path);
      if (params.hash !== snapshot.hash) throw new Error("运行参数已变化，请刷新表单");
      await sweepRuntimeDrafts(path);
      try { return { draft: basename(await writeRuntimeDraft(snapshot, params.changes as RuntimeChanges, path)) }; }
      catch (error) { throw new Error(withRuntimeLabels(error instanceof Error ? error.message : "运行参数无效")); }
    }
    if (operation === "backup-clean") {
      if (!backups) throw new Error("备份列表不可用");
      return backups.prepare(params, session);
    }
    if (operation === "stat-import") {
      fields(params, ["path", "upload"]);
      if (params.upload !== undefined) {
        if (!uploads || params.path !== undefined) throw new Error("统计来源无效");
        const id = textParam(params.upload); return { path: uploads.path(id, session), upload: id };
      }
      const path = textParam(params.path);
      if (!isAbsolute(path)) throw new Error("请输入宿主机上统计文件的绝对路径");
      return { path: resolve(path) };
    }
    operationArgs(operation, params);
    return params;
  };
}
