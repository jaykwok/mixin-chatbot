#!/usr/bin/env bun
// The host sends the validated advanced-settings draft over stdin. Publication and recovery share configuration storage.
import { createHash } from "node:crypto";
import { Protocol, parseOptions, UsageError } from "../lib/maintenance-protocol.ts";
import { configurationSnapshot } from "./configuration-form.ts";
import { nextRuntimeDraft, validateRuntimeDraft } from "./runtime-draft.ts";
import { applyConfiguration } from "./configuration-transaction.ts";
import { assertMaintenanceAction } from "../../src/core/maintenance-state.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";

const [action = "", ...args] = process.argv.slice(2), protocol = new Protocol("json", action);
try {
  if (!["check", "apply"].includes(action)) throw new UsageError("运行参数动作无效");
  const parsed = parseOptions(action, args, { flags: ["--stdin", "--json"], values: ["--id", "--digest"], required: ["--id", "--digest"] });
  const id = parsed.values.get("--id")![0]!, digest = parsed.values.get("--digest")![0]!;
  if (!parsed.flags.has("--stdin") || !/^config-[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest)) throw new UsageError("运行参数请求无效");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) { bytes += chunk.length; if (bytes > 64 * 1024) throw new Error("运行参数草稿过大"); chunks.push(chunk); }
  const raw = Buffer.concat(chunks);
  if (createHash("sha256").update(raw).digest("hex") !== digest) throw new Error("运行参数输入摘要不符");
  const draft = validateRuntimeDraft(JSON.parse(raw.toString("utf8")));
  const prepare = () => {
    assertMaintenanceAction(process.cwd(), "configuration");
    const base = configurationSnapshot(process.cwd(), "runtime");
    return { base, next: { ...base, files: { runtime: nextRuntimeDraft(base.files.runtime!, draft, process.env) } } };
  };
  if (action === "check") prepare();
  else await withMaintenance(async () => { const { base, next } = prepare(); await applyConfiguration(process.cwd(), id, base, next); });
  protocol.emit("success", { result: null, text: `运行参数步骤 ${action} 已完成` });
} catch (error) {
  // A JSON syntax error can quote the draft or runtime.json. Every other message here names settings, ranges, states or
  // steps only (validateRuntimeConfig never names a value), as in configuration-install.ts.
  const reason = error instanceof SyntaxError ? new Error("运行参数草稿或 runtime.json 不是有效 JSON") : error;
  protocol.fail(reason, error instanceof UsageError ? "refused" : "failed", error instanceof UsageError ? "" : `运行参数步骤 ${action} 未完成：`);
}
