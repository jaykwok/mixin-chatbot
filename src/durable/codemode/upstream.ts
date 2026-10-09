// Pure parts of coding-agent's codemode, ported for the Durable engine (gap G2: pi-coding-agent exports only
// `createCodemodeExtension`, whose executor needs an AgentSession). Ported from @earendil-works/pi-coding-agent 1.1.0:
//   dist/extensions/codemode/tool.js        description, catalogue budget, script-call line
//   dist/extensions/codemode/execute.js     previews, script values, output budget, image files, error text, discovery
//                                           globals
//   dist/extensions/tool-search/tool.js     BM25 ranker and search documents
//   dist/core/usage-totals.js               combineUsage
//   dist/core/agent-session.js              how the loadout's prompt guidelines are normalised
// tests/durable/codemode-upstream.test.ts compares these functions with the installed upstream modules.
//
// Differences from upstream:
// - The raw `models` global remains off. Explicit auxiliary tools use the Durable request door and member results,
//   rather than exposing provider calls to scripts.
// - `truncateOutput` and `saveImages` take the place to write to (the caller saves into the call's results directory in
//   the member's tmp, src/durable/codemode/results.ts) instead of creating output files in the shared system temp
//   directory (coding-agent `writeOutputFile`), which the AgentSession engine moved afterwards (src/agent/codemode.ts).
// - Namespaces come from the tool definitions (`ToolDefinition.namespace`), as `getToolNamespace` returned them.
// - `describeScriptCall` takes the description and output schema separately: a Durable registration has no output schema.
// - The discovery globals take the callable tools with their namespaces instead of a lookup callback.
// - Prompt guidelines (1.0.4) come from the tool definitions: the description lists them as AgentSession's loadout gives
//   them (`normalizeGuidelines`), the samples of `ALL_TOOLS` and `describeTool()` as the definitions have them
//   (coding-agent's `getToolGuidelines`).
import {
  MCP_TYPESCRIPT_PREAMBLE, mcpStructuredContentSchema, renderToolOutputType, renderToolSample, toCodemodeIdentifier,
  type CodemodeJsonSchema, type CodemodeOutputItem, type CodemodeResult, type CodemodeTool,
} from "@earendil-works/pi-codemode";
import type { Usage } from "@earendil-works/pi-ai";
import { formatSize, type AgentToolResult, type ToolDefinition, type ToolNamespace } from "@earendil-works/pi-coding-agent";

export { formatSize };

// ---- tool.js -------------------------------------------------------------------------------------------------------

export const CODEMODE_TOOL_NAME = "codemode";

/**
 * Prompt snippet and guideline of the codemode tool.
 * @internal Only the comparison test reads them: tool snippets and guidelines stay out of the system prompt
 * (src/durable/prompt.ts writes its own; see src/durable/tools.ts).
 */
export const codemodeToolSystemPromptContribution = {
  snippet: "Run JavaScript that calls other tools",
  guidelines: [
    "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls.",
  ],
};

const TEXT_OUTPUT_SCHEMA = { type: "string" };

const DESCRIPTION_INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

/** One line per global (upstream `describeGlobals(false)`). */
const GLOBALS = [
  "Globals:",
  "- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
  "- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
  "- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.",
].join("\n");

/** Default inline budget of the description's tool sections, in estimated tokens. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;
/** Characters per token when estimating. */
const CHARS_PER_TOKEN = 4;

/** The tool fields codemode reads. */
export type CodemodeToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "outputSchema">;

/**
 * What a script sees of a tool: its description followed by its prompt guidelines, which the system prompt only has for
 * declared tools. Tools without an output schema resolve to their text output.
 */
export function toCodemodeDeclaration(tool: CodemodeToolInfo, guidelines: readonly string[] = []): Omit<CodemodeTool, "execute"> {
  const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
  return {
    name: tool.name,
    description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
  };
}

/** A tool's prompt guidelines as AgentSession's loadout gives them: trimmed, without empty ones or repeats. */
export function normalizeGuidelines(guidelines: readonly string[] | undefined): string[] {
  return [...new Set((guidelines ?? []).map((guideline) => guideline.trim()).filter((guideline) => guideline.length > 0))];
}

function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
  const id = toCodemodeIdentifier(declaration.name);
  const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
  return `${heading}\n${renderToolSample(declaration).trim()}`;
}

type CatalogueEntry = { name: string; section: string; cost: number };
type CatalogueGroup = { namespace: ToolNamespace | undefined; entries: CatalogueEntry[] };

