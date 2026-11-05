// A preview and its executor share an immutable read set. Verify only while holding the deployment lock.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";

const stateFiles = ["deploy-transaction", "upgrade-transaction", "release-data.json", "data-version.json", "verify-only", "ops-deployment.json"];
const snapshotFiles = ["transaction", "deployment.xml", "target-sha", "was-running", "previous-image", "data-plan.json",
  "directory-scope-plan.json", "revision-cleanup", "candidate-image", "service-user", "task-runtime", "task-previous-cid", "host-runtime",
  "runtime-values.json", "configuration-app.json", "configuration-models.json", "windows-tools"];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export type TransactionReadSet = { operation: "deploy" | "upgrade"; id: string; digest: string; text(path: string): string | null };
export type ConfirmedTransaction = { version: 1; operation: "deploy" | "upgrade"; id: string; digest: string; action: "continue" | "rollback" };

const MAX_FILE = 8 * 1024 * 1024, MAX_READ_SET = 32 * 1024 * 1024;
const decode = (bytes: Buffer, file: string) => new TextDecoder(file.endsWith("/deployment.xml") && bytes[0] === 0xff && bytes[1] === 0xfe
  ? "utf-16le" : "utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
/** This file is also exported alone by the CLI before installing dependencies: keep it built-ins only. */
function readOrdinary(project: string, file: string): Buffer | null {
  const components = file.split("/");
  let observed = false;
  try {
    // Reject dangling links as well as working links; ENOENT alone means absent.
    for (let i = 1; i < components.length; i++) {
      const stat = lstatSync(join(project, ...components.slice(0, i)));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    }
    const path = join(project, file), before = lstatSync(path, { bigint: true }); observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FILE)) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error();
      const buffer = Buffer.alloc(Number(opened.size) + 1); let length = 0, count: number;
      do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
      const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
      if (length !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error();
      const bytes = buffer.subarray(0, length); decode(bytes, file); return bytes;
    } finally { closeSync(fd); }
  } catch (error) {
    if (!observed && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // A file which disappeared after lstat is not a coherent snapshot. The next capture may retry.
      // Parent absence is ordinary only when it is not concealed behind a dangling link (checked above).
      for (let i = 1; i < components.length; i++) {
        try {
          const stat = lstatSync(join(project, ...components.slice(0, i)));
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("事务目录不是普通目录");
        } catch (parentError) { if ((parentError as NodeJS.ErrnoException).code === "ENOENT") return null; throw parentError; }
      }
      try { lstatSync(join(project, file)); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null; }
    }
    throw new Error("无法可靠读取事务记录：" + file);
  }
}

export function readTransaction(project: string): TransactionReadSet | null {
  project = resolve(project);
  const files = new Map<string, Buffer | null>();
  let total = 0;
  const read = (file: string) => {
    const bytes = readOrdinary(project, file);
    total += bytes?.length ?? 0;
    if (total > MAX_READ_SET) throw new Error("事务记录过大，未继续读取");
    files.set(file, bytes);
    return bytes === null ? null : decode(bytes, file);
  };
  for (const name of stateFiles) read("data/state/" + name);
  const text = (file: string) => { const bytes = files.get(file); return bytes == null ? null : decode(bytes, file); };
  const deploy = text("data/state/deploy-transaction")?.trim(), upgrade = text("data/state/upgrade-transaction")?.trim();
  for (const name of [deploy, upgrade]) if (name !== undefined && !/^deploy-[A-Za-z0-9]+$/.test(name)) throw new Error("事务快照名称无效");
  if (!deploy && !upgrade) return null;
  const id = (upgrade ?? deploy)!;
  for (const name of new Set([deploy, upgrade])) if (name) {
    for (const file of snapshotFiles) read(`backup/snapshots/${name}/${file}`);
  }
  const record = text(`backup/snapshots/${id}/transaction`) ?? "";
  const operation = upgrade || /^operation=upgrade$/m.test(record) ? "upgrade" : "deploy";
  const digest = hash(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([file, bytes]) => [file, bytes === null ? null : hash(bytes)])));
  return { operation, id, digest, text };
}

export function confirmTransaction(read: TransactionReadSet, action: ConfirmedTransaction["action"]): string {
  const value: ConfirmedTransaction = { version: 1, operation: read.operation, id: read.id, digest: read.digest, action };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function parseConfirmedTransaction(action: ConfirmedTransaction["action"], token: string): ConfirmedTransaction {
  let expected: ConfirmedTransaction;
  try {
    if (token.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) throw new Error();
    expected = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (expected.version !== 1 || expected.action !== action || !["deploy", "upgrade"].includes(expected.operation)
      || !/^deploy-[A-Za-z0-9]+$/.test(expected.id) || !/^[0-9a-f]{64}$/.test(expected.digest)) throw new Error();
  } catch { throw new Error("事务确认凭据无效，请刷新预览后重新确认"); }
  return expected;
}

export function assertConfirmedTransaction(project: string, action: ConfirmedTransaction["action"], token: string): void {
  const expected = parseConfirmedTransaction(action, token);
  const actual = readTransaction(project);
  if (!actual || actual.operation !== expected.operation || actual.id !== expected.id || actual.digest !== expected.digest) {
    throw new Error("确认后事务或记录已变化，本次动作未执行；请刷新预览后重新确认");
  }
}

if (import.meta.main) {
  const [project, action, token] = process.argv.slice(2);
  try {
    if (!project || !token || !["continue", "rollback"].includes(action ?? "")) throw new Error("事务确认参数无效");
    assertConfirmedTransaction(resolve(project), action as ConfirmedTransaction["action"], token);
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
