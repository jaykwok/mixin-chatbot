import { createHash } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { redactSecrets } from "./failure.ts";

type EventType = AssistantMessageEvent["type"] | "message_start" | "message_end";
type Metadata = Pick<AssistantMessage, "responseId" | "stopReason" | "rawStopReason">;
const metadataText = (value: string | undefined) => value === undefined ? null : redactSecrets(value).slice(0, 160);
const TOOL_SAMPLE_INTERVAL_MS = 1000;
const MAX_LOGGED_TOOLS = 8;
type ToolProgress = {
  block: ToolCall; dirty: boolean; fingerprint?: string;
  chars: number; changes: number; changedAt?: number;
};

/** Raw counters plus sampled parsed arguments; never serialize the full message or retain raw deltas. */
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
  private tools = new Map<number, ToolProgress>();
  private toolsSampledAt = -Infinity;
  private parsedToolArgsChars = 0;
  private toolArgsChanges = 0;
  private toolArgsChangedAt?: number;
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
    this.tools.clear();
    this.toolsSampledAt = -Infinity;
    this.parsedToolArgsChars = this.toolArgsChanges = 0;
    this.toolArgsChangedAt = undefined;
    this.metadata = undefined;
  }

  start(message: AssistantMessage): void {
    this.record("message_start", message);
  }

  /** Raw tool deltas are diagnostic only; progress requires a change in parsed arguments. */
  update(event: AssistantMessageEvent): boolean {
    if (event.type === "done" || event.type === "error") {
      const message = event.type === "done" ? event.message : event.error;
      this.record(event.type, message);
      this.observeFinalTools(message);
      this.pause();
      return false;
    }
    this.record(event.type, event.partial);
    if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
      const block = event.type === "toolcall_end" ? event.toolCall : event.partial.content[event.contentIndex];
      if (block?.type === "toolCall") this.observeTool(event.contentIndex, block);
    }
    if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") return false;
    const chars = event.delta.length;
    const effective = event.delta.replace(/\s/gu, "").length;
    if (!chars) this.emptyDeltas++;
    else if (!effective) this.whitespaceDeltas++;
    if (event.type === "text_delta") this.textChars += chars;
    if (event.type === "thinking_delta") this.thinkingChars += chars;
    if (event.type === "toolcall_delta") this.toolArgsChars += chars;
    this.effectiveChars += effective;
    if (event.type === "toolcall_delta") return this.sampleToolArguments();
    if (effective && this.active) this.updated = this.now();
    return this.active && effective > 0;
  }

  /** At most once per second, except at an idle deadline or response boundary. */
  sampleToolArguments(force = false): boolean {
    if (!this.active) return false;
    const now = this.now();
    if (!force && now - this.toolsSampledAt < TOOL_SAMPLE_INTERVAL_MS) return false;
    this.toolsSampledAt = now;
    let advanced = false;
    for (const tool of this.tools.values()) {
      if (!tool.dirty) continue;
      tool.dirty = false;
      // SDK blocks and arguments may be mutated in place or replaced between deltas.
      // Only a fingerprint is retained; never log arguments or serialization errors.
      let serialized: string | undefined;
      try { serialized = JSON.stringify(tool.block.arguments); } catch { continue; }
      if (serialized === undefined) continue;
      const fingerprint = createHash("sha256").update(serialized).digest("hex");
      this.parsedToolArgsChars += serialized.length - tool.chars;
      tool.chars = serialized.length;
      if (fingerprint === tool.fingerprint) continue;
      const changed = tool.fingerprint !== undefined || serialized !== "{}";
      tool.fingerprint = fingerprint;
      // An empty initial object, tool name or call ID does not renew the idle budget.
      if (!changed) continue;
      tool.changes++;
      tool.changedAt = now;
      this.toolArgsChanges++;
      this.toolArgsChangedAt = this.updated = now;
      advanced = true;
    }
    return advanced;
  }

  finish(message: AssistantMessage): void {
    this.record("message_end", message);
    this.observeFinalTools(message);
    this.pause();
  }

  pause(): void {
    if (this.active) {
      this.sampleToolArguments(true);
      this.paused = this.now();
    }
    this.active = false;
  }

  isIdle(timeoutMs: number): boolean {
    return this.active && this.now() - this.updated >= timeoutMs;
  }

  isExpired(timeoutMs: number): boolean {
    return this.active && this.now() - this.started >= timeoutMs;
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
      parsedToolArgsChars: this.parsedToolArgsChars, toolArgsChanges: this.toolArgsChanges,
      toolArgsLastChangeSecondsAgo: this.toolArgsChangedAt === undefined ? null : Math.floor((now - this.toolArgsChangedAt) / 1000),
      toolCalls: this.tools.size,
      tools: Array.from(this.tools).slice(0, MAX_LOGGED_TOOLS).map(([contentIndex, tool]) => ({
        contentIndex,
        name: /^[A-Za-z0-9_-]{1,64}$/.test(tool.block.name) ? metadataText(tool.block.name) : "<invalid>",
        parsedArgsChars: tool.chars, changes: tool.changes,
        lastChangeSecondsAgo: tool.changedAt === undefined ? null : Math.floor((now - tool.changedAt) / 1000),
      })),
      responseId: metadataText(this.metadata?.responseId),
      stopReason: metadataText(this.metadata?.stopReason), rawStopReason: metadataText(this.metadata?.rawStopReason),
    };
  }

  private observeTool(index: number, block: ToolCall): void {
    if (!this.active) return;
    const tool = this.tools.get(index);
    if (tool) { tool.block = block; tool.dirty = true; }
    else this.tools.set(index, { block, dirty: true, chars: 0, changes: 0 });
  }

  private observeFinalTools(message: AssistantMessage): void {
    if (!this.active) return;
    message.content.forEach((block, index) => {
      if (block.type === "toolCall") this.observeTool(index, block);
    });
  }

  private record(type: EventType, metadata: Metadata): void {
    this.events[type] = (this.events[type] ?? 0) + 1;
    this.lastEvent = type;
    this.lastEventAt = this.now();
    this.metadata = metadata;
  }
}
