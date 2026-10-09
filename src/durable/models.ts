// Model access for the Durable engine (D2-1). One ModelRuntime and model selection per process, as today
// (src/core/model-config.ts: models.json, read-only model catalogue, in-memory credentials, no catalogue network); one
// request door per group Harness, since controls hold the requests of members of one group.
//
// The door wraps the runtime as `HarnessOptions.models`, and its extension must come first in the group's registry (it
// registers each generation request before Durable asks for the stream). Credentials stay the runtime's: the door asks
// `getAuth` for each request, so models.json keys, environment and command references and headers behave as without it.
// A routed (virtual) model is refused here at startup, and again by the door for any request that names one.
import type { Context } from "@earendil-works/chord";
import type { Api, CacheRetention, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Harness, HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import { openModelRuntime, openSettings, resolveModelSelection } from "../core/model-config.ts";
import { RequestDoor, VIRTUAL_MODEL_API, type DoorOptions } from "./door.ts";
import { IdentityDoc } from "./identity.ts";
import { durableSettings } from "./settings.ts";

export interface ModelSelection {
  runtime: ModelRuntime;
  settings: SettingsManager;
  model: Model<Api>;
  /** What every member conversation's agent is configured with. */
  ref: ModelRef;
  thinkingLevel: ModelThinkingLevel;
  harnessSettings: HarnessSettings;
  /** Configured values the Durable engine does not honour, for the startup log. */
  notices: string[];
}

export interface ModelSelectionOptions {
  signal?: AbortSignal;
  modelsPath?: string;
  modelsStorePath?: string;
  settingsPath?: string;
  cacheRetention?: CacheRetention;
}

/**
 * The instance's one model, validated before any work is accepted: configured, known, with credentials (as today), and
 * not a routed model, which the request door cannot send. The service entry (src/server/app.ts) opens it at startup.
 */
export async function openModelSelection(options: ModelSelectionOptions = {}): Promise<ModelSelection> {
  const runtime = await openModelRuntime({ signal: options.signal, modelsPath: options.modelsPath, modelsStorePath: options.modelsStorePath });
  return selectModel(runtime, openSettings(options.settingsPath), options);
}

/**
 * `openModelSelection` on a given runtime and settings view. Routed models come only from extensions registered on the
 * runtime (the service registers none), so this is where tests can offer one.
 * @internal Exported for tests only; knip --production skips `@internal`.
 */
export async function selectModel(runtime: ModelRuntime, settings: SettingsManager,
  options: { signal?: AbortSignal; cacheRetention?: CacheRetention } = {}): Promise<ModelSelection> {
  const { model, thinkingLevel } = await resolveModelSelection(runtime, settings, { signal: options.signal });
  if (model.api === VIRTUAL_MODEL_API) {
    throw new Error(`${model.provider}/${model.id} 是路由（虚拟）模型，Durable 运行时不支持，请运行 bun run configure 选择具体模型`);
  }
  const { settings: harnessSettings, notices } = durableSettings(settings, model, options.cacheRetention);
  return { runtime, settings, model, ref: { provider: model.provider, modelId: model.id }, thinkingLevel, harnessSettings, notices };
}

/** The member a conversation belongs to, from its identity document (src/durable/identity.ts). */
async function memberOf(harness: Harness, conversationId: number, context: Context): Promise<string | undefined> {
  return (await harness.snapshot(IdentityDoc, conversationId as never, context))?.phone;
}

/**
 * A group's request door. Set `holder.harness` once `Harness.open` returned; install `door.extension()` first in the
 * group's registry and pass `door.wrap(selection.runtime)` as `HarnessOptions.models`.
 */
export function groupDoor(holder: { harness?: Harness }, options: Omit<DoorOptions, "memberOf"> = {}): RequestDoor {
  return new RequestDoor(holder, { ...options, memberOf });
}
