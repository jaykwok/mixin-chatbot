// 日志：console + 简单文件轮转。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  LOG_BACKUP_COUNT,
  LOG_DIR,
  LOG_FILE,
  LOG_MAX_BYTES,
} from "./config.ts";

mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = join(LOG_DIR, LOG_FILE);

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

/** 当前日志文件超限时滚动：删除最旧的 .backupCount，依次上移，当前重命名为 .1。 */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH) || statSync(LOG_PATH).size < LOG_MAX_BYTES) return;
    // 删除最旧的备份
    const oldest = `${LOG_PATH}.${LOG_BACKUP_COUNT}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    // .(n-1) -> .n，从大到小依次上移
    for (let i = LOG_BACKUP_COUNT - 1; i >= 1; i--) {
      const from = `${LOG_PATH}.${i}`;
      if (existsSync(from)) renameSync(from, `${LOG_PATH}.${i + 1}`);
    }
    // 当前 -> .1
    renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // 轮转失败不阻塞日志输出
  }
}

function write(level: string, msg: string): void {
  const line = `${timestamp()} - ${level} - ${sanitizeLogMessage(msg)}`;
  console.log(line);
  try {
    rotateIfNeeded();
    appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {
    // 文件写入失败忽略（console 已输出）
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
