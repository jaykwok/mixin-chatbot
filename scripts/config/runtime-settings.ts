import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUNTIME_KEYS, validateRuntimeConfig } from "../../src/core/runtime-config.ts";
import { RUNTIME_CONFIG_PATH } from "../../src/core/storage.ts";
import { archiveFile, withMaintenance } from "../../src/core/maintenance.ts";

/** Persist explicit deployment settings, including supported values inherited from the shell. */
export async function saveRuntimeSettings(path = RUNTIME_CONFIG_PATH, env = process.env): Promise<void> {
  let old: unknown = {};
  try { old = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const settings = validateRuntimeConfig(old);
  for (const name of RUNTIME_KEYS) if (env[name]?.trim()) settings[name] = env[name]!.trim();
  const validated = validateRuntimeConfig(settings);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.runtime-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally { await archiveFile(temporary); }
}

if (import.meta.main) {
  try { await withMaintenance(() => saveRuntimeSettings()); console.log("运行配置已保存到 " + RUNTIME_CONFIG_PATH); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
