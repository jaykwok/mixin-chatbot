#!/usr/bin/env bun
// Internal noninteractive entry. The ops wrapper holds the deployment lock, owns stop/readiness/restore, and checks
// the complete maintenance protocol. The Docker service identity receives private draft bytes only on stdin.
import { Protocol, UsageError, parseOptions } from "../lib/maintenance-protocol.ts";
import { configurationDigest, parseConfigurationDraft } from "./configuration-draft.ts";
import { assertConfigurationBase } from "./configuration-form.ts";
import { checkConfiguration } from "./configuration-check.ts";
import { applyConfiguration, assertRestorable, finishConfiguration, restoreConfiguration } from "./configuration-transaction.ts";
import { readConfigurationState, configurationStateDigest } from "../../src/core/configuration-state.ts";
import { assertMaintenanceAction } from "../../src/core/maintenance-state.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";

const [action = "", ...args] = process.argv.slice(2);
const protocol = new Protocol("json", action);
try {
  if (!["check", "apply", "restore-check", "restore", "finish"].includes(action)) throw new UsageError("配置动作无效");
  const writes = action === "check" || action === "apply";
  const parsed = parseOptions(action, args, { flags: ["--json", ...(writes ? ["--stdin"] : [])],
    values: ["--id", ...(writes ? ["--digest"] : action === "finish" ? [] : ["--expect"])], required: ["--id", ...(writes ? ["--digest"] : [])] });
  if (writes && !parsed.flags.has("--stdin")) throw new UsageError("配置草稿只经 stdin 传入：请加 --stdin");
  const id = parsed.values.get("--id")![0]!, expected = parsed.values.get("--digest")?.[0], project = process.cwd();
  if (!/^config-[a-f0-9]{32}$/.test(id) || (writes && !/^[a-f0-9]{64}$/.test(expected ?? ""))) throw new UsageError("配置草稿编号或摘要无效");
  if (writes) {
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of Bun.stdin.stream()) { bytes += chunk.length; if (bytes > 40 * 1024 * 1024) throw new Error("配置草稿过大"); chunks.push(chunk); }
    const draft = parseConfigurationDraft(Buffer.concat(chunks).toString("utf8"), id);
    if (configurationDigest(draft) !== expected || draft.validated?.digest !== expected) throw new Error("配置草稿没有通过校验或已变化");
    const validate = async () => {
      assertMaintenanceAction(project, "configuration"); assertConfigurationBase(project, draft.base);
      // Offline validation again in the identity/environment which will run the bot; no network or model inference.
      await checkConfiguration(draft.next, { root: project, network: false, refresh: false });
    };
    if (action === "check") await validate();
    else await withMaintenance(async () => { await validate(); await applyConfiguration(project, id, draft.base, draft.next); });
  } else {
    const state = readConfigurationState(project);
    const expectedState = parsed.values.get("--expect")?.[0];
    if (expectedState !== undefined && (!state || !/^[a-f0-9]{64}$/.test(expectedState) || configurationStateDigest(state) !== expectedState)) throw new Error("配置恢复状态已变化，请重新预览");
    // An apply refused before its first marker needs no restoration. Never adopt another transaction's material.
    if (state && state.id !== id) throw new Error("配置事务编号不匹配，保留现场");
    if (action === "restore-check") {
      if (!state) throw new Error("配置事务已结束");
      assertMaintenanceAction(project, "configuration-restore");
      // Before the stop: a restore that could only be refused must not stop the bot.
      if (state.phase !== "committed") assertRestorable(project, id);
    }
    else if (state && action === "restore" && state.phase !== "committed") await withMaintenance(async () => {
      assertMaintenanceAction(project, "configuration-restore"); await restoreConfiguration(project, id);
    });
    else if (state) await finishConfiguration(project, id);
  }
  protocol.emit("success", { result: null, text: `配置步骤 ${action} 已完成` });
} catch (error) {
  // A JSON syntax error can quote the bytes it stopped at, a secret too. Every other message here names fields, states or
  // steps only (checkConfiguration already replaces Pi's own errors), as in configuration-install.ts.
  const reason = error instanceof SyntaxError ? new Error("配置不是有效 JSON") : error;
  protocol.fail(reason, error instanceof UsageError ? "refused" : "failed", error instanceof UsageError ? "" : `配置步骤 ${action} 未完成：`);
}
