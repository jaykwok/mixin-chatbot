// A preview and its executor share an immutable read set. Verify only while holding the deployment lock.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const stateFiles = ["deploy-transaction", "upgrade-transaction", "update-transaction", "update-commit", "migration.json", "data-version.json"];
const snapshotFiles = ["transaction", "deployment.xml", "target-sha", "group-root", "was-running", "previous-image",
  "tunnel-running", "tunnel-command", "code-restore", "migration-plan.json"];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export type TransactionReadSet = { operation: "deploy" | "upgrade"; id: string; digest: string; text(path: string): string | null };
export type ConfirmedTransaction = { version: 1; operation: "deploy" | "upgrade"; id: string; digest: string; action: "continue" | "rollback" };

export function readTransaction(project: string): TransactionReadSet | null {
  const files = new Map<string, Buffer | null>();
  const read = (file: string) => {
    let bytes: Buffer | null;
    try { bytes = readFileSync(join(project, file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; bytes = null; }
    files.set(file, bytes);
    return bytes?.toString("utf8").replace(/^\uFEFF/, "") ?? null;
  };
  for (const name of stateFiles) read("data/state/" + name);
  const text = (file: string) => files.get(file)?.toString("utf8").replace(/^\uFEFF/, "") ?? null;
  const deploy = text("data/state/deploy-transaction")?.trim(), upgrade = text("data/state/upgrade-transaction")?.trim();
  for (const name of [deploy, upgrade]) if (name !== undefined && !/^deploy-[A-Za-z0-9]+$/.test(name)) throw new Error("事务快照名称无效");
  const legacy = text("data/state/update-transaction") !== null;
  if (!deploy && !upgrade && !legacy) return null;
  const id = upgrade ?? deploy ?? "legacy-update";
  for (const name of new Set([deploy, upgrade])) if (name) {
    for (const file of snapshotFiles) read(`backup/snapshots/${name}/${file}`);
  }
  const record = id === "legacy-update" ? "" : text(`backup/snapshots/${id}/transaction`) ?? "";
  const operation = upgrade || legacy || /^operation=upgrade$/m.test(record) ? "upgrade" : "deploy";
  const digest = hash(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([file, bytes]) => [file, bytes === null ? null : hash(bytes)])));
  return { operation, id, digest, text };
}

export function confirmTransaction(read: TransactionReadSet, action: ConfirmedTransaction["action"]): string {
  const value: ConfirmedTransaction = { version: 1, operation: read.operation, id: read.id, digest: read.digest, action };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function assertConfirmedTransaction(project: string, action: ConfirmedTransaction["action"], token: string): void {
  let expected: ConfirmedTransaction;
  try {
    if (token.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) throw new Error();
    expected = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    if (expected.version !== 1 || expected.action !== action || !["deploy", "upgrade"].includes(expected.operation)
      || !/^(deploy-[A-Za-z0-9]+|legacy-update)$/.test(expected.id) || !/^[0-9a-f]{64}$/.test(expected.digest)) throw new Error();
  } catch { throw new Error("事务确认凭据无效，请刷新预览后重新确认"); }
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
