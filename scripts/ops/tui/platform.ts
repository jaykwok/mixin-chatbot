// TUI 读取宿主机部署状态，与 ops 使用相同的本机端口和共享资料目录。
// BOT_PORT 的显式环境变量覆盖对应状态文件。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs } from "../../lib/cli.ts";

/** 仓库根目录。从本文件位置回溯，不依赖调用时的 cwd。 */
export const PROJECT_DIR = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const DATA_DIR = join(PROJECT_DIR, "data");
const STATE_DIR = join(DATA_DIR, "state");

export const LOG_FILE = join(PROJECT_DIR, "logs", "mixin-chatbot.log");

export type Platform = "windows" | "linux";

export interface Deployment {
  platform: Platform;
  /** Windows 是 Bun + 计划任务，Linux 是 Docker 容器。运行时形态决定了哪些命令可用。 */
  runtime: "scheduled-task" | "docker";
  port: number;
  /** 数据目录（data/）的绝对路径：会话、tmp、统计账本和索引都在它下面。 */
  dataRoot: string;
  /** 外置共享资料目录（WORKSPACE_ROOT）；空为默认的 data/workspace。 */
  workspaceRoot: string;
}

/** 宿主平台只取决于运行环境；恢复入口用它转交命令，不读取已保存的设置。 */
export function hostPlatform(): Platform {
  return process.platform === "win32" ? "windows" : "linux";
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
  const platform = hostPlatform();

  const rawPort = process.env.BOT_PORT?.trim() || readState("bot-port") || "1011";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口无效：${rawPort}（来自 BOT_PORT 或 data/state/bot-port）`);
  }

  const workspace = readState("workspace-root");
  return {
    platform,
    runtime: platform === "windows" ? "scheduled-task" : "docker",
    port,
    dataRoot: DATA_DIR,
    workspaceRoot: workspace ? resolve(workspace) : "",
  };
}

/**
 * 现有运维包装器的调用方式。
 *
 * 所有写操作都转交给它，而不是在 TUI 里重写一遍：容器编排、维护租约、history-clear 的
 * 「停机→清理→恢复原状态」这些逻辑已经在那两个脚本里，抄一遍就是维护两份。
 */
export function opsCommand(platform: Platform, args: string[]): { command: string; args: string[]; env: Record<string, string> } {
  const env = { MIXIN_OPS_TUI: "1" };
  if (platform === "windows") {
    const request: Record<string, string | number | boolean> = { Command: args[0] ?? "" };
    let i = 1;
    if (args[0] === "relay-purge") {
      if (args[i] === "--all") { request.All = true; i++; }
      else {
        if (args[i] === "--keyword") i++;
        request.Target = args[i++] ?? "";
      }
    } else if (["update", "upgrade", "history-clear", "history-compact", "stat", "stat-import", "runtime-configure", "directory-confirm", "directory-departments", "directory-scope"].includes(args[0] ?? "") && args[i] && !args[i]!.startsWith("--")) {
      request.Target = args[i++]!;
      if (args[0] === "history-compact") {
        if (!args[i]) throw new Error("压缩需要成员号码");
        request.User = args[i++]!;
      }
    }
    const switches: Record<string, string> = {
      all: "All", json: "Json", repair: "Repair",
      "storage-segment": "StorageSegment", "group-id": "GroupId", direct: "Direct",
    };
    const values: Record<string, string> = { days: "Days", user: "User", group: "Group", since: "Since", until: "Until", period: "Period", "confirmed-transaction": "ConfirmedTransaction", plan: "Plan", digest: "Digest" };
    // TUI passes argument values as opaque strings (including leading dashes).
    // Encode them with '=' before the standard parser, preserving that contract.
    const encodedArgs: string[] = [];
    for (; i < args.length; i++) {
      const flag = args[i]!;
      if (values[flag.slice(2)] && args[i + 1] !== undefined) encodedArgs.push(flag + "=" + args[++i]);
      else encodedArgs.push(flag === "-Repair" ? "--repair" : flag);
    }
    const parsed = cliArgs(encodedArgs, {
      all: { type: "boolean" }, json: { type: "boolean" }, repair: { type: "boolean" },
      "storage-segment": { type: "boolean" }, "group-id": { type: "boolean" }, direct: { type: "boolean" },
      days: { type: "string" }, user: { type: "string" }, group: { type: "string" }, since: { type: "string" }, until: { type: "string" },
      "confirmed-transaction": { type: "string" }, period: { type: "string" },
      plan: { type: "string" }, digest: { type: "string" },
    });
    if (parsed.positionals.length) throw new Error("存在多余的运维参数");
    for (const [name, value] of Object.entries(parsed.values)) {
      request[switches[name] ?? values[name]!] = name === "days" ? Number(value) : value;
    }
    if (request.StorageSegment && request.GroupId) throw new Error("群目录选择参数不能同时使用");
    // Only base64 crosses PowerShell's parameter binder. Values are never parsed as switches.
    const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    return {
      env,
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PROJECT_DIR, "scripts", "ops", "ops.ps1"), "-RequestBase64", encoded],
    };
  }
  const commandArgs = [...args];
  if (["tmp-ls", "tmp-purge", "tmp-preview", "tmp-reclaim", "tmp-discard"].includes(args[0] ?? "")) {
    for (let i = 1; i < commandArgs.length; i++) {
      if (["--group", "--user", "--days", "--plan", "--digest"].includes(commandArgs[i]!) && commandArgs[i + 1] !== undefined) {
        commandArgs.splice(i, 2, commandArgs[i] + "=" + commandArgs[i + 1]);
      }
    }
  } else if (args[0] === "stat" && args[1] && !args[1].startsWith("--")) {
    commandArgs.splice(1, 1);
    commandArgs.push("--", args[1]);
  }
  return { command: "bash", args: [join(PROJECT_DIR, "scripts", "ops", "ops.sh"), ...commandArgs], env };
}

/** 人话的运行形态标签，界面和报表共用。 */
export function describeMode(deployment: Deployment): string {
  return deployment.runtime === "docker" ? "Docker" : "计划任务";
}
