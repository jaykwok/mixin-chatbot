import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { copyJson } from "@earendil-works/chord";
import { toLlmContent } from "@earendil-works/pi-mcp";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpTools } from "../integrations/mcp.ts";
import type { RequestDoor } from "./door.ts";
import { resolveMember, type BaseToolsOptions, type MemberTool } from "./tools.ts";
import { SubCallFiles, resultsDirName } from "./codemode/results.ts";
import { ResultsDoc } from "./result-lifecycle.ts";

export function mcpMemberTools(options: BaseToolsOptions, manager: McpTools, door: RequestDoor): MemberTool[] {
  return manager.catalogue.map(entry => {
    const suffix = createHash("sha256").update(JSON.stringify([entry.server.name, entry.tool.name])).digest("hex").slice(0, 8);
    const serverName = entry.server.name.replaceAll("-", "_");
    const name = `mcp_${serverName}_${entry.tool.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48)}_${suffix}`;
    return {
      definition: { name, label: entry.tool.title ?? entry.tool.name,
        description: entry.tool.description ?? `Call ${entry.tool.name} on ${entry.server.name}.`,
        parameters: entry.tool.inputSchema as ToolDefinition["parameters"],
        ...(entry.tool.outputSchema ? { outputSchema: entry.tool.outputSchema as ToolDefinition["outputSchema"] } : {}),
        namespace: { name: `mcp.${entry.server.name}`, description: "管理员批准的外部工具" }, exposure: "deferred",
        execute: async () => { throw new Error("Member invocation required"); },
      }, replay: "unsafe", outputLimits: { maxBytes: 65536, maxLines: 2200 },
      async run(args, call) {
        const { phone, places } = await resolveMember(options, call);
        if (!call.signal) throw new Error("MCP 工具需要可取消的任务");
        await mkdir(places.tempDir, { recursive: true });
        const result = await manager.call(entry, { groupId: options.groupId, phone, workspaceDir: places.workspaceDir, tempDir: places.tempDir },
          args as Record<string, unknown>, call.signal, (dispatch, signal) => door.external(call.api, call.context, dispatch, signal));
        call.signal.throwIfAborted();
        const content = toLlmContent(result);
        const directoryName = resultsDirName(call.api.taskId as number, `mcp-${call.callId}`);
        const files = new SubCallFiles(places.tempDir, directoryName, () => call.api.commit(async tx => {
          const doc = await tx.doc(ResultsDoc);
          if (!doc.calls[directoryName]) {
            if (Object.keys(doc.calls).length >= 4096) throw new Error("结果归属记录已达上限，请先清理");
            doc.calls[directoryName] = { phone, createdAt: Date.now() };
          }
        }, call.context));
        try {
          let image = 0;
          const imagePaths: string[] = [];
          for (const item of [...content]) if (item.type === "image") {
            if (++image > 4) throw new Error("MCP 返回图片超限");
            const path = await files.saveOutputImage(image, Buffer.from(item.data, "base64"), item.mimeType);
            imagePaths.push(path);
            content.push({ type: "text", text: `Image saved to ${path}` });
          }
          const text = content.filter(item => item.type === "text").map(item => item.text).join("\n");
          if (Buffer.byteLength(text) > 24000) {
            const path = await files.saveOutputText(JSON.stringify(result));
            const pictures = content.filter(item => item.type === "image");
            content.splice(0, content.length, { type: "text", text: `${text.slice(0, 8000)}\n[Full MCP result saved to ${path}]\n${imagePaths.map(path => `Image saved to ${path}`).join("\n")}` }, ...pictures);
          }
          if ((await files.recheck()).size) throw new Error("MCP 结果目录变化，结果路径已撤回");
          return { content, details: { server: entry.server.name, tool: entry.tool.name },
            ...(result.structuredContent ? { structuredContent: copyJson(result.structuredContent) } : {}), ...(result.isError ? { isError: true } : {}) };
        } finally { await files.release(); }
      },
    } satisfies MemberTool;
  });
}
