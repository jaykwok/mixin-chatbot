import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DOCUMENT_TOOLCHAIN_MARKER = ".mixin-doc-toolchain";

/** Shared by image construction, runtime readiness checks and native provisioning. */
export function documentPackages(contents: string): string[] {
  return contents.split(/\r\n?|\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

export function documentMarker(packages: readonly string[]): string {
  return [...packages].sort().join("\n");
}

if (import.meta.main) {
  const [requirements, environment, ...extra] = process.argv.slice(2);
  if (!requirements || !environment || extra.length) {
    throw new Error("Usage: bun document-manifest.ts <requirements.in> <venv directory>");
  }
  const packages = documentPackages(await readFile(requirements, "utf8"));
  await writeFile(join(environment, DOCUMENT_TOOLCHAIN_MARKER), documentMarker(packages), "utf8");
}
