import { archiveFixture as rm, testTempDir as tmpdir } from "../helpers/temp.ts";
// A marker alone is not evidence that the Python interpreter and packages work.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { documentMarker, documentPackages } from "../../scripts/runtime/document-manifest.ts";
import {
  documentToolchainReady,
  venvPythonPath,
} from "../../src/agent/python-toolchain.ts";
import { DOCUMENT_TOOLCHAIN_PACKAGES } from "../../src/core/config.ts";

const MARKER = ".mixin-doc-toolchain";
const sorted = [...DOCUMENT_TOOLCHAIN_PACKAGES].sort();

async function venvWithMarker(content: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mixin-chatbot-venv-"));
  if (content !== null) await writeFile(join(dir, MARKER), content, "utf8");
  return dir;
}

describe("document toolchain readiness", () => {
  test("image marker records the locked project and Python series", async () => {
    const root = await mkdtemp(join(tmpdir(), "document-manifest-"));
    const requirements = join(root, "pyproject.toml");
    const contents = '# dependencies\r\n[project]\r\ndependencies = ["z-package==2.0", "a-package==1.0"]\r\n';
    await writeFile(requirements, contents);
    await writeFile(join(root, "uv.lock"), "version = 1\n");
    await writeFile(join(root, ".python-version"), "3.14\n");
    const child = Bun.spawn([process.execPath,
      fileURLToPath(new URL("../../scripts/runtime/document-manifest.ts", import.meta.url)), root, root],
      { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, err).toBe(0);
      const actual = await readFile(join(root, MARKER), "utf8");
      expect(actual).toBe(documentMarker(documentPackages(contents), "version = 1\n", "3.14"));
      expect(actual).not.toBe(documentMarker(documentPackages(contents), "version = 2\n", "3.14"));
      expect(actual).not.toBe(documentMarker(documentPackages(contents), "version = 1\n", "3.12"));
      expect(await readFile(requirements, "utf8")).toBe(contents);
    } finally { clearTimeout(timer); child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
  });

  test("rejects even a matching marker if the interpreter is missing", async () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const dir = await venvWithMarker(sorted.join(eol));
      try {
        expect(await documentToolchainReady(dir)).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("rejects a marker whose package list no longer matches", async () => {
    const dir = await venvWithMarker(sorted.slice(1).join("\n"));
    try {
      expect(await documentToolchainReady(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("treats a missing marker as not ready", async () => {
    const dir = await venvWithMarker(null);
    try {
      expect(await documentToolchainReady(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("points at the platform's interpreter location", () => {
    const python = venvPythonPath(join("data", "groups", "g", "venv"));
    expect(python.endsWith(process.platform === "win32" ? "python.exe" : "python")).toBe(
      true
    );
    expect(python).toContain(process.platform === "win32" ? "Scripts" : "bin");
  });
});
