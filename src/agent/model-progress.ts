import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { redactSecrets } from "./failure.ts";

type EventType = AssistantMessageEvent["type"] | "message_start" | "message_end";
type Metadata = Pick<AssistantMessage, "responseId" | "stopReason" | "rawStopReason">;
const metadataText = (value: string | undefined) => value === undefined ? null : redactSecrets(value).slice(0, 160);

/** Per-response counters. Only inspect each delta, never serialize the growing partial message. */
export class ModelProgress {
  private response = 0;
  private active = false;
  private started = 0;
  private updated = 0;
  private paused?: number;
  private lastEventAt?: number;
  private lastEvent?: EventType;
  private events: Partial<Record<EventType, number>> = {};
  private emptyDeltas = 0;
  private whitespaceDeltas = 0;
  private textChars = 0;
  private thinkingChars = 0;
  private toolArgsChars = 0;
  private effectiveChars = 0;
  // SDK partials are mutable: finish_reason/responseId can arrive without another delta.
  private metadata?: Metadata;

  constructor(private readonly now: () => number = () => performance.now()) {}

  begin(): void {
    this.response++;
    this.active = true;
    this.started = this.updated = this.now();
    this.paused = this.lastEventAt = this.lastEvent = undefined;
    this.events = {};
    this.emptyDeltas = this.whitespaceDeltas = 0;
    this.textChars = this.thinkingChars = this.toolArgsChars = this.effectiveChars = 0;
    this.metadata = undefined;
  }

  start(message: AssistantMessage): void {
    this.record("message_start", message);
  }

  /** True only when text, thinking or tool arguments gain non-whitespace UTF-16 characters. */
  update(event: AssistantMessageEvent): boolean {
    if (event.type === "done" || event.type === "error") {
      this.record(event.type, event.type === "done" ? event.message : event.error);
      this.pause();
      return false;
    }
    this.record(event.type, event.partial);
    if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") return false;
    const chars = event.delta.length;
    const effective = event.delta.replace(/\s/gu, "").length;
    if (!chars) this.emptyDeltas++;
    else if (!effective) this.whitespaceDeltas++;
    if (event.type === "text_delta") this.textChars += chars;
    if (event.type === "thinking_delta") this.thinkingChars += chars;
    if (event.type === "toolcall_delta") this.toolArgsChars += chars;
    this.effectiveChars += effective;
    if (effective && this.active) this.updated = this.now();
    return effective > 0;
  }

  finish(message: AssistantMessage): void {
    this.record("message_end", message);
    this.pause();
  }

  pause(): void {
    if (this.active) this.paused = this.now();
    this.active = false;
  }

  isIdle(timeoutMs: number): boolean {
    return this.active && this.now() - this.updated >= timeoutMs;
  }

  snapshot() {
    if (!this.response) return undefined;
    const now = this.paused ?? this.now();
    return {
      response: this.response, active: this.active,
      elapsedSeconds: Math.floor((now - this.started) / 1000),
      idleSeconds: Math.floor((now - this.updated) / 1000),
      lastEventSecondsAgo: this.lastEventAt === undefined ? null : Math.max(0, Math.floor((now - this.lastEventAt) / 1000)),
      lastEvent: this.lastEvent ?? null, events: { ...this.events },
      emptyDeltas: this.emptyDeltas, whitespaceDeltas: this.whitespaceDeltas,
      textChars: this.textChars, thinkingChars: this.thinkingChars, toolArgsChars: this.toolArgsChars,
      effectiveChars: this.effectiveChars,
      responseId: metadataText(this.metadata?.responseId),
      stopReason: metadataText(this.metadata?.stopReason), rawStopReason: metadataText(this.metadata?.rawStopReason),
    };
  }

  private record(type: EventType, metadata: Metadata): void {
    this.events[type] = (this.events[type] ?? 0) + 1;
    this.lastEvent = type;
    this.lastEventAt = this.now();
    this.metadata = metadata;
  }
}
