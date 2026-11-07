// What the macOS entries (macos-entry.ts, macos-deploy.ts, macos-doctor.ts) share: messages in the style of ops.sh, commands
// on the caller's terminal (optionally as another account, through macos-become.ts), questions, and the structured result
// a console task reads. The entries run as root through sudo; nothing here changes the deployment.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openOperationLog } from "../../src/lib/operation-log.ts";
import type { OpsResult } from "./result.ts";
import type { Identity } from "./launchd-host.ts";

export const SOURCE = resolve(import.meta.dir, "../..");
const COLORS = { step: "\x1b[0;34m[*]\x1b[0m", ok: "\x1b[0;32m[+]\x1b[0m", warn: "\x1b[1;33m[!]\x1b[0m", error: "\x1b[0;31m[x]\x1b[0m" } as const;
const PLAIN = { step: "[*]", ok: "[+]", warn: "[!]", error: "[x]" } as const;
type Level = keyof typeof COLORS;

let log: ReturnType<typeof openOperationLog> | null = null, stage = "operation", quiet = false;
/** Deploy and upgrade keep a diagnostic log in logs/operations, as on the other platforms. */
export function startLog(project: string, kind: "deploy" | "upgrade") { log = openOperationLog(project, kind); return log; }
export function setStage(name: string): void { stage = name; log?.event("info", stage, "begin"); }
export function event(level: "info" | "warn" | "error", text: string): void { log?.event(level, stage, text); }
/** doctor --json: stdout carries only the JSON. */
export function silence(): void { quiet = true; }

function say(level: Level, text: string): void {
  if (quiet) return;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${(stream.isTTY ? COLORS : PLAIN)[level]} ${text}\n`);
  event(level === "error" ? "error" : level === "warn" ? "warn" : "info", text);
}
export const step = (text: string) => say("step", text), ok = (text: string) => say("ok", text);
export const warn = (text: string) => say("warn", text), fail = (text: string) => say("error", text);

/** A refusal or failure the entry reports as one line and exit code 1; anything else is a bug and keeps its stack. */
export class EntryError extends Error {
  constructor(message: string, readonly code = 1) { super(message); }
}

/** Where to go next: the console's page when a console task runs this, else the command for this terminal. */
export function hint(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIXIN_OPS_UI === "console") {
    const pages: Record<string, string> = { deploy: "维护 → 重新部署", update: "维护 → 升级", resume: "维护 → 继续上次操作", rollback: "维护 → 回滚上次操作",
      start: "维护 → 启动", stop: "维护 → 停止", restart: "维护 → 重启", repair: "维护 → 修复部署", "doctor --repair": "维护 → 修复部署", doctor: "体检 → 刷新",
      status: "总览 → 刷新", logs: "日志", "configure-app-bot": "设置 → 应用机器人凭据", "relay-configure": "设置 → 外链配置", directory: "通讯录" };
    if (pages[command]) return `「${pages[command]}」`;
  }
  return `sudo bash scripts/ops.sh ${command}`;
}

export function requireRoot(what: string): void {
  if (process.geteuid?.() !== 0) throw new EntryError(`${what}需要 root：请用 sudo 运行（sudo bash scripts/ops.sh …）`);
}

export interface Attached { cwd: string; env: NodeJS.ProcessEnv; identity?: Identity; /** Exit code only: no terminal input or output. */ quiet?: boolean }
/**
 * Runs a command on this terminal and returns its exit code. As another account it goes through macos-become.ts, which drops
 * root before the command starts. A TERM or HANGUP sent to this entry (a console task being stopped) is passed on.
 */
export async function attached(argv: string[], options: Attached): Promise<number> {
  const command = options.identity ? [process.execPath, "--no-env-file", join(SOURCE, "ops/core/macos-become.ts"), String(options.identity.uid), String(options.identity.gid), "--", ...argv] : argv;
  const stdio = options.quiet ? "ignore" : "inherit";
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdin: stdio, stdout: stdio, stderr: stdio });
  const forward = (name: NodeJS.Signals) => () => child.kill(name);
  const handlers = (["SIGTERM", "SIGHUP"] as const).map(name => [name, forward(name)] as const);
  for (const [name, handler] of handlers) process.on(name, handler);
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try { return await child.exited; }
  finally { for (const [name, handler] of handlers) process.off(name, handler); process.off("SIGINT", ignore); }
}

/** Output of a short command, for facts (git, versions). */
export async function captured(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const child = Bun.spawn(argv, { cwd: options.cwd, env: options.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 120_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  } catch (error) { return { code: 127, stdout: "", stderr: (error as Error).message }; }
}

/** y/n on the terminal; the end of input answers no. A console task never has an answer, so it refuses instead of guessing. */
export function askYesNo(question: string, fallback = false, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MIXIN_OPS_CONSOLE === "1") throw new EntryError("控制台操作遇到未提供的交互选择，请重新预览；未自动采用默认值");
  for (;;) {
    const answer = prompt(question);
    if (answer === null) { warn("输入已结束，按默认值“否”处理"); return false; }
    const value = answer.trim().toLowerCase();
    if (!value) return fallback;
    if (["y", "yes", "是"].includes(value)) return true;
    if (["n", "no", "否"].includes(value)) return false;
    warn("请输入 y 或 n（也可直接回车采用默认值）");
  }
}
/** An unfinished deployment or upgrade only continues or rolls back; without a terminal the caller must say which. */
export function askTransactionAction(): "continue" | "rollback" | null {
  if (!process.stdin.isTTY) throw new EntryError(`发现未完成的部署或升级；请使用 ${hint("resume")} 继续，或 ${hint("rollback")} 回滚`);
  for (;;) {
    const answer = (prompt("1 继续上次操作  2 回滚到操作前  0 退出 [默认 0]：") ?? "0").trim();
    if (answer === "1") return "continue";
    if (answer === "2") return "rollback";
    if (answer === "" || answer === "0") return null;
    warn("请输入 1、2 或 0");
  }
}

/** The console task's result file (MIXIN_OPS_RESULT_FILE), written through a temporary name. False when it cannot be written. */
export function writeResult(result: Omit<OpsResult, "protocol" | "version">, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.MIXIN_OPS_RESULT_FILE;
  if (!path) return true;
  const temporary = join(dirname(path), `.${process.pid}.result.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ protocol: "mixin-ops", version: 1, ...result }) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    rmSync(temporary, { force: true });
    fail(`无法写入结构化结果：${path}`);
    return false;
  }
}
