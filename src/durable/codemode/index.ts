// The codemode tool for the Durable engine (D2-3; D0 contract 2.4 and 2.8). Layers: Durable tool task -> this
// registration -> the official sandbox (pi-codemode `CodemodeSandbox`) -> one controlled entry for every sub-call.
// The pure catalogue, search and output logic is ported from coding-agent (./upstream.ts); this file replaces
// coding-agent's executor, which needs an AgentSession.
//
// Scope, as coding-agent's mode `on` with `models` off: a script calls the registry's direct tools the conversation is
// offered (the model sees their descriptions with one "Codemode: ..." line, added by this extension's wraps) and the
// script-only tools (`exposure: "codemode"`) of the extensions the conversation selects; never model-only tools
// (send_*), codemode itself, or tools of extensions it does not select. That set is computed when the call runs, from
// the agent Durable resolved for this phase (the one that resolved the codemode call; Durable fixes it per phase), so a
// configuration change applies from the next codemode call, as for the model's own calls. Every sub-call goes through
// `invoke`: it repairs and validates the arguments like the Harness does for a model's call, makes the start durable,
// runs the tool through the same `MemberTool.run` as a model's call (identity check, member places), and makes the
// value durable before the script gets it. A value that cannot be recorded fails the sub-call instead.
//
// Durability (contract 2.8, adjusted): each sub-call event is one line in the call's running output and in the index
// file, and its compact record goes in the details; `api.details` commits output and details together, so a start is
// committed before the tool runs and a result before the script sees it. An interrupted or aborted codemode result is
// built from that output (Durable `fromSlot`): the model sees which sub-calls started and what the finished ones
// returned, and opens long results with read. The whole script is `replay: "unsafe"`: recovery never reruns it.
//
// Output, as coding-agent 1.1.0: console is grouped and adjacent text joined. Text over `max_output_tokens` is cut to its
// start and end and saved whole as `output.txt`; then each distinct image the script showed is saved as `output-<k>.<ext>` and named in a text item
// just before it, so the cut never removes a path. Both files go to the call's results directory (./results.ts). A
// file that cannot be saved is reported in the output instead of its path; the script's result stands. After the last
// file every path the result would give is checked once more: one no longer naming its file is replaced by why, and
// the details name neither it nor, when the directory was found moved, the index.
//
// Store: `load()` reads the conversation document `mixin.codemode-store` as the script starts. A successful script's
// `store()` writes are committed in one transaction before its result, after checking the merged store against the
// sandbox's limits (scripts that ran at the same time each checked only their own view); over the limits nothing is
// written and the script fails. A script that fails, or is aborted before that commit, writes nothing. The store commit
// and the tool result are separate commits: a script aborted, or a process stopped, after the store commit keeps its
// writes although its result is aborted or interrupted.
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { type ImageContent, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
  CODEMODE_SOURCE_GRAMMAR, CodemodeSandbox, type CodemodeTool, MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS, parseCodemodeSource,
  renderToolSample,
} from "@earendil-works/pi-codemode";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  type Agent, defineDoc, defineExtension, type Extension, type JsonObject, type ToolExecutionApi, type ToolExecutionResult,
  type ToolRegistration, type Wrap,
} from "@earendil-works/pi-durable";
import { type BaseToolsOptions, type MemberTool, resolveMember } from "../tools.ts";
import { describeResult, resultsDirName, SubCallFiles } from "./results.ts";
import { ResultsDoc } from "../result-lifecycle.ts";
import {
  CODEMODE_MEMORY_LIMIT_BYTES, CODEMODE_TOOL_NAME, combineUsage, createCodemodeDescription, createDiscoveryGlobals,
  DEFAULT_CODEMODE_INLINE_BUDGET, DEFAULT_MAX_OUTPUT_TOKENS, describeScriptCall, ERROR_PREVIEW_CHARS, formatError, formatOutput,
  joinAdjacentText, normalizeGuidelines, type OutputItem, previewArgs, saveImages, textOf, toCodemodeDeclaration, toScriptValue, truncateOutput,
  truncateText, valueText,
} from "./upstream.ts";

