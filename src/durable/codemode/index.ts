// `mixin.codemode`: Durable's official code mode tool (`@earendil-works/pi-durable/codemode`), adapted to the members of
// a group. The official tool runs the script in a pi-codemode sandbox, journals what it delivers and resumes a script
// after a restart by replaying the journal (replay-safe); nested calls go through `api.executeTool()`, so they are
// resolved among the conversation's callable tools (src/durable/tools.ts `callersOf`), validated, wrapped by the request
// door and run as their own tool tasks with their own replay policy. Scripts call the direct tools the conversation is
// offered and the script-only tools of the extensions it selects; never model-only tools (send_*) or codemode itself.
// `models.*` stays off. The `codemode` prompt section lists the callable tools (deferred ones, MCP, are found with
// `searchTools()`); namespaces come from the tool definitions.
//
// What this adapter adds around each call:
// - Identity: the calling member is resolved first; a conversation without a member of this group runs nothing.
// - Result files: the official tool writes its full output and images through `api.env` (a temp directory, then files
//   in it). Here the environment of the call offers exactly that and nothing else: the "temp directory" is the call's
//   results directory in the member's tmp (../results/files.ts), and only plain names directly in it can be written,
//   each saved through the held directory. After the last file every path is checked once more; the result names only
//   those still in place (a withdrawn path is replaced by why, worded like a failed save). A rerun after a restart writes
//   to this attempt's directory: under rootless isolation each attempt has its own, which the run document then records,
//   and the result ownership moves to its task in the commit registering its first file (../results/ownership.ts).
// - Store limits: scripts that run at the same time each checked their `store()` writes only against their own view.
//   The commit that stores a script's outcome and writes is checked against the merged store: over the sandbox's limits
//   the writes are undone in that transaction and the script fails, with why.
// - Usage: a nested call's usage is counted by Durable under its tool (`pi.usage.tools`), not on the codemode result.
//   Independent receipts (./usage.ts) share each nested result's terminal transaction. The stats ledger consumes them
//   by a durable sequence, independently of cancellation, VM replay, or the parent's outcome. `details.usage` is only
//   a display snapshot; while the script runs the details are `{ calls, usage, partial: true }`. The sum is taken from what
//   Durable kept, not from what this attempt's VM went through: every nested call of the call has its slot in
//   `pi.live.nestedTools` while the call runs, and its result, with the usage Durable recorded, in the call's
//   `NestedCallDoc`, once per key. A rerun that decides without running the script (deadline passed, another code mode
//   version or sandbox, a divergence) or is cancelled before its replay reaches a finished call still charges it, and
//   only once. The outcome's display snapshot can lag a later child; its independent receipt still charges it.
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import { CodemodeSandbox, type CodemodeResult, type CodemodeRun, type CodemodeRunOptions, type CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import {
  defineExtension, type Extension, hook, type JsonObject, LiveDoc, type LiveState, NestedCallDoc, type NestedCallState, type NestedToolExecutionResult, ToolTask,
  type TaskDocToken, type TaskId, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration, type Tx,
} from "@earendil-works/pi-durable";
import {
  type CodemodeNamespace, type CodemodeNestedCall, CodemodeStoreDoc, type CodemodeToolDetails,
  createCodemodeExtension, createCodemodeTool,
} from "@earendil-works/pi-durable/codemode";
import { err, type ExecutionEnv, FileError, ok } from "@earendil-works/pi-durable/env";
import { resultRegistration } from "../results/ownership.ts";
import { ResultFiles, resultsDirName } from "../results/files.ts";
import { type BaseToolsOptions, type MemberTool, resolveMember } from "../tools.ts";
import { recordNestedUsage } from "./usage.ts";
import { isScriptResult, RUN_DOC_KIND, type RunState, type ScriptResult } from "./protocol.ts";
import { codemodeWorkers } from "./workers.ts";

import { checkStoreLimits } from "./store.ts";
export { CodemodeStoreDoc };

/** Memory a script's VM may allocate (coding-agent's limit). */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/**
 * Estimated tokens of the tool declarations in the `codemode` section. The official default (3000) counts the direct
 * tools too and left document_build out (2026-10-13: the full listing of the base and document tools is about 3100);
 * the registry's own tools stay listed in full, and MCP tools are deferred (`searchTools()`) either way.
 */
export const CODEMODE_INLINE_BUDGET = 6000;

/** The codemode result's details: the official ones, with the nested calls' usage; `partial` while the script runs. */
export type CodemodeDetails = Omit<CodemodeToolDetails, "calls"> & {
  calls: Pick<CodemodeNestedCall, "id" | "name" | "status">[];
  usage?: Usage;
  partial?: true;
};

export interface CodemodeOptions {
  /** Identity and places, as for the base tools. */
  readonly members: Pick<BaseToolsOptions, "root" | "groupId" | "venvDir">;
  /** The registry's tools: their namespaces group them in the `codemode` section and for `searchTools()`. */
  readonly tools: readonly MemberTool[];
  /** Estimated tokens of the tool declarations in the `codemode` section; default CODEMODE_INLINE_BUDGET. */
  readonly inlineBudget?: number;
  /** Runs the scripts; default a `CodemodeSandbox` (a worker and VM per run) with CODEMODE_MEMORY_LIMIT_BYTES. */
  readonly sandbox?: CodemodeSandboxBase;
}

/** One namespace per namespaced tool, by its exact name: the definitions say which tools belong together. */
function namespacesOf(tools: readonly MemberTool[]): CodemodeNamespace[] {
  return tools.flatMap(({ definition }) => definition.namespace === undefined ? [] : [{
    name: definition.namespace.name,
    ...(definition.namespace.description === undefined ? {} : { description: definition.namespace.description }),
    ...(definition.namespace.instructions === undefined ? {} : { instructions: definition.namespace.instructions }),
    prefix: definition.name,
  }]);
}

/** `mixin.codemode`: the official codemode tool, run for the calling member, and the `codemode` prompt section. */
export function codemodeExtension(options: CodemodeOptions): Extension {
  const sandbox = options.sandbox ?? new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
    acquireWorker: codemodeWorkers.acquireWorker, onWorkerStarted: codemodeWorkers.onWorkerStarted });
  const official = {
    namespaces: namespacesOf(options.tools),
    inlineBudget: options.inlineBudget ?? CODEMODE_INLINE_BUDGET,
    models: false,
  };
  const extension = createCodemodeExtension({ ...official, sandbox });
  const declared = createCodemodeTool({ ...official, sandbox });
  const tool: ToolRegistration = {
    ...declared,
    execute: (args, api, context) => runCodemode(options, (attempt) => createCodemodeTool({ ...official, sandbox: attempt }),
      sandbox, args as { code: string }, api, context),
  };
  return defineExtension({ name: "mixin.codemode", tools: [tool],
    hooks: [hook(ToolTask, { settleNestedTool: (call, key, result, tx) => recordNestedUsage(call, key, result, tx) })],
    ...(extension.sections ? { sections: extension.sections } : {}) });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCodemode(options: CodemodeOptions, build: (sandbox: CodemodeSandboxBase) => ToolRegistration,
  sandbox: CodemodeSandboxBase, args: { code: string }, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
  let member;
  try {
    member = await resolveMember(options.members, { api, context });
  } catch (error) {
    // An abort goes back to Durable, which writes the result from what was committed (as for the base tools).
    if (context.abortSignal?.aborted) throw error;
    return { output: [{ type: "text", text: message(error) }], isError: true };
  }
  const name = resultsDirName(api.taskId as number, api.callId);
  const files = new ResultFiles(member.places.tempDir, name, resultRegistration(api, context, member.phone, name));
  const attempt = new Attempt(api, context, files);
  // Released whatever happens: on Windows a held directory cannot be renamed or removed.
  try {
    const result = await build(attempt.sandbox(sandbox)).execute(args, attempt.api, context);
    return attempt.finish(result);
  } finally {
    attempt.end();
    await files.release();
  }
}

