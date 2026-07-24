// 发送工具定义：send_image / send_file（ToolDefinition，Pi agent 经 customTools 调用）。
// 从 im 层封装：agent 给 source（URL 或当前用户 tmp 内路径），工具负责下载/读取 + 上传 + 发送。
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ATTACHMENT_HTTP_TIMEOUT,
  MAX_ATTACHMENT_BYTES,
} from "../lib/config.ts";
import { sendFile, sendImage, uploadAttachment } from "../im/im.ts";

/** 加载图片/文件字节：http(s) URL 走 fetch，本地文件必须位于当前用户的 tmp 工作目录。 */
async function loadBytes(source: string, workspaceDir: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(source)) {
    const r = await fetch(source, {
      signal: AbortSignal.timeout(ATTACHMENT_HTTP_TIMEOUT),
    });
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${source}`);
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      throw new Error(`远程文件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`);
    }
    if (!r.body) throw new Error(`下载响应没有内容: ${source}`);

    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new Error(`远程文件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`);
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

  const root = await realpath(resolve(workspaceDir));
  const requestedPath = isAbsolute(source) ? resolve(source) : resolve(root, source);
  const path = await realpath(requestedPath);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..\\`) || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new Error("只能发送当前用户 tmp 工作目录内的文件");
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`不是普通文件: ${source}`);
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`本地文件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`);
  }
  return new Uint8Array(await readFile(path));
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

/** 构造发送工具；callback URL 用 getter 读取，以支持平台轮换机器人 key。 */
export function buildSendTools(
  getCallbackUrl: () => string,
  workspaceDir: string
): ToolDefinition[] {
  const imageParams = Type.Object({
    source: Type.String({ description: "图片来源：http(s) URL 或当前 tmp 工作目录内的路径" }),
    width: Type.Optional(Type.Number({ description: "宽度（像素，可选）" })),
    height: Type.Optional(Type.Number({ description: "高度（像素，可选）" })),
  });
  const fileParams = Type.Object({
    source: Type.String({ description: "文件来源：http(s) URL 或当前 tmp 工作目录内的路径" }),
    filename: Type.Optional(Type.String({ description: "文件名（可选，默认从 source 推断）" })),
  });

  const sendImageTool: ToolDefinition<typeof imageParams> = {
    name: "send_image",
    label: "发送图片",
    description: "向当前群聊发送一张图片。source 为图片的 http(s) URL 或当前用户 tmp 工作目录内的本地路径。",
    promptSnippet: "向群聊发送图片",
    parameters: imageParams,
    async execute(_toolCallId, params) {
      if (
        (params.width !== undefined && (!Number.isInteger(params.width) || params.width <= 0)) ||
        (params.height !== undefined && (!Number.isInteger(params.height) || params.height <= 0))
      ) {
        throw new Error("图片 width/height 必须是正整数");
      }
      const data = await loadBytes(params.source, workspaceDir);
      const callbackUrl = getCallbackUrl();
      const fileId = await uploadAttachment(
        callbackUrl,
        data,
        filenameFromSource(params.source),
        "image"
      );
      if (!fileId) throw new Error(`图片上传失败: ${params.source}`);
      const ok = await sendImage(fileId, callbackUrl, undefined, params.width, params.height);
      if (!ok) throw new Error(`图片发送失败: ${params.source}`);
      return {
        content: [
          { type: "text", text: `已发送图片 (${params.width ?? "?"}×${params.height ?? "?"})` },
        ],
        details: { fileId, source: params.source },
      };
    },
  };

  const sendFileTool: ToolDefinition<typeof fileParams> = {
    name: "send_file",
    label: "发送文件",
    description: "向当前群聊发送一个文件。source 为文件的 http(s) URL 或当前用户 tmp 工作目录内的本地路径。",
    promptSnippet: "向群聊发送文件",
    parameters: fileParams,
    async execute(_toolCallId, params) {
      const data = await loadBytes(params.source, workspaceDir);
      const name = sanitizeFilename(params.filename ?? filenameFromSource(params.source));
      const callbackUrl = getCallbackUrl();
      const fileId = await uploadAttachment(callbackUrl, data, name, "file");
      if (!fileId) throw new Error(`文件上传失败: ${params.source}`);
      const ok = await sendFile(fileId, callbackUrl);
      if (!ok) throw new Error(`文件发送失败: ${params.source}`);
      return { content: [{ type: "text", text: `已发送文件: ${name}` }], details: { fileId, name } };
    },
  };

  return [sendImageTool, sendFileTool];
}
