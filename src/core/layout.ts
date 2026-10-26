import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isPathInside } from "../contracts/paths.ts";
import { DATA_DIR } from "./storage.ts";

/**
 * 应用数据布局的唯一解析入口。一个部署实例对应一个机器人应用：全部单聊和群聊读取同一份 workspace，
 * 会话库按空间（单聊共用一个库、每群一个库）隔离，临时文件按空间、用户和请求隔离。
 *
 *   <data>/workspace                         默认共享资料（WORKSPACE_ROOT 可指向外置目录），模型只读
 *   <data>/index/                            公共资料索引、manifest 与公共解析缓存（可重建）
 *   <data>/config/materials-ignore.txt       管理员维护的索引排除规则
 *   <data>/runtime/document-env              原生部署共享的文档解析环境
 *   <data>/state/stats.sqlite                统计账本
 *   <data>/state/reclamation/                离线回收计划、快照与归档
 *   <data>/conversations/direct/durable.sqlite
 *   <data>/conversations/groups/<群>/durable.sqlite
 *   <data>/tmp/direct/<用户>/                单聊用户 tmp（received/ 附件，tasks/<请求>/ 产物）
 *   <data>/tmp/groups/<群>/<用户>/           群成员 tmp
 */
export interface Layout {
  readonly data: string;
  readonly workspace: string;
  /** True when WORKSPACE_ROOT names a directory the operator manages; it must exist and is never created or chowned. */
  readonly externalWorkspace: boolean;
  readonly index: string;
  readonly materialsIndex: string;
  readonly materialsIgnore: string;
  readonly documentEnv: string;
  readonly state: string;
  readonly stats: string;
  readonly reclamation: string;
  readonly conversations: string;
  readonly tmp: string;
}

/** A conversation space: all direct chats share one, each group has its own. */
export type Scope = { readonly kind: "direct" } | { readonly kind: "group"; readonly groupId: string };

export const DIRECT_SCOPE: Scope = Object.freeze({ kind: "direct" });

export function groupScope(groupId: string): Scope {
  if (!groupId) throw new Error("群号为空");
  return { kind: "group", groupId };
}

/** In-memory key of a scope; group ids never collide with the direct space. */
export function scopeKey(scope: Scope): string {
  return scope.kind === "direct" ? "direct" : `group:${scope.groupId}`;
}

/** The scope a key names (inverse of `scopeKey`), or undefined for anything else. */
export function parseScopeKey(key: string): Scope | undefined {
  if (key === "direct") return DIRECT_SCOPE;
  return key.startsWith("group:") && key.length > "group:".length ? { kind: "group", groupId: key.slice("group:".length) } : undefined;
}

/** Log/display label of a scope. */
export function scopeLabel(scope: Scope): string {
  return scope.kind === "direct" ? "单聊" : `群 ${scope.groupId}`;
}

/**
 * Storage path of a space below conversations/ and tmp/: `direct` or `groups/<segment>`.
 * Offline tools only see segments, so they name spaces this way.
 */
export function spacePath(scope: Scope): string {
  return scope.kind === "direct" ? "direct" : `groups/${groupSegment(scope.groupId)}`;
}

/** Statistics source segment; kept as before (direct chats `direct`, groups their segment) so old ledgers continue. */
export function statsSegment(scope: Scope): string {
  return scope.kind === "direct" ? "direct" : groupSegment(scope.groupId);
}

const SAFE_SEGMENT = /^[A-Za-z0-9_+\-]{1,64}$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Convert an external group id into one safe, cross-platform directory segment.
 * Unsafe/long/reserved ids use a tagged full SHA-256 digest so they cannot escape
 * the data root or collide with a directly-used safe id.
 */
export function groupSegment(groupId: string): string {
  if (SAFE_SEGMENT.test(groupId) && !WINDOWS_RESERVED_SEGMENT.test(groupId)) return groupId;
  return `sha256-${createHash("sha256").update(groupId, "utf8").digest("hex")}`;
}

/** Keep normal phone/user ids readable while avoiding Windows device names. */
export function userSegment(phone: string): string {
  if (SAFE_SEGMENT.test(phone) && !WINDOWS_RESERVED_SEGMENT.test(phone)) return phone;
  return `sha256-user-${createHash("sha256").update(phone, "utf8").digest("hex")}`;
}

/** True for a name `groupSegment`/`userSegment` can produce, so discovery refuses anything else. */
export function isSegment(name: string): boolean {
  return (SAFE_SEGMENT.test(name) && !WINDOWS_RESERVED_SEGMENT.test(name)) || /^sha256-(?:user-)?[0-9a-f]{64}$/.test(name);
}

