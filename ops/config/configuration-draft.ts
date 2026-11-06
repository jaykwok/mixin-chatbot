// Private draft format shared by the host editor and offline configuration publisher. No console/runtime dependencies.
import { configurationFiles, configurationHash, configurationKind, type ConfigurationSnapshot } from "./configuration-form.ts";

export interface ConfigurationDraft {
  version: 1; id: string; session: string; createdAt: number; expiresAt: number; revision: number;
  base: ConfigurationSnapshot; next: ConfigurationSnapshot;
  validated?: { digest: string; summary: string[]; at: number };
}
export function configurationDigest(draft: Pick<ConfigurationDraft, "base" | "next">): string {
  return configurationHash(JSON.stringify([draft.base, draft.next]))!;
}
/** Never includes the supplied bytes in an error. */
export function parseConfigurationDraft(raw: string, id: string): ConfigurationDraft {
  let value: ConfigurationDraft;
  try { if (Buffer.byteLength(raw) > 40 * 1024 * 1024) throw new Error(); value = JSON.parse(raw); }
  catch { throw new Error("配置草稿损坏，已保留现场"); }
  if (!/^config-[a-f0-9]{32}$/.test(id) || !value || value.version !== 1 || value.id !== id || typeof value.session !== "string" || !Number.isSafeInteger(value.revision)
    || !Number.isFinite(value.expiresAt) || !Number.isFinite(value.createdAt) || !value.base || !value.next || value.base.kind !== value.next.kind) throw new Error("配置草稿格式不支持");
  const kind = configurationKind(value.base.kind), keys = configurationFiles(kind);
  for (const snapshot of [value.base, value.next]) {
    if (!snapshot.files || typeof snapshot.files !== "object" || Object.keys(snapshot.files).some(key => !keys.includes(key as typeof keys[number]))
      || keys.some(key => snapshot.files[key] !== null && typeof snapshot.files[key] !== "string")
      || (snapshot.binding !== null && (typeof snapshot.binding !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.binding)))) throw new Error("配置草稿文件清单无效");
  }
  return value;
}