/**
 * Pick the tool sections that fit the budget: in each round every group (tools without a namespace first, then
 * namespaces by name) places its cheapest remaining tool; a group whose next tool does not fit drops out.
 */
function selectCatalog(groups: CatalogueGroup[], budget: number | undefined): Set<string> {
  if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
  const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
  const shown = new Set<string>();
  let remaining = budget;
  let active = queues.filter((queue) => queue.length > 0);
  while (active.length > 0) {
    active = active.filter((queue) => {
      const next = queue[0]!;
      if (next.cost > remaining) return false;
      remaining -= next.cost;
      shown.add(next.name);
      queue.shift();
      return queue.length > 0;
    });
  }
  return shown;
}

export interface CodemodeDescriptionOptions {
  namespaces?: ReadonlyMap<string, ToolNamespace>;
  /** Callable but never listed. */
  deferred?: ReadonlySet<string>;
  /** Prompt guidelines of each tool, by tool name, listed after its description. */
  guidelines?: ReadonlyMap<string, readonly string[]>;
  inlineBudget?: number;
}

/**
 * The codemode tool's description: the helper list, the shared MCP types when listed tools need them, and one section
 * per listed tool grouped by namespace, limited to `inlineBudget`. The caller passes the tools the description lists.
 */
export function createCodemodeDescription(tools: readonly CodemodeToolInfo[], options: CodemodeDescriptionOptions = {}): string {
  const declarations = tools
    .filter((tool) => tool.name !== CODEMODE_TOOL_NAME && !options.deferred?.has(tool.name))
    .map((tool) => toCodemodeDeclaration(tool, options.guidelines?.get(tool.name)));
  const groups = new Map<string, CatalogueGroup>([["", { namespace: undefined, entries: [] }]]);
  for (const declaration of declarations) {
    const namespace = options.namespaces?.get(declaration.name);
    const key = namespace ? `ns:${namespace.name}` : "";
    const group = groups.get(key) ?? { namespace, entries: [] };
    groups.set(key, group);
    const section = renderToolSection(declaration);
    group.entries.push({ name: declaration.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
  }
  const ordered = [...groups.values()].sort((a, b) =>
    a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name));
  const shown = selectCatalog(ordered, options.inlineBudget);
  const sections = [DESCRIPTION_INTRO, GLOBALS];
  if (declarations.some((declaration) => shown.has(declaration.name) && mcpStructuredContentSchema(declaration.outputSchema) !== undefined)) {
    sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
  }
  if (declarations.length === 0) return sections.join("\n\n");
  const toolSections = ["Nested tools:"];
  for (const { namespace, entries } of ordered) {
    const visible = entries.filter((entry) => shown.has(entry.name));
    if (namespace) {
      const listing = visible.length === entries.length ? "" : visible.length === 0 ? " (tools not listed)" : " (some tools not listed)";
      const description = namespace.description?.trim();
      toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
    }
    for (const entry of visible) toolSections.push(entry.section);
  }
  sections.push(toolSections.join("\n\n"));
  return sections.join("\n\n");
}

/** What a script call resolves to, in one line: `a string`, the field names of an object, or the rendered type. */
function describeOutput(schema: CodemodeJsonSchema | undefined): string {
  const type = renderToolOutputType(schema);
  if (type === "string") return "a string";
  const object = typeof schema === "object" ? schema : undefined;
  const properties = object?.properties;
  if (object?.type === "object" && typeof properties === "object" && properties !== null && mcpStructuredContentSchema(schema) === undefined) {
    const required = new Set(Array.isArray(object.required) ? object.required : []);
    const fields = Object.keys(properties).map((name) => (required.has(name) ? name : `${name}?`));
    return `\`{ ${fields.join(", ")} }\``;
  }
  return `\`${type.replace(/\s+/g, " ")}\``;
}

/** A declared tool's description followed by how scripts call it and what the call resolves to (mode `on`). */
export function describeScriptCall(name: string, description: string, outputSchema: unknown): string {
  const resolved = toCodemodeDeclaration({ name, description, parameters: {} as never, outputSchema: outputSchema as never }).outputSchema;
  return `${description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(name)}(args)\` resolves to ${describeOutput(resolved)}.`;
}

// ---- execute.js ----------------------------------------------------------------------------------------------------

const ARGS_PREVIEW_CHARS = 200;
export const ERROR_PREVIEW_CHARS = 500;
/** Heap limit of the QuickJS VM; overruns throw `InternalError: out of memory` inside the script. */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Default token budget for script output. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

export function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

export function previewArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
  } catch {
    return "";
  }
}

