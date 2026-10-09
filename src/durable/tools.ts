// The four official tools (read, bash, edit, write) for the Durable engine (D2-2; contract 2.4). Ported from the D0
// adapter (tmp/pi100-d0/probes-102/lib/adapt.ts, Pi 1.0.2).
//
// One registry serves a group and its tools serve every member. Each call reads the calling conversation's identity
// (`mixin.identity`, src/durable/identity.ts), computes the member's places on the server, and runs the AgentSession
// engine's tools built for that member (src/agent/local-tools.ts: the official factories behind the workspace/tmp path
// guard, the caller environment for bash, full output moved into the member's tmp). Model arguments never choose the
// member, the group or a root, and one member's call never sees another member's tmp as writable.
//
// Adapter rules (checked against pi-coding-agent 1.0.2; the tool files are the same in 1.0.3, where bash's output
// accumulator creates the full-output file private, 0600, which the move into the member's tmp keeps; in 1.0.4 read also
// declares an output schema and gives scripts its text, or an image block for an image file):
// - The tools get only `{ cwd, model }`: the four official tools read nothing else once bash's session environment is
//   off (it reads an AgentSession `sessionManager`). Pi's session variables (PI_SESSION_ID, PI_MODEL, ...) are therefore
//   not exported to bash; nothing in the project reads them.
// - Bash's raw output is also appended to `api.output`, keeping its tail, so an aborted or interrupted result carries
//   the output committed so far (gap G5).
// - A throw other than an abort becomes an error result and the tool task completes, as in coding-agent. An abort is
//   rethrown: Durable writes the aborted result from what was committed before the abort mark, after which the call
//   can commit nothing. The full-output file still moves into the member's tmp, but that result does not name it.
// - Running updates are not forwarded as `api.details`: they would carry the full-output path before it is moved into
//   the member's tmp, and Durable would keep the last of them as the details of a result without its own.
// - `structuredContent` (bash's exit code and full output for scripts) is dropped: Durable results have no such field.
//   Codemode scripts get it through the same entry (`MemberTool.run`, src/durable/codemode/index.ts).
// - Replay: read is safe (read-only), the rest unsafe. Output limits 64 KB / 2200 lines lie above the official
//   truncation (50 KB / 2000 lines plus its notice), so the Harness does not truncate again (gap G6).
// - Registrations carry the pi-ai Tool fields (name, description, parameters, constrainedSampling) plus executionMode
//   and prepareArguments. The definitions' prompt snippets and guidelines stay out of the system prompt, as in the
//   AgentSession engine, whose own prompt replaces the part coding-agent would put them in (src/durable/prompt.ts);
//   codemode shows a script-only tool's guidelines in its description.
//
// A model's call and a codemode script's sub-call run the same `MemberTool.run`: identity check, the member's places
// and the official tool. Only the Harness validates a model's arguments; codemode validates a sub-call's itself.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import {
  type AgentToolResult, createBashToolDefinition, createEditToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, type Extension, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { buildDocumentEnvironmentTool, buildDocumentTool } from "../agent/document-extract.ts";
import { BASH_TOOL_NOTE, buildLocalTools } from "../agent/local-tools.ts";
import { groupIndexDir, groupVenvDir, groupWorkspaceDir, materialsIndexPath, userTempDir } from "../agent/paths.ts";
import { IdentityDoc } from "./identity.ts";

export interface BaseToolsOptions {
  /** Group data root (`GROUP_DATA_ROOT`). */
  root: string;
  /** The group this Harness serves; a conversation whose identity names another group is refused. */
  groupId: string;
  /** Document environment (`BOT_DOCUMENT_ENV`); default the group's venv. */
  venvDir?: string;
  /** Read-only resource directories of the enabled modules (D2-4). */
  resourceReadDirs?: readonly string[];
}

/** Where a member's tools work. */
export interface MemberPlaces { workspaceDir: string; tempDir: string; indexPath: string; venvDir: string }

export function memberPlaces(options: Pick<BaseToolsOptions, "root" | "venvDir">, groupId: string, phone: string): MemberPlaces {
  return {
    workspaceDir: resolve(groupWorkspaceDir(options.root, groupId)),
    tempDir: resolve(userTempDir(options.root, groupId, phone)),
    indexPath: resolve(materialsIndexPath(options.root, groupId)),
    venvDir: resolve(options.venvDir ?? groupVenvDir(options.root, groupId)),
  };
}

