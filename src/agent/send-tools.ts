// 发送工具定义：send_image / send_file（ToolDefinition，Pi agent 经 customTools 调用）。
// 从 im 层封装：agent 给 source（URL、群 workspace 或当前用户 tmp 内路径），工具负责读取 + 上传 + 发送。
//
// 大小分两条路：不超过 IM 单条附件上限的走原来的「读进内存 + 上传 + 发附件消息」；
// 超过上限的本地文件在配置了外链后端时改为流式 PUT 到外部存储，在群里发一条下载链接
// （见 ../integrations/relay.ts）。未配置外链时行为与之前完全一致——直接报文件过大。
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  formatSize,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  ATTACHMENT_HTTP_TIMEOUT,
  MAX_ATTACHMENT_BYTES,
} from "../core/config.ts";
import { sendFile, sendImage, uploadAttachment } from "../integrations/im.ts";
import { describeRelayExpiry, relayFile, type RelayConfig } from "../integrations/relay.ts";
import type { RelayIndex } from "../integrations/relay-index.ts";
import { isPathInside } from "./paths.ts";

/**
 * 定位来源但不读取内容。本地路径在这里就做完 canonical path/符号链接边界校验并拿到
 * 大小，让「多大」和「能不能碰」两个判断都发生在读取之前——外链那条路要靠这个大小来
 * 决定走哪边，也靠它避免把一个 2GB 文件先读进内存才发现放不下。
 */
type ResolvedSource =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string; size: number };

async function resolveSource(
  source: string,
  workspaceDir: string,
  tempDir: string,
  signal?: AbortSignal
): Promise<ResolvedSource> {
  signal?.throwIfAborted();
  if (/^https?:\/\//i.test(source)) return { kind: "remote", url: source };

  const roots = await Promise.all([
    realpath(resolve(workspaceDir)),
    realpath(resolve(tempDir)),
  ]);
  const requestedPath = isAbsolute(source) ? resolve(source) : resolve(roots[0], source);
  const path = await realpath(requestedPath);
  if (!roots.some((root) => isPathInside(path, root))) {
    throw new Error("只能发送本群 workspace 或当前调用用户 tmp 目录内的文件");
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`不是普通文件: ${source}`);
  return { kind: "local", path, size: info.size };
}

/**
 * 超限报错。这条消息会经模型转述进群里，未配置外链后端时它就是用户能得到的全部解释，
 * 所以给人看的单位和实际大小都要带上——原始字节数对着群成员没有意义。
 */
function oversizeError(kind: string, size: number): Error {
  return new Error(
    `${kind}（${formatSize(size)}）超过群聊单条附件上限 ${formatSize(MAX_ATTACHMENT_BYTES)}`
  );
}

/** 下载远程内容，边收边卡上限，避免声明的 content-length 说谎。 */
async function fetchRemoteBytes(
  url: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const r = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ATTACHMENT_HTTP_TIMEOUT)])
      : AbortSignal.timeout(ATTACHMENT_HTTP_TIMEOUT),
  });
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    throw new Error(`下载失败 HTTP ${r.status}: ${url}`);
  }
  const declared = Number(r.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    await r.body?.cancel().catch(() => {});
    throw oversizeError("远程文件", declared);
  }
  if (!r.body) throw new Error(`下载响应没有内容: ${url}`);

  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw oversizeError("远程文件", total);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/** 读进内存供 IM 直传；只在确认不超过单条附件上限后调用。 */
async function readBytes(
  resolved: ResolvedSource,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (resolved.kind === "remote") {
    return fetchRemoteBytes(resolved.url, signal);
  }
  if (resolved.size > MAX_ATTACHMENT_BYTES) {
    throw oversizeError("本地文件", resolved.size);
  }
  const data = new Uint8Array(await readFile(resolved.path));
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw oversizeError("本地文件", data.byteLength);
  }
  signal?.throwIfAborted();
  return data;
}

function filenameFromSource(source: string): string {
  const clean = source.split("?")[0];
  let name = clean.split(/[\\/]/).pop() || "file";
  try {
    name = decodeURIComponent(name);
  } catch {
    // 非法 URL 编码保持原样，后续统一清洗。
  }
  return sanitizeFilename(name);
}

function sanitizeFilename(filename: string): string {
  const clean = filename
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 200);
  return clean || "file";
}

/**
 * 工具产出的、必须原样进群的文本。
 *
 * 外链是这次 send_file 的全部产出——URL 一个字符都不能错，所以不能指望模型在回复里
 * 复述它。但工具自己发一条、模型的回复再发一条，一次发送就吃掉两条出站配额，而平台的
 * 限流是按条算的。所以工具把这段话交给运行时，由运行时拼进那条唯一的回复里。
 */
export interface OutboundNotes {
  add(note: string): void;
  /** 只读快照。拼回复时用它，但在确认送达前不清空。 */
  peek(): string[];
  /** 确认已送达后才清空。 */
  clear(): void;
  /** 取走并清空，用于异常路径兜底补发。 */
  drain(): string[];
}

export function createOutboundNotes(): OutboundNotes {
  let notes: string[] = [];
  return {
    add: (note) => {
      notes.push(note);
    },
    peek: () => [...notes],
    clear: () => {
      notes = [];
    },
    drain: () => {
      const drained = notes;
      notes = [];
      return drained;
    },
  };
}

export interface SendToolsOptions {
  /** callback URL 用 getter 读取，以支持平台轮换机器人 key。 */
  getCallbackUrl: () => string;
  /** 固定为创建当前用户会话时所属的群，不能从模型参数中获取。 */
  groupId: string;
  workspaceDir: string;
  tempDir: string;
  /** 缺省或 null 表示未配置外链后端，超限文件按原样报错。 */
  relay?: RelayConfig | null;
  /** 覆盖默认的进程级外链去重索引。 */
  relayIndex?: RelayIndex;
  /** 外链地址交给它，由运行时并入本轮唯一的那条回复。 */
  notes: OutboundNotes;
}

