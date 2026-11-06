// Console port: --port → saved .console/port → 11012. Never scans for a free port, and never takes a port the bot may
// need later: a stopped bot or a bot in the middle of a transaction leaves its port free, so binding success proves
// nothing about conflicts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPendingTransaction } from "./pending-transaction.ts";

export const DEFAULT_CONSOLE_PORT = 11012;
/** deploy.sh / deploy.ps1 fall back to 1011, and rootless Docker without low-port publishing to 11011. */
const BOT_DEFAULT_PORTS = [1011, 11011];

export function parsePort(raw: string, source: string): number {
  const text = raw.trim();
  if (!/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > 65535) throw new Error(`${source}中的端口无效（应为 1–65535 的整数）：${raw}`);
  return Number(text);
}

export interface PortChoice { port: number; source: "参数" | "保存值" | "默认值" }

export function choosePort(argument: string | undefined, saved: number | null): PortChoice {
  if (argument !== undefined) return { port: parsePort(argument, "--port "), source: "参数" };
  if (saved !== null) return { port: saved, source: "保存值" };
  return { port: DEFAULT_CONSOLE_PORT, source: "默认值" };
}

/**
 * Ports the bot uses now or may use next, each with where it came from. The current BOT_PORT wins over the saved
 * value in loadDeployment and the deploy scripts, so it is protected too. An unreadable or invalid record refuses
 * instead of guessing that it probably does not conflict.
 */
export function botPorts(project: string, env: NodeJS.ProcessEnv = process.env): Map<number, string[]> {
  const ports = new Map<number, string[]>();
  const add = (port: number, source: string) => ports.set(port, [...ports.get(port) ?? [], source]);

  const fromEnv = env.BOT_PORT?.trim();
  if (fromEnv) add(parsePort(fromEnv, "环境变量 BOT_PORT "), "环境变量 BOT_PORT");

  const file = join(project, "data", "state", "bot-port");
  let saved: string | null = null;
  try { saved = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`无法读取机器人端口记录 data/state/bot-port：${(error as Error).message}`);
  }
  if (saved !== null) add(parsePort(saved, "data/state/bot-port "), "data/state/bot-port");
  else for (const port of BOT_DEFAULT_PORTS) add(port, "尚无端口记录时的部署默认值");

  let pending: ReturnType<typeof loadPendingTransaction>;
  try { pending = loadPendingTransaction(project); }
  catch (error) { throw new Error(`未完成的事务记录无法读取（${(error as Error).message}），无法确认机器人端口；请先用 CLI 继续或回滚`); }
  if (pending?.record) add(Number(pending.record.bot_port), "未完成事务记录");
  return ports;
}

/** Throws when the console port is one the bot uses or may use; the message says how to pick another. */
export function assertNoBotConflict(port: number, project: string, env: NodeJS.ProcessEnv = process.env): void {
  const sources = botPorts(project, env).get(port);
  if (sources) {
    throw new Error(`控制台端口 ${port} 与机器人端口相同（来源：${sources.join("、")}）。` +
      `请用 bun run console --port <其他端口> 换一个端口，机器人停止时它的端口同样保留。`);
  }
}
