import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRuntimeConfig } from "../../src/core/runtime-config.ts";
import { saveRuntimeSettings } from "../../scripts/config/runtime-settings.ts";
import { tempFixture } from "../helpers/temp.ts";

test("runtime settings retain previous values and validate explicit overrides", async () => {
  const fixture = await tempFixture("runtime-settings-");
  const path = join(fixture.root, "runtime.json");
  try {
    await writeFile(path, JSON.stringify({ BOT_BASH_TIMEOUT: 123, BOT_INDEX_MAX_DEPTH: 4 }));
    await saveRuntimeSettings(path, { BOT_BASH_TIMEOUT: "456", BOT_DEBUG: "1", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "240", API_KEY: "must-not-copy" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ BOT_BASH_TIMEOUT: "456", BOT_INDEX_MAX_DEPTH: "4", BOT_DEBUG: "1", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "240" });
    await saveRuntimeSettings(path, { BOT_DEBUG: "0" });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("BOT_MODEL_IDLE_TIMEOUT_SECONDS", "240");
    for (const value of [{ BOT_DEBUG: "yes" }, { BOT_SHUTDOWN_TIMEOUT_SECONDS: 999 }, { BOT_HOST: "https://host" }, { UNUSED: "1" },
      ...[0, 9, 7201, 10.5, "abc"].map(value => ({ BOT_MODEL_IDLE_TIMEOUT_SECONDS: value }))]) {
      expect(() => validateRuntimeConfig(value)).toThrow();
    }
    for (const value of [10, 180, 7200]) expect(validateRuntimeConfig({ BOT_MODEL_IDLE_TIMEOUT_SECONDS: value })).toHaveProperty("BOT_MODEL_IDLE_TIMEOUT_SECONDS", String(value));
    await expect(saveRuntimeSettings(path, { BOT_INDEX_MAX_DEPTH: "0" })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("BOT_INDEX_MAX_DEPTH", "4");
  } finally { await fixture.cleanup(); }
});
