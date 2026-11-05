// 运行参数（data/config/runtime.json）的写入。
// 部署：--prepare-values 在停机前、服务仍在运行时算出部署要安装的完整取值（现有文件加上环境中设置的受支持键；Docker
// 部署的工作目录和任务运行时由部署管理，不取环境值），连同现有文件的摘要写进暂存文件（0600），不改 runtime.json；
// 停机后部署宿主在目标版本中以 --values 安装：维护租约内写入，现有文件已是结果时不重写，既不是停机前读到的也不是结果时拒绝。
// 不带参数（`bun run configure-runtime`）：Windows 本机停机后按当前环境变量保存受支持项。Linux 的 Docker 部署由部署入口
// 写入，这里拒绝。高级运行参数由控制台经运维核心交给 runtime-apply.ts。
//
// 用法：runtime-settings.ts --prepare-values <文件> --deployment docker|windows
//       runtime-settings.ts --values <文件> --json
//       runtime-settings.ts
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  RUNTIME_KEYS, validateRuntimeConfig, type RuntimeConfig, type RuntimeKey,
} from "../../src/core/runtime-schema.ts";
import { DATA_DIR, RUNTIME_CONFIG_PATH } from "../../src/core/storage.ts";
import { publish } from "../lib/atomic-file.ts";
import { readBoundedText } from "../lib/bounded-text.ts";
import { Protocol, UsageError, parseOptions } from "../lib/maintenance-protocol.ts";
import { parseRuntimeValues, runtimeDigest, runtimeText, serializeRuntimeValues, type RuntimeValues } from "./runtime-values.ts";
import { currentFile, readRuntimeSettings } from "./runtime-draft.ts";

/** Keeps the owner of the file it replaces (or of its directory). */
async function writeAtomic(path: string, raw: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const owner = await stat(path).catch(error => { if (error.code === "ENOENT") return stat(dirname(path)); throw error; });
  await publish(path, raw, { owner: { uid: owner.uid, gid: owner.gid } });
}

/** A Docker deployment computes the container's workspace path and owns the task runtime; native runs set them. */
const DOCKER_MANAGED: readonly RuntimeKey[] = ["WORKSPACE_ROOT", "BOT_TASK_IMAGE", "BOT_TASK_CONTROL_ROOT"];
export type RuntimeDeployment = "docker" | "windows";

/** The settings a deployment keeps: the current values, overridden by the supported values set in the environment. */
function deploymentSettings(values: RuntimeConfig, env: NodeJS.ProcessEnv, deployment: RuntimeDeployment): RuntimeConfig {
  const settings = { ...values };
  for (const name of RUNTIME_KEYS) {
    if (deployment === "docker" && DOCKER_MANAGED.includes(name)) continue;
    if (env[name]?.trim()) settings[name] = env[name]!.trim();
  }
  // The default workspace is not a setting: naming it (the Windows deployment does, to return from an external one) drops the key.
  if (settings.WORKSPACE_ROOT && resolve(settings.WORKSPACE_ROOT) === resolve(DATA_DIR, "workspace")) delete settings.WORKSPACE_ROOT;
  return validateRuntimeConfig(settings);
}

/** Persist explicit deployment settings, including supported values inherited from the shell. */
export async function saveRuntimeSettings(path = RUNTIME_CONFIG_PATH, env = process.env): Promise<void> {
  await writeAtomic(path, runtimeText(deploymentSettings((await readRuntimeSettings(path)).values, env, "windows")));
}

/**
 * Before a deployment's stop, while the service still runs (no lease, runtime.json unchanged): the complete runtime.json
 * the deployment installs after the stop, and the digest of the file it was computed from, written 0600 to `file`.
 */
export async function prepareRuntimeValues(file: string, deployment: RuntimeDeployment, path = RUNTIME_CONFIG_PATH, env = process.env): Promise<RuntimeValues> {
  const raw = await currentFile(path);
  let current: RuntimeConfig;
  try { current = validateRuntimeConfig(raw === null ? {} : JSON.parse(raw)); }
  catch (error) { throw new Error(`现有 data/config/runtime.json 无效：${error instanceof SyntaxError ? "不是有效 JSON" : (error as Error).message}`); }
  const value: RuntimeValues = { format: 1, base: runtimeDigest(raw), values: deploymentSettings(current, env, deployment) };
  await publish(file, serializeRuntimeValues(value), { createOnly: true });
  return value;
}

/** After the stop, under the service lease: the prepared runtime.json over the file it was computed from. False when already in place. */
export async function installRuntimeValues(file: string, path = RUNTIME_CONFIG_PATH): Promise<boolean> {
  let raw: string | null = null;
  try { raw = readBoundedText(file, 1024 * 1024); } catch { /* Reported below. */ }
  if (raw === null) throw new Error("运行参数暂存无法读取");
  const values = parseRuntimeValues(raw), text = runtimeText(values.values), current = await currentFile(path);
  if (current === text) return false;
  if (runtimeDigest(current) !== values.base) throw new Error("data/config/runtime.json 在停机前确认之后被改动，没有覆盖");
  await writeAtomic(path, text);
  return true;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--values") {
    // The deployment host's configure-runtime step, in the target release: one result of the maintenance protocol.
    const protocol = new Protocol("json", "values");
    try {
      const parsed = parseOptions("values", argv, { flags: ["--json"], values: ["--values"], required: ["--values"] });
      if (!parsed.flags.has("--json")) throw new UsageError("values 只输出 JSON 结果：请加 --json");
      const { withMaintenance } = await import("../../src/core/maintenance.ts");
      const installed = await withMaintenance(() => installRuntimeValues(resolve(parsed.values.get("--values")![0]!)));
      protocol.emit("success", { result: { installed }, text: installed ? "已写入停机前确定的运行参数" : "停机前确定的运行参数已在位" });
    } catch (error) {
      protocol.fail(error, error instanceof UsageError ? "refused" : "failed", error instanceof UsageError ? "" : "运行参数没有写入：");
    }
  } else if (argv[0] === "--prepare-values") {
    try {
      const parsed = parseOptions("prepare-values", argv, { values: ["--prepare-values", "--deployment"], required: ["--prepare-values", "--deployment"] });
      const deployment = parsed.values.get("--deployment")![0];
      if (deployment !== "docker" && deployment !== "windows") throw new UsageError("--deployment 只能是 docker 或 windows");
      await prepareRuntimeValues(resolve(parsed.values.get("--prepare-values")![0]!), deployment);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else try {
    if (argv.length) throw new Error("不带参数时按当前环境变量保存；高级运行参数请在控制台的「设置」中修改");
    // The native settings: a Docker host's own working directory and task runtime are not the container's.
    if (process.platform !== "win32") throw new Error("Docker 部署的运行参数由部署入口写入，没有保存；高级运行参数请在控制台的「设置」中修改");
    const { withMaintenance } = await import("../../src/core/maintenance.ts");
    const { assertLocalConfigurationWrite } = await import("../../src/core/maintenance-state.ts");
    await withMaintenance(() => { assertLocalConfigurationWrite("."); return saveRuntimeSettings(); });
    console.log("运行配置已保存到 " + RUNTIME_CONFIG_PATH);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
