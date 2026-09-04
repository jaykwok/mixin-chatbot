// 就绪判定错一次的代价是无声重建：uv venv 对已存在目录是重建，会连同运维手动加装的
// 包一起抹掉，而日志里只有一行「开始准备文档解析环境」。这里锁住标记文件的比对规则。
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("accepts the marker regardless of line endings", async () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const dir = await venvWithMarker(sorted.join(eol));
      try {
        expect(await documentToolchainReady(dir)).toBe(true);
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
