import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { parseOptions } from "../../lib/maintenance-protocol.ts";
import { readBoundedText } from "../../lib/bounded-text.ts";
import { ConfigurationDrafts } from "../console/configuration-drafts.ts";
import { configurationDigest, type ConfigurationDraft } from "../../config/configuration-draft.ts";
import { parseConfigurationStage, stageKind } from "../../config/configuration-stage.ts";
import { MaintenanceRefused, runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";
import { maintenanceResult } from "./data-result.ts";
import { waitStream } from "./readiness.ts";
import { redactSecrets } from "../../lib/redact.ts";

/**
 * apply publishes a validated web draft (id and digest) or a terminal wizard's stage file (stage): both go through the
 * same check, stop, write, readiness and restore. restore finishes or undoes an interrupted publication.
 */
export interface ConfigurationRequest { action: "apply" | "restore"; id?: string; digest?: string; expect?: string; stage?: string }
export function configurationRequest(command: string, args: string[]): ConfigurationRequest {
  const action = command === "configuration-apply" ? "apply" : command === "configuration-restore" ? "restore" : undefined;
  if (!action) throw new Error("配置动作或草稿编号无效");
  if (action === "apply" && args[0] === "--stage") {
    const parsed = parseOptions(action, args, { values: ["--stage"], required: ["--stage"] }), stage = parsed.values.get("--stage")![0]!;
    if (!stageKind(basename(stage))) throw new Error("配置暂存文件名无效");
    return { action, stage: resolve(stage) };
  }
  const id = args[0];
  if (!id || !/^config-[a-f0-9]{32}$/.test(id)) throw new Error("配置动作或草稿编号无效");
  const key = action === "apply" ? "--digest" : "--expect";
  const parsed = parseOptions(action, args.slice(1), { values: [key], required: action === "apply" ? [key] : [] });
  const value = parsed.values.get(key)?.[0];
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw new Error("配置摘要无效");
  return { action, id, ...(value === undefined ? {} : action === "apply" ? { digest: value } : { expect: value }) };
}

/** The wizard already checked the answers with the operator (online where it needs to); the stage stands for a validated draft. */
export function configurationStageDraft(path: string, id: string): ConfigurationDraft {
  const kind = stageKind(basename(path));
  let text: string | null = null;
  try { text = readBoundedText(path, 64 * 1024 * 1024); } catch { /* Reported below. */ }
  if (!kind || text === null) throw new MaintenanceRefused("配置暂存无法读取；机器人未停止");
  let stage;
  try { stage = parseConfigurationStage(text, kind); }
  catch (error) { throw new MaintenanceRefused(`${error instanceof Error ? error.message : "配置暂存无法读取"}；机器人未停止`); }
  const now = Date.now(), draft: ConfigurationDraft = { version: 1, id, session: "terminal", createdAt: now, expiresAt: now + 30 * 60_000, revision: 0,
    base: stage.base, next: stage.next };
  draft.validated = { digest: configurationDigest(draft), summary: [], at: now };
  return draft;
}

export async function configurationStep(context: ReturnType<typeof createMaintenanceHost>, id: string, action: string,
  options: { input?: Uint8Array; digest?: string; expect?: string; signal?: AbortSignal } = {}): Promise<number> {
  const { input, digest, expect, signal } = options;
  return maintenanceResult(await context.data({ script: "scripts/config/configuration-apply.ts",
    args: [action, "--id", id, "--json", ...(input === undefined ? [] : ["--stdin", "--digest", digest!]), ...(expect ? ["--expect", expect] : [])],
    currentCode: true, protocol: true, ...(input === undefined ? {} : { input }),
    ...(["check", "restore-check"].includes(action) ? { readOnly: true } : action === "finish" ? { online: true as const } : {}),
  }, signal), action).code;
}

export async function runConfiguration(request: ConfigurationRequest, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  const id = request.id ?? "config-" + randomUUID().replaceAll("-", "");
  const operation = { ...maintenanceRequest(options.source, { command: "configuration-" + request.action,
    intent: request.action === "apply" ? "configuration" : "configuration-restore", label: request.action === "apply" ? "应用配置" : "恢复配置" }), configuration: id };
  const context = create(options, operation); let input: Uint8Array | undefined, digest = request.digest, kind: string | undefined;
  const step = (action: string, activeSignal?: AbortSignal) => configurationStep(context, id, action, {
    ...(["check", "apply"].includes(action) ? { input, digest } : {}),
    ...(request.action === "restore" && ["restore-check", "restore"].includes(action) ? { expect: request.expect } : {}), signal: activeSignal });
  return runMaintenance(operation, context.host, {
    async prepare(signal) {
      await context.prepare();
      if (request.action === "apply") {
        const draft = request.stage ? configurationStageDraft(request.stage, id) : new ConfigurationDrafts(options.project).read(id);
        if (request.stage) digest = draft.validated!.digest;
        else if (configurationDigest(draft) !== request.digest || draft.validated?.digest !== request.digest) throw new MaintenanceRefused("配置草稿未校验或已变化");
        input = Buffer.from(JSON.stringify(draft)); kind = draft.next.kind;
      }
      if (await step(request.action === "apply" ? "check" : "restore-check", signal)) throw new MaintenanceRefused("配置预检未通过；机器人未停止");
    },
    run: signal => step(request.action, signal),
    ...(request.action === "apply" ? {
      async recover() { if (await step("restore")) throw new Error("配置恢复未完成，保留恢复材料"); },
      // A format check cannot prove app credentials, and the bot is ready before its Stream connects: wait for the Stream.
      async started() {
        if (kind !== "app") return;
        const stream = await waitStream(options.project, options.streamTimeoutMs);
        if (!stream.connected) throw new Error(`新应用凭据启动后没有连上事件 Stream${stream.reason ? `（${redactSecrets(stream.reason)}）` : ""}；恢复原配置`);
      },
    } : {}),
    async complete() { if (await step("finish")) throw new Error("配置收尾未完成，保留恢复材料"); },
  }, signal);
}
