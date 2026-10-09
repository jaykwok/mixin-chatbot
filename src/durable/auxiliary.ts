import { mkdir } from "node:fs/promises";
import { Type, type ClassifierContext, type ClassifierResult, type ImageContent } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { AuxiliaryConfig } from "../core/auxiliary-config.ts";
import type { RequestDoor } from "./door.ts";
import { ResultsDoc } from "./result-lifecycle.ts";
import { SubCallFiles, resultsDirName } from "./codemode/results.ts";
import { resolveMember, type BaseToolsOptions, type MemberCall, type MemberTool } from "./tools.ts";

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

const IMAGE = Type.Object({ type: Type.Literal("image"), data: Type.String({ maxLength: 12 * 1024 * 1024 }),
  mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp"), Type.Literal("image/gif")]) });
function images(raw: ImageContent[] | undefined): ImageContent[] {
  if (!raw) return [];
  if (raw.length > 4) throw new Error("每次最多四张参考图片");
  return raw.map(item => {
    if (item.type !== "image" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mimeType)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) || item.data.length > 12 * 1024 * 1024) throw new Error("图片格式或大小无效");
    return { ...item };
  });
}

export function auxiliaryMemberTools(options: BaseToolsOptions, door: RequestDoor, config: AuxiliaryConfig, budget: AuxiliaryBudget): MemberTool[] {
  const run = <T>(call: MemberCall, work: () => Promise<T>): Promise<T> => {
    if (!call.signal) return Promise.reject(new Error("辅助模型需要可取消的任务"));
    return budget.run(call.signal, () => door.withToolModels(call.api, call.context, call.callId, call.signal!, work));
  };
  const tools: MemberTool[] = [];
  if (config.classifier) tools.push({
    definition: {
      name: "document_route", label: "判断文档处理路线", namespace: { name: "models", description: "管理员配置的辅助模型" },
      description: "Classify a document or page as text extraction, OCR, or layout processing with the configured classifier. Images use image blocks returned by read. This starts a billed model request; use once for a representative page when the route is uncertain.",
      parameters: Type.Object({ text: Type.String({ maxLength: 32768 }), images: Type.Optional(Type.Array(IMAGE, { maxItems: 4 })) }),
      outputSchema: Type.Object({ route: Type.Union([Type.Literal("text"), Type.Literal("ocr"), Type.Literal("layout")]), confidence: Type.Number() }),
      execute: async () => { throw new Error("Member invocation required"); },
    }, replay: "unsafe", outputLimits: { maxBytes: 65536, maxLines: 2200 },
    async run(raw, call) {
      await resolveMember(options, call);
      const args = raw as { text: string; images?: ImageContent[] };
      const ref = config.classifier!;
      const model = call.api.models.getModelOfType("classifier", ref.provider, ref.modelId);
      if (!model) throw new Error(`没有分类模型 ${ref.provider}/${ref.modelId}`);
      const context: ClassifierContext = { state: { text: args.text }, images: images(args.images), questions: {
        route: { type: "choice", instructions: "Choose the minimal processing route needed to preserve the supplied document's information.",
          criteria: { text: "Existing text is readable; extract text.", ocr: "A scanned page or image needs OCR to obtain text.", layout: "Tables, diagrams, slides, or spatial layout require preserving structure." } },
      } };
      const result = await run(call, async () => {
        let result: ClassifierResult;
        for (let attempt = 0; ; attempt++) {
          result = await call.api.models.classify(model, context);
          if (result.stopReason !== "error" || attempt >= config.classifierRetries
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
      if (result.stopReason !== "stop") return { content: [{ type: "text", text: result.errorMessage ?? result.stopReason }], isError: true, details: undefined };
      const answer = result.answers.route;
      if (answer?.type !== "choice" || !["text", "ocr", "layout"].includes(answer.choice)) throw new Error("分类模型没有返回有效处理路线");
      const value = { route: answer.choice, confidence: answer.confidence };
      // Usage is persisted/charged by AuxiliaryDoc, never attached again to the parent tool's combined usage.
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, details: { provider: ref.provider, model: ref.modelId } };
    },
  });
  if (config.image) tools.push({
    definition: {
      name: "generate_image", label: "生成图片", namespace: { name: "models", description: "管理员配置的辅助模型" },
      description: "Generate an image with the configured image model and save it into your own tmp. Starts a billed request. Supply a prompt and optional image blocks; send_image remains a separate model-only tool.",
      parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 32768 }), images: Type.Optional(Type.Array(IMAGE, { maxItems: 4 })) }),
      execute: async () => { throw new Error("Member invocation required"); },
    }, replay: "unsafe", outputLimits: { maxBytes: 65536, maxLines: 2200 },
    async run(raw, call) {
      const { phone, places } = await resolveMember(options, call);
      const args = raw as { prompt: string; images?: ImageContent[] };
      const ref = config.image!;
      const model = call.api.models.getModelOfType("image", ref.provider, ref.modelId);
      if (!model) throw new Error(`没有图片模型 ${ref.provider}/${ref.modelId}`);
      const result = await run(call, () => call.api.models.generateImages(model, { input: [{ type: "text", text: args.prompt }, ...images(args.images)] }));
      call.signal?.throwIfAborted();
      if (result.stopReason !== "stop") return { content: [{ type: "text", text: result.errorMessage ?? result.stopReason }], isError: true, details: undefined };
      await mkdir(places.tempDir, { recursive: true });
      const name = resultsDirName(call.api.taskId as number, `image-${call.callId}`);
      const files = new SubCallFiles(places.tempDir, name, () => call.api.commit(async tx => {
        const doc = await tx.doc(ResultsDoc);
        if (!doc.calls[name]) {
          if (Object.keys(doc.calls).length >= 4096) throw new Error("结果归属记录已达上限，请先清理");
          doc.calls[name] = { phone, createdAt: Date.now() };
        }
      }, call.context));
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
        return { content, details: { provider: ref.provider, model: ref.modelId } };
      } finally { await files.release(); }
    },
  });
  return tools;
}
