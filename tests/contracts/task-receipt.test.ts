import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContractError } from "../../src/contracts/maintenance.ts";
import { decodeReceipt, signReceipt, verifyReceiptEnvelope, type Receipt } from "../../src/contracts/task-receipt.ts";

const id = "11111111-2222-4333-8444-555555555555", manager = "66666666-7777-4888-8999-aaaaaaaaaaaa", daemon = "daemon-1";
const key = Buffer.alloc(32, 7), expected = { id, manager, daemon, deployment: undefined };
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error as Error; } throw new Error("decoded"); };

/** The oldest receipt T0 accepts: every optional field left out. */
async function minimal(): Promise<Record<string, any>> {
  const template = await readFile(join(import.meta.dir, "../fixtures/maintenance-formats/receipt-v2-minimal.payload.json"), "utf8");
  return JSON.parse(template.replace('"<ID>"', JSON.stringify(id)).replace('"<NONCE>"', JSON.stringify("e".repeat(64)))
    .replace('"<MANAGER>"', JSON.stringify(manager)).replace('"<DAEMON>"', JSON.stringify(daemon))
    .replace('"<IMAGE>"', JSON.stringify("sha256:" + "f".repeat(64))).replace('"<TEMP>"', JSON.stringify(resolve("/srv/groups/g/users/u/tmp"))));
}

describe("receipt envelopes", () => {
  test("the signature covers the saved text, checked before parsing", async () => {
    const receipt = await minimal(), envelope = signReceipt(receipt as Receipt, key);
    expect(decodeReceipt(verifyReceiptEnvelope(envelope, key), expected)).toEqual(receipt as Receipt);
    // Other whitespace is other bytes: the same receipt re-serialized does not verify under the old signature.
    const reformatted = { ...envelope, payload: JSON.stringify(receipt, null, 1) };
    expect(failure(() => verifyReceiptEnvelope(reformatted, key)).message).toBe("任务回执签名无效，保留目录");
    // ...while a text signed as saved verifies as is, whatever its formatting.
    const spaced = JSON.stringify(receipt, null, 1);
    const signed = { payload: spaced, signature: createHmac("sha256", key).update(spaced).digest("hex") };
    expect(decodeReceipt(verifyReceiptEnvelope(signed, key), expected).id).toBe(id);
    for (const bad of [null, [], { payload: envelope.payload }, { ...envelope, signature: envelope.signature.toUpperCase() },
      { ...envelope, payload: envelope.payload + " " }]) {
      const error = failure(() => verifyReceiptEnvelope(bad, key));
      expect(error).toBeInstanceOf(ContractError);
      expect(error.message).toBe("任务回执签名无效，保留目录");
    }
    expect(failure(() => verifyReceiptEnvelope(envelope, Buffer.alloc(32, 8))).message).toBe("任务回执签名无效，保留目录");
  });

  test("another deployment mapping is refused first, with its own message", async () => {
    const receipt = { ...await minimal(), deployment: "mapping-a", version: 3 };
    expect(failure(() => decodeReceipt(JSON.stringify(receipt), expected)).message).toBe("任务部署映射已变化，拒绝按当前映射操作旧回执");
    expect(failure(() => decodeReceipt(JSON.stringify({ ...receipt, version: 2 }), { ...expected, deployment: "mapping-b" })).message)
      .toBe("任务部署映射已变化，拒绝按当前映射操作旧回执");
    expect(decodeReceipt(JSON.stringify({ ...receipt, version: 2 }), { ...expected, deployment: "mapping-a" }).deployment).toBe("mapping-a");
  });

  test("each receipt rule names its field", async () => {
    const base = await minimal(), evidence = { dev: "1", ino: "2", uid: 1000, fingerprint: "a".repeat(64), bytes: 1, files: 1, newest: 1 };
    const cases: [string, Record<string, unknown> | unknown[]][] = [
      ["回执", []],
      ["version", { version: 1 }],
      ["id", { id: manager }],
      ["manager", { manager: id }],
      ["daemon", { daemon: "other" }],
      ["image", { image: "busybox" }],
      ["phase", { phase: "deleted" }],
      ["nonce", { nonce: "E".repeat(64) }],
      ["containers", { containers: ["c"] }],
      ["pendingNames", { pendingNames: [`mixin-task-${manager}-1`] }],
      ["mounts", { mounts: null }],
      ["role", { role: "admin" }],
      ["resultName", { resultName: "1-r.txt" }],
      ["archive", { archive: { destination: "relative", evidence } }],
      ["archive（归档阶段缺少归档记录）", { phase: "archived" }],
      ["ownerEpoch", { ownerEpoch: "x" }],
      ["role（结果回执不能有容器）", { role: "results", pendingNames: [`mixin-task-${id}-1`] }],
      ["allocation", { allocation: { step: "started" } }],
      ["allocation", { allocation: null }],
      ["allocation（分配阶段不能有容器）", { phase: "allocating" }],
      ["allocation（分配阶段不能有容器）", { phase: "allocation-failed", allocation: { step: "reserved" }, containers: ["c".repeat(64)] }],
      ["createdAt", { createdAt: null }],
      ["pid", { pid: 0 }],
      ["temp", { temp: "relative/tmp" }],
    ];
    for (const [field, change] of cases) {
      const payload = Array.isArray(change) ? JSON.stringify(change) : JSON.stringify({ ...base, ...change });
      const error = failure(() => decodeReceipt(payload, expected));
      expect(error).toBeInstanceOf(ContractError);
      expect(error.message).toBe(`任务回执位置或身份不匹配，保留目录：${field}`);
    }
    const results = { ...base, role: "results", resultName: "1-r.txt", phase: "archived", archive: { destination: resolve("/srv/rm/x"), evidence },
      ownerEpoch: manager, allocation: { step: "work-created", error: "late" } };
    expect(decodeReceipt(JSON.stringify(results), expected).resultName).toBe("1-r.txt");
  });
});
