import type { Identity } from "./held-directory.ts";

/**
 * Whether the service defers removing what member commands could also write, until a permit proves no writer is left.
 * Linux and macOS: without isolated tasks, member commands run as the service's identity, and a held directory binds no
 * removal to the entity checked. Windows removes through held handles, which do.
 */
export function removalNeedsPermit(): boolean {
  return process.platform !== "win32";
}

/** A short-lived management capability, issued only after the isolated backend has reaped all writers. */
export class RemovalPermit {
  #valid = true;
  constructor(private readonly parent: Identity, private readonly child: Identity) {
    if (parent.dev !== child.dev) throw new Error("不同设备不能授予目录回收权限");
  }
  permits(parent: Identity, child: Identity): boolean {
    return this.#valid && this.parent.dev === parent.dev && this.parent.ino === parent.ino && this.child.dev === child.dev && this.child.ino === child.ino;
  }
  revoke() { this.#valid = false; }
}
