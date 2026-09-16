import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const DOCUMENT_TOOLCHAIN_MARKER = ".mixin-doc-toolchain";

/** Shared by image construction, runtime readiness checks and native provisioning. */
export function documentPackages(contents: string): string[] {
  const parsed = Bun.TOML.parse(contents) as { project?: { dependencies?: unknown } };
  const dependencies = parsed.project?.dependencies;
  if (!Array.isArray(dependencies) || !dependencies.length ||
      !dependencies.every(value => typeof value === "string" && /^[a-z0-9-]+==[a-z0-9.]+$/i.test(value))) {
    throw new Error("文档项目必须声明精确版本的直接依赖");
  }
  return dependencies as string[];
}

export function documentMarker(packages: readonly string[], lock?: string, python = "3.14"): string {
  return [...packages].sort().join("\n") + (lock === undefined ? "" :
    "\n# lock-sha256=" + createHash("sha256").update(lock.replace(/\r\n?/g, "\n")).digest("hex")) + "\n# python=" + python.trim();
}

if (import.meta.main) {
  const [project, environment, ...extra] = process.argv.slice(2);
  if (!project || !environment || extra.length) {
    throw new Error("Usage: bun document-manifest.ts <Python project directory> <venv directory>");
  }
  const packages = documentPackages(await readFile(join(project, "pyproject.toml"), "utf8"));
  const lock = await readFile(join(project, "uv.lock"), "utf8");
  const python = await readFile(join(project, ".python-version"), "utf8");
  await writeFile(join(environment, DOCUMENT_TOOLCHAIN_MARKER), documentMarker(packages, lock, python), "utf8");
}
