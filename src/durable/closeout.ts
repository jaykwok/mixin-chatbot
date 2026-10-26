import type { Context } from "@earendil-works/chord";
import { Type, type Message } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineExtension, type DocumentReader, GenerationTask, ToolTask, hook, type HookApi, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { basename, extname } from "node:path";
import { unlink } from "node:fs/promises";
import { completeFile, deliverableCandidates, freezeFile, registerDeliverable } from "../agent/deliverables.ts";
import { BASH_DEFAULT_TIMEOUT, NATIVE_FILE_MAX_BYTES } from "../core/config.ts";
import { resolveSource } from "../agent/send-tools.ts";
import { IdentityDoc } from "./identity.ts";
import { InboxDoc } from "./inbox.ts";
import { memberRecords, recordsOf, type RequestRecord } from "./records.ts";
import { memberTool, type BaseToolsOptions, type Member, type MemberCall } from "./tools.ts";

export interface CloseoutTiming { closeoutMs: number; reserveMs: number; fallbackMs: number }
export function validateCloseout(timing: CloseoutTiming, runTimeoutMs: number): void {
  if (![timing.closeoutMs, timing.reserveMs, timing.fallbackMs].every(x => Number.isSafeInteger(x) && x > 0) ||
    timing.reserveMs >= timing.closeoutMs || timing.closeoutMs >= runTimeoutMs / 2) {
    throw new Error("收尾配置无效：交付保留时间须小于收尾时间，收尾时间须小于任务总时限的一半；各时间须为正数");
  }
}
/** The running inbox item of the calling conversation, with its member and run record. */
export async function activeRequest(api: Pick<DocumentReader, "snapshot"> & Pick<HookApi, "conversationId">, context: Context) {
  const head = (await api.snapshot(InboxDoc, api.conversationId, context))?.items[0];
  if (!head || head.startedAt === undefined || head.cancelled) return;
  const identity = await api.snapshot(IdentityDoc, api.conversationId, context);
  if (!identity?.phone) return;
  const record = (await memberRecords(api, identity.phone, context)).requests[head.requestId];
  if (!record) return;
  return { requestId: head.requestId, startedAt: head.startedAt, phone: identity.phone, space: identity.space, record };
}

/** Change one run record in its own commit (hooks have no transaction of their own). */
export type RecordWriter = (phone: string, requestId: string, change: (record: RequestRecord) => void) => Promise<void>;
export function phase(remaining: number, timing: CloseoutTiming): "常规" | "收尾" | "交付" {
  return remaining <= timing.reserveMs ? "交付" : remaining <= timing.closeoutMs ? "收尾" : "常规";
}
export function appendTiming(messages: readonly Message[], text: string, now: number): Message[] {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content];
    return [...messages.slice(0, -1), { ...last, content: [...content, { type: "text", text }] }];
  }
  return [...messages, { role: "user", content: [{ type: "text", text }], timestamp: now }];
}
export async function closeoutTool(name: string, args: unknown, api: ToolExecutionApi, context: Context, timing: CloseoutTiming, runTimeoutMs: number) {
  const item = await activeRequest(api, context);
  if (!item) return args;
  const remaining = item.startedAt + runTimeoutMs - Date.now(), stage = phase(remaining, timing);
  if (stage === "交付" && !["send_file", "send_image", "deliverable_register", "read"].includes(name)) {
    throw new Error(`任务只剩 ${Math.max(0, Math.ceil(remaining / 1000))} 秒，已进入交付阶段；仅允许 read、deliverable_register、send_file、send_image。请立即交付已登记版本。`);
  }
  if (name === "bash") {
    const params = args as { timeout?: number };
    const available = Math.floor((remaining - timing.reserveMs) / 1000);
    if (available < 1) throw new Error("剩余时间已保留给交付，不能启动新命令");
    return { ...params, timeout: Math.min(params.timeout ?? BASH_DEFAULT_TIMEOUT, available) };
  }
  return args;
}

const DOCUMENT_TOOLS = ["document_build", "document_compose", "document_patch"];

