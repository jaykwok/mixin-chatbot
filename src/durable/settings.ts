import type { Api, CacheRetention, Model } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_RESTART_LIMIT, type CompactionPolicy, type HarnessSettings } from "@earendil-works/pi-durable";
import { enginePolicy } from "../core/engine-policy.ts";
import { compactionPolicy } from "./compaction.ts";

/** A model's context window by its `provider/modelId` key, when the catalogue knows the model. */
type WindowOf = (key: string) => number | undefined;

/**
 * Durable's settings for the instance's model. Per-model budgets go to Durable as its native `modelOverrides` (each entry
 * applies field by field to the model it names); the background threshold, which Durable does not derive, is computed
 * here from each model's own window (compaction.ts), for the harness-wide policy and for every override whose model the
 * catalogue knows. A configured `backgroundTokens` wins everywhere.
 *
 * Two run semantics are stated rather than left to defaults. A failed run keeps whatever Durable queued behind it
 * (`keep`): the member worker submits one inbox item at a time and answers a failure itself, so nothing is withdrawn
 * or sent on without it. A task cut off by crashes `DEFAULT_RESTART_LIMIT` times in a row without progress is parked
 * (never `Infinity`): /status names it and /stop, /clear or the total deadline end it (service.ts).
 */
export function durableSettings(settings: SettingsManager, model: Model<Api>, cacheRetention?: CacheRetention, windowOf?: WindowOf): HarnessSettings {
  const policy = enginePolicy((settings.getGlobalSettings() as { durable?: unknown }).durable);
  const { modelOverrides, backgroundTokens, ...ordinary } = policy.compaction;
  const background = (budgets: typeof ordinary, window: number) => backgroundTokens ?? compactionPolicy(budgets, window).backgroundTokens;
  const own = `${model.provider}/${model.id}`;
  const overrides: Record<string, Partial<CompactionPolicy>> = Object.create(null);
  for (const [key, budgets] of Object.entries(modelOverrides ?? {})) {
    const window = key === own ? model.contextWindow : windowOf?.(key);
    overrides[key] = { ...budgets, ...(window === undefined ? {} : { backgroundTokens: background({ ...ordinary, ...budgets }, window) }) };
  }
  return { ...policy,
    compaction: { ...ordinary, backgroundTokens: background(ordinary, model.contextWindow), ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {}) },
    // An explicit durable.stream.cacheRetention in settings.json wins over the runtime setting (docs/runtime-tools.md).
    stream: { ...(cacheRetention === undefined ? {} : { cacheRetention }), ...policy.stream },
    followUpMode: "one-at-a-time", steeringMode: "one-at-a-time", afterFailedRun: "keep", restartLimit: DEFAULT_RESTART_LIMIT };
}
