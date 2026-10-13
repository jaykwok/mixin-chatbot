import type { loadSkills, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DocumentOptions } from "./document-extract.ts";

/**
 * An enabled module before it is bound to a member: the Durable engine builds its tools for the calling member on every
 * call; skills, read-only directories and the prompt are the same for everyone.
 */
export interface AgentModuleDefinition {
  /** Short name; the Durable extension is `mixin.<name>`. */
  name: string;
  tools(options: DocumentOptions): ToolDefinition[];
  skills: ReturnType<typeof loadSkills>;
  readOnlyDirs: string[];
  prompt: string;
}

/** Default templates for document_build when a call names none (runtime settings BOT_DOCUMENT_PPTX/DOCX_TEMPLATE). */
export interface DocumentTemplates { pptx?: string; docx?: string }

/** The enabled modules, in registration order. Disabled modules are not imported or read from disk. */
export async function loadModuleDefinitions(options: { documentWorkEnabled: boolean; documentTemplates?: DocumentTemplates }): Promise<AgentModuleDefinition[]> {
  // Single registration point.
  if (!options.documentWorkEnabled) return [];
  const { documentWorkModule } = await import("./modules/document-work/index.ts");
  return [documentWorkModule(options.documentTemplates)];
}

