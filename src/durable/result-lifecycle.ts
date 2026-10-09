import { defineDoc } from "@earendil-works/pi-durable";
import { resolve, sep } from "node:path";
import { resultsRoot } from "./codemode/results.ts";

/** Session scope: /clear and context compaction must not erase ownership or pending-delivery references. */
export const ResultsDoc = defineDoc<{ calls: Record<string, { phone: string; createdAt: number; isolatedTask?: string; expiryRequestedAt?: number; expiredAt?: number;
  reclamation?: { status: "deferred" | "refused"; reason?: string; identity?: { dev: string; ino: string }; attemptedAt: number; nextAttemptAt: number } }> }>({
  kind: "mixin.results", version: 1, scope: "session", initial: () => ({ calls: {} }),
});

/** Conservative matching: references may occur in message text, tool details or attachment originals. */
export function referencedResults(tempDir: string, registered: readonly string[], values: readonly unknown[], isolated: ReadonlyMap<string, string> = new Map()): Set<string> {
  const text = values.map(value => JSON.stringify(value)).join("\n").replaceAll("\\\\", "\\").replaceAll("/", sep);
  const haystack = process.platform === "win32" ? text.toLowerCase() : text;
  return new Set(registered.filter(name => {
    const id = isolated.get(name);
    const path = id ? resolve(tempDir, ".isolated-work", id, "work") : resolve(resultsRoot(tempDir), name);
    return haystack.includes(process.platform === "win32" ? path.toLowerCase() : path);
  }));
}
