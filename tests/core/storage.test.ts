import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CONFIG_DIR,
  DATA_DIR,
  DEFAULT_GROUP_DATA_ROOT,
  MODELS_JSON_PATH,
  MODELS_STORE_PATH,
  PI_AGENT_DIR,
  RUNTIME_DIR,
  STATE_DIR,
  WEBHOOK_SECRET_FILE,
} from "../../src/core/storage.ts";

describe("persistent storage layout", () => {
  test("keeps configuration, state, runtime and group data in separate subtrees", () => {
    expect(DATA_DIR).toBe("data");
    expect(CONFIG_DIR).toBe(join("data", "config"));
    expect(STATE_DIR).toBe(join("data", "state"));
    expect(RUNTIME_DIR).toBe(join("data", "runtime"));
    expect(DEFAULT_GROUP_DATA_ROOT).toBe(join("data", "groups"));
    expect(MODELS_JSON_PATH).toBe(join(CONFIG_DIR, "models.json"));
    expect(WEBHOOK_SECRET_FILE).toBe(join(CONFIG_DIR, "webhook-secret"));
    expect(PI_AGENT_DIR).toBe(join(RUNTIME_DIR, "pi"));
    // Pi 的模型目录缓存是可重建产物，必须留在 runtime 而不是配置目录里。
    expect(MODELS_STORE_PATH).toBe(join(RUNTIME_DIR, "models-store.json"));
    expect(MODELS_STORE_PATH.startsWith(CONFIG_DIR)).toBe(false);
  });
});
