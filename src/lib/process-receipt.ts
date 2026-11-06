// Built-ins only. The parent durably authorizes a command before sending it; the Linux subreaper writes completion
// only after waitpid reports ECHILD. A missing/corrupt completion after authorization never means "nothing is running".
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostProcessReceipt } from "../contracts/ops-host-process.ts";
export interface ProcessReceipt extends HostProcessReceipt { path: string }

export function assertReceiptDirectory(receipt: ProcessReceipt): void {
  if (process.platform !== "linux" || !isAbsolute(receipt.path) || !receipt.path.endsWith("/" + receipt.id)
    || !/^[a-f0-9]{32}$/.test(receipt.id) || !/^[a-f0-9]{64}$/.test(receipt.commandDigest)) throw new Error("进程收尾记录参数无效");
  for (const path of [dirname(dirname(receipt.path)), dirname(receipt.path), receipt.path]) {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.geteuid!()) || (stat.mode & 0o077n) !== 0n
      || path === receipt.path && (String(stat.dev) !== receipt.directory.dev || String(stat.ino) !== receipt.directory.ino))
      throw new Error("进程收尾目录身份或权限变化，保留恢复记录");
  }
}
function bytes(receipt: ProcessReceipt, phase: "authorized" | "reaped"): string {
  return JSON.stringify({ version: 1, id: receipt.id, commandDigest: receipt.commandDigest, phase }) + "\n";
}
export function hasProcessReceipt(receipt: ProcessReceipt, phase: "authorized" | "reaped"): boolean {
  assertReceiptDirectory(receipt);
  let observed = false;
  try {
    const path = join(receipt.path, phase), before = lstatSync(path, { bigint: true }); observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n || before.uid !== BigInt(process.geteuid!()) || (before.mode & 0o077n) !== 0n) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1024n) throw new Error();
      const buffer = Buffer.alloc(1025); let length = 0, count: number;
      do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
      const text = buffer.subarray(0, length).toString("utf8"), after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
      if (text !== bytes(receipt, phase) || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs
        || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error();
    } finally { closeSync(fd); }
    assertReceiptDirectory(receipt); return true;
  } catch (error) {
    if (!observed && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("进程收尾凭据不完整或身份变化，未放行恢复");
  }
}
export function writeProcessReceipt(receipt: ProcessReceipt, phase: "authorized" | "reaped"): void {
  assertReceiptDirectory(receipt);
  const target = join(receipt.path, phase), temporary = join(receipt.path, ".receipt-" + randomUUID());
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes(receipt, phase)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    assertReceiptDirectory(receipt); linkSync(temporary, target); // Create-only publication, never overwrite another result.
    const directory = openSync(receipt.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
}
