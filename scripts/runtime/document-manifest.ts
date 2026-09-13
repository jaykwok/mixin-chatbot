import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export const DOCUMENT_TOOLCHAIN_MARKER = ".mixin-doc-toolchain";

/** Shared by image construction, runtime readiness checks and native provisioning. */
export function documentPackages(contents: string): string[] {
  return contents.split(/\r\n?|\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

export function documentMarker(packages: readonly string[], lock?: string): string {
  return [...packages].sort().join("\n") + (lock === undefined ? "" :
    "\n# lock-sha256=" + createHash("sha256").update(lock.replace(/\r\n?/g, "\n")).digest("hex"));
}

if (import.meta.main) {
  const [requirements, environment, ...extra] = process.argv.slice(2);
  if (!requirements || !environment || extra.length) {
    throw new Error("Usage: bun document-manifest.ts <requirements.in> <venv directory>");
  }
  const packages = documentPackages(await readFile(requirements, "utf8"));
  const lock = await readFile(join(dirname(requirements), "requirements.txt"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  await writeFile(join(environment, DOCUMENT_TOOLCHAIN_MARKER), documentMarker(packages, lock), "utf8");
}
