// Signed isolated-task receipts (receipts/<id>.json under the task management root): an envelope with the receipt's
// exact JSON text and its HMAC. The signature covers that text as saved; it is checked before the text is parsed and
// the text is never re-serialized for checking.
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { ContractError, ID_PATTERN, RESULT_NAME, validTreeEvidence, type TreeEvidence } from "./maintenance.ts";

export const IMAGE_PATTERN = /^sha256:[a-f\d]{64}$/;
export const RECEIPT_PHASES = ["allocating", "allocation-failed", "active", "stopping", "writers-reaped", "reclaiming", "removed", "archiving", "archived"] as const;
export const ALLOCATION_STEPS = ["reserved", "entity-registered", "marker-written", "work-created"] as const;
export type ReceiptPhase = typeof RECEIPT_PHASES[number];
export type TaskMount = { source: string; target: string; writable: boolean };

export interface Receipt {
  version: 2; id: string; nonce: string; manager: string; daemon: string; image: string;
  deployment?: string;
  ownerEpoch?: string;
  temp: string; createdAt: number; pid: number; phase: ReceiptPhase; containers: string[];
  pendingNames: string[];
  role?: "worker" | "results";
  resultName?: string;
  archive?: { destination: string; evidence: TreeEvidence };
  allocation?: { step: typeof ALLOCATION_STEPS[number]; error?: string };
  mounts: Record<string, TaskMount[]>;
  reclamation?: { attemptedAt: number; nextAttemptAt: number; reason?: string };
  parentIdentity?: { dev: string; ino: string }; identity?: { dev: string; ino: string };
}
export interface ReceiptEnvelope { payload: string; signature: string }

export function signReceipt(receipt: Receipt, key: Buffer): ReceiptEnvelope {
  const payload = JSON.stringify(receipt);
  return { payload, signature: createHmac("sha256", key).update(payload).digest("hex") };
}

/** The receipt text of a saved envelope whose signature verifies under the manager key. */
export function verifyReceiptEnvelope(saved: unknown, key: Buffer): string {
  const envelope = saved as Partial<ReceiptEnvelope> | null;
  if (!envelope || typeof envelope !== "object" || typeof envelope.payload !== "string" || typeof envelope.signature !== "string"
    || !/^[a-f\d]{64}$/.test(envelope.signature)
    || !timingSafeEqual(Buffer.from(envelope.signature, "hex"), createHmac("sha256", key).update(envelope.payload).digest())) {
    throw new ContractError("任务回执签名无效，保留目录");
  }
  return envelope.payload;
}

const PLACE = "任务回执位置或身份不匹配，保留目录";
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function need(ok: boolean, field: string): asserts ok { if (!ok) throw new ContractError(`${PLACE}：${field}`); }
const resolved = (value: unknown) => typeof value === "string" && resolve(value) === value;

/** A verified receipt text for this task, manager, daemon and deployment mapping. A receipt made under another
 * mapping is refused first, with its own message: its paths must not be read through the current mapping. */
export function decodeReceipt(payload: string, expected: { id: string; manager: string; daemon: string; deployment: string | undefined }): Receipt {
  const receipt: unknown = JSON.parse(payload);
  need(isObject(receipt) && !Array.isArray(receipt), "回执");
  if (receipt.deployment !== expected.deployment) throw new ContractError("任务部署映射已变化，拒绝按当前映射操作旧回执");
  const { id } = expected, phase = receipt.phase;
  need(receipt.version === 2, "version");
  need(receipt.id === id, "id");
  need(receipt.manager === expected.manager, "manager");
  need(receipt.daemon === expected.daemon, "daemon");
  need(typeof receipt.image === "string" && IMAGE_PATTERN.test(receipt.image), "image");
  need(RECEIPT_PHASES.includes(phase as ReceiptPhase), "phase");
  need(typeof receipt.nonce === "string" && /^[a-f\d]{64}$/.test(receipt.nonce), "nonce");
  const { containers, pendingNames } = receipt;
  need(Array.isArray(containers) && containers.every(cid => typeof cid === "string" && /^[a-f\d]{64}$/.test(cid)), "containers");
  const pending = new RegExp(`^mixin-task-${id}-[0-9]+$`);
  need(Array.isArray(pendingNames) && pendingNames.every(name => typeof name === "string" && pending.test(name)), "pendingNames");
  need(isObject(receipt.mounts), "mounts");
  need(receipt.role === undefined || receipt.role === "worker" || receipt.role === "results", "role");
  need(receipt.resultName === undefined || receipt.role === "results" && typeof receipt.resultName === "string" && RESULT_NAME.test(receipt.resultName), "resultName");
  const archive = receipt.archive;
  need(archive === undefined || isObject(archive) && resolved(archive.destination) && validTreeEvidence(archive.evidence), "archive");
  need(!(phase === "archiving" || phase === "archived") || archive !== undefined, "archive（归档阶段缺少归档记录）");
  need(receipt.ownerEpoch === undefined || typeof receipt.ownerEpoch === "string" && ID_PATTERN.test(receipt.ownerEpoch), "ownerEpoch");
  need(receipt.role !== "results" || containers.length === 0 && pendingNames.length === 0, "role（结果回执不能有容器）");
  const allocation = receipt.allocation;
  need(allocation === undefined || isObject(allocation) && ALLOCATION_STEPS.includes(allocation.step as typeof ALLOCATION_STEPS[number])
    && (allocation.error === undefined || typeof allocation.error === "string"), "allocation");
  need(!(phase === "allocating" || phase === "allocation-failed") || allocation !== undefined && containers.length === 0 && pendingNames.length === 0,
    "allocation（分配阶段不能有容器）");
  need(Number.isFinite(receipt.createdAt), "createdAt");
  need(Number.isSafeInteger(receipt.pid) && (receipt.pid as number) >= 1, "pid");
  need(resolved(receipt.temp), "temp");
  return receipt as unknown as Receipt;
}
