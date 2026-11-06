// 日志：终端 + 简单文件轮转。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../lib/redact.ts";

// 不依赖 config.ts：那里在导入时校验 runtime.json 和环境变量。部署恢复、维护和只读查询的宿主工具都写日志，配置损坏时
// 它们仍要能运行（回滚正是恢复这份配置的办法）。
export const LOG_FILE = "mixin-bot.log";
export const LOG_MAX_BYTES = 5 * 1024 ** 2; // 5MB
export const LOG_BACKUP_COUNT = 3;
const LOG_DIR = "logs";

/**
 * 日志去向。服务按默认值写 logs/（相对工作目录，首次写入时才创建）并输出到 stdout；stdout 另有用途的宿主工具（维护协议的
 * 机器模式、只读查询）在入口改到 stderr，不应在部署目录写东西的只读查询关掉文件。导入本模块没有副作用。
 */
export interface LogSink {
  /** 日志文件；null 表示不写文件。 */
  readonly file: string | null;
  readonly stream: "stdout" | "stderr";
}
let sink: LogSink = { file: join(LOG_DIR, LOG_FILE), stream: "stdout" };
let directoryReady: string | null = null;

export function configureLog(options: Partial<LogSink>): void {
  sink = { ...sink, ...options };
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 日志严格保持单行，并转义终端控制字符，避免外部字段伪造日志记录。 */
export function sanitizeLogMessage(message: string): string {
  return message.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,
    (character) => {
      const code = character.charCodeAt(0);
      if (code === 0x09) return "\\t";
      if (code === 0x0a) return "\\n";
      if (code === 0x0d) return "\\r";
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
  );
}

/** 仅保留当前文件和固定份数的备份；过期日志直接删除，不进入业务归档。 */
function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < LOG_MAX_BYTES) return;
    const oldest = `${path}.${LOG_BACKUP_COUNT}`;
    rmSync(oldest, { force: true });
    // .(n-1) -> .n，从大到小依次上移
    for (let i = LOG_BACKUP_COUNT - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    // 当前 -> .1
    renameSync(path, `${path}.1`);
  } catch {
    // 轮转失败不阻塞日志输出
  }
}

function write(level: string, msg: string): void {
  const line = `${timestamp()} - ${level} - ${sanitizeLogMessage(redactSecrets(msg))}`;
  (sink.stream === "stderr" ? console.error : console.log)(line);
  const path = sink.file;
  if (path === null) return;
  try {
    if (directoryReady !== path) { mkdirSync(dirname(path), { recursive: true }); directoryReady = path; }
    rotateIfNeeded(path);
    appendFileSync(path, line + "\n", "utf8");
  } catch {
    // 文件写入失败忽略（终端已输出）
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
