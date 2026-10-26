// Executed in a fresh process with cwd = a synthetic project (tests/server/application-binding.test.ts): the real service
// entry point src/server/app.ts against a local fake platform that accepts the credentials in data/config/app-bot.json.
// The model is a faux provider and the relay is off. Prints SERVICE_READY once the instance file exists and the stream
// is connected. PLATFORM_REQUESTS=<n> is the number of requests the fake platform received (token, directory, stream,
// sends): printed before SERVICE_READY, and at exit.
import { existsSync, readFileSync } from "node:fs";
import { mock } from "bun:test";
import { fauxModels } from "./durable.ts";
import { FakePlatform } from "./fake-platform.ts";

const platform = new FakePlatform({ config: JSON.parse(readFileSync("data/config/app-bot.json", "utf8")) });
platform.directory = { children: { "1": [] }, members: { "1": [] }, ids: {} };
process.on("exit", () => console.log(`PLATFORM_REQUESTS=${platform.requests.length}`));
const platformConfig = await import("../../src/integrations/open-platform/config.ts");
mock.module("../../src/integrations/open-platform/config.ts", () => ({ ...platformConfig, platformEndpoints: () => platform.endpoints }));
const { models, model } = fauxModels();
const durableModels = await import("../../src/durable/models.ts");
mock.module("../../src/durable/models.ts", () => ({ ...durableModels,
  openModelSelection: async () => ({
    runtime: models, settings: undefined, model: models.getModel(model.provider, model.modelId)!, ref: model, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 0, baseDelayMs: 5, maxAgentDelayMs: 20 } },
  }),
}));
const relay = await import("../../src/integrations/relay.ts");
mock.module("../../src/integrations/relay.ts", () => ({ ...relay, getRelayConfig: () => null }));

await import("../../src/server/app.ts");
for (const end = Date.now() + 30_000; !existsSync("data/state/instance.json") || platform.sockets.size === 0;) {
  if (Date.now() > end) { console.log("SERVICE_NOT_READY"); process.exit(3); }
  await Bun.sleep(20);
}
// The test kills the process once ready, which on Windows runs no exit handler: report the count now.
console.log(`PLATFORM_REQUESTS=${platform.requests.length}`);
console.log("SERVICE_READY");
