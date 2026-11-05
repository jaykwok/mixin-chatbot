// Bootstrap diagnostics: built-ins only, independent of configuration and installed packages.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets as redact } from "./redact.ts";

const namePattern = /^(upgrade|deploy|startup)-[\dTZ]+-[\w-]+\.log$/;
const maxBytes = 2 * 1024 * 1024;
// rootful deployments hand logs/ to the service identity, so a root writer must not follow what it may have planted: every
// append opens without O_CREAT, refusing a link (O_NOFOLLOW) or a FIFO (O_NONBLOCK, then fstat) in place of the log.
const appendFlags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Exclusive creation. On Linux the new file must be the project's own logs/operations entry; one created through a replaced directory is removed again. */
function createLog(project: string, path: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform !== "linux") return;
    const actual = readlinkSync(`/proc/self/fd/${fd}`);
    if (actual !== join(realpathSync(join(project, "logs")), "operations", basename(path))) {
      unlinkSync(actual);
      throw new Error("diagnostic directory was replaced");
    }
  } finally { closeSync(fd); }
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

/**
 * The newest startup failure recorded since `since` (ms): its log and the error's first line, already redacted.
 * Deployments show it when a new instance never becomes ready, instead of only the supervisor's exit code.
 */
export function latestStartupError(project: string, since: number): { path: string; error: string } | null {
  const directory = join(project, "logs/operations");
  try {
    const newest = readdirSync(directory).filter(file => file.startsWith("startup-") && namePattern.test(file))
      .map(file => ({ path: join(directory, file), stat: lstatSync(join(directory, file)) }))
      .filter(item => item.stat.isFile() && !item.stat.isSymbolicLink() && item.stat.mtimeMs >= since && item.stat.size <= maxBytes)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    if (!newest) return null;
    const line = readFileSync(newest.path, "utf8").split("\n").reverse().find(text => / error startup: /.test(text));
    // event() writes a message's own line breaks as a literal \n: the first line is the error, the rest its stack.
    const error = line?.slice(line.indexOf(" error startup: ") + 16).split("\\n")[0]?.trim();
    return error ? { path: newest.path, error: error.slice(0, 400) } : null;
  } catch { return null; }
}

export function openOperationLog(project: string, kind: "upgrade" | "deploy" | "startup", inherited = process.env.BOT_OPERATION_LOG) {
  const directory = join(project, "logs/operations");
  // Inheriting a log also delegates its terminal announcement to the caller.
  const parentName = inherited && namePattern.test(inherited) ? inherited : undefined;
  let path: string | undefined, name: string | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("diagnostic directory is a link");
    name = parentName ?? `${kind}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}.log`;
    path = join(directory, name);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("diagnostic file is not a regular file");
    if (!existsSync(path)) createLog(project, path);
    // Rotate only this file's family, including inherited upgrade logs. Startup
    // restart loops must never evict the upgrade or deployment that caused them.
    const family = name.split("-")[0] + "-";
    const old = readdirSync(directory).filter(file => file !== name && file.startsWith(family) && namePattern.test(file))
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
    let fd: number | undefined;
    try {
      fd = openSync(path, appendFlags);
      const stat = fstatSync(fd), size = stat.size;
      if (!stat.isFile()) throw new Error("diagnostic file is not a regular file");
      if (size >= maxBytes) return;
      if (level === "output" && size >= maxBytes / 2) {
        if (outputLimited) return;
        outputLimited = true;
        level = "warn";
        detail = "Command output limit reached; subsequent stages and errors are still recorded.";
      }
      const message = redact(detail).slice(0, 16_384).replace(/[\r\n\u0000-\u001f\u007f]/g, character => character === "\n" ? "\\n" : character === "\r" ? "\\r" : " ");
      writeSync(fd, `${new Date().toISOString()} [${process.pid}] ${level} ${stage}: ${message}\n`, null, "utf8");
    } catch (error) {
      if (!warned) console.error("运维日志写入失败：" + redact(String(error)));
      warned = true;
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  return { path, name, event, ownsLog: !parentName };
}
