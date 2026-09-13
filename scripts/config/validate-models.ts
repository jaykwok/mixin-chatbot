import { readFileSync } from "node:fs";
import { validateModelConfig } from "../../src/core/model-config.ts";

try {
  validateModelConfig(JSON.parse(readFileSync(process.argv[2] ?? "data/config/models.json", "utf8")));
} catch (error) {
  // Errors are field-level descriptions, never the configuration or provider credentials.
  console.error(error instanceof SyntaxError ? "models.json 不是有效 JSON" : error instanceof Error ? error.message : "模型配置校验失败");
  process.exitCode = 1;
}