export function buildSendTools(options: SendToolsOptions): ToolDefinition[] {
  const { getCallbackUrl, groupId, workspaceDir, tempDir, relay, relayIndex, notes } = options;

  const imageParams = Type.Object({
    source: Type.String({
      description: "图片来源：http(s) URL、本群 workspace 或当前用户 tmp 内的路径",
    }),
    width: Type.Optional(Type.Number({ description: "宽度（像素，可选）" })),
    height: Type.Optional(Type.Number({ description: "高度（像素，可选）" })),
  });
  const fileParams = Type.Object({
    source: Type.String({
      description: "文件来源：http(s) URL、本群 workspace 或当前用户 tmp 内的路径",
    }),
    filename: Type.Optional(Type.String({ description: "文件名（可选，默认从 source 推断）" })),
  });

  const sendImageTool: ToolDefinition<typeof imageParams> = {
    name: "send_image",
    label: "发送图片",
    description:
      "向当前群聊发送一张图片。source 为 http(s) URL、本群 workspace 或当前调用用户 tmp 内的路径。",
    promptSnippet: "向群聊发送图片",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: imageParams,
    async execute(_toolCallId, params, signal) {
      if (
        (params.width !== undefined && (!Number.isInteger(params.width) || params.width <= 0)) ||
        (params.height !== undefined && (!Number.isInteger(params.height) || params.height <= 0))
      ) {
        throw new Error("图片 width/height 必须是正整数");
      }
      // 图片不走外链：群聊里图片的价值在于内联显示，换成一条链接就没有意义了，
      // 而且超过 25MB 的图基本都是本该当文件发的东西。
      const resolved = await resolveSource(params.source, workspaceDir, tempDir, signal);
      const data = await readBytes(resolved, signal);
      const callbackUrl = getCallbackUrl();
      const fileId = await uploadAttachment(
        callbackUrl,
        data,
        filenameFromSource(params.source),
        "image",
        signal
      );
      if (!fileId) throw new Error(`图片上传失败: ${params.source}`);
      const ok = await sendImage(
        fileId,
        groupId,
        callbackUrl,
        undefined,
        params.width,
        params.height,
        signal
      );
      if (!ok) throw new Error(`图片发送失败: ${params.source}`);
      return {
        content: [
          { type: "text", text: `已发送图片 (${params.width ?? "?"}×${params.height ?? "?"})` },
        ],
        details: { fileId, source: params.source },
      };
    },
  };

  const relayNote = relay
    ? ` 超过 ${formatSize(MAX_ATTACHMENT_BYTES)} 的本地文件会自动改为上传外部存储、在群里发送下载链接，你不需要为此做任何额外处理，照常调用即可。`
    : "";

  const sendFileTool: ToolDefinition<typeof fileParams> = {
    name: "send_file",
    label: "发送文件",
    description:
      "向当前群聊发送一个文件。source 为 http(s) URL、本群 workspace 或当前调用用户 tmp 内的路径。" +
      relayNote,
    promptSnippet: "向群聊发送文件",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    parameters: fileParams,
    async execute(_toolCallId, params, signal) {
      const resolved = await resolveSource(params.source, workspaceDir, tempDir, signal);
      const name = sanitizeFilename(params.filename ?? filenameFromSource(params.source));

      if (relay && resolved.kind === "local" && resolved.size > MAX_ATTACHMENT_BYTES) {
        const url = await relayFile({
          config: relay,
          localPath: resolved.path,
          size: resolved.size,
          filename: name,
          signal,
          index: relayIndex,
        });
        // 有效期必须写进群消息本身：群成员只有提前知道期限才会及时下载。措辞随后端机制
        // 变化（删文件 / 只失效签名），交给 relay 层拼，见 describeRelayExpiry。
        const expiry = describeRelayExpiry(relay);
        // 交给运行时并入本轮回复，而不是在这里单独发一条：URL 必须逐字正确，所以不能让
        // 模型复述；但也不值得为它多花一条出站配额。
        notes.add(
          `📎 ${name}（${formatSize(resolved.size)}）超过群聊 ${formatSize(MAX_ATTACHMENT_BYTES)} 附件上限，已改为链接分发：\n${url}${expiry}`
        );
        return {
          content: [
            {
              type: "text",
              // 明确告诉模型别再贴一遍：链接会由代码原样附在回复末尾，模型复述一遍只会
              // 让同一条消息里出现两个 URL。
              text:
                `文件超过 ${formatSize(MAX_ATTACHMENT_BYTES)}，已改为链接分发，下载链接会由系统自动附在你本轮回复的末尾。` +
                `请正常回复用户（说明文件已通过链接发送即可），不要重复粘贴链接地址。`,
            },
          ],
          details: { name, url, size: resolved.size, mode: "relay" },
        };
      }

      const data = await readBytes(resolved, signal);
      const callbackUrl = getCallbackUrl();
      const fileId = await uploadAttachment(callbackUrl, data, name, "file", signal);
      if (!fileId) throw new Error(`文件上传失败: ${params.source}`);
      const ok = await sendFile(fileId, groupId, callbackUrl, undefined, signal);
      if (!ok) throw new Error(`文件发送失败: ${params.source}`);
      return { content: [{ type: "text", text: `已发送文件: ${name}` }], details: { fileId, name } };
    },
  };

  return [sendImageTool, sendFileTool];
}