export function textOf(result: Pick<AgentToolResult<unknown>, "content">): string {
  return (result.content ?? []).filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n");
}

/** Like the script's `text()`: strings as is, other values as compact JSON. */
export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

type ScriptCall = { name: string; status: string };

function formatCallSummary(calls: readonly ScriptCall[]): string {
  if (calls.length === 0) return "No tool calls were made.";
  return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

export function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly ScriptCall[]): string {
  const { error } = result;
  const head = error.kind === "script"
    ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
    : error.kind === "timeout"
      ? `Script timed out: ${error.message}`
      : error.kind === "aborted"
        ? `Script aborted: ${error.message}`
        : `Script sandbox failed: ${error.message}`;
  return `${head}\n\n${formatCallSummary(calls)}`;
}

export type OutputItem = CodemodeOutputItem;

/** Pi 1.1.0 execute.js: distinguish text items before truncation, collect console after all other output. */
export function formatOutput(output: OutputItem[]): OutputItem[] {
  const total = output.filter(item => item.type === "text" && !item.console).length;
  const items: OutputItem[] = [];
  const consoleLines: string[] = [];
  let index = 0;
  for (const item of output) {
    if (item.type === "image") items.push(item);
    else if (item.console) consoleLines.push(item.text);
    else {
      index++;
      items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
    }
  }
  if (consoleLines.length) items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
  return items;
}

/** Pi 1.1.0 merges text before truncating and after saving image labels. */
export function joinAdjacentText(items: OutputItem[]): OutputItem[] {
  const joined: OutputItem[] = [];
  for (const item of items) {
    const last = joined.at(-1);
    if (item.type === "text" && last?.type === "text") {
      const separator = last.text === "" || last.text.endsWith("\n") ? "" : "\n";
      joined[joined.length - 1] = { type: "text", text: `${last.text}${separator}${item.text}` };
    } else joined.push(item);
  }
  return joined;
}

/**
 * Apply the token budget: when the combined text exceeds it, the text items become one item that keeps the start and
 * end of the text, and images follow it. `spill` saves the full text and returns its path or an error message.
 */
export async function truncateOutput(
  items: OutputItem[],
  maxTokens: number,
  spill: (text: string) => Promise<{ path: string } | { error: string }>,
): Promise<{ items: OutputItem[]; fullOutputPath?: string }> {
  items = joinAdjacentText(items);
  const texts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
  const combined = texts.join("\n");
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (texts.length === 0 || combined.length <= budget) return { items };
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - headChars - tailChars;
  const head = combined.slice(0, headChars);
  const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
  let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
  const spilled = await spill(combined);
  text += "path" in spilled
    ? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
    : `\n\n[Could not save the full output: ${spilled.error}]`;
  return {
    items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
    ...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
  };
}

/**
 * Save each image and put a text item with its path before it. The model sees the image but has no other way to reach
 * its bytes: scripts cannot write files, and `write` only takes text. Images shown more than once are saved once. Runs
 * after `truncateOutput`, which joins the text items and moves images after them, so each path stays next to its image
 * and is never cut. `save` writes the bytes and returns the path.
 *
 * Upstream rejects an image type it has no file extension for before saving (unreachable: the sandbox's `image()`
 * accepts only types with one); here the caller's `save` decides, and its error becomes the label like any other.
 */
