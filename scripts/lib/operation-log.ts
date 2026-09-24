// Bootstrap diagnostics: built-ins only, independent of configuration and installed packages.
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const namePattern = /^(upgrade|deploy|migration|startup)-[\dTZ]+-[\w-]+\.log$/;
const maxBytes = 2 * 1024 * 1024;

function redact(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:key|token|secret|password)=)[^\s&#"']+/gi, "$1[redacted]")
    .replace(/\/webhook\/[a-f\d]{64}\b/gi, "/webhook/[redacted]")
    .replace(/\bsk-[\w-]{12,}\b/g, "[redacted]");
}

export function operationError(error: unknown): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown): string => {
    if (seen.has(value)) return "[circular cause]";
    seen.add(value);
    if (!(value instanceof Error)) return String(value);
    return (value.stack || value.message) + (value.cause === undefined ? "" : "\nCaused by: " + describe(value.cause));
  };
  return describe(error);
}

export function openOperationLog(project: string, kind: "upgrade" | "deploy" | "migration" | "startup", inherited = process.env.BOT_OPERATION_LOG) {
  const directory = join(project, "logs/operations");
  let path: string | undefined, name: string | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("diagnostic directory is a link");
    name = inherited && namePattern.test(inherited) ? inherited : `${kind}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}.log`;
    path = join(directory, name);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("diagnostic file is not a regular file");
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    // Keep this operation and the 19 most recently written operation logs.
    const old = readdirSync(directory).filter(file => file !== name && namePattern.test(file))
      .map(file => ({ file, stat: lstatSync(join(directory, file)) }))
      .filter(item => item.stat.isFile() && !item.stat.isSymbolicLink())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const item of old.slice(19)) unlinkSync(join(directory, item.file));
  } catch (error) {
    console.error("无法创建运维日志，继续使用终端输出：" + redact(String(error)));
    path = undefined;
  }
  let warned = false, outputLimited = false;
  const event = (level: string, stage: string, detail = "") => {
    if (!path) return;
    try {
      const size = statSync(path).size;
      if (size >= maxBytes) return;
      if (level === "output" && size >= maxBytes / 2) {
        if (outputLimited) return;
        outputLimited = true;
        level = "warn";
        detail = "Command output limit reached; subsequent stages and errors are still recorded.";
      }
      const message = redact(detail).slice(0, 16_384).replace(/[\r\n\u0000-\u001f\u007f]/g, character => character === "\n" ? "\\n" : character === "\r" ? "\\r" : " ");
      appendFileSync(path, `${new Date().toISOString()} [${process.pid}] ${level} ${stage}: ${message}\n`, "utf8");
    } catch (error) {
      if (!warned) console.error("运维日志写入失败：" + redact(String(error)));
      warned = true;
    }
  };
  return { path, name, event };
}
