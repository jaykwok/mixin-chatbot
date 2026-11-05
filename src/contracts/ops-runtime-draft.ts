export interface OpsRuntimeDraft {
  name: string; digest: string; dev: string; ino: string; uid: number; phase: "captured" | "removed";
}
export function validateOpsRuntimeDraft(value: unknown): asserts value is OpsRuntimeDraft {
  const v = value as OpsRuntimeDraft;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "dev,digest,ino,name,phase,uid"
    || typeof v.name !== "string" || !/^\.runtime-draft-[a-f0-9-]{36}\.json$/.test(v.name)
    || typeof v.digest !== "string" || !/^[a-f0-9]{64}$/.test(v.digest) || typeof v.dev !== "string" || !/^\d+$/.test(v.dev) || typeof v.ino !== "string" || !/^\d+$/.test(v.ino)
    || !Number.isSafeInteger(v.uid) || v.uid < 0 || !["captured", "removed"].includes(v.phase)) throw new Error("运行参数草稿恢复记录无效");
}
