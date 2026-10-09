// Request door: the one place where a generation request reaches the provider (D0 reviews R2-1, R2-4, R3-1; contract
// 2.6). Ported from the accepted D0 probe (tmp/pi100-d0/probes-102/lib/door.ts, Pi 1.0.2) without its mutation switches
// and the arguments only they used; absorbed errors go to `onReport` instead of an ever-growing list.
//
// Serial boundary. A control command (/clear, /stop) is marked in the door's in-memory registry synchronously when it is
// received, before its admission commit; a generation request is handed to the provider only by the door, right after a
// synchronous check of that registry, with no await in between. Both run on the one JS thread of the process that holds
// the lease, so they are totally ordered: a request that passed the check was handed over before the control was
// received and is in flight, and the control's abort cancels it; a request checked after the mark holds and is never
// handed over (the control's abort ends the hold). Every await of the request path (identity read, credential
// resolution, task read, start-record commit, the hold itself) lies before the final check. The registry is loaded from
// the pending admissions at startup, before scheduling, and a control leaves it only after its removal from the stream
// is committed (D3 wires the admission side).
//
// Registration ownership. Each admission attempt of a control holds its own ticket from receipt until that attempt is
// resolved, and a control waiting in the admission stream holds one stream registration under its requestId. Every
// release names what it releases and is idempotent: a late reply of one control cannot release another, and a duplicate
// cannot add a second registration for the same control.
//
// Where. Durable calls `models.streamSimple`; Models (coding-agent `ModelRuntime`) awaits credential resolution before it
// calls the provider, so the door does not delegate generation requests to it. It implements `streamSimple` itself on the
// public `Models` interface: `getProvider(id)` and `getAuth(model, ...)` (which also adds the models.json headers), merged
// into the provider options as pi-ai `Models.applyAuth` / `ModelRuntime.prepareRequest` do (1.0.2, the same in 1.0.3 and 1.0.4),
// then, after the final check, `provider.streamSimple` synchronously. A `beforeRequest` hook registers the generation's
// abort signal with its conversation and task, synchronously, without I/O; the door looks the registration up by signal
// identity (the hook context's `abortSignal` is the invocation controller's signal). The door fails closed: a request
// without a registration is not sent.
//
// Compaction (gap G4, option A; D2-5). The summarize request (`models.completeSimple`) takes the same path: the
// project's pi-durable patch (scripts/patches/) adds a `beforeSummarize` hook before every summarize attempt, which
// registers the compaction's signal as `beforeRequest` does for a generation; the door then holds it for a pending
// control, commits its start record (kind "compaction") and hands it over after the same final check. pi-ai's
// `Models.completeSimple` is `streamSimple(...).result()`, so the door answers it with its own stream's result. Durable
// keeps no per-compaction usage (it adds it to `pi.usage` with the generations), so the door writes the response's
// usage into the start record before ending the stream (best effort; src/durable/compaction.ts).
//
// Error semantics. A failure while preparing the provider call (not a chat model, unknown provider, provider not
// configured, credential resolution or header transform failing) ends the stream as Models' lazy setup does
// (`api/lazy.js`): stop reason "error", the error's own message, no retry by the door, so Durable classifies it as it
// would without the door. Routed (virtual) models are refused as a setup failure.
//
// Start record. The door commits the attempt's start (src/durable/attempts.ts) before the final check and hands the
// request over only after that commit succeeded. Its own steps (member read, start record) are retried with an abortable
// backoff; if they keep failing the request is not sent and the stream ends in a NOT_SENT error, which Durable's retry
// policy retries. A start whose request was then held is marked withdrawn (a failed withdraw leaves an over-count).
//
// Not gated: deferred polls, which continue a request that already went through the door; a control aborts them like any
// background work.
import { type Context, copyJson } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream,
  createModels, type AnyModel, type AssistantImages, type ClassifierContext, type ClassifierModel, type ClassifierResult,
  type ImageModel, type ImagesContext, type Model, type Models, normalizeContext, type Provider, type Usage,
} from "@earendil-works/pi-ai";
import { assertChatModel } from "@earendil-works/pi-ai/utils/model-operations";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { AuxiliaryDoc } from "./auxiliary-records.ts";
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error";
import {
  type CompactionCheckpoint, CompactionTask, defineExtension, type Extension, GenerationTask, type GenerationCheckpoint, type Harness, hook,
} from "@earendil-works/pi-durable";
import { AttemptsDoc, NOT_SENT, type UsageRecord } from "./attempts.ts";