export function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) } : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) } : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

function totalUsage(...sources: ReadonlyMap<string, Usage>[]): Usage | undefined {
  const byKey = new Map<string, Usage>();
  for (const source of sources) for (const [key, usage] of source) if (!byKey.has(key)) byKey.set(key, usage);
  let total: Usage | undefined;
  for (const usage of byKey.values()) total = total === undefined ? usage : combineUsage(total, usage);
  return total;
}

/**
 * The usage of the nested calls of task `taskId` that Durable kept a result of, by key. Its slots in `live` name them
 * (`callId` is `<parentCallId>/<key>`; slots stay until the call settles), `call` reads one's `NestedCallDoc`; the keys
 * in `known` are not read.
 */
async function keptUsage(taskId: TaskId, live: Readonly<LiveState> | undefined,
  call: (key: string) => Promise<Readonly<NestedCallState> | undefined>, known?: ReadonlySet<string>): Promise<Map<string, Usage>> {
  const kept = new Map<string, Usage>();
  for (const slot of live?.nestedTools ?? []) {
    if (slot.parentTaskId !== taskId || !slot.callId.startsWith(`${slot.parentCallId}/`)) continue;
    const key = slot.callId.slice(slot.parentCallId.length + 1);
    if (known?.has(key)) continue;
    const usage = (await call(key))?.result?.usage;
    if (usage !== undefined) kept.set(key, copyJson(usage) as unknown as Usage);
  }
  return kept;
}

