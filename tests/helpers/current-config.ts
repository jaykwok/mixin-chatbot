import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function writeCurrentConfig(project: string) {
  await mkdir(join(project, "data/config"), { recursive: true });
  await mkdir(join(project, "data/runtime/pi"), { recursive: true });
  await writeFile(join(project, "data/config/models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-only", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  await writeFile(join(project, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test" }));
}
