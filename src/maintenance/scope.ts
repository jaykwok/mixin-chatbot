// The protected business view offline maintenance acts under. The service layer implements it (durable space snapshot
// plus the outbox ledger, `src/durable/maintenance-view.ts`) and the entry injects it; maintenance never opens a
// business database itself.
import type { UserTmp } from "../../scripts/lib/tmp-scan.ts";
import type { ResultOwnership } from "../contracts/maintenance.ts";
import { ReferenceText } from "../core/reference-text.ts";

/** Valid only inside the callback: every lock and transaction backing it is held until the callback settles. */
export interface MemberView {
  /** This member's result ownership records, active and queued for reclamation. */
  readonly calls: Readonly<Record<string, ResultOwnership>>;
  /** The space database has recoverable tasks or unsettled submissions. */
  readonly liveWork: boolean;
  /** Referenced by a context or a pending delivery, or anything while the space is busy. */
  protectedPath(path: string): boolean;
  /** Settle the given confirmed-removed owners in the source transaction (refused in a read-only view). */
  settle(owners: ReadonlyMap<string, ResultOwnership>): Promise<void>;
}

/** `root` is the data directory (conversations/ and tmp/ below it); `recordedRoot` the name the service saw for it. */
export interface ViewPaths { root: string; state: string; recordedRoot?: string }

export interface MemberScope {
  /** `exclusive` takes the write reservations (apply) instead of reading (preview). Without `requireGroup` a missing
   * space database reads as a member with no ownership and only ledger references. */
  withMember<T>(paths: ViewPaths, user: UserTmp, mode: { exclusive: boolean; requireGroup: boolean }, run: (view: MemberView) => Promise<T>): Promise<T>;
}

/** Built once per protected view: each path is a lookup in the same normalized text, not another serialization of it.
 * A path counts as referenced under its host name or, for container deployments, its recorded name. */
export function reclamationReferences(values: unknown[], options: Pick<ViewPaths, "root" | "recordedRoot">): (path: string) => boolean {
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const text = new ReferenceText(() => fold(JSON.stringify(values).replaceAll("\\\\", "\\").replaceAll("\\", "/")), "/");
  return path => {
    const needle = path.replaceAll("\\", "/"), original = options.recordedRoot ? needle.replace(options.root.replaceAll("\\", "/"), options.recordedRoot.replaceAll("\\", "/")) : needle;
    return [needle, original].map(fold).some(value => text.includes(value, value.slice(0, value.lastIndexOf("/") + 1)));
  };
}
