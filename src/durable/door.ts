// Request door: the one place where a generation request reaches the provider.
// Absorbed errors go to `onReport` instead of an ever-growing list.
//
// Serial boundary. A control command (/clear, /stop) is marked in the door's in-memory registry synchronously when it is
// received, before its admission commit; a generation request is handed to the provider only by the door, right after a
// synchronous check of that registry, with no await in between. Both run on the one JS thread of the process that holds
// the lease, so they are totally ordered: a request that passed the check was handed over before the control was
// received and is in flight, and the control's abort cancels it; a request checked after the mark holds and is never
// handed over (the control's abort ends the hold). Every await of the request path (member lookup, the run budget,
// credential resolution, the hold itself) lies before the final check. The registry is loaded from the pending
// admissions at startup, before scheduling, and a control leaves it only after its removal from the stream is committed
// by the service.
//
// Registration ownership. Each admission attempt of a control holds its own ticket from receipt until that attempt is
// resolved, and a control waiting in the admission stream holds one stream registration under its requestId. Every
// release names what it releases and is idempotent: a late reply of one control cannot release another, and a duplicate
// cannot add a second registration for the same control.
//
// Where. Durable calls `models.streamSimple`; Models (coding-agent `ModelRuntime`) awaits credential resolution before it
// calls the provider, so the door does not delegate generation requests to it. It implements `streamSimple` itself on the
// public `Models` interface: `getProvider(id)` and `getAuth(model, ...)` (which also adds the models.json headers), merged
// into the provider options as pi-ai `Models.applyAuth` / `ModelRuntime.prepareRequest` do,
// then, after the final check, `provider.streamSimple` synchronously.
//
// Which member. Durable passes every generation and summarize request the conversation's provider session id
// (`pi.provider`, created in the conversation's creating commit, fresh for a fork) as `options.sessionId`. The door maps
// it to the conversation and member from committed data only: the member directory, the conversation's identity and its
// provider document must agree (`sessions`, src/durable/models.ts). The map is loaded before scheduling (`loadSessions`),
// extended after a member conversation was committed (`bind`), and read again once when a request names an unknown
// session; a session still unknown, or claimed by two conversations, is not sent. Tools find their member the same way,
// by conversation id. Nothing is inferred from the request's content or from which member is active.
//
// Compaction. The summarize request (`models.completeSimple`) carries the same session id and takes the same path, so
// background, overflow and manual compaction hold for a member's pending control like a generation. pi-ai's
// `Models.completeSimple` is `streamSimple(...).result()`, so the door answers it with its own stream's result.
//
// Error semantics. A failure while preparing the provider call (not a chat model, unknown provider, provider not
// configured, credential resolution or header transform failing) ends the stream as Models' lazy setup does
// (`api/lazy.js`): stop reason "error", the error's own message, no retry by the door, so Durable classifies it as it
// would without the door. Routed (virtual) models are refused as a setup failure. A request the door refuses (no or an
// unknown session, the member lookup failing) ends in a NOT_SENT error, which Durable's retry policy retries.
//
// Usage. The door keeps no records: Durable adds each committed response's usage to `pi.usage`, which the statistics
// read (src/agent/stats-ledger.ts).
//
// Not gated: deferred polls, which continue a request that already went through the door; a control aborts them like any
// background work.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, createAssistantMessageEventStream,
  createModels, type AnyModel, type AssistantImages, type ClassifierContext, type ClassifierModel, type ClassifierResult,
  type ImageModel, type ImagesContext, type Model, type Models, normalizeContext, type Provider,
} from "@earendil-works/pi-ai";
import { assertChatModel } from "@earendil-works/pi-ai/utils/model-operations";
import type { Extension, Harness, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error";

/** coding-agent `VIRTUAL_MODEL_API` (core/virtual-models.js; not exported from the package). */
export const VIRTUAL_MODEL_API = "pi-virtual";

/**
 * Error-message prefix of a request the door ended without calling the provider. "internal error" is what pi-ai's
 * `isRetryableAssistantError` matches, so Durable's retry policy retries it.
 */
export const NOT_SENT = "mixin request door: internal error, request not sent";

/** A member conversation's provider session, as committed. */
export type SessionBinding = { readonly sessionId: string; readonly conversationId: number; readonly phone: string };
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
  signal?: AbortSignal; sessionId?: string; apiKey?: string; env?: Record<string, string>; headers?: Record<string, string>;
  transformHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>> | Record<string, string>;
};

