// `mixin.prompt`: the system prompt for the Durable engine (D2-4). It renders the same sections the AgentSession engine
// sent (src/agent/session-factory.ts, removed at data version 3), so a group's model saw the same prompt text after the switch:
//
// - coding-agent 1.0.4 `buildSystemPromptSections` with the project's own prompt (`systemPromptOverride`) keeps only
//   `preamble` (untagged: the project prompt with the enabled module's text), `skills` (the module's skills, as
//   `formatSkillsForPrompt` lists them for the read tool) and `cwd` (the group workspace, forward slashes). It leaves
//   out the tool snippets and guidelines, the rules and the Pi documentation that its default prompt would carry, and
//   adds nothing else here (no appended prompt, context files or extension sections).
// - Durable renders sections in this order and tags all but `preamble` as `<key>\n...\n</key>`, the shape
//   coding-agent stores; pi-ai joins them the same way for both engines.
//
// The sections follow what the conversation selects: a module's text and skills appear only while its extension
// (`mixin.<name>`) is selected. Nothing depends on the member: the member's tmp is named through $PI_USER_TMP.
import { resolve } from "node:path";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { defineExtension, type Extension, type PromptInput, section } from "@earendil-works/pi-durable";
import type { AgentModuleDefinition } from "../agent/modules.ts";
import { groupWorkspaceDir } from "../agent/paths.ts";
import { buildChatContext } from "../agent/prompt.ts";

export interface PromptOptions {
  root: string;
  groupId: string;
  /** The enabled modules; a module counts while the conversation selects `mixin.<name>`. */
  modules: readonly AgentModuleDefinition[];
  /** Whether a large-file relay is configured (the delivery paragraph differs). */
  relayEnabled: boolean;
}

export const moduleExtensionName = (module: Pick<AgentModuleDefinition, "name">) => `mixin.${module.name}`;

function selectedModules(options: PromptOptions, input: PromptInput) {
  return options.modules.filter((module) => input.agent.extensions.some((extension) => extension.name === moduleExtensionName(module)));
}

/** `mixin.prompt`: sections only; install it before the tool extensions so its sections come first. */
export function promptExtension(options: PromptOptions): Extension {
  const cwd = resolve(groupWorkspaceDir(options.root, options.groupId)).replace(/\\/g, "/");
  return defineExtension({
    name: "mixin.prompt",
    sections: [
      section("preamble", (input) => {
        const modulePrompt = selectedModules(options, input).map((module) => module.prompt).filter(Boolean).join("\n\n");
        return buildChatContext({ relayEnabled: options.relayEnabled, ...(modulePrompt ? { modulePrompt } : {}) });
      }, { tag: false }),
      section("skills", (input) => {
        // coding-agent names the tool that reads a skill file: read when offered, else bash; without either, no list.
        const offered = new Set(input.agent.tools.map((tool) => tool.name));
        const reader = (["read", "bash"] as const).find((name) => offered.has(name));
        const skills = selectedModules(options, input).flatMap((module) => module.skills.skills);
        if (reader === undefined || skills.length === 0) return undefined;
        return formatSkillsForPrompt(skills, reader).trim() || undefined;
      }),
      section("cwd", () => cwd),
    ],
  });
}