const LIMITS = { maxBytes: 64 * 1024, maxLines: 2200 };
type Policy = { replay: "safe" | "unsafe"; outputLimits: NonNullable<ToolRegistration["outputLimits"]> };
const POLICY: Record<string, Policy> = {
  read: { replay: "safe", outputLimits: LIMITS },
  bash: { replay: "unsafe", outputLimits: { ...LIMITS, retain: "tail" } },
  edit: { replay: "unsafe", outputLimits: LIMITS },
  write: { replay: "unsafe", outputLimits: LIMITS },
};
/**
 * Every other tool (document_extract, document_environment, the modules' and the send tools): unsafe, as contract 2.4
 * says until a tool is shown idempotent. document_extract writes a content-addressed cache and document_environment may
 * download; the module tools write new files; a send cannot be taken back.
 */
const OTHER_POLICY: Policy = { replay: "unsafe", outputLimits: LIMITS };

/** What running a tool for the calling member needs. */
export interface MemberCall {
  /** The Durable invocation: a model's call, or the codemode call a script's sub-call belongs to. */
  readonly api: Pick<ToolExecutionApi, "conversationId" | "taskId" | "snapshot" | "agent" | "models" | "commit">;
  readonly context: Context;
  /** The call ID the official tool gets: the model's, or `<codemode call ID>/<n>` for a sub-call. */
  readonly callId: string;
  readonly signal: AbortSignal | undefined;
  /** Raw bash output as it arrives. Must not throw. */
  readonly onBashOutput?: (data: Buffer) => void;
}

/** A tool as the catalogue shows it (official definition fields), runnable for the calling member. */
export interface MemberTool extends Policy {
  readonly definition: ToolDefinition;
  /**
   * Check the caller's identity and run the official tool for that member, returning its whole result (including
   * `structuredContent`). Throws for refusals and failures; arguments are expected validated.
   */
  run(args: unknown, call: MemberCall): Promise<AgentToolResult<unknown>>;
}

/**
 * What the catalogue shows, from the official factories: names, descriptions and schemas depend on neither the member
 * nor the cwd. The member's tools are built per call; tests check that they show the same.
 */
export function catalogueDefinitions(cwd: string): ToolDefinition[] {
  const bash = createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
  return [createReadToolDefinition(cwd), { ...bash, description: bash.description + BASH_TOOL_NOTE },
    createEditToolDefinition(cwd), createWriteToolDefinition(cwd)] as ToolDefinition[];
}

function json(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : copyJson(value as JsonValue, { omitUndefinedProperties: true }) as JsonValue;
}

/**
 * The calling conversation's member and places, from its identity document; refuses a conversation without a member or
 * of another group. Creates the member's directories.
 */
export async function resolveMember(options: Pick<BaseToolsOptions, "root" | "groupId" | "venvDir">, call: Pick<MemberCall, "api" | "context">) {
  const identity = await call.api.snapshot(IdentityDoc, call.api.conversationId, call.context);
  if (!identity?.phone) throw new Error("会话没有成员身份，工具未执行");
  if (identity.groupId !== options.groupId) throw new Error("会话的成员身份不属于本群，工具未执行");
  const places = memberPlaces(options, options.groupId, identity.phone);
  for (const dir of [places.workspaceDir, places.tempDir, groupIndexDir(options.root, options.groupId)]) await mkdir(dir, { recursive: true });
  return { phone: identity.phone, places };
}

/** The calling member, resolved from the conversation's identity. */
export interface Member { phone: string; places: MemberPlaces; conversationId: MemberCall["api"]["conversationId"] }

/** Builds the calling member's tools for one call; the one with the definition's name runs. */
export type MemberToolBuilder = (member: Member, call: MemberCall) => ToolDefinition[] | Promise<ToolDefinition[]>;

/**
 * A tool the catalogue shows as `definition`, run for the calling member: identity check, the member's places, then the
 * tool `build` makes for that member. Definitions must not depend on the member (tests check the catalogue against a
 * member's tools).
 */