export interface DoorOptions {
  /** Verified member sessions of the space; only the given conversation's when `conversationId` is set. */
  sessions(harness: Harness, context: Context, conversationId?: number): Promise<SessionBinding[]>;
  clock?: () => number;
  /** Errors the door absorbed (failed lookups, conflicting sessions, failed stream reads). Must not throw. */
  onReport?: (error: unknown) => void;
  /** A request ended NOT_SENT (as `notSent` counts). Must not throw. */
  onNotSent?: () => void;
  /** Tests: a request of this conversation holds for a pending control. */
  onHold?: (conversationId: number) => void;
  /** Tests: called synchronously right after the provider call returned its stream (the handover). */
  onDispatch?: (conversationId: number) => void;
  /** Service lifecycle budget; recovered tasks wait here until their inbox head can run. */
  beforeDispatch?: (phone: string, signal: AbortSignal) => Promise<void>;
  /** Synchronous lifecycle check immediately before dispatch, including after auth and receipt commits. */
  dispatchError?: (phone: string) => Error | undefined;
  /** Execution boundary, including recovered and nested calls. May clamp arguments or refuse new work. */
  prepareTool?: (name: string, args: unknown, api: ToolExecutionApi, context: Context) => Promise<unknown>;
}

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Wait `ms` unless `signal` aborts; the abort listener goes with the timer, so the long-lived signal keeps none. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** pi-ai `mergeHeaders` (models.js): an override replaces a header of any case. */
function mergeHeaders(base: Record<string, string> | undefined, override: Record<string, string> | undefined) {
  if (!base && !override) return undefined;
  const merged: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    merged[name] = value;
  }
  return merged;
}

/** One per space Harness; created by `spaceDoor` (src/durable/models.ts). */
export class RequestDoor {
  readonly #toolScope = new AsyncLocalStorage<{ api: Pick<ToolExecutionApi, "taskId" | "conversationId">; context: Context; callId: string; signal: AbortSignal }>();
  readonly #requestedAt = new WeakMap<AssistantMessageEventStream, number>();
  readonly #holder: { harness?: Harness };
  readonly #options: DoorOptions;
  readonly #bySession = new Map<string, SessionBinding>();
  readonly #byConversation = new Map<number, SessionBinding>();
  /** Sessions claimed by more than one conversation: never sent. */
  readonly #conflicts = new Set<string>();
  #reloading: Promise<void> | undefined;
  /** Admission attempts of controls, not yet resolved. */
  readonly #tickets = new Set<ControlTicket>();
  /** Controls waiting in the admission stream, by requestId. */
  readonly #waiting = new Map<string, PendingControl>();
  readonly #waiters = new Set<() => void>();
  /** Background resolutions of uncertain admissions; `close()` stops them. */
  readonly #recoveries = new Set<Promise<void>>();
  readonly #closing = new AbortController();
  /** Generation and summarize requests the door handed to a provider. */
  dispatched = 0;
  /** Requests ended NOT_SENT (no or an unknown session, the member lookup failed). */
  notSent = 0;
  /** Requests ended by a setup failure (Models' semantics; nothing sent). */
  setupFailed = 0;

  /** `holder.harness` is set once `Harness.open` returned; the door runs only after scheduling started. */
  constructor(holder: { harness?: Harness }, options: DoorOptions) {
    this.#holder = holder;
    this.#options = options;
  }

  // ---- member sessions ------------------------------------------------------------------------------------------------

