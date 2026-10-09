export interface Decisions { acceptNativeCache?: boolean; provider?: string; model?: string }
/** scratch: preview staging outside the project, so a read-only data mount can be previewed. */
export interface Context { project: string; groups: string; decisions: Decisions; scratch?: string; signal?: AbortSignal; report?: (stage: string, detail: string) => void }
export interface PreviewContext {
  project: string;
  decisions: Decisions;
  /** Read-only capability: no live group-root path or write operations. */
  groups: { read(path: string): Promise<Buffer | null>; directories(path: string): Promise<string[]> };
}
export interface Decision { key: "acceptNativeCache" | "model"; message: string }
export interface Preview {
  files: { root: "project" | "groups"; path: string }[];
  decisions: Decision[];
  steps: string[];
  /** Project configuration projections only; the executor never calls apply during preview. */
  configuration?: Record<string, unknown>;
}
export interface Migration {
  to: number;
  preview(context: PreviewContext): Promise<Preview>;
  apply(context: Context): Promise<void>;
  validate(context: Context): Promise<void>;
}
