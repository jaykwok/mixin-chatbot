/** Non-secret proof for a host process supervised on Linux, not another task queue or service. */
export interface HostProcessReceipt {
  id: string;
  commandDigest: string;
  directory: { dev: string; ino: string };
}
export interface LinuxTaskRecord extends HostProcessReceipt {
  kind: "linux-supervisor";
  version: 1;
  phase: "prepared" | "reaped";
}
export function validateHostProcess(value: unknown): asserts value is LinuxTaskRecord {
  const r = value as LinuxTaskRecord;
  if (!r || typeof r !== "object" || Array.isArray(r) || r.kind !== "linux-supervisor" || r.version !== 1
    || Object.keys(r).sort().join(",") !== "commandDigest,directory,id,kind,phase,version"
    || !/^[a-f0-9]{32}$/.test(r.id) || !/^[a-f0-9]{64}$/.test(r.commandDigest) || !["prepared", "reaped"].includes(r.phase)
    || !r.directory || typeof r.directory !== "object" || Object.keys(r.directory).sort().join(",") !== "dev,ino"
    || typeof r.directory.dev !== "string" || !/^\d+$/.test(r.directory.dev) || typeof r.directory.ino !== "string" || !/^\d+$/.test(r.directory.ino))
    throw new Error("Linux 宿主写入者记录不完整");
}