  /** Startup before scheduling: every member session of the space, so a recovered summarize request finds its member. */
  async loadSessions(context: Context): Promise<void> {
    const found = await this.#options.sessions(this.#harness(), context);
    this.#bySession.clear();
    this.#byConversation.clear();
    this.#conflicts.clear();
    for (const binding of found) this.#add(binding);
  }

  /** After a member conversation's creating (or verifying) commit returned: its session may be sent from now on. */
  async bind(conversationId: number, context: Context): Promise<void> {
    if (this.#byConversation.has(conversationId)) return;
    const [binding] = await this.#options.sessions(this.#harness(), context, conversationId);
    if (binding === undefined) throw new Error(`request door: conversation ${conversationId} has no verified member session`);
    this.#add(binding);
    if (this.#conflicts.has(binding.sessionId)) throw new Error(`request door: session of conversation ${conversationId} is claimed twice`);
  }

  #add(binding: SessionBinding): void {
    const other = this.#bySession.get(binding.sessionId);
    if (this.#conflicts.has(binding.sessionId) || (other !== undefined && other.conversationId !== binding.conversationId)) {
      this.#conflicts.add(binding.sessionId);
      this.#bySession.delete(binding.sessionId);
      if (other !== undefined) this.#byConversation.delete(other.conversationId);
      this.#report(new Error(`request door: provider session of conversations ${other?.conversationId ?? "?"} and ${binding.conversationId} is the same; not sent`));
      return;
    }
    this.#bySession.set(binding.sessionId, binding);
    this.#byConversation.set(binding.conversationId, binding);
  }

  /** The member of a request's session: known, or after one reload of the space's sessions; otherwise refused. */
  async #session(sessionId: string, signal: AbortSignal): Promise<SessionBinding> {
    let binding = this.#bySession.get(sessionId);
    if (binding === undefined && !this.#conflicts.has(sessionId)) {
      this.#reloading ??= this.loadSessions(BACKGROUND_CONTEXT).finally(() => { this.#reloading = undefined; });
      await this.#reloading;
      signal.throwIfAborted();
      binding = this.#bySession.get(sessionId);
    }
    if (binding === undefined) throw new Error("no verified member for this provider session");
    return binding;
  }

