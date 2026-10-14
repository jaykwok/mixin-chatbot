// Whether a result directory is still referenced by any context, fork or pending delivery of the group.
import { resolve, sep } from "node:path";
import { ReferenceText } from "../../core/reference-text.ts";
import { resultsRoot } from "./files.ts";

const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

/** Conservative matching: references may occur in message text, tool details or attachment originals.
 * Build once per maintenance pass of a group; every member, queued item and receipt reuses it. */
export function resultReferences(values: readonly unknown[]): ReferenceText {
  return new ReferenceText(() => fold(values.map(value => JSON.stringify(value)).join("\n").replaceAll("\\\\", "\\").replaceAll("/", sep)), sep);
}

/** Same answer as searching the whole reference text for each result path. */
export function referencedResults(tempDir: string, registered: readonly string[], references: ReferenceText, isolated: ReadonlyMap<string, string> = new Map()): Set<string> {
  const results = fold(resolve(resultsRoot(tempDir)) + sep), tasks = fold(resolve(tempDir, ".isolated-work") + sep);
  return new Set(registered.filter(name => {
    const id = isolated.get(name);
    return id ? references.includes(fold(resolve(tempDir, ".isolated-work", id, "work")), tasks)
      : references.includes(fold(resolve(resultsRoot(tempDir), name)), results);
  }));
}
