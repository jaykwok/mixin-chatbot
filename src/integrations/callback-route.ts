import { createHash } from "node:crypto";
import {
  CALLBACK_ROUTE_TTL,
  MAX_CALLBACK_ROUTES,
} from "../core/config.ts";

// 官方出站接口只按 callback key 路由；同一 key 一旦出现在多个群，继续回复会广播串群。
interface CallbackRouteState {
  groups: Set<string>;
  lastSeen: number;
}

const callbackRoutes = new Map<string, CallbackRouteState>();

export interface CallbackRouteObservation {
  safe: boolean;
  reason: "ok" | "conflict" | "capacity";
  fingerprint: string;
  groups: string[];
}

/** 回收长期未出现且从未冲突的 key；冲突记录在本进程内始终失败关闭。 */
export function cleanupCallbackRoutes(now = Date.now()): void {
  for (const [routeHash, state] of callbackRoutes) {
    if (
      state.groups.size === 1 &&
      now - state.lastSeen >= CALLBACK_ROUTE_TTL
    ) {
      callbackRoutes.delete(routeHash);
    }
  }
}

/**
 * 记录平台回传的 callback key 与群的关系。
 * 不保存或记录明文 key；发现同一 key 对应多个群后，对所有相关群失败关闭。
 */
export function observeCallbackRoute(
  callbackUrl: string,
  groupId: string
): CallbackRouteObservation {
  const now = Date.now();
  const parsed = new URL(callbackUrl);
  const callbackKey = parsed.searchParams.get("key") ?? "";
  const routeHash = createHash("sha256")
    .update(callbackKey, "utf8")
    .digest("hex");
  let state = callbackRoutes.get(routeHash);
  if (!state) {
    if (callbackRoutes.size >= MAX_CALLBACK_ROUTES) {
      cleanupCallbackRoutes(now);
    }
    if (callbackRoutes.size >= MAX_CALLBACK_ROUTES) {
      return {
        safe: false,
        reason: "capacity",
        fingerprint: routeHash.slice(0, 12),
        groups: [],
      };
    }
    state = { groups: new Set<string>(), lastSeen: now };
    callbackRoutes.set(routeHash, state);
  }
  state.lastSeen = now;
  state.groups.add(groupId);
  const safe = state.groups.size === 1;
  return {
    safe,
    reason: safe ? "ok" : "conflict",
    fingerprint: routeHash.slice(0, 12),
    groups: [...state.groups],
  };
}