/** Values of `load()`, by key. */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "mixin.codemode-store",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ values: {} }),
});

/** A tool scripts may call, with the extension that provides it. */
export interface CallableTool {
  readonly extension: string;
  readonly tool: MemberTool;
}

export interface CodemodeOptions {
  /** Identity and places, as for the base tools. */
  readonly members: Pick<BaseToolsOptions, "root" | "groupId" | "venvDir">;
  /**
   * The registry's tools by their exposure (`ToolDefinition.exposure`, default `direct`): direct ones are registered
   * elsewhere and declared to the model; `codemode` and `deferred` ones are reached only from scripts; others never.
   */
  readonly tools: readonly CallableTool[];
  /** Estimated tokens of tool sections in the description; default 3000 (coding-agent's default). */
  readonly inlineBudget?: number;
}

type SubCallStatus = "running" | "ok" | "error" | "cancelled";
/** Compact record of a sub-call in the details: what the projection and the UI need; results are in the lines. */
export type SubCallRecord = { id: string; name: string; status: SubCallStatus; durationMs?: number; error?: string };
export type CodemodeDetails = { calls: SubCallRecord[]; complete: boolean; index?: string; fullOutputPath?: string };

/** Sub-calls recorded in the details (coding-agent `NESTED_CALL_LIMITS.maxCalls`); later ones only in the lines. */
const MAX_RECORDED_CALLS = 256;
/**
 * How long a finished script waits for the sub-calls it left running to stop (the sandbox cancelled them), so their
 * last lines are committed before the result. A tool that ignores the cancel stays `running` in the details.
 */
const DRAIN_LIMIT_MS = 5000;
/** Above the default script budget (10000 tokens, 40000 characters, any UTF-8 width), so only explicit budgets reach it. */
const OUTPUT_LIMITS = { maxBytes: 256 * 1024, maxLines: 50_000, retain: "head" as const };

const codemodeSchema = Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) });

function exposureOf(tool: MemberTool) {
  return tool.definition.exposure ?? "direct";
}

/**
 * The sandbox's store limits (pi-codemode `store()`) on the whole store: each value at most MAX_STORE_VALUE_CHARS
 * characters of JSON, keys and JSON together at most MAX_STORE_TOTAL_CHARS.
 */
function checkStoreLimits(values: Record<string, JsonValue>): void {
  let total = 0;
  for (const [key, value] of Object.entries(values)) {
    const json = JSON.stringify(value);
    if (json.length > MAX_STORE_VALUE_CHARS) {
      throw new RangeError(`store(${JSON.stringify(key)}) value has ${json.length} characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}`);
    }
    total += key.length + json.length;
  }
  if (total > MAX_STORE_TOTAL_CHARS) {
    throw new RangeError(`store is full: with the writes of other scripts, stored values would have ${total} characters of JSON, more than the limit of ${MAX_STORE_TOTAL_CHARS}. Delete keys with store(key, undefined).`);
  }
}

/** Whether a script may call `entry` for a conversation with this agent. */
function isCallable(entry: CallableTool, agent: Pick<Agent, "tools" | "extensions">): boolean {
  const { definition } = entry.tool;
  if (definition.name === CODEMODE_TOOL_NAME) return false;
  switch (exposureOf(entry.tool)) {
    case "direct":
      // Offered to the model, and the same tool (a registration passes the schema through by reference).
      return agent.tools.some((tool) => tool.name === definition.name && tool.parameters === definition.parameters);
    case "codemode":
    case "deferred":
      return agent.extensions.some((extension) => extension.name === entry.extension);
    default:
      return false;
  }
}

/**
 * `mixin.codemode`: the codemode tool, and the "Codemode: ..." line on the direct tools' descriptions where it is
 * selected. The description lists the script-only tools (coding-agent mode `on`).
 */