export async function saveImages(items: OutputItem[], save: (bytes: Buffer, mimeType: string) => Promise<string>): Promise<OutputItem[]> {
  const labels = new Map<string, Promise<string>>();
  const label = async ({ data, mimeType }: { data: string; mimeType: string }) => {
    const bytes = Buffer.from(data, "base64");
    const kind = `${mimeType}, ${formatSize(bytes.length)}`;
    // A failed write (disk full, unwritable directory) must not discard the result of a script whose tool calls already
    // ran, so it becomes part of the label.
    try {
      return `[Image saved to ${await save(bytes, mimeType)} (${kind})]`;
    } catch (error) {
      return `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
    }
  };
  const result = await Promise.all(items.map(async (item): Promise<OutputItem[]> => {
    if (item.type !== "image") return [item];
    let pending = labels.get(item.data);
    if (!pending) {
      pending = label(item);
      labels.set(item.data, pending);
    }
    return [{ type: "text", text: await pending }, item];
  }));
  return result.flat();
}

/**
 * The value a script receives for a nested call: a tool that declares `outputSchema` resolves to its
 * `structuredContent`, also for error results that carry one; any other tool resolves to its text content. Other
 * failures reject with the tool's error text.
 */
export function toScriptValue(tool: Pick<ToolDefinition, "name" | "outputSchema">, result: AgentToolResult<unknown>): unknown {
  if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  if (result.isError) throw new Error(text || `Tool "${tool.name}" failed`);
  return text;
}

/**
 * Whether `query` names the namespace: its name, its script identifier, or the part after its last `__` in either form.
 */
function isNamespaceName(namespace: string, query: string): boolean {
  const id = toCodemodeIdentifier(namespace);
  const queryId = toCodemodeIdentifier(query);
  const suffix = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined);
  return namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId;
}

export type DiscoveryTool = Pick<ToolDefinition, "name" | "description" | "parameters"> & { namespace?: ToolNamespace };

/** `searchTools()`, `describeTool()` and `describeNamespace()` over the script's callable tools. */
export function createDiscoveryGlobals(tools: readonly DiscoveryTool[], samples: ReadonlyMap<string, string>): CodemodeTool[] {
  const ranker = new Bm25Ranker();
  const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
  return [
    {
      name: "searchTools",
      spread: true,
      execute: (args) => {
        const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
        if (typeof query !== "string") throw new Error("searchTools() expects a query string");
        const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
          throw new Error("searchTools() limit must be a positive integer");
        }
        const namespace = searchOptions?.namespace;
        if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
          throw new Error("searchTools() namespace must be a string");
        }
        const documents = tools.flatMap((tool) => {
          if (namespace && (!tool.namespace || !isNamespaceName(tool.namespace.name, namespace))) return [];
          return [createToolSearchDocument(tool, tool.namespace)];
        });
        return ranker.rank(query, documents, limit).map((match) => entry(match.name));
      },
    },
    {
      name: "describeTool",
      spread: true,
      execute: (args) => {
        const [name] = args as unknown[];
        if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
        const tool = tools.find((candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name);
        return tool ? samples.get(tool.name) : undefined;
      },
    },
    {
      name: "describeNamespace",
      spread: true,
      execute: (args) => {
        const [name] = args as unknown[];
        if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
        let namespace: ToolNamespace | undefined;
        const names: string[] = [];
        for (const tool of tools) {
          if (!tool.namespace || !isNamespaceName(tool.namespace.name, name)) continue;
          namespace ??= tool.namespace;
          names.push(toCodemodeIdentifier(tool.name));
        }
        if (!namespace) return undefined;
        return {
          name: namespace.name,
          ...(namespace.description ? { description: namespace.description } : {}),
          ...(namespace.instructions ? { instructions: namespace.instructions } : {}),
          tools: names,
        };
      },
    },
  ];
}

// ---- tool-search/tool.js -------------------------------------------------------------------------------------------

export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "with"]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
  if (!isObject(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

/** Search text of a tool: its names, description, schema text, and its namespace. */
export function createToolSearchDocument(tool: Pick<ToolDefinition, "name" | "description" | "parameters">, namespace?: ToolNamespace) {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.parameters, parts);
  if (namespace) parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
  return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Okapi BM25 with the usual parameters. Ties keep document order. */
export class Bm25Ranker {
  private readonly k1: number;
  private readonly b: number;
  constructor(options: { k1?: number; b?: number } = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
  }

  rank(query: string, documents: readonly { name: string; text: string }[], limit: number): { name: string; score: number }[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
    const termCounts = documents.map((document) => {
      const counts = new Map<string, number>();
      for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
      return counts;
    });
    const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
    const idf = new Map(queryTerms.map((term) => {
      const frequency = termCounts.filter((counts) => counts.has(term)).length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
    }));
    const matches: { name: string; score: number }[] = [];
    documents.forEach((document, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const count = termCounts[index]!.get(term);
        if (!count) continue;
        const norm = this.k1 * (1 - this.b + (this.b * lengths[index]!) / averageLength);
        score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
      }
      if (score > 0) matches.push({ name: document.name, score });
    });
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// ---- usage-totals.js -----------------------------------------------------------------------------------------------

/** Sum of two usages, keeping the optional token splits when either side reports them. */
export function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
      : {}),
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