// What this adapter relies on of the official tool beyond its exported API: review these on every Pi upgrade. The tests
// named fail when a release changes the first two (checked by renaming the kind and by refusing the shape):
// - The run document `pi.codemode.run` (not exported): `{ start, result?, outputDir? }`, task-scoped. Every commit that
//   decides the outcome sets `result` in it, once; the attempt notes the document's token from the first commit that
//   opens it. Tests: codemode.test.ts "usage across a restart", "store limits hold for the merged store";
//   codemode-ownership.test.ts "stopped after …", "three attempts"; codemode-paths.test.ts "results directory changed
//   at every write".
// - The shape of what the outcome commit returns: `{ output, isError?, details: { calls } }` (isScriptResult). Tests:
//   "store limits hold for the merged store", "results directory changed at every write".
// - The output directory: created through `env.createTempDir()` and recorded as `outputDir` in the run document, which
//   a commit then returns as a string; result files are written into it with `env.writeFile()`. Tests:
//   codemode-ownership.test.ts "stopped after …", "three attempts" (reruns after a restart).
// - Timing: the sandbox run settles before the official tool's commits for the outcome (files, then the outcome), so
//   commits after it are the result's. Relied on by "store limits hold for the merged store" and "results directory
//   changed at every write"; no test changes the timing on its own.

/** One attempt of a codemode call: the member's environment, the wrapped API and the sandbox seen by the official tool. */
class Attempt {
  readonly api: ToolExecutionApi;
  /** The script's own outcome is known: commits from here on are the result's (files, outcome). */
  #finished = false;
  /** The script's `store()` writes, once its run settled. */
  #writes = false;
  #runDoc: TaskDocToken<RunState> | undefined;
  /** Nested calls of this attempt by key, for the running details; their usage once they returned. */
  readonly #rows = new Map<string, Pick<CodemodeNestedCall, "id" | "name" | "status">>();
  readonly #usage = new Map<string, Usage>();
  /** The usage of nested calls Durable kept a result of when this attempt began (earlier attempts' calls), by key. */
  #kept = new Map<string, Usage>();
  /** The details of the outcome as stored, once a commit of this attempt stored it. */
  #decided: CodemodeDetails | undefined;
  /** Result files by the path the official tool names, to the path they were saved at. */
  readonly #saved = new Map<string, string>();
  #publishing: Promise<void> | undefined;
  #dirty = false;
  #ended = false;

