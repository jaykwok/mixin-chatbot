// Run Pi in a separate process: credential commands inherit this cwd/HOME, never the caller's config or command cache.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { executeProcess } from "../lib/process.ts";

/** The supervisor also bounds synchronous credential commands and reaps their descendants. */
const timeoutMs = 30_000;
export async function checkResetModels(project: string, env = process.env): Promise<string> {
  const result = await executeProcess({ command: process.execPath,
    args: [fileURLToPath(import.meta.url)], cwd: resolve(project), env, timeoutMs, maxOutputBytes: 64 * 1024 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "模型凭证检查失败");
  const model: unknown = JSON.parse(result.stdout);
  if (typeof model !== "string" || !model) throw new Error("模型凭证检查未返回选中的模型");
  return model;
}

if (import.meta.main) {
  try {
    const { openModelRuntime, openSettings, resolveModelSelection } = await import("../../src/core/model-config.ts");
    const runtime = await openModelRuntime();
    const { model } = await resolveModelSelection(runtime, openSettings());
    const auth = await runtime.getAuth(model, { signal: AbortSignal.timeout(timeoutMs) });
    if (!auth) throw new Error(`provider ${model.provider} 没有可用凭证`);
    console.log(JSON.stringify(`${model.provider}/${model.id}`));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
