// .console/: private console state, tasks and short-lived configuration drafts. No chat export copies.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parsePort } from "./console-port.ts";
import { windowsPrivateOwner } from "../../src/lib/windows-private-directory.ts";

export const consoleDir = (project: string) => join(project, ".console");
/**
 * macOS: the data tools run as the service account from the frozen code under .console/runtime, so these two directories
 * let others pass (0711), never list or read. Everything inside them stays private on its own (0700/0600).
 */
export const passable = () => process.platform === "darwin";

/**
 * Creates .console/ with 0700 and refuses one this identity does not own (e.g. first run under sudo, later run as the
 * rootless user), instead of changing its owner. Windows checks the account SID, owner and every existing DACL.
 */
export function prepareConsoleDir(dir: string): void {
  if (process.platform === "win32") {
    const sid = windowsPrivateOwner(dir);
    // The parent is protected before this first identity record is written.
    if (readOptional(join(dir, "owner.json")) === null) writeAtomic(join(dir, "owner.json"), JSON.stringify({ version: 1, sid }) + "\n");
    return;
  }
  mkdirSync(dir, { recursive: true, mode: passable() ? 0o711 : 0o700 });
  let stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${dir} 不是目录`);
  const uid = process.geteuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${dir} 的属主（UID ${stat.uid}）不是当前运行身份（UID ${uid}）。控制台需要用部署时的运维身份运行；` +
      `请换回该身份，不要改目录属主后混用两种身份。`);
  }
  if (passable() && stat.isDirectory() && (stat.mode & 0o777) === 0o700) { chmodSync(dir, 0o711); stat = lstatSync(dir); }
  if ((stat.mode & (passable() ? 0o066 : 0o077)) !== 0) {
    const mode = passable() ? "711" : "700";
    throw new Error(`${dir} 的权限是 ${(stat.mode & 0o777).toString(8)}，组或其他用户可以访问；请改为 ${mode} 后重试（chmod ${mode} .console）`);
  }
}

function readOptional(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`无法读取 ${path}：${(error as Error).message}`, { cause: error });
  }
}

export function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The saved port, null when none was saved. An invalid saved value is an error, not a silent fallback to 10001. */
export function readSavedPort(dir: string): number | null {
  const text = readOptional(join(dir, "port"));
  if (text === null) return null;
  try { return parsePort(text, ".console/port "); }
  catch (error) { throw new Error(`${(error as Error).message}；请用 --port <端口> 重新指定（成功启动后覆盖保存值）`); }
}

export function savePort(dir: string, port: number): void {
  writeAtomic(join(dir, "port"), `${port}\n`);
}

export interface InstanceRecord { format: 1; instanceId: string; pid: number; port: number; startedAt: number; version: string }

export function readInstance(dir: string): InstanceRecord | null {
  const text = readOptional(join(dir, "instance.json"));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<InstanceRecord>;
    if (value.format === 1 && typeof value.instanceId === "string" && Number.isInteger(value.pid) && Number.isInteger(value.port)
      && Number.isFinite(value.startedAt) && typeof value.version === "string") return value as InstanceRecord;
  } catch {}
  return null;
}

export function writeInstance(dir: string, record: InstanceRecord): void {
  writeAtomic(join(dir, "instance.json"), JSON.stringify(record) + "\n");
}

/** Removes the record only while it is still ours: a newer console may already have replaced it. */
export function removeInstance(dir: string, instanceId: string): void {
  if (readInstance(dir)?.instanceId === instanceId) rmSync(join(dir, "instance.json"), { force: true });
}

/**
 * Whether the recorded console still answers on its port with the same instance id. A stale record (crash, PID reuse,
 * another program on the port) is not a running console.
 */
export async function liveInstance(dir: string): Promise<InstanceRecord | null> {
  const record = readInstance(dir);
  if (!record) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/instance`, {
      headers: { "X-Console-Request": "1" }, signal: AbortSignal.timeout(1500), redirect: "error",
    });
    const body = await response.json() as { instanceId?: unknown };
    return response.ok && body.instanceId === record.instanceId ? record : null;
  } catch {
    return null;
  }
}
