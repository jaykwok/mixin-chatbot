/** Only size and SHA-256 may enter the durable host record. Payloads stay in process memory and pipes. */
export interface OpsTaskInput { bytes: number; digest: string }
export function validateOpsTaskInput(value: unknown): asserts value is OpsTaskInput {
  const v = value as OpsTaskInput;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "bytes,digest"
    || !Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.bytes > 40 * 1024 * 1024
    || typeof v.digest !== "string" || !/^[a-f0-9]{64}$/.test(v.digest)) throw new Error("维护输入记录无效");
}