export function codemodeExtension(options: CodemodeOptions): Extension {
  const listed = options.tools.filter((entry) => ["codemode", "deferred"].includes(exposureOf(entry.tool)));
  const description = createCodemodeDescription(listed.map((entry) => entry.tool.definition), {
    namespaces: new Map(listed.flatMap((entry) => entry.tool.definition.namespace ? [[entry.tool.definition.name, entry.tool.definition.namespace]] : [])),
    deferred: new Set(listed.filter((entry) => exposureOf(entry.tool) === "deferred").map((entry) => entry.tool.definition.name)),
    guidelines: new Map(listed.map((entry) => [entry.tool.definition.name, normalizeGuidelines(entry.tool.definition.promptGuidelines)])),
    inlineBudget: options.inlineBudget ?? DEFAULT_CODEMODE_INLINE_BUDGET,
  });
  const tool = {
    name: CODEMODE_TOOL_NAME,
    description,
    parameters: codemodeSchema,
    // Capable models write the script as raw text instead of a JSON-escaped string.
    constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
    replay: "unsafe",
    outputLimits: OUTPUT_LIMITS,
    execute: (args: { code: string }, api: ToolExecutionApi, context: Context) => runCodemode(options, args.code, api, context),
  } as ToolRegistration;
  // Only the tool scripts would call (see isCallable) says how scripts call it.
  const wraps: Wrap[] = options.tools.filter((entry) => exposureOf(entry.tool) === "direct").map((entry) => ({
    tool: entry.tool.definition.name,
    wrap: (declared: ToolRegistration) => declared.parameters !== entry.tool.definition.parameters ? declared
      : { ...declared, description: describeScriptCall(declared.name, declared.description, entry.tool.definition.outputSchema) },
  }));
  return defineExtension({ name: "mixin.codemode", tools: [tool], wraps });
}

