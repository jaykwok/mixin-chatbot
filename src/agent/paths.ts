import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

const SAFE_GROUP_SEGMENT = /^[A-Za-z0-9_+\-]{1,64}$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Convert an external group id into one safe, cross-platform directory segment.
 * Unsafe/long/reserved ids use a tagged full SHA-256 digest so they cannot escape
 * the data root or collide with a directly-used safe id.
 */
export function groupSegment(groupId: string): string {
  if (SAFE_GROUP_SEGMENT.test(groupId) && !WINDOWS_RESERVED_SEGMENT.test(groupId)) {
    return groupId;
  }
  return `sha256-${createHash("sha256").update(groupId, "utf8").digest("hex")}`;
}

/** Keep normal phone/user ids readable while avoiding Windows device names. */
export function userSegment(phone: string): string {
  if (SAFE_GROUP_SEGMENT.test(phone) && !WINDOWS_RESERVED_SEGMENT.test(phone)) {
    return phone;
  }
  return `sha256-user-${createHash("sha256").update(phone, "utf8").digest("hex")}`;
}

/** Group-shared persistent working directory. */
export function groupWorkspaceDir(root: string, groupId: string): string {
  return join(root, groupSegment(groupId), "workspace");
}

/** Per-user scratch directory inside a group. */
export function userTempDir(root: string, groupId: string, phone: string): string {
  return join(root, groupSegment(groupId), userSegment(phone), "tmp");
}

/** Per-user conversation history inside a group. */
export function sessionFilePath(root: string, groupId: string, phone: string): string {
  return join(
    root,
    groupSegment(groupId),
    userSegment(phone),
    "sessions",
    "session.jsonl"
  );
}

/** True when path is root itself or one of its descendants. Both paths should be canonical. */
export function isPathInside(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return !(
    fromRoot === ".." ||
    fromRoot.startsWith(`..\\`) ||
    fromRoot.startsWith("../") ||
    isAbsolute(fromRoot)
  );
}