  /** The member of a tool's conversation: known, or bound now from committed data; otherwise refused. */
  async #member(conversationId: number, context: Context, signal: AbortSignal): Promise<string> {
    let binding = this.#byConversation.get(conversationId);
    if (binding === undefined) {
      await this.bind(conversationId, context);
      signal.throwIfAborted();
      binding = this.#byConversation.get(conversationId);
    }
    if (binding === undefined) throw new Error(`conversation ${conversationId} has no member identity`);
    return binding.phone;
  }

  // ---- controls (registered by the service on admission) -------------------------------------------------------------

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

  /** Startup before scheduling. Preserve receipts registered while the space was asynchronously opening. */
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

  /** ToolTask calls execute for both first execution and safe replay; beforeTool is skipped on replay. */
  wrapTools(extension: Extension): Extension {
    const wrap = (tool: ToolRegistration): ToolRegistration => ({
      ...tool,
      execute: async (args, api, context) => {
        if (!context.abortSignal) throw new Error("tool execution requires a Durable invocation signal");
        const signal = AbortSignal.any([context.abortSignal, this.#closing.signal]);
        const phone = await this.#member(api.conversationId as number, context, signal);
        await this.#options.beforeDispatch?.(phone, signal);
        signal.throwIfAborted();
        const blocked = this.#options.dispatchError?.(phone);
        if (blocked) throw blocked;
        const prepared = this.#options.prepareTool ? await this.#options.prepareTool(tool.name, args, api, context) : args;
        signal.throwIfAborted();
        return tool.execute(prepared, api, context);
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
    const conversationId = api.conversationId as number;
    const phone = await this.#member(conversationId, context, signal);
    await this.#options.beforeDispatch?.(phone, signal);
    for (;;) {
      await this.#hold(phone, conversationId, signal);
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
      ...(provider.classify ? { classify: ((selected, transcript, options) => this.#auxiliary(options?.signal,
        () => provider.classify!(selected, transcript, { ...options, maxRetries: 0 }))) as Provider["classify"] } : {}),
      ...(provider.generateImages ? { generateImages: ((selected, transcript, options) => this.#auxiliary(options?.signal,
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

  /** Classifier and image requests: their usage is returned on the tool's result, which Durable adds to `pi.usage`. */
  async #auxiliary<T>(requestSignal: AbortSignal | undefined, dispatch: () => Promise<T>): Promise<T> {
    const scope = this.#toolScope.getStore();
    if (!scope || !requestSignal) throw new Error("auxiliary request has no invocation");
    const conversationId = scope.api.conversationId as number;
    const phone = await this.#member(conversationId, scope.context, requestSignal);
    await this.#options.beforeDispatch?.(phone, requestSignal);
    for (;;) {
      await this.#hold(phone, conversationId, requestSignal);
      // Serial boundary: the provider receives the request immediately after this final synchronous check.
      requestSignal.throwIfAborted();
      const blocked = this.#options.dispatchError?.(phone);
      if (blocked) throw blocked;
      if (this.pendingControls(phone) > 0) continue;
      this.dispatched++;
      const work = dispatch();
      this.#options.onDispatch?.(conversationId);
      return await work;
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
    const requestSignal = options?.signal;
    const sessionId = options?.sessionId;
    if (requestSignal === undefined || typeof sessionId !== "string" || sessionId === "") {
      return this.#end(outer, model, "error", "the request carries no provider session");
    }
    const signal = AbortSignal.any([requestSignal, this.#closing.signal]);
    try {
      signal.throwIfAborted();
      const { phone, conversationId } = await this.#session(sessionId, signal);
      await this.#options.beforeDispatch?.(phone, signal);
      for (;;) {
        await this.#hold(phone, conversationId, signal);
        if (this.#options.dispatchError?.(phone)) return this.#end(outer, model, "aborted");
        let request: Prepared;
        try {
          request = await this.#prepare(models, model, { ...options, signal });
        } catch (error) {
          if (signal.aborted) return this.#end(outer, model, "aborted");
          this.setupFailed++;
          return this.#fail(outer, model, error);
        }
        // ---- serial boundary: no await from the checks below to the provider call ----
        if (this.#options.dispatchError?.(phone) || signal.aborted) return this.#end(outer, model, "aborted");
        if (this.pendingControls(phone) === 0) {
          this.dispatched++;
          let inner: AssistantMessageEventStream;
          try {
            // Harness owns cancellation once dispatched: closing the door must not settle a recoverable task first.
            inner = request.provider.streamSimple(request.model as never, transcript as never, { ...request.options, signal: requestSignal } as never);
          } catch (error) {
            // A provider that throws instead of returning a stream: as `api/lazy.js`.
            return this.#fail(outer, model, error);
          }
          this.#pipe(inner, outer, model);
          this.#options.onDispatch?.(conversationId);
          return;
        }
        this.#options.onHold?.(conversationId);
      }
    } catch (error) {
      if (signal.aborted) return this.#end(outer, model, "aborted");
      this.#report(error);
      return this.#end(outer, model, "error", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Provider and provider options, as `ModelRuntime.streamSimple` / `prepareRequest` and pi-ai `Models.applyAuth` build
   * them (same checks and messages; credentials resolved now, before the final check).
   * An OAuth refresh that has started runs on its own signal and its result is stored even when the
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

  /** Wait while the member has a received, unfinished control; the control's abort ends the wait. */
  async #hold(phone: string, conversationId: number, signal: AbortSignal): Promise<void> {
    while (this.pendingControls(phone) > 0) {
      this.#options.onHold?.(conversationId);
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

  #pipe(inner: AssistantMessageEventStream, outer: AssistantMessageEventStream, model: Model<never>): void {
    void (async () => {
      try {
        for await (const event of inner) outer.push(event);
        outer.end(await inner.result());
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
    if (reason === "error") { this.notSent++; this.#options.onNotSent?.(); }
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