async function runCodemode(options: CodemodeOptions, input: string, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
  const signal = context.abortSignal;
  try {
    return await runScript(options, input, api, context);
  } catch (error) {
    // An abort goes back to Durable, which writes the result from what was committed (as for the base tools).
    if (signal?.aborted) throw error;
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

async function runScript(options: CodemodeOptions, input: string, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
  const startedAt = performance.now();
  const signal = context.abortSignal;
  const { code, options: sourceOptions } = parseCodemodeSource(input);
  const { phone, places } = await resolveMember(options.members, { api, context });
  const agent = await api.agent(context);
  const callable = options.tools.filter((entry) => isCallable(entry, agent));
  // What a script sees of a tool (ALL_TOOLS, describeTool): its original description with its prompt guidelines, and its
  // declaration.
  const samples = new Map(callable.map(({ tool: { definition } }) =>
    [definition.name, renderToolSample(toCodemodeDeclaration(definition, definition.promptGuidelines))]));
  const directoryName = resultsDirName(api.taskId as number, api.callId);
  const files = new SubCallFiles(places.tempDir, directoryName, (isolatedTask) => api.commit(async tx => {
    const doc = await tx.doc(ResultsDoc);
    if (!doc.calls[directoryName]) {
      if (Object.keys(doc.calls).length >= 4096) throw new Error("结果归属记录已达上限，请先清理不再引用的结果");
      doc.calls[directoryName] = { phone, createdAt: Date.now(), ...(isolatedTask ? { isolatedTask } : {}) };
    }
  }, context));
  // Released whatever happens: on Windows a held directory cannot be renamed or removed.
  try {
    const run = new ScriptRun(api, context, files);
    const sandbox = new CodemodeSandbox({
      tools: callable.map((entry): CodemodeTool => ({
        name: entry.tool.definition.name,
        description: samples.get(entry.tool.definition.name),
        execute: (args, { signal: callSignal }) => run.call(entry, args, callSignal),
      })),
      globals: createDiscoveryGlobals(callable.map((entry) => entry.tool.definition), samples),
      timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
      memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
    });
    let result;
    try {
      const store = (await api.snapshot(CodemodeStoreDoc, api.conversationId, context))?.values ?? {};
      result = await sandbox.execute(code, { signal, store });
    } finally {
      await sandbox.close();
      // Calls the script left running were cancelled when it ended; their last lines are committed before the result.
      // A call still running after that records nothing more.
      await run.drain(DRAIN_LIMIT_MS);
      await files.closeIndex();
    }
    signal?.throwIfAborted();

    const items: OutputItem[] = result.output.map(item => ({ ...item }));
    const errors: OutputItem[] = [];
    let failed = !result.ok;
    if (result.ok) {
      const { set, delete: deleted } = result.storeWrites;
      if (Object.keys(set).length > 0 || deleted.length > 0) {
        try {
          await api.commit(async (tx) => {
            const values = (await tx.doc(CodemodeStoreDoc, api.conversationId)).values;
            for (const key of deleted) delete values[key];
            for (const [key, value] of Object.entries(set)) values[key] = copyJson(value as JsonValue);
            // Thrown inside the transaction: nothing of this script's writes is committed.
            checkStoreLimits(values);
          }, context);
          // From here the writes stay, whatever happens to this call's result.
        } catch (error) {
          if (signal?.aborted) throw error;
          failed = true;
          errors.push({ type: "text", text: `Script error:\nstore() writes were not saved: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      // pi extension: a returned value is appended like text().
      if (!failed && result.value !== undefined) items.push({ type: "text", text: valueText(result.value) });
    } else {
      errors.push({ type: "text", text: `Script error:\n${formatError(result, run.summary())}` });
    }
    const truncated = await truncateOutput([...formatOutput(items), ...errors], sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, async (text) => {
      try {
        return { path: await files.saveOutputText(text) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    let images = 0;
    const saved = await saveImages(truncated.items, async (bytes, mimeType) => files.saveOutputImage(++images, bytes, mimeType));
    // A later save may have found the directory moved: the result names only what is still in place (./results.ts).
    const stale = await files.recheck();
    const output = joinAdjacentText(withdraw(saved, stale));
    const fullOutputPath = truncated.fullOutputPath !== undefined && !stale.has(truncated.fullOutputPath) ? truncated.fullOutputPath : undefined;
    const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
    const header = `${failed ? "Script failed" : "Script completed"}\nWall time ${wallTime} seconds\nOutput:\n`;
    const details: CodemodeDetails = { ...run.details(), ...(fullOutputPath === undefined ? {} : { fullOutputPath }) };
    return {
      content: [{ type: "text", text: header }, ...output],
      details: details as unknown as JsonValue,
      ...(run.usage === undefined ? {} : { usage: run.usage }),
      ...(failed ? { isError: true } : {}),
    };
  } finally {
    await files.release();
  }
}

/**
 * Replace the references `truncateOutput` and `saveImages` wrote (./upstream.ts) to output files that no longer name
 * what was saved (`stale`: path to why) with why, worded like a failed save.
 */
function withdraw(items: OutputItem[], stale: ReadonlyMap<string, string>): OutputItem[] {
  if (stale.size === 0) return items;
  return items.map((item) => {
    if (item.type !== "text") return item;
    let text = item.text;
    for (const [path, why] of stale) {
      text = text.replace(`[Full output: ${path} (read with offset/limit)]`, () => `[Could not save the full output: ${why}]`);
      const label = `[Image saved to ${path} (`;
      if (text.startsWith(label) && text.endsWith(")]")) text = `[Image (${text.slice(label.length, -2)}) could not be saved: ${why}]`;
    }
    return { ...item, text };
  });
}

type Recorded = { text: string; structured: boolean; images: readonly ImageContent[] };

/**
 * What a sub-call's files and line record of the value the script gets (the script gets the value itself either way).
 * A structured value is recorded as its JSON, except two shapes read returns (coding-agent 1.0.4): a string (a text
 * file) is recorded as that text, and an image block (an image file) as its note with the image saved once as an image
 * file, not as base64 inside JSON.
 */
function recordOf(value: unknown, structured: boolean, images: readonly ImageContent[]): Recorded {
  if (!structured) return { text: String(value), structured: false, images };
  if (typeof value === "string") return { text: value, structured: false, images };
  if (isImageBlock(value)) {
    const image: ImageContent = { type: "image", data: value.data, mimeType: value.mimeType };
    return { text: value.note, structured: false, images: images.some((each) => each.data === image.data) ? images : [...images, image] };
  }
  return { text: JSON.stringify(value), structured: true, images };
}

/** Exactly read's value for an image file (coding-agent 1.0.4 `readOutputSchema`): these four strings, nothing else. */
function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType: string; note: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  return Object.keys(block).sort().join() === "data,mimeType,note,type" && block.type === "image"
    && typeof block.data === "string" && typeof block.mimeType === "string" && typeof block.note === "string";
}

/** The sub-calls of one script: numbering, records, durable lines and the controlled entry. */
class ScriptRun {
  /** Every sub-call, in call order; the details carry the first MAX_RECORDED_CALLS. */
  readonly #records: SubCallRecord[] = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  #opened: Promise<void> | undefined;
  /** The index was created: the details name it. */
  #indexed = false;
  #exclusive: Promise<void> = Promise.resolve();
  usage: AgentToolResult<unknown>["usage"];

  constructor(private readonly api: ToolExecutionApi, private readonly context: Context, private readonly files: SubCallFiles) {}

  details(): CodemodeDetails {
    const calls = this.#records.slice(0, MAX_RECORDED_CALLS).map((record) => ({ ...record }));
    return {
      calls,
      complete: this.#records.length <= MAX_RECORDED_CALLS && calls.every((call) => call.status !== "running"),
      // Named only while its path names it (./results.ts): not after the member moved, removed or replaced it or the
      // call's directory.
      ...(this.#indexed && !this.files.indexLost ? { index: this.files.index } : {}),
    };
  }

  /** Every sub-call's name and status for a failed script's summary; one still running was cut off (upstream). */
  summary(): { name: string; status: string }[] {
    return this.#records.map((record) => ({ name: record.name, status: record.status === "running" ? "cancelled" : record.status }));
  }

  /** Wait for every sub-call handler, including the ones the sandbox cancelled, at most `limitMs`. */
  async drain(limitMs: number): Promise<void> {
    const deadline = performance.now() + limitMs;
    while (this.#inFlight.size > 0) {
      const left = deadline - performance.now();
      if (left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.#inFlight]), new Promise((resolve) => { timer = setTimeout(resolve, left); })]);
      clearTimeout(timer);
    }
  }

  call(entry: CallableTool, args: unknown, signal: AbortSignal): Promise<unknown> {
    // The number is fixed now: parallel sub-calls finish in any order.
    const n = this.#records.length + 1;
    const record: SubCallRecord = { id: `${this.api.callId}/${n}`, name: entry.tool.definition.name, status: "running" };
    this.#records.push(record);
    const work = this.#invoke(entry, n, record, args, signal);
    this.#inFlight.add(work);
    void work.then(() => this.#inFlight.delete(work), () => this.#inFlight.delete(work));
    return work;
  }

  /** Append a line to the index and the running output, and commit it with the details. */
  async #publish(line: string): Promise<void> {
    await this.#open();
    await this.files.append(line);
    this.api.output(`${line}\n`);
    await this.api.details(this.details() as unknown as JsonValue, this.context);
  }

  /** The index exists, and is the first line of the running output, before any sub-call line. */
  #open(): Promise<void> {
    this.#opened ??= (async () => {
      await this.files.open(`codemode call ${this.api.callId} (task ${this.api.taskId}): every sub-call event, one per line`);
      this.#indexed = true;
      this.api.output(`Sub-call index: ${this.files.index} (every sub-call and its result; read it if this output is cut short)\n`);
    })();
    return this.#opened;
  }

  /** Record the end of a sub-call that hands the script no value; best effort, the failure is what the script gets. */
  async #end(record: SubCallRecord, status: SubCallStatus, message: string, startedAt: number | undefined): Promise<void> {
    record.status = status;
    if (startedAt !== undefined) record.durationMs = Math.round(performance.now() - startedAt);
    record.error = truncateText(message, ERROR_PREVIEW_CHARS);
    await this.#publish(`[${record.id}] ${record.name} ${status}: ${JSON.stringify(record.error)}`).catch(() => {});
  }

  async #invoke(entry: CallableTool, n: number, record: SubCallRecord, rawArgs: unknown, signal: AbortSignal): Promise<unknown> {
    const { definition } = entry.tool;
    // The Harness's checks for a model's call: repair, then validate against the schema.
    let args: unknown;
    try {
      const prepared = definition.prepareArguments === undefined ? rawArgs : definition.prepareArguments(rawArgs);
      args = validateToolArguments(definition, { type: "toolCall", id: record.id, name: definition.name, arguments: prepared as JsonObject });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#end(record, "error", message, undefined);
      throw new Error(message);
    }
    // The start is durable before the tool can do anything.
    try {
      await this.#publish(`[${record.id}] ${definition.name} started ${previewArgs(args)}`.trimEnd());
    } catch (error) {
      // The line may still be committed later with other output: the next line corrects it.
      const message = `Tool ${definition.name} was not started: the call could not be recorded (${error instanceof Error ? error.message : String(error)})`;
      await this.#end(record, "error", message, undefined);
      throw new Error(message);
    }
    const startedAt = performance.now();
    let result: AgentToolResult<unknown>;
    const release = definition.executionMode === "sequential" ? await this.#acquire() : undefined;
    try {
      // The script may have ended (or the call been cancelled) while the start was committed or the queue waited.
      if (signal.aborted) throw new Error(`Tool ${definition.name} was cancelled before it ran`);
      result = await entry.tool.run(args, { api: this.api, context: this.context, callId: record.id, signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#end(record, signal.aborted ? "cancelled" : "error", message, startedAt);
      throw error;
    } finally {
      release?.();
    }
    if (result.usage !== undefined) this.usage = this.usage === undefined ? result.usage : combineUsage(this.usage, result.usage);
    let value: unknown;
    try {
      value = toScriptValue(definition, result);
    } catch (error) {
      await this.#end(record, signal.aborted ? "cancelled" : "error", (error as Error).message, startedAt);
      throw error;
    }
    const status: SubCallStatus = result.isError ? (signal.aborted ? "cancelled" : "error") : "ok";
    // The value is durable before the script sees it: files, index line, then the committed output line.
    const recorded = recordOf(value, definition.outputSchema !== undefined && result.structuredContent !== undefined,
      result.content.filter((item): item is ImageContent => item.type === "image"));
    let line: string;
    try {
      const bounded = await this.files.bound(n, recorded.text, recorded.structured, recorded.images);
      record.status = status;
      record.durationMs = Math.round(performance.now() - startedAt);
      if (result.isError) record.error = truncateText(textOf(result) || `Tool "${definition.name}" failed`, ERROR_PREVIEW_CHARS);
      line = `[${record.id}] ${definition.name} ${status}${describeResult(bounded)}`;
    } catch (error) {
      const message = `The result of ${definition.name} could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      await this.#end(record, "error", message, startedAt);
      throw new Error(message);
    }
    try {
      await this.#publish(line);
    } catch (error) {
      // The script does not get the value; the next line corrects the one that may still be committed later.
      const message = `The result of ${definition.name} could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
      await this.#end(record, "error", message, startedAt);
      throw new Error(message);
    }
    return value;
  }

  /** One sub-call of a `sequential` tool at a time in this script (coding-agent runs such nested calls exclusively). */
  async #acquire(): Promise<() => void> {
    const previous = this.#exclusive;
    let release!: () => void;
    this.#exclusive = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}
