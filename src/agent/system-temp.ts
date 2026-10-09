import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { move } from "fs-extra";
import { isPathInside } from "./paths.ts";

/**
 * Pi writes the full output of a truncated result to the shared system temp directory (bash: pi-bash-*.log,
 * codemode: pi-codemode-*.txt). Move it into the user's tmp, where the wrapped read can reach it and other groups cannot.
 * Paths outside the system temp directory or with another name are returned unchanged.
 */
export async function moveSystemTempOutput(
  source: string,
  tempDir: string,
  prefix: string,
  extension: string
): Promise<string> {
  if (!basename(source).startsWith(prefix) || extname(source) !== extension) {
    return source;
  }

  const canonicalSource = await realpath(source);
  const canonicalSystemTemp = await realpath(tmpdir());
  const canonicalUserTemp = await realpath(tempDir);
  if (!isPathInside(canonicalSource, canonicalSystemTemp)) return source;
  if (isPathInside(canonicalSource, canonicalUserTemp)) return canonicalSource;

  const stem = basename(source, extension);
  const destination = join(canonicalUserTemp, `${stem}-${randomUUID()}${extension}`);
  await move(canonicalSource, destination, { overwrite: false });
  return destination;
}
