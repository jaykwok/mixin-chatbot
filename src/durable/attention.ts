import { scopeLabel, type Scope } from "../core/layout.ts";

/**
 * Events since this process started that an operator should look at. `/health` exposes them for the doctor and the TUI
 * overview; the log has the details. Only counts, the time and the space label: no phones, no contents.
 */
export const ATTENTION_KINDS = ["parked", "faulted", "deliveryAbandoned", "notSent", "statsRegressed"] as const;
export type AttentionKind = typeof ATTENTION_KINDS[number];
export interface AttentionEntry { count: number; lastAt: number; space: string }
export type AttentionStatus = Partial<Record<AttentionKind, AttentionEntry>>;

export class Attention {
  readonly #entries = new Map<AttentionKind, AttentionEntry>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  note(kind: AttentionKind, scope: Scope): void {
    const entry = this.#entries.get(kind);
    this.#entries.set(kind, { count: (entry?.count ?? 0) + 1, lastAt: this.#clock(), space: scopeLabel(scope) });
  }

  status(): AttentionStatus {
    return Object.fromEntries([...this.#entries].map(([kind, entry]) => [kind, { ...entry }]));
  }
}
