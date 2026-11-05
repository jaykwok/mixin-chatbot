/** The only writable report mount is project/tmp/backup-cleanup; the path is derived by the host. */
export interface OpsReports { dev: string; ino: string; uid: number; gid: number }
export function validateOpsReports(value: unknown): asserts value is OpsReports {
  const record = value as OpsReports;
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join(",") !== "dev,gid,ino,uid"
    || ![record.dev, record.ino].every(v => typeof v === "string" && /^\d+$/.test(v))
    || ![record.uid, record.gid].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff)) throw new Error("备份报告目录记录不完整");
}
