// Everything a deployment's entry decided before the stop, in the private stage directory it hands to the core: the
// choices, the runtime settings, the plans and the staged configuration, plus the platform's own records. The core reads
// it once, under deploy.lock and before the stop; the snapshot keeps what a resume needs. Built-ins and npm-free modules
// only: the host runs this without node_modules.
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseConfigurationStage, stageName, STAGED_KINDS, type ConfigurationStage, type StagedKind } from "../config/configuration-stage.ts";
import { parseRuntimeValues, RUNTIME_VALUES_FILE, type RuntimeValues } from "../config/runtime-values.ts";
import { readText } from "./host-files.ts";
import { MaintenanceRefused } from "./maintenance.ts";

export const DEPLOY_CHOICES_FILE = "deployment.json";
/** Records the platform session parses itself (Docker: candidate image, service identity, task daemon, original container; Windows: the tools the launcher runs). */
export const PLATFORM_STAGE_FILES = ["candidate-image", "service-user", "task-runtime", "facts", "windows-tools"] as const;
export type PlatformStageFile = typeof PLATFORM_STAGE_FILES[number];
export interface DeployChoices {
  format: 1;
  /** HEAD when the entry staged; empty without a Git checkout (an unpacked release). */
  target: string;
  port: number;
  /** Shared-files root on the host; empty for the default data/workspace. */
  workspace: string;
}
export interface DeployStage {
  choices: DeployChoices;
  runtime: { text: string; value: RuntimeValues };
  /** Absent when there was no model configuration before the stop: prepare-data previews after installing it. */
  plan: string | null;
  directoryPlan: string | null;
  configuration: Partial<Record<StagedKind, { text: string; stage: ConfigurationStage }>>;
  platform: Partial<Record<PlatformStageFile, string>>;
}
export const STAGE_UNCHANGED = "；服务尚未停止，未做任何改动";

function parseChoices(text: string): DeployChoices {
  let value: DeployChoices;
  try { value = JSON.parse(text); } catch { throw new Error("部署选择无法读取"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "format,port,target,workspace"
    || value.format !== 1 || typeof value.target !== "string" || !/^([a-f0-9]{40}|[a-f0-9]{64})?$/.test(value.target)
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.workspace !== "string" || value.workspace.length > 4096
    || /[\x00-\x1f\x7f]/.test(value.workspace) || value.workspace !== "" && !isAbsolute(value.workspace))
    throw new Error("部署选择格式不支持");
  return value;
}

export function readDeployStage(path: string): DeployStage {
  const directory = resolve(path), file = (name: string) => readText(join(directory, name));
  try {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try { stat = lstatSync(directory); } catch { /* Reported below. */ }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("部署暂存目录不存在或是链接");
    const choicesText = file(DEPLOY_CHOICES_FILE), runtimeText = file(RUNTIME_VALUES_FILE);
    if (choicesText === null || runtimeText === null) throw new Error("部署暂存不完整（缺少部署选择或运行参数）");
    const choices = parseChoices(choicesText), runtime = parseRuntimeValues(runtimeText);
    if (runtime.values.BOT_PORT !== String(choices.port)) throw new Error("运行参数的端口与部署选择不一致");
    const configuration: DeployStage["configuration"] = {};
    for (const kind of STAGED_KINDS) {
      const text = file(stageName(kind));
      if (text !== null) configuration[kind] = { text, stage: parseConfigurationStage(text, kind) };
    }
    const platform: DeployStage["platform"] = {};
    for (const name of PLATFORM_STAGE_FILES) { const text = file(name); if (text !== null) platform[name] = text; }
    return { choices, runtime: { text: runtimeText, value: runtime }, plan: file("data-plan.json"), directoryPlan: file("directory-scope-plan.json"),
      configuration, platform };
  } catch (error) {
    throw new MaintenanceRefused(`${error instanceof Error ? error.message : "部署暂存无法读取"}${STAGE_UNCHANGED}`);
  }
}
