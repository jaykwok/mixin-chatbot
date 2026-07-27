import { createHash } from "node:crypto";

// 官方出站接口只按 callback key 路由；同一 key 一旦出现在多个群，继续回复会广播串群。
const callbackRouteGroups = new Map<string, Set<string>>();

export interface CallbackRouteObservation {
  safe: boolean;
  fingerprint: string;
  groups: string[];
}

/**
 * 记录平台回传的 callback key 与群的关系。
 * 不保存或记录明文 key；发现同一 key 对应多个群后，对所有相关群失败关闭。
 */
export function observeCallbackRoute(
  callbackUrl: string,
  groupId: string
): CallbackRouteObservation {
  const parsed = new URL(callbackUrl);
  const callbackKey = parsed.searchParams.get("key") ?? "";
  const routeHash = createHash("sha256")
    .update(callbackKey, "utf8")
    .digest("hex");
  let groups = callbackRouteGroups.get(routeHash);
  if (!groups) {
    groups = new Set<string>();
    callbackRouteGroups.set(routeHash, groups);
  }
  groups.add(groupId);
  return {
    safe: groups.size === 1,
    fingerprint: routeHash.slice(0, 12),
    groups: [...groups],
  };
}
