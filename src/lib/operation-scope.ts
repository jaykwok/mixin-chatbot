import { createHash } from "node:crypto";
import { lstatSync, openSync, closeSync, readSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { historySpaces } from "./history-scan.ts";
import { readRelayIndex } from "../integrations/relay-index.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function historyScope(root: string, selection: string, phone?: string): Promise<string> {
  const spaces = (await historySpaces(root)).sort();
  const chosen = selection === "all" ? spaces : spaces.filter(space => space === selection);
  if (selection !== "all" && !chosen.length) throw new Error("选择的会话空间不存在");
  return hash([chosen, phone ?? null]);
}
export function relayScope(root: string, keyword?: string): string {
  const keys = readRelayIndex(join(root, "state/relay.sqlite")).filter(row => !keyword || row.name.includes(keyword) || row.url.includes(keyword))
    .map(row => row.key).sort();
  let config: string | null;
  try { config = readFileSync(join(root, "config/relay.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; config = null; }
  return hash([keys, config]);
}

/** Content fingerprint survives copying into a container; no original host path or inode is embedded. */
export function statsFileScope(path: string): string {
  const pieces = ["", "-wal"].map(suffix => {
    let stat;
    try { stat = lstatSync(path + suffix); } catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("统计文件必须是普通文件");
    const fd = openSync(path + suffix, "r"), digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count)); }
    finally { closeSync(fd); }
    return [suffix, stat.size, digest.digest("hex")];
  });
  return hash(pieces);
}

export function assertExpectedScope(expected: string | undefined, actual: string): void {
  if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual)) throw new Error("操作范围已变化，未执行；请重新预览并确认");
}

/** Extract one reserved option, preserving existing positional CLI parsing and rejecting duplicate/missing values. */
export function takeExpected(args: string[]): { args: string[]; expected?: string } {
  let expected: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--expect" || arg.startsWith("--expect=")) {
      if (expected !== undefined) throw new Error("--expect 不能重复");
      expected = arg === "--expect" ? args[++i] : arg.slice(9);
      if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("--expect 需要 SHA-256 摘要");
    } else rest.push(arg);
  }
  return { args: rest, expected };
}
