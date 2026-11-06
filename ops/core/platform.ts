// 控制台读取宿主机部署状态，与 ops 使用相同的本机端口和共享资料目录。
// BOT_PORT 的显式环境变量覆盖对应状态文件。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliArgs } from "../lib/cli.ts";

/** 仓库根目录。从本文件位置回溯，不依赖调用时的 cwd。 */
export const SOURCE_DIR = resolve(process.env.MIXIN_CONSOLE_SOURCE_ROOT ?? fileURLToPath(new URL("../..", import.meta.url)));
export const PROJECT_DIR = resolve(process.env.MIXIN_CONSOLE_PROJECT_ROOT ?? SOURCE_DIR);

const DATA_DIR = join(PROJECT_DIR, "data");
const STATE_DIR = join(DATA_DIR, "state");

export const LOG_FILE = join(PROJECT_DIR, "logs", "mixin-bot.log");

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
 * 控制台调用运维入口（ops.ps1 / ops.sh）的参数形式，只接受控制台发出的参数。
 *
 * 写操作都经入口交给共用核心（ops/core）：部署锁、停机窗口、计划复核和结果文件都在核心里，
 * 控制台不另写一份。`ui` 为 console 时，提示指向控制台页面；cli 时显示可直接执行的命令。
 */
export function opsCommand(platform: Platform, args: string[], project = PROJECT_DIR, source = project, ui: "console" | "cli" = "cli"): { command: string; args: string[]; env: Record<string, string> } {
  // Display hints are separate from MIXIN_OPS_CONSOLE, which enables the write-operation guard.
  const env: Record<string, string> = { MIXIN_OPS_UI: ui, ...(resolve(source) !== resolve(project) ? { MIXIN_OPS_PROJECT: resolve(project) } : {}) };
  if (platform === "windows") {
    const request: Record<string, string | number | boolean> = { Command: args[0] ?? "" };
    let i = 1;
    if (args[0] === "relay-purge") {
      if (args[i] === "--all") { request.All = true; i++; }
      else {
        if (args[i] === "--keyword") i++;
        request.Target = args[i++] ?? "";
      }
    } else if (args[0] === "history-compact" && args[i] === "--direct") {
      request.Direct = true; request.User = args[i + 1] ?? ""; i += 2;
    } else if (["update", "history-clear", "history-compact", "stat-import", "runtime-configure", "configuration-apply", "configuration-restore", "backup-clean"].includes(args[0] ?? "") && args[i] && !args[i]!.startsWith("--")) {
      request.Target = args[i++]!;
      if (args[0] === "history-compact") {
        if (!args[i]) throw new Error("压缩需要成员号码");
        request.User = args[i++]!;
      }
    }
    const switches: Record<string, string> = { all: "All", json: "Json", "storage-segment": "StorageSegment", direct: "Direct" };
    const values: Record<string, string> = { days: "Days", user: "User", group: "Group", "confirmed-transaction": "ConfirmedTransaction", plan: "Plan", digest: "Digest", expect: "Expect", confirm: "ConfirmCode" };
    // The console passes argument values as opaque strings (including leading dashes).
    // Encode them with '=' before the standard parser, preserving that contract.
    const encodedArgs: string[] = [];
    for (; i < args.length; i++) {
      const flag = args[i]!;
      if (flag.startsWith("--") && values[flag.slice(2)] && args[i + 1] !== undefined) encodedArgs.push(flag + "=" + args[++i]);
      else encodedArgs.push(flag);
    }
    const parsed = cliArgs(encodedArgs, {
      all: { type: "boolean" }, json: { type: "boolean" }, "storage-segment": { type: "boolean" }, direct: { type: "boolean" },
      days: { type: "string" }, user: { type: "string" }, group: { type: "string" }, "confirmed-transaction": { type: "string" },
      plan: { type: "string" }, digest: { type: "string" }, expect: { type: "string" }, confirm: { type: "string" },
    });
    if (parsed.positionals.length) throw new Error("存在多余的运维参数");
    for (const [name, value] of Object.entries(parsed.values)) {
      request[switches[name] ?? values[name]!] = name === "days" ? Number(value) : value;
    }
    // Only base64 crosses PowerShell's parameter binder. Values are never parsed as switches.
    const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    return {
      env,
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(source, "scripts", "ops.ps1"), "-RequestBase64", encoded],
    };
  }
  const commandArgs = [...args];
  if (["tmp-purge", "tmp-preview", "tmp-reclaim", "tmp-discard"].includes(args[0] ?? "")) {
    for (let i = 1; i < commandArgs.length; i++) {
      if (["--group", "--user", "--days", "--plan", "--digest"].includes(commandArgs[i]!) && commandArgs[i + 1] !== undefined) {
        commandArgs.splice(i, 2, commandArgs[i] + "=" + commandArgs[i + 1]);
      }
    }
  }
  return { command: "bash", args: [join(source, "scripts", "ops.sh"), ...commandArgs], env };
}

/** 人话的运行形态标签，界面和报表共用。 */
export function describeMode(deployment: Deployment): string {
  return deployment.runtime === "docker" ? "Docker" : "计划任务";
}
