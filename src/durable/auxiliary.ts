import { mkdir } from "node:fs/promises";
import type { ClassifierContext, ClassifierResult, ImageContent, Usage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { ModelRef } from "@earendil-works/pi-durable";
import { arr, lit, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AuxiliaryConfig } from "../core/auxiliary-config.ts";
import type { RequestDoor } from "./door.ts";
import { resultRegistration } from "./results/ownership.ts";
import { ResultFiles, resultsDirName } from "./results/files.ts";
import { memberTool, type BaseToolsOptions, type MemberCall, type MemberTool, type MemberToolSpec } from "./tools.ts";

/** One instance per service, shared by all groups; queued calls are bounded and abort without a request. */
export class AuxiliaryBudget {
  #active = 0;
  readonly #waiting = new Set<() => void>();
  constructor(private readonly limit: number) {}
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    while (this.#active >= this.limit) {
      if (this.#waiting.size >= 32) throw new Error("辅助模型等待队列已满");
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { this.#waiting.delete(wake); signal.removeEventListener("abort", abort); };
        this.#waiting.add(wake); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    this.#active++;
    try { return await work(); }
    finally { this.#active--; [...this.#waiting][0]?.(); }
  }
}

/** The usage the provider returned for every attempt of one call: the tool result carries it into `pi.usage.tools`. */
function sumUsage(results: readonly { usage?: Usage }[]): Usage | undefined {
  let total: Usage | undefined;
  for (const { usage } of results) {
    if (usage === undefined) continue;
    if (total === undefined) { total = structuredClone(usage); continue; }
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
    for (const field of ["cacheWrite1h", "reasoning"] as const) if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field];
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
  }
  return total;
}

const IMAGE = obj({ type: lit("image"), data: str({ maxLength: 12 * 1024 * 1024 }),
  mimeType: oneOf(["image/png", "image/jpeg", "image/webp", "image/gif"]) }, { open: true });
const MODELS = { name: "models", description: "管理员配置的辅助模型" };
const routeParams = obj({ text: str({ maxLength: 32768 }), images: opt(arr(IMAGE, { maxItems: 4 })) }, { open: true });
const routeOutput = obj({ route: oneOf(["text", "ocr", "layout"]), confidence: num() }, { open: true });
const imageParams = obj({ prompt: str({ minLength: 1, maxLength: 32768 }), images: opt(arr(IMAGE, { maxItems: 4 })) }, { open: true });
function images(raw: ImageContent[] | undefined): ImageContent[] {
  if (!raw) return [];
  if (raw.length > 4) throw new Error("每次最多四张参考图片");
  return raw.map(item => {
    if (item.type !== "image" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mimeType)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) || item.data.length > 12 * 1024 * 1024) throw new Error("图片格式或大小无效");
    return { ...item };
  });
}

type Budgeted = <T>(call: MemberCall, work: () => Promise<T>) => Promise<T>;

/** document_route: the configured classifier picks a processing route; transient errors are retried `retries` times. */
function routeTool(ref: ModelRef, retries: number, run: Budgeted): MemberToolSpec<typeof routeParams> {
  return {
    name: "document_route", namespace: MODELS,
    description: "Classify a document or page as text extraction, OCR, or layout processing with the configured classifier. Images use image blocks returned by read. This starts a billed model request; use once for a representative page when the route is uncertain.",
    parameters: routeParams, structuredOutputSchema: routeOutput,
    async run(args, _member, call) {
      const model = call.api.models.getModelOfType("classifier", ref.provider, ref.modelId);
      if (!model) throw new Error(`没有分类模型 ${ref.provider}/${ref.modelId}`);
      const context: ClassifierContext = { state: { text: args.text }, images: images(args.images), questions: {
        route: { type: "choice", instructions: "Choose the minimal processing route needed to preserve the supplied document's information.",
          criteria: { text: "Existing text is readable; extract text.", ocr: "A scanned page or image needs OCR to obtain text.", layout: "Tables, diagrams, slides, or spatial layout require preserving structure." } },
      } };
      const attempts: ClassifierResult[] = [];
      const result = await run(call, async () => {
        let result: ClassifierResult;
        for (let attempt = 0; ; attempt++) {
          result = await call.api.models.classify(model, context);
          attempts.push(result);
          if (result.stopReason !== "error" || attempt >= retries
            || !isRetryableAssistantError({ stopReason: "error", errorMessage: result.errorMessage } as never)) return result;
          await new Promise<void>((resolve, reject) => {
            const signal = call.signal!;
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000 * 2 ** attempt);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
        }
      });
      call.signal?.throwIfAborted();
      const usage = sumUsage(attempts);
      const charged = usage === undefined ? {} : { usage };
      if (result.stopReason !== "stop") return { output: [{ type: "text", text: result.errorMessage ?? result.stopReason }], isError: true, ...charged };
      const answer = result.answers.route;
      if (answer?.type !== "choice" || !["text", "ocr", "layout"].includes(answer.choice)) throw new Error("分类模型没有返回有效处理路线");
      const value = { route: answer.choice, confidence: answer.confidence };
      return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value, details: { provider: ref.provider, model: ref.modelId }, ...charged };
    },
  };
}

/** generate_image: the configured image model; its images are saved in the member's results directory. */
function imageTool(ref: ModelRef, run: Budgeted): MemberToolSpec<typeof imageParams> {
  return {
    name: "generate_image", namespace: MODELS,
    description: "Generate an image with the configured image model and save it into your own tmp. Starts a billed request. Supply a prompt and optional image blocks; send_image remains a separate model-only tool.",
    parameters: imageParams,
    async run(args, { phone, places }, call) {
      const model = call.api.models.getModelOfType("image", ref.provider, ref.modelId);
      if (!model) throw new Error(`没有图片模型 ${ref.provider}/${ref.modelId}`);
      const result = await run(call, () => call.api.models.generateImages(model, { input: [{ type: "text", text: args.prompt }, ...images(args.images)] }));
      call.signal?.throwIfAborted();
      const charged = result.usage === undefined ? {} : { usage: result.usage };
      if (result.stopReason !== "stop") return { output: [{ type: "text", text: result.errorMessage ?? result.stopReason }], isError: true, ...charged };
      await mkdir(places.tempDir, { recursive: true });
      const name = resultsDirName(call.api.taskId as number, `image-${call.callId}`);
      const files = new ResultFiles(places.tempDir, name, resultRegistration(call.api, call.context, phone, name));
      try {
        const content: ({ type: "text"; text: string } | ImageContent)[] = [];
        let index = 0;
        for (const item of result.output) {
          if (item.type === "text") { content.push(item); continue; }
          if (++index > 4 || item.data.length > 24 * 1024 * 1024) throw new Error("图片模型返回结果超限");
          const path = await files.saveOutputImage(index, Buffer.from(item.data, "base64"), item.mimeType);
          content.push({ type: "text", text: `Image saved to ${path}` }, item);
        }
        const stale = await files.recheck();
        if (stale.size) throw new Error("生成图片目录发生变化，结果路径已撤回");
        return { output: content, details: { provider: ref.provider, model: ref.modelId }, ...charged };
      } finally { await files.release(); }
    },
  };
}

/** The configured auxiliary model tools (document_route, generate_image), script-callable like any direct tool. */
export function auxiliaryMemberTools(options: BaseToolsOptions, door: RequestDoor, config: AuxiliaryConfig, budget: AuxiliaryBudget): MemberTool[] {
  const run: Budgeted = (call, work) => {
    if (!call.signal) return Promise.reject(new Error("辅助模型需要可取消的任务"));
    return budget.run(call.signal, () => door.withToolModels(call.api, call.context, call.callId, call.signal!, work));
  };
  const tools: MemberToolSpec[] = [
    ...config.classifier ? [routeTool(config.classifier, config.classifierRetries, run)] : [],
    ...config.image ? [imageTool(config.image, run)] : [],
  ];
  return tools.map((spec) => memberTool(spec, options));
}