/** coding-agent `VIRTUAL_MODEL_API` (core/virtual-models.js, 1.0.2 to 1.0.4; not exported from the package). */
export const VIRTUAL_MODEL_API = "pi-virtual";

type Registration = { kind: "generation" | "compaction"; conversationId: number; taskId: number; context: Context };
/** One admission attempt of a control: its registration from receipt until the attempt is resolved. */
export type ControlTicket = { readonly phone: string; readonly requestId: string };
/** A control waiting in the admission stream. */
export type PendingControl = { phone: string; requestId: string; seq: number };
type Prepared = {
  provider: { streamSimple(model: never, context: never, options: never): AssistantMessageEventStream };
  model: Model<never>;
  options: Record<string, unknown>;
};
type StreamOptions = {
  signal?: AbortSignal; apiKey?: string; env?: Record<string, string>; headers?: Record<string, string>;
  transformHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>> | Record<string, string>;
};

export interface DoorOptions {
  /** Member (group-scoped phone) of a conversation; read once per conversation and cached. */
  memberOf(harness: Harness, conversationId: number, context: Context): Promise<string | undefined>;
  /** Tries for each of the door's own steps (member read, start record) before giving up unsent; default 3. */
  startTries?: number;
  clock?: () => number;
  /** Errors the door absorbed (failed tries, failed withdraws, failed stream reads). Must not throw. */
  onReport?: (error: unknown) => void;
  /** Tests: a request of this conversation holds for a pending control. */
  onHold?: (conversationId: number) => void;
  /** Tests: called synchronously right after the provider call returned its stream (the handover). */
  onDispatch?: (conversationId: number) => void;
  /** Service lifecycle budget; recovered tasks wait here until their inbox head can run. */
  beforeDispatch?: (phone: string, signal: AbortSignal) => Promise<void>;
  /** Synchronous lifecycle check immediately before dispatch, including after auth and receipt commits. */
  dispatchError?: (phone: string) => Error | undefined;
}

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** pi-ai `mergeHeaders` (models.js, 1.0.2 to 1.0.4): an override replaces a header of any case. */
function mergeHeaders(base: Record<string, string> | undefined, override: Record<string, string> | undefined) {
  if (!base && !override) return undefined;
  const merged: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    merged[name] = value;
  }
  return merged;
}

/** One per group Harness; created by `groupDoor` (src/durable/models.ts). */
export class RequestDoor {
  readonly #toolScope = new AsyncLocalStorage<{ api: Pick<ToolExecutionApi, "taskId" | "conversationId">; context: Context; callId: string; signal: AbortSignal }>();
  readonly #requestedAt = new WeakMap<AssistantMessageEventStream, number>();
  readonly #holder: { harness?: Harness };
  readonly #options: DoorOptions;
  readonly #registrations = new WeakMap<AbortSignal, Registration>();
  readonly #members = new Map<number, string>();
  /** Admission attempts of controls, not yet resolved. */
  readonly #tickets = new Set<ControlTicket>();
  /** Controls waiting in the admission stream, by requestId. */
  readonly #waiting = new Map<string, PendingControl>();
  readonly #waiters = new Set<() => void>();
  /** Background resolutions of uncertain admissions; `close()` stops them. */
  readonly #recoveries = new Set<Promise<void>>();
  /** Start/terminal records already admitted; close drains them before the Harness closes. */
  readonly #writes = new Set<Promise<unknown>>();
  readonly #closing = new AbortController();
  /** Generation and summarize requests the door handed to a provider. */
  dispatched = 0;
  /** Requests ended NOT_SENT (the door's own steps failed, or no registration). */
  notSent = 0;
  /** Requests ended by a setup failure (Models' semantics; nothing sent). */
  setupFailed = 0;
  withdrawn = 0;

