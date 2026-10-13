// The task control root: manager identity (`manager.json`: ID and receipt key), the process-lifetime owner lock, and
// signed receipts (`receipts/<id>.json`). One instance per manager object; its checks are shared while in flight.
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ID_PATTERN } from "../../contracts/maintenance.ts";
import { decodeReceipt, signReceipt, verifyReceiptEnvelope, type Receipt, type ReceiptEnvelope } from "../../contracts/task-receipt.ts";
import { holdDirectory } from "../held-directory.ts";
import { taskOwner } from "../task-owner.ts";

/** Explicit storage dependency for allocation fault regressions; production uses ordinary held I/O. */
export interface TaskStorage {
  holdDirectory(base: string, names: readonly string[], create: boolean): Promise<Pick<Awaited<ReturnType<typeof holdDirectory>>, "identity" | "use" | "release">>;
  saveReceipt(path: string, envelope: ReceiptEnvelope, first: boolean): Promise<void>;
}
type Manager = { manager: string; key: Buffer; daemon: string };

async function privateRoot(root: string) {
  const info = await lstat(root);
  if (!info.isDirectory() || await realpath(root) !== root || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error("任务管理根必须是管理端拥有的普通 0700 目录");
}

async function readManager(root: string): Promise<{ manager: string; key: Buffer }> {
  const held = await holdDirectory(root, [], false);
  let saved: { manager: string; key: string };
  try { saved = JSON.parse((await held.use(entries => entries.read("manager.json")))!); } finally { await held.release(); }
  if (!ID_PATTERN.test(saved.manager) || !/^[a-f\d]{64}$/.test(saved.key)) throw new Error("任务管理身份损坏");
  return { manager: saved.manager, key: Buffer.from(saved.key, "hex") };
}

export class TaskControl {
  #ready: Promise<Manager & { ownerEpoch: string }> | undefined;
  #observation: Promise<Manager> | undefined;

  /** `deployment`: the mapping identity every receipt must carry (none without a deployment manifest). */
  constructor(readonly root: string, private readonly storage: TaskStorage, private readonly checkDaemon: () => Promise<string>,
    private readonly deployment: string | undefined) {}

  /** Create or open the control root under the owner lock, then check the daemon. In-flight and successful checks are
   * shared; a failure lets a later call recheck recovered dependencies. */
  initialize() {
    if (this.#ready) return this.#ready;
    const attempt = (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await privateRoot(this.root);
      const ownerEpoch = taskOwner(this.root);
      await mkdir(join(this.root, "receipts"), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      await mkdir(join(this.root, "snapshots"), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      for (const name of ["receipts", "snapshots"]) { const directory = await holdDirectory(this.root, [name], false); await directory.release(); }
      const keyPath = join(this.root, "manager.json");
      try { await writeFile(keyPath, JSON.stringify({ manager: randomUUID(), key: randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const saved = await readManager(this.root);
      const daemon = await this.checkDaemon();
      return { ...saved, daemon, ownerEpoch };
    })();
    this.#ready = attempt;
    void attempt.catch(() => { if (this.#ready === attempt) this.#ready = undefined; });
    return attempt;
  }

  /** Signed-receipt verification without taking the owner lock: a preview runs while the service owns it.
   * Creates nothing; callers of an observed view never change a receipt or a directory. */
  observed() {
    return this.#observation ??= (async () => {
      await privateRoot(this.root);
      const saved = await readManager(this.root);
      return { ...saved, daemon: await this.checkDaemon() };
    })().catch(error => { this.#observation = undefined; throw error; });
  }

  async save(receipt: Receipt, first = false) {
    const { key } = await this.initialize();
    await this.storage.saveReceipt(join(this.root, "receipts", receipt.id + ".json"), signReceipt(receipt, key), first);
  }

  async load(id: string, observe = false): Promise<Receipt> {
    if (!ID_PATTERN.test(id)) throw new Error("任务 ID 无效");
    const { key, manager, daemon } = observe ? await this.observed() : await this.initialize();
    const held = await holdDirectory(this.root, ["receipts"], false);
    let saved: unknown;
    try { saved = JSON.parse((await held.use(entries => entries.read(id + ".json")))!); } finally { await held.release(); }
    return decodeReceipt(verifyReceiptEnvelope(saved, key), { id, manager, daemon, deployment: this.deployment });
  }
}