  constructor(private readonly base: ToolExecutionApi, private readonly context: Context, private readonly files: ResultFiles) {
    this.api = {
      ...base,
      env: this.#env(),
      commit: <T>(change: (tx: Tx) => T | Promise<T>, commitContext: Context) => this.#commit(change, commitContext),
      executeTool: (name, args, callContext, options) => this.#executeTool(name, args, callContext, options),
    };
  }

  /** The sandbox for the official tool: the shared one, noting when the script's run settles and whether it wrote. */
  sandbox(shared: CodemodeSandboxBase): CodemodeSandboxBase {
    const delegate = Object.create(shared) as CodemodeSandboxBase;
    delegate.start = (code: string, runOptions: CodemodeRunOptions): CodemodeRun => {
      const run = shared.start(code, runOptions);
      void run.result.then((result: CodemodeResult) => {
        this.#writes = result.ok && (Object.keys(result.storeWrites.set).length > 0 || result.storeWrites.delete.length > 0);
        this.#finished = true;
      }, () => { this.#finished = true; });
      return run;
    };
    return delegate;
  }

  /**
   * The result the official tool returned, with the details as stored when this attempt stored the outcome (an outcome
   * the official tool decided returns without them, or without the usage), else with this attempt's nested usage.
   */
  finish(result: ToolExecutionResult): ToolExecutionResult {
    const own = result.details as CodemodeDetails | undefined;
    const details = own ?? this.#decided;
    if (details === undefined || !Array.isArray(details.calls)) return result;
    const usage = this.#total() ?? details.usage ?? this.#decided?.usage;
    if (details === own && usage === own.usage) return result;
    return { ...result, details: { ...details, ...(usage === undefined ? {} : { usage }) } as unknown as JsonValue };
  }

  end(): void {
    this.#ended = true;
  }

  #total(): Usage | undefined {
    return totalUsage(this.#usage, this.#kept);
  }

  /**
   * The nested calls' usage: what this attempt knows, and what Durable kept in the transaction of the calls it does not
   * know of yet (an earlier attempt's call that finished on its own meanwhile).
   */
  async #keptTotal(tx: Tx): Promise<{ usage: Usage | undefined; kept: Map<string, Usage> }> {
    const live = await tx.doc(LiveDoc, this.base.conversationId);
    const known = new Set([...this.#usage.keys(), ...this.#kept.keys()]);
    const kept = new Map(this.#kept);
    for (const [key, usage] of await keptUsage(this.base.taskId, live, (key) => tx.doc(NestedCallDoc, this.base.taskId, key, null), known)) kept.set(key, usage);
    return { usage: totalUsage(kept, this.#usage), kept };
  }

  /**
   * Exactly what the official tool uses to save its result files: a temp directory, which is the call's results
   * directory, and files with plain names directly in it. Everything else is refused.
   */
  #env(): ExecutionEnv {
    const files = this.files;
    const refused = (operation: string) => async () => err(new FileError("not_supported", `${operation} is not available to code mode results`));
    const own: Partial<ExecutionEnv> = {
      id: `mixin-codemode-results:${files.name}`,
      createTempDir: async () => ok(files.dir),
      writeFile: async (path: string, content: string | Uint8Array) => {
        const name = [`${files.dir}/`, `${files.dir}\\`].flatMap((prefix) => path.startsWith(prefix) ? [path.slice(prefix.length)] : [])[0];
        if (name === undefined || name.includes("/") || name.includes("\\")) {
          return err(new FileError("permission_denied", `code mode results are only written directly in ${files.dir}`, path));
        }
        try {
          const saved = await files.saveOutput(name, typeof content === "string" ? Buffer.from(content, "utf8") : content);
          this.#saved.set(path, saved);
          return ok(undefined);
        } catch (error) {
          return err(new FileError("unknown", message(error), path));
        }
      },
      cleanup: async () => {},
    };
    return new Proxy(own, {
      // Not thenable: `then` stays undefined, so the environment is never taken for a promise.
      get: (target, property) => Reflect.get(target, property)
        ?? (typeof property === "string" && property !== "then" ? refused(property) : undefined),
    }) as ExecutionEnv;
  }

  #track(tx: Tx): Tx {
    return new Proxy(tx, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "doc") {
          return (token: { definition?: { kind?: string } }, ...rest: unknown[]) => {
            if (token.definition?.kind === RUN_DOC_KIND) this.#runDoc ??= token as TaskDocToken<RunState>;
            return (value as (...args: unknown[]) => unknown).call(target, token, ...rest);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /**
   * The official tool's commits, each in its own transaction with what this adapter adds:
   * - The first that opens the run document notes it and, unless the outcome is stored already, the usage of the nested
   *   calls Durable kept (earlier attempts'), which the running details show from then on.
   * - After the script's outcome, a recorded directory of an earlier attempt is replaced by this attempt's, in the run
   *   document too.
   * - The one that stores the outcome stores the nested usage with it. The script's own outcome gets the merged-store
   *   check and the withdrawn paths too; an outcome the official tool decided (deadline passed, another code mode
   *   version or sandbox, a divergence) only the usage.
   */
  async #commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
    const finished = this.#finished;
    const stale = finished ? await this.files.recheck() : undefined;
    let kept: Map<string, Usage> | undefined;
    let decided: CodemodeDetails | undefined;
    const value = await this.base.commit(async (tx) => {
      const opened = this.#runDoc !== undefined;
      const run = opened ? await tx.doc(this.#runDoc!, this.base.taskId) : undefined;
      const stored = run?.result !== undefined;
      const store = finished && this.#writes ? await tx.doc(CodemodeStoreDoc, this.base.conversationId) : undefined;
      const before = store === undefined ? undefined : copyJson(store.values);
      const value = await change(this.#track(tx));
      if (!opened && this.#runDoc !== undefined) {
        const found = await tx.doc(this.#runDoc, this.base.taskId);
        if (found.result === undefined) {
          const live = await tx.doc(LiveDoc, this.base.conversationId);
          kept = await keptUsage(this.base.taskId, live, (key) => tx.doc(NestedCallDoc, this.base.taskId, key, null));
        }
        return value;
      }
      if (finished && typeof value === "string" && value !== this.files.dir && run?.outputDir === value) {
        // An earlier attempt's directory: under rootless isolation each attempt has its own, so this attempt's is recorded
        // instead; the result ownership moves to its task when its first file is registered (../results/ownership.ts).
        run.outputDir = this.files.dir;
        return this.files.dir as T;
      }
      if (run === undefined || stored || run.result === undefined) return value;
      const total = await this.#keptTotal(tx);
      kept = total.kept;
      const usage = total.usage;
      if (!finished || !isScriptResult(value)) {
        const details = (run.result as { details?: JsonValue }).details;
        if (typeof details !== "object" || details === null || Array.isArray(details)) return value;
        if (usage !== undefined) details.usage = copyJson(usage as unknown as JsonObject, { omitUndefinedProperties: true });
        decided = copyJson(details) as unknown as CodemodeDetails;
        return value;
      }
      let result: ScriptResult = value;
      if (usage !== undefined) result = { ...result, details: { ...result.details, usage } };
      if (store !== undefined && before !== undefined && result.isError !== true) {
        try {
          checkStoreLimits(store.values);
        } catch (error) {
          for (const key of Object.keys(store.values)) delete store.values[key];
          Object.assign(store.values, before);
          result = failed(result, `store() writes were not saved: ${message(error)}`);
        }
      }
      result = withdraw(result, this.#staleNames(stale!));
      run.result = copyJson(result as unknown as JsonObject, { omitUndefinedProperties: true }) as JsonObject;
      decided = result.details;
      return result as T;
    }, context);
    if (decided !== undefined) this.#decided = decided;
    if (kept !== undefined) {
      this.#kept = kept;
      if (kept.size > 0) this.#publish();
    }
    return value;
  }

  /** The paths the official tool named whose files no longer name what was saved, with why. */
  #staleNames(stale: ReadonlyMap<string, string>): Map<string, string> {
    const names = new Map<string, string>();
    for (const [named, saved] of this.#saved) {
      const why = stale.get(saved);
      if (why !== undefined) names.set(named, why);
    }
    return names;
  }

  async #executeTool(name: string, args: JsonObject, context: Context, options?: { readonly key?: string; readonly progress?: boolean }): Promise<NestedToolExecutionResult> {
    const key = options?.key ?? "";
    const id = /^c\d+$/.test(key) ? Number(key.slice(1)) : this.#rows.size + 1;
    const row: Pick<CodemodeNestedCall, "id" | "name" | "status"> = { id, name, status: "running" };
    this.#rows.set(key, row);
    this.#publish();
    try {
      const result = await this.base.executeTool(name, args, context, options);
      if (result.usage !== undefined) this.#usage.set(key, result.usage);
      row.status = result.isError ? "error" : "ok";
      return result;
    } catch (error) {
      row.status = "cancelled";
      throw error;
    } finally {
      this.#publish();
    }
  }

  /** Commit the running details; one commit in flight, what changes meanwhile goes into the next. */
  #publish(): void {
    if (this.#ended) return;
    this.#dirty = true;
    this.#publishing ??= (async () => {
      while (this.#dirty && !this.#ended) {
        this.#dirty = false;
        const usage = this.#total();
        const details: CodemodeDetails = {
          calls: [...this.#rows.values()].sort((a, b) => a.id - b.id).map((row) => ({ ...row })),
          ...(usage === undefined ? {} : { usage }),
          partial: true,
        };
        await this.base.details(details as unknown as JsonValue, this.context).catch(() => {});
      }
      this.#publishing = undefined;
    })();
  }
}

/** The result as a failed script's, with `why` as its script error. */
function failed(result: ScriptResult, why: string): ScriptResult {
  const [header, ...rest] = result.output;
  const output = header?.type === "text" && header.text.startsWith("Script completed\n")
    ? [{ ...header, text: `Script failed\n${header.text.slice("Script completed\n".length)}` }, ...rest]
    : result.output;
  return { ...result, isError: true, output: [...output, { type: "text", text: `Script error:\n${why}` }] };
}

/**
 * Replace the references the official output formatting wrote to files that no longer name what was saved (`stale`:
 * path to why) with why, worded like a failed save; the details no longer name the full output then.
 */
function withdraw(result: ScriptResult, stale: ReadonlyMap<string, string>): ScriptResult {
  if (stale.size === 0) return result;
  const output = result.output.map((item) => {
    if (item.type !== "text") return item;
    let text = item.text;
    for (const [path, why] of stale) {
      text = text.split(`[Full output: ${path} (read with offset/limit)]`).join(`[Could not save the full output: ${why}]`);
      const label = `[Image saved to ${path} (`;
      for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
        const end = text.indexOf(")]", at + label.length);
        if (end === -1) break;
        const kind = text.slice(at + label.length, end);
        text = `${text.slice(0, at)}[Image (${kind}) could not be saved: ${why}]${text.slice(end + 2)}`;
      }
    }
    return { ...item, text };
  });
  const { fullOutputPath, ...details } = result.details;
  return { ...result, output, details: fullOutputPath === undefined || !stale.has(fullOutputPath) ? result.details : details };
}