const REQUEST_ID = /^msg:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Directory name of a durable request (`msg:<uuid>` → `msg-<uuid>`); the same request always maps to the same directory. */
export function requestSegment(requestId: string): string {
  const match = REQUEST_ID.exec(requestId);
  if (!match) throw new Error(`请求标识格式不符：${requestId}`);
  return `msg-${match[1]}`;
}

export function appLayout(data: string = DATA_DIR, workspaceRoot?: string): Layout {
  const fallback = join(data, "workspace");
  const configured = workspaceRoot?.trim() ? resolve(workspaceRoot.trim()) : undefined;
  return {
    data,
    workspace: configured ?? fallback,
    externalWorkspace: !!configured && configured !== resolve(fallback),
    index: join(data, "index"),
    materialsIndex: join(data, "index", "materials.md"),
    materialsIgnore: join(data, "config", "materials-ignore.txt"),
    documentEnv: join(data, "runtime", "document-env"),
    state: join(data, "state"),
    stats: join(data, "state", "stats.sqlite"),
    reclamation: join(data, "state", "reclamation"),
    conversations: join(data, "conversations"),
    tmp: join(data, "tmp"),
  };
}

export function spaceDatabase(layout: Pick<Layout, "conversations">, scope: Scope): string {
  return join(layout.conversations, spacePath(scope), "durable.sqlite");
}

/** A space's tmp directory: the parent of its users' tmp directories. */
export function spaceTmp(layout: Pick<Layout, "tmp">, scope: Scope): string {
  return join(layout.tmp, spacePath(scope));
}

/** A member's tmp: inbound attachments, the managed task/result directories and one directory per request. */
export function userTmp(layout: Pick<Layout, "tmp">, scope: Scope, phone: string): string {
  return join(spaceTmp(layout, scope), userSegment(phone));
}

/** The model's working and output directory for one durable request. */
export function requestTmp(memberTmp: string, requestId: string): string {
  return join(memberTmp, "tasks", requestSegment(requestId));
}

/** Real path of `path`, or of its nearest existing ancestor with the missing rest appended. */
function real(path: string): string {
  const absolute = resolve(path), parent = dirname(absolute);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  return parent === absolute ? absolute : join(real(parent), basename(absolute));
}

/**
 * Startup/deploy check of the workspace: an external one must already be a directory (a missing mount must not
 * become an empty workspace), and it may neither contain the data directory nor overlap a managed directory (either
 * way, after resolving links), so
 * the read-only material view never exposes conversations, tmp, state, configuration or backups. Read-only: nothing is
 * created. `roots` gives the backup and log directories when they are not `<project>/backup` and `<project>/logs` as
 * seen here (a Docker host check passes their resolved host paths).
 */
export function checkWorkspace(layout: Layout, project: string = process.cwd(),
  roots: { readonly backup?: string; readonly logs?: string } = {}): void {
  const workspace = resolve(layout.workspace);
  let stat;
  try { stat = statSync(workspace); } catch {
    if (layout.externalWorkspace) throw new Error(`WORKSPACE_ROOT 不存在：${workspace}；外置资料目录必须先挂载或创建`);
  }
  if (stat && !stat.isDirectory()) throw new Error(`资料目录不是目录：${workspace}`);
  const target = real(workspace), data = real(layout.data);
  if (isPathInside(data, target)) throw new Error(`资料目录 ${workspace} 包含数据目录 ${layout.data}，会暴露会话、临时文件和配置`);
  const managed = [layout.index, layout.state, layout.tmp, layout.conversations, join(layout.data, "config"), join(layout.data, "runtime"),
    roots.backup ?? join(project, "backup"), roots.logs ?? join(project, "logs")];
  for (const path of managed) {
    const resolved = real(path);
    if (isPathInside(target, resolved)) throw new Error(`资料目录 ${workspace} 位于受管目录 ${path} 内`);
    // The other way round: a managed directory linked into the workspace while data itself stays outside.
    if (isPathInside(resolved, target)) {
      throw new Error(`受管目录 ${path} 实际位于资料目录 ${workspace} 内（${resolved}），会把其中的文件暴露给成员工具`);
    }
  }
}

/**
 * The layout boundary of a deployment of `project` (preflight, verification instance and service start alike), with its
 * final workspace (absolute, or relative to the project; blank = data/workspace). Read-only.
 */
export function checkProjectLayout(project: string, workspace: string | undefined,
  roots: { readonly data?: string; readonly backup?: string; readonly logs?: string } = {}): void {
  const configured = workspace?.trim() ? resolve(project, workspace.trim()) : undefined;
  checkWorkspace(appLayout(roots.data ?? join(project, "data"), configured), project, roots);
}
