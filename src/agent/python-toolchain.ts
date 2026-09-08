// Fixed document parser environment. Every command shares the supervised process lifecycle.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_TOOLCHAIN_PACKAGES, DOCUMENT_TOOLCHAIN_TIMEOUT } from "../core/config.ts";
import { KeyedQueue, application } from "../core/lifecycle.ts";
import { runProcess } from "../core/process.ts";
import { log } from "../core/log.ts";
import { DOCUMENT_TOOLCHAIN_MARKER, documentMarker } from "../../scripts/runtime/document-manifest.ts";

const expected = () => documentMarker(DOCUMENT_TOOLCHAIN_PACKAGES);
const requirements = fileURLToPath(new URL("../../scripts/runtime/requirements.txt", import.meta.url));
const provisioning = new KeyedQueue();

async function toolchainEnv() {
  const temporary = resolve("agents/temp/document-toolchain");
  await mkdir(temporary, { recursive: true });
  return { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    UV_CACHE_DIR: join(temporary, "uv-cache"), UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR || join(temporary, "python"),
    PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", UV_NO_CONFIG: "1" };
}

export function venvPythonPath(venvDir: string): string {
  return join(resolve(venvDir), process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

function uvPath(): string {
  const path = Bun.which(process.platform === "win32" ? "uv.exe" : "uv");
  if (!path) throw new Error("缺少 uv 可执行文件；请在部署阶段安装 uv");
  return path;
}

async function verify(venvDir: string, signal?: AbortSignal): Promise<boolean> {
  const code = "import importlib.metadata as m; expected=" + JSON.stringify([...DOCUMENT_TOOLCHAIN_PACKAGES]) +
    "; assert all(m.version(p.split('==')[0]) == p.split('==')[1] for p in expected); import pptx, docx, openpyxl, pypdf, pandas, numpy, dateutil, xlsxwriter, PIL";
  const result = await runProcess({ command: uvPath(),
    args: ["run", "--no-project", "--no-python-downloads", "--python", venvPythonPath(venvDir), "-c", code],
    cwd: process.cwd(), timeoutMs: 30000, signal,
    env: { ...await toolchainEnv(), VIRTUAL_ENV: resolve(venvDir), UV_PROJECT_ENVIRONMENT: resolve(venvDir) },
  });
  return result.exitCode === 0;
}

export async function documentToolchainReady(venvDir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (!(await stat(venvPythonPath(venvDir))).isFile()) return false;
    const content = await readFile(join(venvDir, DOCUMENT_TOOLCHAIN_MARKER), "utf8");
    if (content.replace(/\r\n?/g, "\n").trim() !== expected()) return false;
    return await verify(venvDir, signal);
  } catch (error) { signal?.throwIfAborted(); application.signal.throwIfAborted(); return false; }
}

export async function ensureDocumentToolchain(venvDir: string, signal?: AbortSignal): Promise<boolean> {
  const target = resolve(venvDir);
  return provisioning.run(target, async () => {
    const budget = AbortSignal.any([application.signal, AbortSignal.timeout(DOCUMENT_TOOLCHAIN_TIMEOUT), ...(signal ? [signal] : [])]);
    if (await documentToolchainReady(target, budget)) return true;
    const uv = uvPath();
    const env = await toolchainEnv();
    for (const args of [
      ["venv", "--allow-existing", "--python", "3.12.13", target],
      ["pip", "sync", "--python", venvPythonPath(target), requirements],
    ]) {
      const result = await runProcess({ command: uv, args, cwd: process.cwd(), env, signal: budget, timeoutMs: DOCUMENT_TOOLCHAIN_TIMEOUT });
      if (result.exitCode !== 0) { log.warn("文档环境准备失败: " + result.output.slice(-1000)); return false; }
    }
    if (!await verify(target, budget)) return false;
    await writeFile(join(target, DOCUMENT_TOOLCHAIN_MARKER), expected(), "utf8");
    return true;
  }, signal);
}
