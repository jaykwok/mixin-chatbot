// Explicit choices for new lifecycle operations. No stdin defaults and no arbitrary environment/argv from the browser.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readDirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { assertMaintenanceAction } from "../../src/core/maintenance-state.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { loadPendingTransaction } from "./pending-transaction.ts";
import { assertLifecycleTarget } from "./recovery-plan.ts";
import { parsePort } from "./console-port.ts";
import { canonical, planDigest } from "./plans.ts";
import { runCommand, type Runner } from "./hosting.ts";
import { ownsDataMount } from "./deployment-data.ts";
import { directoryChoice, checkedDirectoryChoice, directoryChoiceText, type DirectoryChoice } from "../lib/directory-choice.ts";

type Common = { directory: "saved" | "all" | DirectoryChoice };
export type UpgradeOptions = Common & { target: string; switchMain: boolean };
export type DeployOptions = Common & { port: number; workspace: string };
export type DeploymentOperation = "update" | "deploy";
const INPUTS = ["data/state/data-version.json", "data/state/release-data.json", "data/state/bot-port", "data/state/workspace-root",
  "data/config/app-bot.json", "data/config/models.json", "data/config/runtime.json", "data/config/directory.json",
  "data/runtime/pi/settings.json", ".console/port"];

export function deploymentOptions(operation: DeploymentOperation, input: Record<string, unknown>): UpgradeOptions | DeployOptions {
  const keys = ["directory", ...(operation === "update" ? ["target", "switchMain"] : ["port", "workspace"])];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length
    || Object.keys(input).some(key => !keys.includes(key))) throw new Error("请明确选择每项部署设置，不接受缺失或多余参数");
  const common: Common = { directory: input.directory === "saved" || input.directory === "all" ? input.directory : directoryChoice(input.directory) };
  if (operation === "update") {
    if (typeof input.target !== "string" || !/^[a-f0-9]{40}$/.test(input.target) || typeof input.switchMain !== "boolean") throw new Error("升级需要已核对的完整提交和明确的分支切换选择");
    return { ...common, target: input.target, switchMain: input.switchMain };
  }
  if (!Number.isSafeInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535 || typeof input.workspace !== "string"
    || input.workspace.length > 4096 || /[\x00-\x1f]/.test(input.workspace) || input.workspace !== input.workspace.trim()
    || (input.workspace !== "" && !isAbsolute(input.workspace))) throw new Error("部署需要有效端口和共享目录的绝对路径；空目录表示使用默认目录");
  return { ...common, port: Number(input.port), workspace: input.workspace };
}

/** These are named internal choices, not a shell fragment. Clear ambient overrides when preserving saved settings. */
export function deploymentEnvironment(operation: DeploymentOperation, input: Record<string, unknown>, project: string): Record<string, string> {
  const value = deploymentOptions(operation, input);
  return { ...Object.fromEntries(RUNTIME_KEYS.map(key => [key, ""])),
    MIXIN_OPS_LIFECYCLE: operation,
    MIXIN_OPS_DIRECTORY: typeof value.directory === "string" ? value.directory : "selected", BOT_DIRECTORY_SCOPE: value.directory === "all" ? "all" : "",
    MIXIN_OPS_DIRECTORY_INPUT: typeof value.directory === "string" ? "" : directoryChoiceText(value.directory),
    MIXIN_OPS_DIRECTORY_APP: typeof value.directory === "string" ? "" : value.directory.appHash,
    MIXIN_OPS_SWITCH_MAIN: "switchMain" in value && value.switchMain ? "1" : "0",
    BOT_PORT: "port" in value ? String(value.port) : "",
    WORKSPACE_ROOT: "workspace" in value ? value.workspace || (process.platform === "win32" ? join(project, "data/workspace") : "") : "" };
}

export function assertDeploymentEnvironment(operation: string, input: Record<string, unknown>, project: string, env = process.env): void {
  if (operation !== "update" && operation !== "deploy" && operation !== "repair") return;
  const expectedEnvironment = operation === "repair" ? repairEnvironment(project, input) : deploymentEnvironment(operation, input, project);
  for (const [key, expected] of Object.entries(expectedEnvironment)) {
    if (env[key] !== expected) throw new Error(`部署选择未完整传递（${key}），未执行操作`);
  }
}

export function repairEnvironment(project: string, params: Record<string, unknown>): Record<string, string> {
  return process.platform === "win32" ? { ...Object.fromEntries(RUNTIME_KEYS.map(key => [key, ""])), MIXIN_OPS_LIFECYCLE: "repair" }
    : deploymentEnvironment("deploy", params, project);
}

export async function repairScope(project: string, params: Record<string, unknown>, run: Runner = runCommand) {
  if (process.platform !== "win32") return deploymentScope(project, "deploy", params, run);
  if (loadPendingTransaction(project) || readConfigurationState(project)) throw new Error("请先完成或恢复未结束的维护事务");
  assertMaintenanceAction(project, "service");
  const before = INPUTS.map(path => [path, fileHash(join(project, path))]), identity = await deploymentIdentity(project, run);
  if (planDigest(before) !== planDigest(INPUTS.map(path => [path, fileHash(join(project, path))]))) throw new Error("预览期间部署设置已变化，请重试");
  return { scope: planDigest([before, identity]), summary: ["检查本机实例身份与就绪状态，未就绪时尝试重启（包括当前停止的实例）。",
    "本机已就绪时不重启。不改配置或数据；计划任务缺失或安装损坏时，请使用重新部署。"] };
}

