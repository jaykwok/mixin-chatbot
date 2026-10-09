import type { Api, CacheRetention, Model } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { enginePolicy } from "../core/engine-policy.ts";
import { compactionPolicy } from "./compaction.ts";

export function durableSettings(settings: SettingsManager, model: Model<Api>, cacheRetention?: CacheRetention): { settings: HarnessSettings; notices: string[] } {
  const policy = enginePolicy((settings.getGlobalSettings() as { durable?: unknown }).durable);
  const { modelOverrides, backgroundTokens, ...ordinary } = policy.compaction;
  const override = modelOverrides?.[`${model.provider}/${model.id}`];
  const compaction = compactionPolicy({ ...ordinary, ...override }, model.contextWindow);
  return {
    settings: { ...policy, compaction: { ...compaction, ...(backgroundTokens === undefined ? {} : { backgroundTokens }) },
      stream: { ...policy.stream, ...(cacheRetention === undefined ? {} : { cacheRetention }) },
      followUpMode: "one-at-a-time", steeringMode: "one-at-a-time" },
    notices: [],
  };
}
