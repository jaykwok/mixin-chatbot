import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CONFIG_DIR,
  DATA_DIR,
  MODELS_JSON_PATH,
  MODELS_STORE_PATH,
  PI_AGENT_DIR,
  PI_SETTINGS_PATH,
  RUNTIME_DIR,
  STATE_DIR,
  APP_BOT_CONFIG_PATH,
  STATE_DATABASE_PATH,
} from "../../src/core/storage.ts";

describe("persistent storage layout", () => {
  test("keeps configuration, state, runtime and group data in separate subtrees", () => {
    expect(DATA_DIR).toBe("data");
    expect(CONFIG_DIR).toBe(join("data", "config"));
    expect(STATE_DIR).toBe(join("data", "state"));
    expect(RUNTIME_DIR).toBe(join("data", "runtime"));
    expect(MODELS_JSON_PATH).toBe(join(CONFIG_DIR, "models.json"));
    expect(APP_BOT_CONFIG_PATH).toBe(join(CONFIG_DIR, "app-bot.json"));
    expect(STATE_DATABASE_PATH).toBe(join(STATE_DIR, "agent.sqlite"));
    expect(PI_AGENT_DIR).toBe(join(RUNTIME_DIR, "pi"));
    // Pi 的模型目录缓存是可重建产物，必须留在 runtime 而不是配置目录里。
    expect(MODELS_STORE_PATH).toBe(join(RUNTIME_DIR, "models-store.json"));
    expect(MODELS_STORE_PATH.startsWith(CONFIG_DIR)).toBe(false);
    // 选型沿用 Pi 对 agentDir 的默认布局。
    expect(PI_SETTINGS_PATH).toBe(join(PI_AGENT_DIR, "settings.json"));
  });
});

// The state database holds the address-book copy (phone → platform ID, name); it is as sensitive as the credentials.
test.skipIf(process.platform === "win32")("the state database and its WAL files are owner-only", async () => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { openState } = await import("../../src/core/state.ts");
  const root = await mkdtemp(join(tmpdir(), "state-mode-"));
  const previous = process.umask(0o022);
  try {
    const path = join(root, "state", "agent.sqlite");
    const db = openState(path);
    db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
    db.close();
  } finally { process.umask(previous); await rm(root, { recursive: true, force: true }); }
});