function fileHash(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("部署设置必须是普通文件且大小有上限");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function deploymentScope(project: string, operation: DeploymentOperation, params: Record<string, unknown>, run: Runner = runCommand) {
  const options = deploymentOptions(operation, params);
  if (loadPendingTransaction(project)) throw new Error("请先继续或回滚未完成的部署或升级");
  if (readConfigurationState(project)) throw new Error("请先完成或恢复未结束的配置事务");
  // The redeployment restarts the service: an unfinished ops task or an unreadable state record refuses it.
  assertMaintenanceAction(project, "service");
  const before = INPUTS.map(path => [path, fileHash(join(project, path))]);
  for (const path of ["data/config/app-bot.json", "data/config/models.json", "data/runtime/pi/settings.json", "data/state/data-version.json"]) {
    if (fileHash(join(project, path)) === null) throw new Error("请先完成首次部署及模型、机器人配置；网页只重新部署已有实例");
  }
  const directory = readDirectoryScope(join(project, "data/config/directory.json"));
  if (options.directory === "saved" && !directory) throw new Error("没有已保存的通讯录范围，请先选择同步范围");
  if (options.directory === "all" && directory) throw new Error("已有同步范围；请在通讯录设置修改，然后选择沿用保存值");
  if (typeof options.directory === "object") {
    if (directory) throw new Error("已有同步范围；请在通讯录设置修改，然后选择沿用保存值");
    checkedDirectoryChoice(project, options.directory);
  }
  const branch = await run(["git", "-C", project, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) throw new Error("无法核对当前分支");
  let workspaceIdentity: unknown = null;
  if ("target" in options) {
    const status = await run(["git", "-C", project, "status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0 || status.stdout.trim()) throw new Error("已跟踪文件有改动，未开始升级");
    if (branch.stdout.trim() !== "main" && !options.switchMain) throw new Error("当前不在 main，请明确允许切换分支再预览");
    await assertLifecycleTarget(project, options.target, run);
  } else {
    const portFile = readFileSync(join(project, ".console/port"), "utf8");
    if (options.port === parsePort(portFile, "控制台 ")) throw new Error("机器人目标端口与控制台端口相同，未停止机器人");
    if (options.workspace) {
      const path = realpathSync(options.workspace), stat = lstatSync(path);
      if (!stat.isDirectory()) throw new Error("共享资料目录不存在或不是目录");
      workspaceIdentity = [path, String(stat.dev), String(stat.ino)];
    }
  }
  const identity = await deploymentIdentity(project, run);
  if (planDigest(before) !== planDigest(INPUTS.map(path => [path, fileHash(join(project, path))]))) throw new Error("预览期间部署设置已变化，请重试");
  return { scope: planDigest([before, options, branch.stdout.trim(), workspaceIdentity, identity]), summary: [
    "target" in options ? `目标提交：${options.target}；当前分支：${branch.stdout.trim()}；${options.switchMain ? "允许切换到 main" : "不允许切换分支"}。`
      : `重新部署当前代码；端口 ${options.port}；共享资料：${options.workspace || "data/workspace（默认）"}。`,
    options.directory === "saved" ? "沿用已保存的通讯录范围。" : options.directory === "all" ? "首次设置通讯录范围：整个通讯录。"
      : `首次设置通讯录范围：${options.directory.names.join("、")}（含全部子部门）。`,
    "target" in options ? "原来运行的实例升级后恢复运行；原来停止的实例保持停止。" : "重新部署完成后启动机器人，包括当前处于停止状态的实例。",
    "沿用模型与机器人凭据；目标脚本在停机前校验。提交前失败恢复原部署，提交后只能继续收尾。",
  ] };
}

async function deploymentIdentity(project: string, run: Runner): Promise<unknown> {
  let identity: unknown;
  if (process.platform === "win32") {
    const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $t=Get-ScheduledTask -TaskName mixin-bot -ErrorAction Stop; [ordered]@{Principal=[ordered]@{UserId=$t.Principal.UserId; LogonType=[string]$t.Principal.LogonType; RunLevel=[string]$t.Principal.RunLevel}; Actions=@($t.Actions | ForEach-Object { [ordered]@{Execute=$_.Execute; Arguments=$_.Arguments; WorkingDirectory=$_.WorkingDirectory} })} | ConvertTo-Json -Depth 6 -Compress"]);
    if (result.code !== 0) throw new Error("无法核对已部署的机器人计划任务");
    identity = JSON.parse(result.stdout);
    const actions = (identity as { Actions: { WorkingDirectory: string }[] }).Actions;
    if (actions?.length !== 1 || resolve(actions[0]!.WorkingDirectory ?? "") !== resolve(project)) throw new Error("机器人计划任务不属于此部署");
  } else {
    const result = await run(["docker", "container", "inspect", "mixin-bot"]);
    if (result.code !== 0) throw new Error("请先完成首次部署，无法核对机器人容器身份");
    const containers = JSON.parse(result.stdout), c = containers[0];
    if (containers.length !== 1 || !ownsDataMount(project, c?.Mounts)) throw new Error("机器人容器不属于此部署");
    // Docker builds Mounts from a map: successive inspections may return the same mounts in a different order.
    // Keep every property in the confirmation, but make this unordered collection stable across processes.
    const mounts = [...c.Mounts].sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
    identity = { id: c.Id, image: c.Image, user: c.Config?.User, mounts };
  }
  return identity;
}
