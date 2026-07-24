// 发送工具定义：send_image / send_file（ToolDefinition，Pi agent 经 customTools 调用）。
// 从 im 层封装：agent 给 source（URL 或 ./data 路径），工具负责下载/读取 + 上传 + 发送。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_CWD } from "../lib/config.ts";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { sendFile, sendImage, uploadAttachment } from "../im/im.ts";

/** 加载图片/文件字节：http(s) URL 走 fetch，否则视为 ./data 下的路径读取。 */
async function loadBytes(source: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(source)) {
    const r = await fetch(source);
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${source}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  // 本地路径按 agent 工作目录（AGENT_CWD）解析；默认 data 时行为同前。
  const cwd = AGENT_CWD.replace(/[\\/]+$/, "");
  const path = source.startsWith(`./${cwd}/`) || source.startsWith(`${cwd}/`) ? source : join(cwd, source);
  return new Uint8Array(await readFile(path));
}

function filenameFromSource(source: string): string {
  const clean = source.split("?")[0];
  if (/^https?:\/\//i.test(clean)) return clean.split("/").pop() || "download";
  return clean.split(/[\\/]/).pop() || "file";
}

/** 构造发送工具（ToolDefinition，闭包捕获 callbackUrl）。 */
export function buildSendTools(callbackUrl: string): ToolDefinition[] {
  const imageParams = Type.Object({
    source: Type.String({ description: "图片来源：http(s) URL 或 ./data 下相对路径" }),
    width: Type.Optional(Type.Number({ description: "宽度（像素，可选）" })),
    height: Type.Optional(Type.Number({ description: "高度（像素，可选）" })),
  });
  const fileParams = Type.Object({
    source: Type.String({ description: "文件来源：http(s) URL 或 ./data 下相对路径" }),
    filename: Type.Optional(Type.String({ description: "文件名（可选，默认从 source 推断）" })),
  });

  const sendImageTool: ToolDefinition<typeof imageParams> = {
    name: "send_image",
    label: "发送图片",
    description: "向当前群聊发送一张图片。source 为图片的 http(s) URL 或 ./data 目录下的本地路径。",
    promptSnippet: "向群聊发送图片",
    parameters: imageParams,
    async execute(_toolCallId, params) {
      const data = await loadBytes(params.source);
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
    description: "向当前群聊发送一个文件。source 为文件的 http(s) URL 或 ./data 目录下的本地路径。",
    promptSnippet: "向群聊发送文件",
    parameters: fileParams,
    async execute(_toolCallId, params) {
      const data = await loadBytes(params.source);
      const name = params.filename ?? filenameFromSource(params.source);
      const fileId = await uploadAttachment(callbackUrl, data, name, "file");
      if (!fileId) throw new Error(`文件上传失败: ${params.source}`);
      const ok = await sendFile(fileId, callbackUrl);
      if (!ok) throw new Error(`文件发送失败: ${params.source}`);
      return { content: [{ type: "text", text: `已发送文件: ${name}` }], details: { fileId, name } };
    },
  };

  return [sendImageTool, sendFileTool];
}
