// Task directories on disk: `<tmp>/.isolated-work/<id>/` holds the manager's `.manager-owner` marker and the worker's
// `work` directory. Removal acts only on a held directory whose identity (and marker, when given) matches the receipt.
import { join } from "node:path";
import type { Receipt } from "../../contracts/task-receipt.ts";
import { holdDirectory, type DirectoryRemoval } from "../held-directory.ts";
import { RemovalPermit } from "../reclamation.ts";

export const workPath = (receipt: Pick<Receipt, "temp" | "id">) => join(receipt.temp, ".isolated-work", receipt.id, "work");

type Entity = { dev: string; ino: string };
const same = (held: { dev: bigint; ino: bigint }, expected: Entity) => String(held.dev) === expected.dev && String(held.ino) === expected.ino;

/** Remove `base/name` as one held tree. With a receipt, both the parent and the entry must be its registered entities
 * (with `parent`/`entry`, these); with a nonce, the entry's marker must hold it. */
export async function removeTree(base: string, name: string, options: { nonce?: string; receipt?: Receipt; parent?: Entity; entry?: Entity } = {}): Promise<DirectoryRemoval> {
  const { nonce, receipt } = options;
  const parent = await holdDirectory(base, [], false);
  let child: Awaited<ReturnType<typeof holdDirectory>> | undefined, permit: RemovalPermit | undefined;
  try {
    child = await holdDirectory(base, [name], false);
    if (receipt && (!receipt.parentIdentity || !receipt.identity || String(parent.identity.dev) !== receipt.parentIdentity.dev || String(parent.identity.ino) !== receipt.parentIdentity.ino
      || String(child.identity.dev) !== receipt.identity.dev || String(child.identity.ino) !== receipt.identity.ino)) return { name, status: "deferred", reason: "registered-entity-moved-or-replaced" };
    if ((options.parent && !same(parent.identity, options.parent)) || (options.entry && !same(child.identity, options.entry))) return { name, status: "deferred", reason: "registered-entity-moved-or-replaced" };
    if (parent.identity.dev !== child.identity.dev) return { name, status: "deferred", reason: "different-device" };
    permit = new RemovalPermit(parent.identity, child.identity);
    const results = await parent.use(entries => entries.removeDirectories({ select: entry => entry === name, permit, requireRemoval: true,
      beforeRemove: async (_name, _time, entries) => {
        if (nonce !== undefined && await entries.read(".manager-owner") !== nonce) throw new Error("任务实体登记不匹配，保留目录");
        return true;
      } }));
    return results[0] ?? { name, status: "deferred", reason: "registered-entry-missing" };
  } finally { permit?.revoke(); try { await child?.release(); } finally { await parent.release(); } }
}

/** Manager-owned trees (snapshots, scratch): anything but a confirmed removal is an error. */
export async function removeInternalTree(base: string, name: string): Promise<void> {
  const result = await removeTree(base, name);
  if (result.status !== "removed") throw new Error(`内部任务目录未确认回收：${name}: ${result.reason}`);
}

/** The same, where an already absent tree is fine. */
export async function discardInternalTree(base: string, name: string): Promise<void> {
  try { await removeInternalTree(base, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Why an unfinished allocation's directory cannot yet be proven ours, or undefined when it can. */
export async function allocationProof(receipt: Receipt): Promise<string | undefined> {
  if (!receipt.parentIdentity || !receipt.identity) return "allocation-entity-unconfirmed";
  let parent: Awaited<ReturnType<typeof holdDirectory>> | undefined, child: Awaited<ReturnType<typeof holdDirectory>> | undefined;
  try {
    parent = await holdDirectory(receipt.temp, [".isolated-work"], false);
    child = await holdDirectory(receipt.temp, [".isolated-work", receipt.id], false);
    if (String(parent.identity.dev) !== receipt.parentIdentity.dev || String(parent.identity.ino) !== receipt.parentIdentity.ino
      || String(child.identity.dev) !== receipt.identity.dev || String(child.identity.ino) !== receipt.identity.ino) return "registered-entity-moved-or-replaced";
    if (await child.use(entries => entries.read(".manager-owner")) !== receipt.nonce) return "allocation-marker-unconfirmed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "allocation-entity-unconfirmed";
    throw error;
  } finally { try { await child?.release(); } finally { await parent?.release(); } }
}
