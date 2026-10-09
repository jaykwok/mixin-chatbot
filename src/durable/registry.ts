// The extensions of a group's registry (D2-4), in install order after the request door's (src/durable/models.ts):
//
// - `mixin.prompt`: the system prompt sections (./prompt.ts);
// - `mixin.base`: read, bash, edit, write, document_environment, document_extract (./tools.ts);
// - `mixin.send`: send_image, send_file, model-only (./send.ts);
// - `mixin.<module>` for each enabled module: no Durable tools of its own (its tools are script-only, reached through
//   codemode), but selecting it turns the module on for the conversation: its tools become callable from scripts and its
//   prompt text and skills appear;
// - `mixin.codemode`: the codemode tool over all of the above (./codemode/index.ts).
//
// The model sees the tools in that order. Every tool runs through `memberTool`: the conversation's identity decides the
// member and the member's places. The relay setting is fixed per registry (it shapes send_file's description and the
// prompt); the relay configuration is read once at service start (src/integrations/relay.ts), so a change needs a
// restart anyway.
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { AgentModuleDefinition } from "../agent/modules.ts";
import type { AuxiliaryConfig } from "../core/auxiliary-config.ts";
import { auxiliaryMemberTools, type AuxiliaryBudget } from "./auxiliary.ts";
import type { RequestDoor } from "./door.ts";
import type { McpTools } from "../integrations/mcp.ts";
import { mcpMemberTools } from "./mcp.ts";
import type { RelayConfig } from "../integrations/relay.ts";
import { type CallableTool, codemodeExtension } from "./codemode/index.ts";
import { moduleExtensionName, promptExtension } from "./prompt.ts";
import { type SendDelivery, sendMemberTools } from "./send.ts";
import { baseExtension, baseMemberTools, documentMemberTools, memberRegistration, memberTool, type MemberTool } from "./tools.ts";

export interface GroupRegistryOptions {
  /** Group data root (`GROUP_DATA_ROOT`). */
  root: string;
  groupId: string;
  /** Document environment (`BOT_DOCUMENT_ENV`); default the group's venv. */
  venvDir?: string;
  /** The enabled modules (src/agent/modules.ts `loadModuleDefinitions`). */
  modules: readonly AgentModuleDefinition[];
  relay: RelayConfig | null;
  delivery: SendDelivery;
  auxiliary?: { config: AuxiliaryConfig; budget: AuxiliaryBudget; door: RequestDoor };
  mcp?: { manager: McpTools; door: RequestDoor };
}

/**
 * The registry's extensions for one group, in install order (after the door's).
 */
export function groupExtensions(options: GroupRegistryOptions): Extension[] {
  const members = {
    root: options.root, groupId: options.groupId,
    ...(options.venvDir === undefined ? {} : { venvDir: options.venvDir }),
    resourceReadDirs: options.modules.flatMap((module) => module.readOnlyDirs),
  };
  const base = baseMemberTools(members);
  const documents = documentMemberTools(members);
  const send = sendMemberTools({ ...members, relay: options.relay, delivery: options.delivery });
  const auxiliary = options.auxiliary ? auxiliaryMemberTools(members, options.auxiliary.door, options.auxiliary.config, options.auxiliary.budget) : [];
  const mcp = options.mcp ? mcpMemberTools(members, options.mcp.manager, options.mcp.door) : [];
  const modules = options.modules.map((module) => ({
    module,
    tools: module.tools({ workspaceDir: "catalogue", tempDir: "catalogue", indexPath: "catalogue", venvDir: "catalogue" })
      .map((definition): MemberTool => memberTool(definition, members, ({ places }) => module.tools(places))),
  }));
  const callable: CallableTool[] = [
    ...[...base, ...documents].map((tool) => ({ extension: "mixin.base", tool })),
    ...send.map((tool) => ({ extension: "mixin.send", tool })),
    ...auxiliary.map(tool => ({ extension: "mixin.auxiliary", tool })),
    ...mcp.map(tool => ({ extension: "mixin.mcp", tool })),
    ...modules.flatMap(({ module, tools }) => tools.map((tool) => ({ extension: moduleExtensionName(module), tool }))),
  ];
  return [
    promptExtension({ root: options.root, groupId: options.groupId, modules: options.modules, relayEnabled: options.relay !== null }),
    baseExtension(members, documents),
    defineExtension({ name: "mixin.send", tools: send.map(memberRegistration) }),
    ...(auxiliary.length ? [defineExtension({ name: "mixin.auxiliary", tools: auxiliary.map(memberRegistration) })] : []),
    ...(mcp.length ? [defineExtension({ name: "mixin.mcp" })] : []),
    // A module's tools that the model may call directly would be registered here; the current module has none.
    ...modules.map(({ module, tools }) => defineExtension({
      name: moduleExtensionName(module),
      tools: tools.filter((tool) => (tool.definition.exposure ?? "direct") === "direct").map(memberRegistration),
    })),
    codemodeExtension({ members, tools: callable }),
  ];
}
