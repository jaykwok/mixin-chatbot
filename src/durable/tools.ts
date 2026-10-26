import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import {
  type AgentToolResult, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, type Extension, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { buildDocumentEnvironmentTool, buildDocumentTool } from "../agent/document-extract.ts";
import { nativeBaseTools } from "./base-tools.ts";
import { createMemberEnv } from "./member-env.ts";
import { parseScopeKey, requestTmp, scopeKey, userTmp, type Layout, type Scope } from "../core/layout.ts";
import { IdentityDoc } from "./identity.ts";
import { InboxDoc } from "./inbox.ts";
import { commandScope } from "../core/process.ts";
import { memberTaskText } from "./running-requests.ts";

export interface BaseToolsOptions {
  layout: Layout;
  /** The space this Harness serves; a conversation whose identity names another space is refused. */
  scope: Scope;
  /** Document environment (`BOT_DOCUMENT_ENV`); default the layout's shared one. */
  venvDir?: string;
  /** Read-only resource directories of the enabled modules. */
  resourceReadDirs?: readonly string[];
}

/**
 * Where a member's tools work: the application's read-only workspace and index, the member's tmp (attachments and the
 * managed task/result directories) and, inside a run, the request's own directory (`tasks/<request>`), the model's
 * working and output directory.
 */
export interface MemberPlaces { workspaceDir: string; tempDir: string; requestDir?: string; indexPath: string; venvDir: string }

export function memberPlaces(options: Pick<BaseToolsOptions, "layout" | "venvDir">, scope: Scope, phone: string, requestId?: string): MemberPlaces {
  const tempDir = resolve(userTmp(options.layout, scope, phone));
  return {
    workspaceDir: resolve(options.layout.workspace),
    tempDir,
    ...(requestId === undefined ? {} : { requestDir: requestTmp(tempDir, requestId) }),
    indexPath: resolve(options.layout.materialsIndex),
    venvDir: resolve(options.venvDir ?? options.layout.documentEnv),
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
 * Every other tool (document_extract, document_environment, the modules' and the send tools): unsafe until proven
 * idempotent. document_extract writes a content-addressed cache and document_environment may
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
export interface AdaptedMemberTool extends Policy {
  readonly definition: ToolDefinition;
  /**
   * Check the caller's identity and run the official tool for that member, returning its whole result (including
   * `structuredContent`). Throws for refusals and failures; arguments are expected validated.
   */
  run(args: unknown, call: MemberCall): Promise<AgentToolResult<unknown>>;
}

export type MemberTool = AdaptedMemberTool | {
  readonly definition: Pick<ToolDefinition, "name" | "description" | "parameters" | "namespace" | "exposure">;
  readonly native: ToolRegistration;
  readonly replay: "safe" | "unsafe";
  readonly outputLimits: NonNullable<ToolRegistration["outputLimits"]>;
};

function json(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : copyJson(value as JsonValue, { omitUndefinedProperties: true }) as JsonValue;
}

/**
 * The calling conversation's member and places, from its identity document; refuses a conversation without a member or
 * of another space. The request is the inbox head: the item the run belongs to stays there until the run settled.
 * Creates the member's and the request's directories (and the default workspace; an external one must exist).
 */
export async function resolveMember(options: Pick<BaseToolsOptions, "layout" | "scope" | "venvDir">, call: Pick<MemberCall, "api" | "context">) {
  const identity = await call.api.snapshot(IdentityDoc, call.api.conversationId, call.context);
  if (!identity?.phone) throw new Error("会话没有成员身份，工具未执行");
  if (identity.space !== scopeKey(options.scope)) throw new Error("会话的成员身份不属于本空间，工具未执行");
  const head = (await call.api.snapshot(InboxDoc, call.api.conversationId, call.context))?.items[0];
  const places = memberPlaces(options, options.scope, identity.phone, head?.requestId);
  const dirs = [places.requestDir ?? places.tempDir, resolve(options.layout.index), ...options.layout.externalWorkspace ? [] : [places.workspaceDir]];
  for (const dir of dirs) await mkdir(dir, { recursive: true });
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
export function memberTool(definition: ToolDefinition, options: Pick<BaseToolsOptions, "layout" | "scope" | "venvDir">,
  build: MemberToolBuilder): AdaptedMemberTool {
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

/** Places that only fill a definition's builder; nothing runs there. */
const CATALOGUE_PLACES: MemberPlaces = { workspaceDir: "catalogue", tempDir: "catalogue", indexPath: "catalogue", venvDir: "catalogue" };

/** document_environment and document_extract (`mixin.base`), built per call for the member's places. */
export function documentMemberTools(options: BaseToolsOptions): MemberTool[] {
  const build = ({ places }: Member) => [buildDocumentEnvironmentTool(places.venvDir), buildDocumentTool(places)];
  return build({ phone: "", places: CATALOGUE_PLACES, conversationId: 0 as Member["conversationId"] })
    .map((definition) => memberTool(definition, options, build));
}

/**
 * Who may call a tool, from its coding-agent exposure: direct tools both the model and scripts (`executeTool()`),
 * model-only tools (send_*) only the model, script-only tools only scripts. A deferred tool is script-only and left out
 * of the codemode section's declarations: scripts find it with `searchTools()`.
 */
export function callersOf(definition: Pick<ToolDefinition, "name" | "exposure">): Pick<ToolRegistration, "callers" | "deferred"> {
  switch (definition.exposure ?? "direct") {
    case "direct": return {};
    case "model-only": return { callers: ["model"] };
    case "codemode": return { callers: ["tools"] };
    case "deferred": return { callers: ["tools"], deferred: true };
    default: throw new Error(`tool ${definition.name}: exposure ${definition.exposure} has no Durable registration`);
  }
}

/** The call ID of the tool call a nested call belongs to (`<parent>/<key>`), or undefined for a model's call. */
function parentCallOf(callId: string): string | undefined {
  const slash = callId.lastIndexOf("/");
  return slash === -1 ? undefined : callId.slice(0, slash);
}

/**
 * Sequential tools within one calling tool call (a codemode script), one at a time in call order. Durable runs nested
 * calls at once whatever their `executionMode`; a call cancelled while it waits never runs.
 */
const sequentialQueues = new Map<string, Promise<void>>();
async function sequentialTurn(key: string, signal: AbortSignal | undefined): Promise<() => void> {
  const previous = sequentialQueues.get(key) ?? Promise.resolve();
  const { promise: done, resolve: release } = Promise.withResolvers<void>();
  const turn = previous.then(() => done);
  sequentialQueues.set(key, turn);
  const finish = () => { release(); if (sequentialQueues.get(key) === turn) sequentialQueues.delete(key); };
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      void previous.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
    });
  } catch (error) { finish(); throw error; }
  return finish;
}

/**
 * The Durable registration of a member tool: what the model and scripts call. A tool's `outputSchema` is its
 * `structuredOutputSchema` and its `structuredContent` the `structuredOutput` scripts get (bash's exit code and output,
 * an MCP tool's declared value); a schema-less tool's scripts get its output.
 */
export function memberRegistration(tool: MemberTool): ToolRegistration {
  if ("native" in tool) return tool.native;
  const { definition } = tool;
  const schema = definition.outputSchema;
  const sequential = definition.executionMode === "sequential";
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    // A pi-ai Tool field: it enters the transcript declaration and the request.
    ...(definition.constrainedSampling === undefined ? {} : { constrainedSampling: definition.constrainedSampling }),
    ...callersOf(definition),
    replay: tool.replay,
    outputLimits: tool.outputLimits,
    ...(schema === undefined ? {} : { structuredOutputSchema: schema }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    ...(definition.prepareArguments === undefined ? {} : { prepareArguments: definition.prepareArguments }),
    async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
      const signal = context.abortSignal;
      const parent = sequential ? parentCallOf(api.callId) : undefined;
      const release = parent === undefined ? undefined : await sequentialTurn(`${api.conversationId}:${parent}`, signal);
      // Output arriving after the call settled is dropped (`api.output` rejects then); a throw here would stop the command.
      const output = (data: string | Uint8Array) => { try { api.output(data); } catch {} };
      try {
        signal?.throwIfAborted();
        let label = "成员未知";
        try {
          const identity = await api.snapshot(IdentityDoc, api.conversationId, context);
          const space = identity?.phone ? parseScopeKey(identity.space) : undefined;
          if (space) label = memberTaskText(space, identity!.phone);
        } catch { /* Diagnostic identity must not change tool failure semantics. */ }
        const scope = { tool: definition.name, toolTask: api.taskId as number, describe: async () => label };
        const result = await commandScope.run(scope, () => tool.run(args, { api, context, callId: api.callId, signal, onBashOutput: output }));
        const details = json(result.details);
        const structured = schema === undefined ? undefined : json(result.structuredContent);
        return {
          output: result.content,
          ...(structured === undefined ? {} : { structuredOutput: structured }),
          ...(details === undefined ? {} : { details }),
          ...(result.isError ? { isError: true } : {}),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.terminate ? { control: { terminate: true } } : {}),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      } finally { release?.(); }
    },
  } as ToolRegistration;
}

/** The four tools for the space's members, in catalogue order. */
export function baseMemberTools(options: BaseToolsOptions): MemberTool[] {
  return nativeBaseTools().map(official => {
    const policy = POLICY[official.name]!;
    const native: ToolRegistration = { ...official, ...policy, async execute(args, api, context) {
      const { phone, places } = await resolveMember(options, { api, context });
      const env = await createMemberEnv({ ...places, materialsIndexPath: places.indexPath, phone, scope: options.scope,
        resourceReadDirs: options.resourceReadDirs, inputPaths: (args as { input_paths?: string[] }).input_paths });
      const label = memberTaskText(options.scope, phone);
      const scope = { tool: official.name, toolTask: api.taskId as number, describe: async () => label };
      return commandScope.run(scope, () => official.execute(args, { ...api, env }, context));
    } };
    return { definition: official, native, ...policy };
  });
}

/** The registrations, in catalogue order. */
export function baseTools(options: BaseToolsOptions): ToolRegistration[] {
  return baseMemberTools(options).map(memberRegistration);
}

/**
 * `mixin.base`: the four official tools, then `extra` (the space registry adds document_environment and
 * document_extract, src/durable/registry.ts).
 */
export function baseExtension(options: BaseToolsOptions, extra: readonly MemberTool[] = []): Extension {
  return defineExtension({ name: "mixin.base", tools: [...baseTools(options), ...extra.map(memberRegistration)] });
}
