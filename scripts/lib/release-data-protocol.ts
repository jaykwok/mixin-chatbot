// Built-ins only: the target release runs this before installing dependencies and before reading runtime settings.
export const RELEASE_DATA_PROTOCOL = "mixin-release-data";
export const RELEASE_DATA_COMMANDS = ["check", "preview", "apply", "validate", "commit", "rollback"] as const;
export type ReleaseDataCommand = typeof RELEASE_DATA_COMMANDS[number];
export interface ReleaseDataArgs { action: ReleaseDataCommand; json: boolean; project?: string; deployment?: string; plan?: string; workspace?: string; upgrade: boolean }
export function parseReleaseDataArgs(argv: readonly string[]): ReleaseDataArgs {
  const [action, ...args] = argv;
  if (!RELEASE_DATA_COMMANDS.includes(action as ReleaseDataCommand)) throw new Error("未知的数据准备动作");
  const result: ReleaseDataArgs = { action: action as ReleaseDataCommand, json: false, upgrade: false }, seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error("数据准备参数重复");
    seen.add(flag);
    if (["--project", "--deployment", "--plan", "--workspace"].includes(flag)) {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new Error("数据准备参数缺少值");
      result[flag.slice(2) as "project" | "deployment" | "plan" | "workspace"] = value;
    } else if (flag === "--json") result.json = true;
    else if (flag === "--upgrade" && action === "preview") result.upgrade = true;
    else throw new Error("数据准备不接受此参数");
  }
  return result;
}
export interface ReleaseDataResult {
  protocol: typeof RELEASE_DATA_PROTOCOL;
  version: 1;
  command: ReleaseDataCommand | "unknown";
  exitCode: number;
  success: boolean;
  result: null;
}

/** Keep the legacy 42 rollback refusal: it is not an affirmative result. */
export function releaseDataResult(command: string, exitCode: number): ReleaseDataResult {
  const known = RELEASE_DATA_COMMANDS.includes(command as ReleaseDataCommand) ? command as ReleaseDataCommand : "unknown";
  return { protocol: RELEASE_DATA_PROTOCOL, version: 1, command: known, exitCode, success: exitCode === 0, result: null };
}

export function decodeReleaseData(stdout: string, command: ReleaseDataCommand, exitCode: number): ReleaseDataResult {
  let value: ReleaseDataResult;
  try {
    value = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "command,exitCode,protocol,result,success,version"
      || value.protocol !== RELEASE_DATA_PROTOCOL || value.version !== 1 || value.command !== command
      || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255 || value.exitCode !== exitCode || value.success !== (exitCode === 0)
      || value.result !== null) throw new Error();
  } catch { throw new Error("数据准备工具的退出码、动作或完整结果不一致"); }
  return value;
}