  /** `holder.harness` is set once `Harness.open` returned; the door runs only after scheduling started. */
  constructor(holder: { harness?: Harness }, options: DoorOptions) {
    this.#holder = holder;
    this.#options = options;
  }

  // ---- controls (admission side, wired in D3) -------------------------------------------------------------------------

  /** Synchronous, before the control's admission commit: the attempt's own registration. */
  controlReceived(phone: string, requestId: string): ControlTicket {
    const ticket: ControlTicket = Object.freeze({ phone, requestId });
    this.#tickets.add(ticket);
    return ticket;
  }

  /**
   * The attempt's commit returned, or a read after an uncertain commit answered: the control waits in the stream at `seq`.
   * The ticket becomes the control's stream registration (one per requestId). A ticket already released (the control
   * was executed meanwhile) changes nothing.
   */
  controlAdmitted(ticket: ControlTicket, seq: number): void {
    if (!this.#tickets.delete(ticket)) return;
    this.#waiting.set(ticket.requestId, { phone: ticket.phone, requestId: ticket.requestId, seq });
    this.#wake();
  }

  /** The attempt left nothing to wait for (rolled back, duplicate of an executed control, not found): this ticket only. */
  controlDropped(ticket: ControlTicket): void {
    if (!this.#tickets.delete(ticket)) return;
    this.#wake();
  }

  /**
   * The control's removal from the stream (with its done mark) is committed: releases its stream registration and every
   * ticket of the same requestId. Idempotent: recovery may execute a control again.
   */
  controlExecuted(requestId: string): void {
    this.#waiting.delete(requestId);
    for (const ticket of this.#tickets) if (ticket.requestId === requestId) this.#tickets.delete(ticket);
    this.#wake();
  }

  /**
   * The attempt's commit reported failure; it may have landed. Resolve the ticket by reading the stream (`read` returns
   * the control's seq if it is pending): the first read here, so the caller's error path sees the outcome; if a read
   * fails, the ticket stays (the member's requests hold) and reads are retried in the background (20 ms doubling to 1 s)
   * until one answers, the control's execution releases the ticket, or the door closes. A read after the rejection is
   * final: Durable settles a commit's promise only after storage settled.
   */
  async controlUncertain(ticket: ControlTicket, read: () => Promise<number | undefined>): Promise<"resolved" | "retrying"> {
    if (await this.#resolve(ticket, read)) return "resolved";
    const recovery = (async () => {
      for (let delay = 20; this.#tickets.has(ticket); delay = Math.min(delay * 2, 1000)) {
        try { await pause(delay, this.#closing.signal); } catch { return; }
        if (await this.#resolve(ticket, read)) return;
      }
    })();
    this.#recoveries.add(recovery);
    void recovery.finally(() => this.#recoveries.delete(recovery));
    return "retrying";
  }

  /** Startup before scheduling. Preserve receipts registered while the group was asynchronously opening. */
  loadControls(pending: Iterable<PendingControl>): void {
    this.#waiting.clear();
    for (const control of pending) this.#waiting.set(control.requestId, { ...control });
  }

  /** Registrations that hold the member's requests: unresolved attempts plus waiting controls. */
  pendingControls(phone: string): number {
    let count = 0;
    for (const ticket of this.#tickets) if (ticket.phone === phone) count++;
    for (const control of this.#waiting.values()) if (control.phone === phone) count++;
    return count;
  }

  /** The member's registrations by owner (status views and tests). */
  controls(phone: string): { tickets: string[]; stream: string[] } {
    return {
      tickets: [...this.#tickets].filter((ticket) => ticket.phone === phone).map((ticket) => ticket.requestId),
      stream: [...this.#waiting.values()].filter((control) => control.phone === phone).map((control) => control.requestId),
    };
  }

  /** Stop background resolutions (before closing the Harness); unresolved tickets keep holding until then. */
  async close(): Promise<void> {
    this.#closing.abort();
    await Promise.allSettled([...this.#recoveries]);
    await Promise.allSettled([...this.#writes]);
  }

  async #resolve(ticket: ControlTicket, read: () => Promise<number | undefined>): Promise<boolean> {
    if (!this.#tickets.has(ticket)) return true;
    let seq: number | undefined;
    try {
      seq = await read();
    } catch (error) {
      this.#report(error);
      return false;
    }
    if (seq === undefined) this.controlDropped(ticket);
    else this.controlAdmitted(ticket, seq);
    return true;
  }

  #wake(): void {
    for (const wake of [...this.#waiters]) wake();
  }

  #report(error: unknown): void {
    try { this.#options.onReport?.(error); } catch {}
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------------

  /** Install first: registers each generation and summarize request's abort signal (synchronous, no I/O). */
  extension(): Extension {
    const registrations = this.#registrations;
    const register = (kind: Registration["kind"], api: { conversationId: unknown; taskId: unknown }, context: Context) => {
      if (context.abortSignal !== undefined) {
        registrations.set(context.abortSignal, { kind, conversationId: api.conversationId as number, taskId: api.taskId as number, context });
      }
    };
    return defineExtension({
      name: "mixin-request-door",
      hooks: [
        hook(GenerationTask, {
          async beforeRequest(_request, api, context: Context) {
            register("generation", api, context);
            return undefined;
          },
        }),
        hook(CompactionTask, {
          async beforeSummarize(_request, api, context: Context) {
            register("compaction", api, context);
          },
        }),
      ],
    });
  }

  /** ToolTask calls execute for both first execution and safe replay; beforeTool is skipped on replay. */
  wrapTools(extension: Extension): Extension {
    const wrap = (tool: ToolRegistration): ToolRegistration => ({
      ...tool,
      execute: async (args, api, context) => {
        if (!context.abortSignal) throw new Error("tool execution requires a Durable invocation signal");
        const signal = AbortSignal.any([context.abortSignal, this.#closing.signal]);
        const registration: Registration = { kind: "generation", conversationId: api.conversationId as number,
          taskId: api.taskId as number, context };
        const phone = await this.#member(registration, signal);
        await this.#options.beforeDispatch?.(phone, signal);
        signal.throwIfAborted();
        const blocked = this.#options.dispatchError?.(phone);
        if (blocked) throw blocked;
        return tool.execute(args, api, context);
      },
    });
    return {
      ...extension,
      ...(extension.tools ? { tools: extension.tools.map(wrap) } : {}),
      // A later extension may replace execute; guard the result of that wrapper too.
      ...(extension.wraps ? { wraps: extension.wraps.map(each => "tool" in each
        ? { ...each, wrap: (tool: ToolRegistration) => wrap(each.wrap(tool)) } : each) } : {}),
    };
  }

  /**
   * The Models view for `Harness.open`: generation (`streamSimple`) and summarize (`completeSimple`) requests go through
   * the door. Only public catalogue reads and native deferred continuations are passed through.
   */
  wrap(models: Models): Models {
    return new Proxy(models, {
      get: (target, property) => {
        if (property === "streamSimple") {
          return (model: Model<never>, context: never, options?: StreamOptions) => this.#stream(target, model, context, options);
        }
        if (property === "completeSimple") {
          return (model: Model<never>, context: never, options?: StreamOptions) => this.#stream(target, model, context, options).result();
        }
        if (property === "classify") return (model: ClassifierModel<never>, context: ClassifierContext) => this.#classify(models, model, context);
        if (property === "generateImages") return (model: ImageModel<never>, context: ImagesContext) => this.#images(models, model, context);
        if (!["getModel", "getModels", "getModelOfType", "getModelsOfType", "getAllModels", "streamDeferred", "fetchDeferred", "cancelDeferred"].includes(String(property))) {
          return () => { throw new Error(`request door: ${String(property)} is unavailable in a tool; use the configured auxiliary tools`); };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Only an explicitly registered member tool can enter this scope. Sandbox code receives tool functions only. */
  withToolModels<T>(api: Pick<ToolExecutionApi, "taskId" | "conversationId">, context: Context, callId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (!context.abortSignal) throw new Error("auxiliary model call requires a Durable invocation signal");
    return this.#toolScope.run({ api, context, callId, signal: AbortSignal.any([context.abortSignal, signal]) }, run);
  }

  /** External-tool transports call this after auth preparation and immediately before handing over the request. */
  async external<T>(api: Pick<ToolExecutionApi, "taskId" | "conversationId">, context: Context, dispatch: () => Promise<T>, callerSignal: AbortSignal): Promise<T> {
    if (!context.abortSignal) throw new Error("external tool requires a Durable invocation signal");
    const signal = AbortSignal.any([context.abortSignal, callerSignal, this.#closing.signal]);
    const registration: Registration = { kind: "generation", taskId: api.taskId as number, conversationId: api.conversationId as number, context };
    const phone = await this.#member(registration, signal);
    await this.#options.beforeDispatch?.(phone, signal);
    for (;;) {
      await this.#hold(phone, registration, signal);
      signal.throwIfAborted();
      if (this.pendingControls(phone) === 0) {
        const blocked = this.#options.dispatchError?.(phone);
        if (blocked) throw blocked;
        return dispatch();
      }
    }
  }

  #operationModels(models: Models, model: AnyModel): Models {
    const scope = this.#toolScope.getStore();
    if (!scope) throw new Error("auxiliary models require an explicit Durable tool invocation");
    const provider = models.getProvider(model.provider);
    if (!provider) throw new Error(`Unknown provider: ${model.provider}`);
    const view = createModels();
    view.setProvider({ ...provider, getModels: () => provider.getModels(),
      getAllModels: () => provider.getAllModels?.() ?? provider.getModels(),
      // Pi owns auth preparation and image capability validation. Only dispatch is wrapped, after every auth await.
      auth: { apiKey: { name: "Configured runtime", resolve: ({ signal }) => models.getAuth(model, { signal }) } },
      ...(provider.classify ? { classify: ((selected, transcript, options) => this.#auxiliary("classifier", selected, options?.signal,
        () => provider.classify!(selected, transcript, { ...options, maxRetries: 0 }))) as Provider["classify"] } : {}),
      ...(provider.generateImages ? { generateImages: ((selected, transcript, options) => this.#auxiliary("image", selected, options?.signal,
        () => provider.generateImages!(selected, transcript, { ...options, maxRetries: 0 }))) as Provider["generateImages"] } : {}),
    });
    return view;
  }

  #classify(models: Models, model: ClassifierModel<never>, context: ClassifierContext): Promise<ClassifierResult> {
    const scope = this.#toolScope.getStore();
    if (!scope) return Promise.reject(new Error("auxiliary models require an explicit Durable tool invocation"));
    const signal = AbortSignal.any([scope.signal, this.#closing.signal, AbortSignal.timeout(120000)]);
    return this.#operationModels(models, model).classify(model, context, { signal, maxRetries: 0, timeoutMs: 120000 });
  }

  #images(models: Models, model: ImageModel<never>, context: ImagesContext): Promise<AssistantImages> {
    const scope = this.#toolScope.getStore();
    if (!scope) return Promise.reject(new Error("auxiliary models require an explicit Durable tool invocation"));
    const signal = AbortSignal.any([scope.signal, this.#closing.signal, AbortSignal.timeout(120000)]);
    return this.#operationModels(models, model).generateImages(model, context, { signal, maxRetries: 0, timeoutMs: 120000 });
  }

  async #auxiliary<T extends { stopReason: "stop" | "error" | "aborted"; usage?: Usage }>(kind: "classifier" | "image", model: AnyModel,
    requestSignal: AbortSignal | undefined, dispatch: () => Promise<T>): Promise<T> {
    const scope = this.#toolScope.getStore();
    if (!scope || !requestSignal) throw new Error("auxiliary request has no invocation");
    const registration: Registration = { kind: "generation", conversationId: scope.api.conversationId as number,
      taskId: scope.api.taskId as number, context: scope.context };
    const phone = await this.#member(registration, requestSignal);
    await this.#options.beforeDispatch?.(phone, requestSignal);
    for (;;) {
      await this.#hold(phone, registration, requestSignal);
      requestSignal.throwIfAborted();
      const blocked = this.#options.dispatchError?.(phone);
      if (blocked) throw blocked;
      const key = await this.#tries(requestSignal, () => this.#write(() => this.#harness().commit(async tx => {
        const doc = await tx.doc(AuxiliaryDoc, scope.api.conversationId);
        let index = 1;
        while (doc.starts[`${scope.api.taskId}:${scope.callId}:${index}`]) index++;
        const key = `${scope.api.taskId}:${scope.callId}:${index}`;
        doc.starts[key] = { taskId: scope.api.taskId as number, callId: scope.callId, kind, provider: model.provider, model: model.id,
          startedAt: (this.#options.clock ?? Date.now)() };
        return key;
      }, scope.context)));
      // Serial boundary: the provider receives the request immediately after this final synchronous check.
      const blockedAtDispatch = this.#options.dispatchError?.(phone);
      if (!blockedAtDispatch && !requestSignal.aborted && this.pendingControls(phone) === 0) {
        this.dispatched++;
        let work: Promise<T>;
        try { work = dispatch(); }
        catch (error) { throw error; }
        this.#options.onDispatch?.(registration.conversationId);
        const result = await work;
        // After shutdown retain the durable start as unknown, like generation; never attempt a new receipt write.
        if (this.#closing.signal.aborted) return result;
        try {
          await this.#write(() => this.#harness().commit(async tx => {
            const start = (await tx.doc(AuxiliaryDoc, scope.api.conversationId)).starts[key];
            if (!start) throw new Error("auxiliary request receipt missing");
            start.endedAt = (this.#options.clock ?? Date.now)();
            start.outcome = result.stopReason;
            if (result.stopReason === "stop" && result.usage) start.usage = copyJson(result.usage, { omitUndefinedProperties: true }) as UsageRecord;
          }, withoutAbortSignal(scope.context)));
        } catch (error) { this.#report(error); }
        return result;
      }
      await this.#write(() => this.#harness().commit(async tx => {
        const start = (await tx.doc(AuxiliaryDoc, scope.api.conversationId)).starts[key];
        if (start) start.withdrawn = true;
      }, withoutAbortSignal(scope.context)));
      if (blockedAtDispatch) throw blockedAtDispatch;
      requestSignal.throwIfAborted();
    }
  }

  // ---- the request path -----------------------------------------------------------------------------------------------

  #stream(models: Models, model: Model<never>, context: never, options: StreamOptions | undefined): AssistantMessageEventStream {
    const outer = createAssistantMessageEventStream();
    this.#requestedAt.set(outer, (this.#options.clock ?? Date.now)());
    void this.#run(models, model, normalizeContext(context), options, outer);
    return outer;
  }

  async #run(models: Models, model: Model<never>, transcript: ReturnType<typeof normalizeContext>, options: StreamOptions | undefined,
    outer: AssistantMessageEventStream): Promise<void> {
    const registeredSignal = options?.signal;
    const registration = registeredSignal === undefined ? undefined : this.#registrations.get(registeredSignal);
    if (registeredSignal === undefined || registration === undefined) return this.#end(outer, model, "error", "no registration for this request");
    const signal = AbortSignal.any([registeredSignal, this.#closing.signal]);
    try {
      signal.throwIfAborted();
      const phone = await this.#member(registration, signal);
      await this.#options.beforeDispatch?.(phone, signal);
      for (;;) {
        await this.#hold(phone, registration, signal);
        if (this.#options.dispatchError?.(phone)) return this.#end(outer, model, "aborted");
        let request: Prepared;
        try {
          request = await this.#prepare(models, model, { ...options, signal });
        } catch (error) {
          if (signal.aborted) return this.#end(outer, model, "aborted");
          this.setupFailed++;
          return this.#fail(outer, model, error);
        }
        const key = await this.#tries(signal, () => this.#start(registration));
        // ---- serial boundary: no await from the checks below to the provider call ----
        if (this.#options.dispatchError?.(phone)) {
          await this.#withdraw(registration, key);
          return this.#end(outer, model, "aborted");
        }
        if (signal.aborted) {
          this.#end(outer, model, "aborted");
          void this.#withdraw(registration, key);
          return;
        }
        if (this.pendingControls(phone) === 0) {
          this.dispatched++;
          let inner: AssistantMessageEventStream;
          try {
            // Harness owns cancellation once dispatched: closing the door must not settle a recoverable task first.
            inner = request.provider.streamSimple(request.model as never, transcript as never, { ...request.options, signal: registeredSignal } as never);
          } catch (error) {
            // A provider that throws instead of returning a stream: as `api/lazy.js` (the start stays, counted once).
            return this.#fail(outer, model, error);
          }
          this.#pipe(inner, outer, model, { registration, key });
          this.#options.onDispatch?.(registration.conversationId);
          return;
        }
        this.#options.onHold?.(registration.conversationId);
        await this.#withdraw(registration, key);
      }
    } catch (error) {
      if (signal.aborted) return this.#end(outer, model, "aborted");
      this.#report(error);
      return this.#end(outer, model, "error", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Provider and provider options, as `ModelRuntime.streamSimple` / `prepareRequest` and pi-ai `Models.applyAuth` build
   * them (1.0.2, the same in 1.0.3 and 1.0.4; same checks and messages; credentials resolved now, before the final check).
   * From pi-ai 1.0.3 an OAuth refresh that has started runs on its own signal and its result is stored even when the
   * request's signal aborts; `getAuth` still returns at the abort, so the request ends aborted without waiting for it.
   */
  async #prepare(models: Models, model: Model<never>, options: StreamOptions | undefined): Promise<Prepared> {
    if ((model as { api: string }).api === VIRTUAL_MODEL_API) {
      throw new Error(`mixin request door: routed model ${model.provider}/${model.id} is not supported`);
    }
    assertChatModel(model);
    const provider = models.getProvider(model.provider);
    if (provider === undefined) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
    const resolution = await models.getAuth(model as never, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal } as never);
    if (resolution === undefined) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
    const auth = resolution.auth as { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
    let headers = mergeHeaders(auth.headers, options?.headers);
    if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
    const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
    const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
    return {
      provider,
      model: auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      options: { ...providerOptions, apiKey: options?.apiKey ?? auth.apiKey, headers, env },
    };
  }

  async #member(registration: Registration, signal: AbortSignal): Promise<string> {
    const cached = this.#members.get(registration.conversationId);
    if (cached !== undefined) return cached;
    const phone = await this.#tries(signal, async () => {
      const value = await this.#options.memberOf(this.#harness(), registration.conversationId, registration.context);
      if (value === undefined || value === "") throw new Error(`conversation ${registration.conversationId} has no member identity`);
      return value;
    });
    this.#members.set(registration.conversationId, phone);
    return phone;
  }

  /** Wait while the member has a received, unfinished control; the control's abort ends the wait. */
  async #hold(phone: string, registration: Registration, signal: AbortSignal): Promise<void> {
    while (this.pendingControls(phone) > 0) {
      this.#options.onHold?.(registration.conversationId);
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const cleanup = () => { this.#waiters.delete(wake); signal.removeEventListener("abort", abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        this.#waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  /** Commit the start record of this invocation; returns its key. */
  async #start(registration: Registration): Promise<string> {
    const harness = this.#harness();
    const { conversationId, taskId, context } = registration;
    const task = await harness.getTask(taskId as never, context);
    const checkpoint = (task?.state.status === "running" || task?.state.status === "pending" ? task.state.checkpoint : undefined) as
      GenerationCheckpoint | CompactionCheckpoint | undefined;
    const phase = registration.kind === "generation" ? "request" : "summarize";
    if (checkpoint?.phase !== phase || !("model" in checkpoint)) throw new Error(`request door: task ${taskId} is not in phase ${phase}`);
    const clock = this.#options.clock ?? Date.now;
    return this.#write(() => harness.commit(async (tx) => {
      const latest = (await tx.scanEntries({ conversationId: conversationId as never }, 1)).items[0]?.id ?? 0;
      const doc = await tx.doc(AttemptsDoc, conversationId as never);
      let k = 1;
      while (doc.starts[`${taskId}:${checkpoint.attempt}:${k}`] !== undefined) k++;
      const key = `${taskId}:${checkpoint.attempt}:${k}`;
      doc.starts[key] = { taskId, attempt: checkpoint.attempt, k, afterEntry: latest as number, startedAt: clock(),
        provider: checkpoint.model.provider, model: checkpoint.model.modelId, ...(registration.kind === "compaction" ? { kind: "compaction" as const } : {}) };
      return key;
    }, context));
  }

  /** The request was not sent after its start was committed: mark the start withdrawn (best effort, not cancelled by the abort). */
  async #withdraw(registration: Registration, key: string): Promise<void> {
    if (this.#closing.signal.aborted) return;
    try {
      await this.#write(() => this.#harness().commit(async (tx) => {
        const start = (await tx.doc(AttemptsDoc, registration.conversationId as never)).starts[key];
        if (start !== undefined) start.withdrawn = true;
      }, withoutAbortSignal(registration.context)));
      this.withdrawn++;
    } catch (error) {
      this.#report(error);
    }
  }

  /** Record the terminal response before resolving it; errors/aborts carry no confirmed bill. */
  async #usage(registration: Registration, key: string, message: AssistantMessage): Promise<void> {
    // Late responses after shutdown retain their durable start as unconfirmed; never write to a closed Session.
    if (this.#closing.signal.aborted) return;
    try {
      await this.#write(() => this.#harness().commit(async (tx) => {
        const start = (await tx.doc(AttemptsDoc, registration.conversationId as never)).starts[key];
        if (start !== undefined) {
          start.outcome = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "done";
          if (start.outcome === "done") start.usage = copyJson(message.usage, { omitUndefinedProperties: true }) as UsageRecord;
        }
      }, withoutAbortSignal(registration.context)));
    } catch (error) {
      this.#report(error);
    }
  }

  async #tries<T>(signal: AbortSignal, step: () => Promise<T>): Promise<T> {
    const tries = this.#options.startTries ?? 3;
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await step();
      } catch (error) {
        if (signal.aborted || attempt >= tries) throw error;
        this.#report(error);
        await pause(10 * 4 ** (attempt - 1), signal);
      }
    }
  }

  #write<T>(operation: () => Promise<T>): Promise<T> {
    this.#closing.signal.throwIfAborted();
    const work = operation();
    this.#writes.add(work);
    void work.finally(() => this.#writes.delete(work)).catch(() => {});
    return work;
  }

  #pipe(inner: AssistantMessageEventStream, outer: AssistantMessageEventStream, model: Model<never>,
    usageOf?: { registration: Registration; key: string }): void {
    void (async () => {
      try {
        let recorded = false;
        for await (const event of inner) {
          // The terminal event resolves the result. Persist its confirmed usage before forwarding it.
          if (usageOf !== undefined && (event.type === "done" || event.type === "error")) {
            await this.#usage(usageOf.registration, usageOf.key, event.type === "done" ? event.message : event.error);
            recorded = true;
          }
          outer.push(event);
        }
        const message = await inner.result();
        if (usageOf !== undefined && !recorded) await this.#usage(usageOf.registration, usageOf.key, message);
        outer.end(message);
      } catch (error) {
        // The request was handed over: a broken stream is an ordinary provider error, not NOT_SENT (as `api/lazy.js`).
        this.#fail(outer, model, error);
      }
    })();
  }

  /** End like Models' lazy setup failure (`api/lazy.js` createSetupErrorMessage): stop reason "error", the error's message. */
  #fail(outer: AssistantMessageEventStream, model: Model<never>, error: unknown): void {
    const message = this.#message(model, "error", error instanceof Error ? error.message : String(error), this.#requestedAt.get(outer));
    outer.push({ type: "error", reason: "error", error: message });
    outer.end(message);
  }

  #end(outer: AssistantMessageEventStream, model: Model<never>, reason: "error" | "aborted", detail?: string): void {
    if (reason === "error") this.notSent++;
    const message = this.#message(model, reason, reason === "aborted" ? "Request was aborted" : `${NOT_SENT} (${detail})`, this.#requestedAt.get(outer));
    outer.push({ type: "error", reason, error: message } as AssistantMessageEvent);
    outer.end(message);
  }

  #message(model: Model<never>, stopReason: "error" | "aborted", errorMessage: string, requestedAt?: number): AssistantMessage {
    return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(),
      stopReason, errorMessage, timestamp: requestedAt ?? (this.#options.clock ?? Date.now)() };
  }

  #harness(): Harness {
    const harness = this.#holder.harness;
    if (harness === undefined) throw new Error("request door: Harness not set");
    return harness;
  }
}