export function closeoutExtension(write: RecordWriter, timing: CloseoutTiming, runTimeoutMs: number) {
  return defineExtension({ name: "mixin.clock", hooks: [
    hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        const item = await activeRequest(api, context); if (!item) return;
        const now = Date.now(), deadline = item.startedAt + runTimeoutMs, remaining = Math.max(0, deadline - now), stage = phase(remaining, timing);
        const seconds = Math.ceil(remaining / 1000), versions = Object.values(item.record.events).filter(x => DOCUMENT_TOOLS.includes(x.name)).length;
        const registered = deliverableCandidates(item.record), sent = item.record.files.filter(x => x.state === "sent").length;
        const direction = stage === "交付" ? "立即登记并发送最佳可交付版本，简述检查范围和未检查项。" : stage === "收尾" ? "停止美化及非必要重建；先登记最佳版本再发送，只修正事实错误。" : "";
        const text = `[任务计时] 剩余 ${Math.floor(seconds / 60)}分${seconds % 60}秒；阶段：${stage}；本任务已生成文档 ${versions} 版；已登记交付物 ${registered.length} 个；已发送 ${sent} 个。${direction}${versions >= 4 ? "除修正事实错误外不要再重建。" : ""}`;
        return { messages: appendTiming(request.messages, text, now) };
      },
      async onYield(_answer, api, context) {
        const item = await activeRequest(api, context); if (!item) return;
        if (item.record.events.delivery_reminder) return;
        const sends = item.record.files;
        const missing = deliverableCandidates(item.record).filter(x => !sends.some(s => s.sha256 === x.sha256 && (s.state === "sent" || s.mode === "relay")));
        if (!missing.length) return;
        await write(item.phone, item.requestId, record => { record.events.delivery_reminder ??= { name: "delivery_reminder", at: Date.now() }; });
        return { continue: `你登记了 ${missing.map(x => `《${x.name}》`).join("、")} 但尚未发送；请立即发送。如果不需要发送，请在回复中说明原因。` };
      },
    }),
    hook(ToolTask, { async afterTool(call, result, api, context) {
      if (result.isError || !["document_build", "document_compose", "document_patch", "document_render"].includes(call.name)) return;
      const item = await activeRequest(api, context); if (!item) return;
      const output = result.structuredOutput ?? result.details;
      const digest = output && typeof output === "object" && "digest" in output && typeof output.digest === "string" ? output.digest : undefined;
      await write(item.phone, item.requestId, record => { record.events[`${api.taskId}/${call.id}`] ??= { name: call.name, ...(digest ? { digest } : {}), at: Date.now() }; });
      return undefined;
    } }),
  ] });
}

const registerParams = Type.Object({
  path: Type.String(), slot: Type.Optional(Type.String({ maxLength: 120 })),
  status: Type.Union([Type.Literal("checked"), Type.Literal("draft"), Type.Literal("rejected")]),
  checked: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 }),
  unchecked: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 }),
  issues: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 }),
});
function registerDefinition(member?: Member, call?: MemberCall, maxBytes = NATIVE_FILE_MAX_BYTES): ToolDefinition<typeof registerParams> {
  return {
    name: "deliverable_register", label: "登记交付物", exposure: "model-only",
    description: "登记生成文件的不可变副本，供失败时自动交付。先登记再美化；检查后再登记 checked。图片、参数、事实错误必须标记 rejected；draft 只允许外观问题或尚未检查。每任务最多 3 个交付物、8 个版本。登记不等于发送，也不证明内容已核对。",
    parameters: registerParams,
    async execute(_id, params, signal) {
      if (!member || !call) throw new Error("catalogue only");
      const item = await activeRequest(call.api, call.context); if (!item) throw new Error("没有正在执行的任务，不能登记交付物");
      const source = await resolveSource(params.path, member.places.workspaceDir, member.places.tempDir, signal);
      if (source.kind !== "local") throw new Error("只能登记当前用户 tmp 或共享资料 workspace 内的文件");
      const frozen = await freezeFile(source.path, member.places.tempDir, item.requestId, maxBytes, signal);
      try {
        const complete = await completeFile(frozen.path, frozen.format);
        const layout = ["docx", "pptx"].includes(frozen.format) && params.status === "checked" && params.checked.some(x => /版式|看图/.test(x));
        const rendered = Object.values(item.record.events).some(x => x.name === "document_render" && x.digest === frozen.sha256);
        const downgrade = layout && !rendered;
        const entry = { ...frozen,
          slot: params.slot?.trim() || basename(source.path, extname(source.path)), complete, status: downgrade ? "draft" as const : params.status,
          checked: downgrade ? params.checked.filter(x => !/版式|看图/.test(x)) : params.checked,
          unchecked: [...params.unchecked, ...(downgrade ? ["版式未检查（未渲染该版本）"] : [])], issues: params.issues };
        const record = await call.api.commit(async tx => {
          const current = (await recordsOf(tx, item.phone)).requests[item.requestId];
          if (!current || current.closedAt !== undefined) throw new Error("任务已结束，不能再登记交付物");
          return structuredClone(registerDeliverable(current, entry));
        }, call.context);
        return { content: [{ type: "text", text: JSON.stringify({ ...record, message: !complete ? "文件结构不完整，不会自动发送" : downgrade ? "未渲染该版本，已降为草稿" : "已登记，发送时使用 snapshot 路径", snapshot: record.path }) }], details: record, ...(complete ? {} : { isError: true }) };
      } catch (error) { await unlink(frozen.path).catch(() => {}); throw error; }
    },
  };
}
export function deliverableTool(options: BaseToolsOptions, maxBytes?: number) {
  return memberTool(registerDefinition(), options, (member, call) => [registerDefinition(member, call, maxBytes)]);
}
