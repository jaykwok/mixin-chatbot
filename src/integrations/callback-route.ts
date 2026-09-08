// Bind callback keys to groups and quarantine conflicts before every outbound request.
import { createHash } from "node:crypto";
import { CALLBACK_ROUTE_TTL, GROUP_ID_PATTERN, MAX_CALLBACK_ROUTES, MAX_GROUP_ID_LENGTH } from "../core/config.ts";
import { stateDatabase } from "../core/state.ts";

export interface CallbackRouteObservation {
  safe: boolean; reason: "ok" | "conflict" | "capacity"; fingerprint: string; groups: string[];
}
interface Route { hash: string; group_id: string; conflict: string | null; seen: number; }
interface CallbackRouteEntry {
  fingerprint: string; groupId: string; conflictingGroupId: string | null; seenAt: number;
}
const controllers = new Map<string, AbortController>();
function db() {
  const db = stateDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS callback_routes (hash TEXT PRIMARY KEY, group_id TEXT NOT NULL, conflict TEXT, seen INTEGER NOT NULL)");
  return db;
}
function hash(url: string): string {
  return createHash("sha256").update(new URL(url).searchParams.get("key") ?? "").digest("hex");
}
function controller(key: string): AbortController {
  let value = controllers.get(key);
  if (!value) { value = new AbortController(); controllers.set(key, value); }
  return value;
}
export function cleanupCallbackRoutes(now = Date.now()): void {
  const database = db();
  // Expiring a binding also cancels work holding its previous signal.
  const stale = database.query("SELECT hash FROM callback_routes WHERE conflict IS NULL AND seen < ?").all(now - CALLBACK_ROUTE_TTL) as { hash: string }[];
  for (const row of stale) {
    controller(row.hash).abort(new Error("回调路由观察已过期"));
    controllers.delete(row.hash);
    database.query("DELETE FROM callback_routes WHERE hash = ? AND conflict IS NULL").run(row.hash);
  }
}

function view(route: Route): CallbackRouteEntry {
  return { fingerprint: route.hash, groupId: route.group_id, conflictingGroupId: route.conflict, seenAt: route.seen };
}

/** Only hashes and group identifiers are exposed; callback credentials never enter the CLI. */
export function listCallbackRoutes(): CallbackRouteEntry[] {
  return (db().query("SELECT * FROM callback_routes ORDER BY seen, hash").all() as Route[]).map(view);
}

function findRoute(fingerprint: string): Route {
  if (!/^[a-f0-9]{12,64}$/i.test(fingerprint)) throw new Error("指纹必须是 12–64 位十六进制字符");
  const matches = db().query("SELECT * FROM callback_routes WHERE hash LIKE ?").all(fingerprint.toLowerCase() + "%") as Route[];
  if (!matches.length) throw new Error("未找到该回调路由指纹");
  if (matches.length !== 1) throw new Error("指纹前缀匹配多条路由，请使用 list 输出的完整指纹");
  return matches[0]!;
}

function invalidate(key: string): void {
  controllers.get(key)?.abort(new Error("回调路由已由运维调整，旧交付已取消"));
  controllers.delete(key);
}

/** Caller must hold the maintenance lease after correcting the platform's key/group assignment. */
export function resetCallbackRoute(fingerprint: string, groupId: string): CallbackRouteEntry {
  if (!groupId.trim() || groupId.length > MAX_GROUP_ID_LENGTH || !GROUP_ID_PATTERN.test(groupId)) {
    throw new Error("目标群号无效");
  }
  const database = db();
  const route = database.transaction(() => {
    const current = findRoute(fingerprint);
    const seen = Date.now();
    database.query("UPDATE callback_routes SET group_id = ?, conflict = NULL, seen = ? WHERE hash = ?")
      .run(groupId, seen, current.hash);
    return { ...current, group_id: groupId, conflict: null, seen };
  })();
  invalidate(route.hash);
  return view(route);
}

/** Caller must hold the maintenance lease. Removing a retired binding allows a future observation to bind it anew. */
export function forgetCallbackRoute(fingerprint: string): void {
  const database = db();
  const route = database.transaction(() => {
    const current = findRoute(fingerprint);
    database.query("DELETE FROM callback_routes WHERE hash = ?").run(current.hash);
    return current;
  })();
  invalidate(route.hash);
}

export function observeCallbackRoute(callbackUrl: string, groupId: string): CallbackRouteObservation {
  const key = hash(callbackUrl);
  const database = db();
  const result = database.transaction((): CallbackRouteObservation => {
    let route = database.query("SELECT * FROM callback_routes WHERE hash = ?").get(key) as Route | null;
    if (!route) {
      const { count } = database.query("SELECT COUNT(*) AS count FROM callback_routes").get() as { count: number };
      if (count >= MAX_CALLBACK_ROUTES) return { safe: false, reason: "capacity", fingerprint: key.slice(0, 12), groups: [] };
      database.query("INSERT INTO callback_routes VALUES (?, ?, NULL, ?)").run(key, groupId, Date.now());
      route = { hash: key, group_id: groupId, conflict: null, seen: Date.now() };
    }
    const conflict = route.conflict ?? (route.group_id !== groupId ? groupId : null);
    database.query("UPDATE callback_routes SET conflict = ?, seen = ? WHERE hash = ?").run(conflict, Date.now(), key);
    return { safe: !conflict, reason: conflict ? "conflict" : "ok", fingerprint: key.slice(0, 12),
      groups: conflict ? [route.group_id, conflict] : [groupId] };
  })();
  if (result.reason === "conflict") controller(key).abort(new Error("callback key 路由冲突，已停止交付"));
  return result;
}

/** Returned signal also cancels already queued/in-flight sends when a conflict is discovered. */
export function callbackDeliverySignal(url: string, groupId?: string): AbortSignal {
  if (groupId && !observeCallbackRoute(url, groupId).safe) throw new Error("callback key 无法安全路由到当前群");
  const key = hash(url);
  const route = db().query("SELECT conflict FROM callback_routes WHERE hash = ?").get(key) as { conflict: string | null } | null;
  if (!route) throw new Error("callback key 尚未绑定群，禁止交付");
  if (route?.conflict) controller(key).abort(new Error("callback key 已隔离，禁止继续交付"));
  return controller(key).signal;
}
