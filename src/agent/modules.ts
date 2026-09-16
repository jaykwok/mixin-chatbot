import type { loadSkills, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DocumentOptions } from "./document-extract.ts";

/** A module contributes its tools and model-facing resources as one unit. */
export interface AgentModule {
  tools: ToolDefinition[];
  skills: ReturnType<typeof loadSkills>;
  readOnlyDirs: string[];
  prompt: string;
}

export async function loadAgentModules(options: DocumentOptions & { documentWorkEnabled: boolean }): Promise<AgentModule> {
  // Single registration point. Disabled modules are not imported or read from disk.
  if (options.documentWorkEnabled) {
    const { loadDocumentWork } = await import("./modules/document-work/index.ts");
    return loadDocumentWork(options);
  }
  return { tools: [], skills: { skills: [], diagnostics: [] }, readOnlyDirs: [], prompt: "" };
}
