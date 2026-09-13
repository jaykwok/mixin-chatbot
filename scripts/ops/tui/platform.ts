// 平台与部署状态。
//
// TUI 跑在宿主机上，读的必须是「这台机器实际部署成了什么样」，而不是仓库里的默认值。
// 这些事实的唯一来源是 deploy 写下的 data/state/*，与 ops.sh / ops.ps1 读的是同一批文件
// ——两边看到的端口、模式、域名和群数据根必须是同一个，否则 TUI 会对着另一套配置做体检。

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录。从本文件位置回溯，不依赖调用时的 cwd。 */
export const PROJECT_DIR = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const STATE_DIR = join(PROJECT_DIR, "data", "state");
const DEFAULT_GROUP_DATA_ROOT = join(PROJECT_DIR, "data", "groups");

export const LOG_FILE = join(PROJECT_DIR, "logs", "mixin-chatbot.log");

export type Platform = "windows" | "linux";
export type DeployMode = "direct" | "cloudflare";

export interface Deployment {
  platform: Platform;
  /** Windows 是 Bun + 计划任务，Linux 是 Docker 容器。运行时形态决定了哪些命令可用。 */
  runtime: "scheduled-task" | "docker";
  port: number;
  mode: DeployMode;
  /** 隧道模式下的公网域名；未设置时为空。 */
  domain: string;
  /** 群数据总根的绝对路径。 */
  groupDataRoot: string;
  /** 群数据根是否被指到了项目外的其他磁盘。 */
  groupDataRootIsCustom: boolean;
}

function readState(name: string): string {
  try {
    return readFileSync(join(STATE_DIR, name), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 读取部署状态。
 *
 * 环境变量优先于状态文件，与 ops.sh 的取值顺序一致：临时改端口调试时，两边得同时看到
 * 同一个值。非法值不静默兜底成默认值——那会让体检对着一个根本没人在用的端口报「正常」。
 */
export function loadDeployment(): Deployment {
  const platform: Platform = process.platform === "win32" ? "windows" : "linux";

  const rawPort = process.env.BOT_PORT?.trim() || readState("bot-port") || "1011";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口无效：${rawPort}（来自 BOT_PORT 或 data/state/bot-port）`);
  }

  const rawMode = readState("deploy-mode") || "direct";
  if (rawMode !== "direct" && rawMode !== "cloudflare") {
    throw new Error(`部署模式无效：${rawMode}（data/state/deploy-mode）`);
  }

  const rawRoot = readState("group-data-root");
  const groupDataRoot = rawRoot
    ? isAbsolute(rawRoot)
      ? resolve(rawRoot)
      : resolve(PROJECT_DIR, rawRoot)
    : DEFAULT_GROUP_DATA_ROOT;

  return {
    platform,
    runtime: platform === "windows" ? "scheduled-task" : "docker",
    port,
    mode: rawMode,
    domain: (process.env.BOT_DOMAIN?.trim() || readState("bot-domain")).toLowerCase(),
    groupDataRoot,
    groupDataRootIsCustom: groupDataRoot !== DEFAULT_GROUP_DATA_ROOT,
  };
}

/**
 * 现有运维包装器的调用方式。
 *
 * 所有写操作都转交给它，而不是在 TUI 里重写一遍：容器编排、维护租约、history-clear 的
 * 「停机→清理→恢复原状态」这些逻辑已经在那两个脚本里，抄一遍就是维护两份。
 */
export function opsCommand(platform: Platform, args: string[]): { command: string; args: string[] } {
  if (platform === "windows") {
    let native = args;
    if (args[0] === "routes") {
      native = ["routes", "-Target", args[1] ?? "list"];
      if (args[2]) native.push("-Fingerprint", args[2]);
      if (args[3] === "--group") native.push("-Group", args[4] ?? "");
    } else {
      const flags: Record<string, string> = {
        "--all": "-All", "--days": "-Days", "--user": "-User", "--group": "-Group",
        "--since": "-Since", "--until": "-Until", "--json": "-Json",
      };
      native = args.map(arg => flags[arg] ?? arg);
    }
    return {
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PROJECT_DIR, "scripts", "ops", "ops.ps1"), ...native],
    };
  }
  return { command: "bash", args: [join(PROJECT_DIR, "scripts", "ops", "ops.sh"), ...args] };
}

/** 人话的模式标签，界面和报表共用。 */
export function describeMode(deployment: Deployment): string {
  const runtime = deployment.runtime === "docker" ? "Docker" : "计划任务";
  return `${runtime} · ${deployment.mode === "cloudflare" ? "Cloudflare 隧道" : "直连"}`;
}
