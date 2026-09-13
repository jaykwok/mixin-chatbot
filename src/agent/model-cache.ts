import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type CachePolicy = "auto" | "short" | "long" | "none";

/** Default is Pi's own behavior. Only explicit administrator overrides cross this boundary. */
export function configureModelCache(runtime: ModelRuntime, policy: CachePolicy): void {
  if (policy === "auto") return;
  const original = runtime.streamSimple;
  runtime.streamSimple = function(model, context, options) {
    return original.call(this, model, context, { ...options,
      cacheRetention: options?.cacheRetention ?? policy });
  };
}
