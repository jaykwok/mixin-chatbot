import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { Static } from "@earendil-works/pi-schema";
import { documentTools } from "../agent/document-extract.ts";
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
  /** The tool call's ID: the model's, or `<codemode call ID>/<n>` for a sub-call. */
  readonly callId: string;
  readonly signal: AbortSignal | undefined;
}

/** The calling member, resolved from the conversation's identity. */
export interface Member { phone: string; places: MemberPlaces; conversationId: MemberCall["api"]["conversationId"] }

/** Groups tools in the `codemode` section and for `searchTools()` (./codemode/index.ts); the tool's name is the prefix. */
export type ToolNamespace = Omit<CodemodeNamespace, "prefix">;

/**
 * What a member tool returns: Durable's result, with `structuredOutput` and `details` any JSON data (copied, undefined
 * properties dropped). `structuredOutput` is kept only for a tool that declares `structuredOutputSchema`.
 */
export type MemberToolResult = Omit<ToolExecutionResult, "structuredOutput" | "details"> & {
  readonly structuredOutput?: unknown;
  readonly details?: unknown;
};

/**
 * A tool of the space's members: its Durable registration fields (`callers` and `deferred` say who may call it) and how
 * it runs for the calling member. `args` are validated against `parameters` and typed by them; `run` throws for refusals
 * and failures, which become an error result.
 */
export type MemberToolSpec<P extends object = object> = Omit<ToolRegistration<P>, "execute" | "replay" | "outputLimits"> & {
  readonly namespace?: ToolNamespace;
  run(args: Static<P>, member: Member, call: MemberCall): Promise<MemberToolResult>;
};

/** A tool as the registry installs it, with the namespace the `codemode` section groups it by. */
export interface MemberTool {
  readonly registration: ToolRegistration;
  readonly namespace?: ToolNamespace;
}

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
 * The Durable registration of a member tool: what the model and scripts call. Each call checks the caller's identity,
 * resolves the member's places, then runs the tool for that member under the command log's label. `structuredOutput`
 * is what scripts get from a tool with `structuredOutputSchema` (a schema-less tool's scripts get its output).
 */
export function memberTool<P extends object>(spec: MemberToolSpec<P>, options: Pick<BaseToolsOptions, "layout" | "scope" | "venvDir">): MemberTool {
  const { namespace, run, ...fields } = spec;
  const schema = spec.structuredOutputSchema;
  const sequential = spec.executionMode === "sequential";
  const registration: ToolRegistration = {
    ...fields as Omit<ToolRegistration, "execute">,
    ...POLICY[spec.name] ?? OTHER_POLICY,
    async execute(args, api, context) {
      const signal = context.abortSignal;
      const parent = sequential ? parentCallOf(api.callId) : undefined;
      const release = parent === undefined ? undefined : await sequentialTurn(`${api.conversationId}:${parent}`, signal);
      try {
        signal?.throwIfAborted();
        let label = "成员未知";
        try {
          const identity = await api.snapshot(IdentityDoc, api.conversationId, context);
          const space = identity?.phone ? parseScopeKey(identity.space) : undefined;
          if (space) label = memberTaskText(space, identity!.phone);
        } catch { /* Diagnostic identity must not change tool failure semantics. */ }
        const scope = { tool: spec.name, toolTask: api.taskId as number, describe: async () => label };
        const { structuredOutput, details, ...result } = await commandScope.run(scope, async () => {
          const { phone, places } = await resolveMember(options, { api, context });
          return run(args as Static<P>, { phone, places, conversationId: api.conversationId }, { api, context, callId: api.callId, signal });
        });
        const copied = json(details);
        const structured = schema === undefined ? undefined : json(structuredOutput);
        return {
          ...result,
          ...(structured === undefined ? {} : { structuredOutput: structured }),
          ...(copied === undefined ? {} : { details: copied }),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      } finally { release?.(); }
    },
  };
  return { registration, ...(namespace === undefined ? {} : { namespace }) };
}

/** document_environment and document_extract (`mixin.base`). */
export function documentMemberTools(options: BaseToolsOptions): MemberTool[] {
  return documentTools().map((spec) => memberTool(spec, options));
}

/** The four tools for the space's members, in catalogue order. */
export function baseMemberTools(options: BaseToolsOptions): MemberTool[] {
  return nativeBaseTools().map(official => {
    const registration: ToolRegistration = { ...official, ...POLICY[official.name]!, async execute(args, api, context) {
      const { phone, places } = await resolveMember(options, { api, context });
      const env = await createMemberEnv({ ...places, materialsIndexPath: places.indexPath, phone, scope: options.scope,
        resourceReadDirs: options.resourceReadDirs, inputPaths: (args as { input_paths?: string[] }).input_paths });
      const label = memberTaskText(options.scope, phone);
      const scope = { tool: official.name, toolTask: api.taskId as number, describe: async () => label };
      return commandScope.run(scope, () => official.execute(args, { ...api, env }, context));
    } };
    return { registration };
  });
}

/**
 * `mixin.base`: the four official tools, then `extra` (the space registry adds document_environment and
 * document_extract, src/durable/registry.ts).
 */
export function baseExtension(options: BaseToolsOptions, extra: readonly MemberTool[] = []): Extension {
  return defineExtension({ name: "mixin.base", tools: [...baseMemberTools(options), ...extra].map((tool) => tool.registration) });
}