export function memberTool(definition: ToolDefinition, options: Pick<BaseToolsOptions, "root" | "groupId" | "venvDir">,
  build: MemberToolBuilder): MemberTool {
  const policy = POLICY[definition.name] ?? OTHER_POLICY;
  return {
    definition,
    ...policy,
    async run(args, call) {
      const { phone, places } = await resolveMember(options, call);
      const tools = await build({ phone, places, conversationId: call.api.conversationId }, call);
      const tool = tools.find((candidate) => candidate.name === definition.name);
      if (tool === undefined) throw new Error(`tool ${definition.name} missing for the member`);
      const agent = await call.api.agent(call.context);
      const model = agent.model === undefined ? undefined : call.api.models.getModel(agent.model.provider, agent.model.modelId);
      const ctx = { cwd: places.workspaceDir, model } as unknown as ExtensionToolContext;
      return tool.execute(call.callId, args as never, call.signal, undefined, ctx);
    },
  };
}

function localTool(definition: ToolDefinition, options: BaseToolsOptions): MemberTool {
  if (POLICY[definition.name] === undefined) throw new Error(`no policy for tool ${definition.name}`);
  return memberTool(definition, options, ({ phone, places }, call) => buildLocalTools({
    workspaceDir: places.workspaceDir, tempDir: places.tempDir, phone, groupId: options.groupId,
    venvDir: places.venvDir, materialsIndexPath: places.indexPath, resourceReadDirs: [...options.resourceReadDirs ?? []],
    sessionEnvironment: false, ...(call.onBashOutput === undefined ? {} : { onBashOutput: call.onBashOutput }),
  }));
}

/** Places that only fill a definition's builder; nothing runs there. */
const CATALOGUE_PLACES: MemberPlaces = { workspaceDir: "catalogue", tempDir: "catalogue", indexPath: "catalogue", venvDir: "catalogue" };

/** document_environment and document_extract (contract 2.4 `mixin.base`), built per call for the member's places. */
export function documentMemberTools(options: BaseToolsOptions): MemberTool[] {
  const build = ({ places }: Member) => [buildDocumentEnvironmentTool(places.venvDir), buildDocumentTool(places)];
  return build({ phone: "", places: CATALOGUE_PLACES, conversationId: 0 as Member["conversationId"] })
    .map((definition) => memberTool(definition, options, build));
}

/** The Durable registration of a member tool: what the model calls. */
export function memberRegistration(tool: MemberTool): ToolRegistration {
  const { definition } = tool;
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    // A pi-ai Tool field: it enters the transcript declaration and the request, as the AgentSession wrapper passes it.
    ...(definition.constrainedSampling === undefined ? {} : { constrainedSampling: definition.constrainedSampling }),
    replay: tool.replay,
    outputLimits: tool.outputLimits,
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    ...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
    async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
      const signal = context.abortSignal;
      // Output arriving after the call settled is dropped (`api.output` rejects then); a throw here would stop the command.
      const output = (data: string | Uint8Array) => { try { api.output(data); } catch {} };
      try {
        const result = await tool.run(args, { api, context, callId: api.callId, signal, onBashOutput: output });
        const details = json(result.details);
        return {
          content: result.content,
          ...(details === undefined ? {} : { details }),
          ...(result.isError ? { isError: true } : {}),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.terminate ? { control: { terminate: true } } : {}),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  } as ToolRegistration;
}

/** The four tools for the group's members, in the catalogue order the AgentSession engine shows. */
export function baseMemberTools(options: BaseToolsOptions): MemberTool[] {
  return catalogueDefinitions(resolve(groupWorkspaceDir(options.root, options.groupId))).map((definition) => localTool(definition, options));
}

/** The registrations, in the catalogue order the AgentSession engine shows. */
export function baseTools(options: BaseToolsOptions): ToolRegistration[] {
  return baseMemberTools(options).map(memberRegistration);
}

/**
 * `mixin.base`: the four official tools, then `extra` (the group registry adds document_environment and
 * document_extract, src/durable/registry.ts).
 */
export function baseExtension(options: BaseToolsOptions, extra: readonly MemberTool[] = []): Extension {
  return defineExtension({ name: "mixin.base", tools: [...baseTools(options), ...extra.map(memberRegistration)] });
}
