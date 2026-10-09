// Faux models and Harness options for the Durable storage tests (no network, no real provider).
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry, Harness, type Extension, type HarnessOptions, type HarnessSettings, type ModelRef, type ProgressPolicy, type Storage,
} from "@earendil-works/pi-durable";
import type { DoorOptions, RequestDoor } from "../../src/durable/door.ts";
import { claimGroup } from "../../src/durable/identity.ts";
import { groupDoor } from "../../src/durable/models.ts";
import { enginePolicy } from "../../src/core/engine-policy.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";

/**
 * The progress policy group Harnesses run with unless a test sets its own: the native engine policy, or
 * Durable's defaults when MIXIN_TEST_DURABLE_PROGRESS=default (the regression run on the 100 ms default).
 */
export const PROJECT_PROGRESS: ProgressPolicy = enginePolicy({}).progress;
export const TEST_PROGRESS: ProgressPolicy | undefined = process.env.MIXIN_TEST_DURABLE_PROGRESS === "default" ? undefined : PROJECT_PROGRESS;

export function fauxModels() {
  const faux = fauxProvider({ tokenSize: { min: 50, max: 50 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { faux, models, model: { provider: model.provider, modelId: model.id } satisfies ModelRef };
}

/** A fresh registry per Harness, short retry delays. */
export function harnessOptions(models: Models): () => HarnessOptions {
  return () => ({ models, registry: createRegistry(), settings: { retry: { baseDelayMs: 5, maxAgentDelayMs: 20 } } });
}

export type GroupHarness = {
  path: string;
  harness: Harness;
  door: RequestDoor | undefined;
  /** What the Harness got as `models`: the door's view, or `models` itself without the door. */
  models: Models;
  /** Errors the door absorbed. */
  reports: unknown[];
  close(): Promise<void>;
};

/**
 * A group Harness wired as the service will be (src/durable/models.ts): the door's extension first in the registry, the
 * door's view of `models` as `HarnessOptions.models`, the database claimed for `group`. `door: false` opens without the
 * door (parity controls). `outside` wraps what the Harness calls, outside the door. `extensions` follow the door's.
 * `settings` apply over TEST_PROGRESS.
 */
export async function openGroupHarness(path: string, models: Models, options: {
  settings?: HarnessSettings; door?: false | Omit<DoorOptions, "memberOf">; group?: string; outside?: (models: Models) => Models;
  extensions?: readonly Extension[];
  /** Wraps the group's storage, for example to count commits. */
  storage?: (storage: Storage) => Storage;
} = {}): Promise<GroupHarness> {
  const holder: { harness?: Harness } = {};
  const reports: unknown[] = [];
  const door = options.door === false ? undefined : groupDoor(holder, { onReport: (error) => reports.push(error), ...options.door });
  const registry = createRegistry();
  if (door !== undefined) registry.install(door.extension());
  for (const extension of options.extensions ?? []) registry.install(extension);
  const inner = door === undefined ? models : door.wrap(models);
  const view = options.outside === undefined ? inner : options.outside(inner);
  const storage = await openGroupStorage(path);
  const settings: HarnessSettings = { ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }), ...options.settings };
  const harness = await Harness.open(options.storage?.(storage) ?? storage, { models: view, registry, settings }, context);
  holder.harness = harness;
  await claimGroup(harness, options.group ?? "group-a", context);
  return { path, harness, door, models: view, reports, async close() { await door?.close(); await harness.close(context); } };
}

/** A response that waits for `open()` or the request's abort (a closing Harness aborts it) before answering. */
export function gatedResponse(answer: string): { step: FauxResponseFactory; open(): void; started: Promise<void> } {
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  return {
    open, started,
    step: async (_context, options) => {
      start();
      await new Promise<void>((resolve) => {
        void gate.then(resolve);
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage(answer);
    },
  };
}
