import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applicationBinding } from "../../src/core/data-version.ts";
/** The application binding of the configuration writeCurrentConfig writes, for deployment records of fixtures. */
export const CURRENT_APPLICATION = applicationBinding({ environment: "production", appId: "test-app" });
export async function writeCurrentConfig(project: string) {
  await mkdir(join(project, "data/config"), { recursive: true });
  await mkdir(join(project, "data/runtime/pi"), { recursive: true });
  await writeFile(join(project, "data/config/app-bot.json"), JSON.stringify({ environment: "production", appId: "test-app", appSecret: "test-only-secret" }));
  await writeFile(join(project, "data/config/models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-only", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  await writeFile(join(project, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test" }));
}
