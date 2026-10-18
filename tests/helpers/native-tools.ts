// Test invocation adapter only. Production registers Durable tools directly.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nativeBaseTools } from "../../src/durable/base-tools.ts";
import { createMemberEnv, type MemberEnvOptions } from "../../src/durable/member-env.ts";

export async function buildLocalTools(options: MemberEnvOptions): Promise<ToolDefinition[]> {
  return nativeBaseTools().map(tool => ({ ...tool, async execute(_id, args, signal, _update, ctx) {
    let text = "";
    const diagnostics: { message: string }[] = [];
    const env = await createMemberEnv({ ...options, inputPaths: (args as { input_paths?: string[] }).input_paths });
    const api = { env, output: (value: string | Uint8Array) => { text = (text + (typeof value === "string" ? value : new TextDecoder().decode(value))).slice(-50 * 1024); },
      retainedOutput: () => ({ text, truncated: false }), diagnostic: (value: { message: string }) => diagnostics.push(value),
      agent: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
      models: { getModel: () => ctx.model ?? { input: ["text", "image"] } } } as unknown as ToolExecutionApi;
    const result = await tool.execute(args, api, { ...BACKGROUND_CONTEXT, ...(signal ? { abortSignal: signal } : {}) });
    const content = [...result.output ?? (text ? [{ type: "text" as const, text }] : []),
      ...[...diagnostics, ...result.diagnostics ?? []].map(item => ({ type: "text" as const, text: item.message }))];
    return { content, isError: result.isError, details: result.details, structuredContent: result.structuredOutput };
  } })) as ToolDefinition[];
}
