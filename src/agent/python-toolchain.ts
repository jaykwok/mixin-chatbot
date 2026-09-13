// Fixed document parser environment. Every command shares the supervised process lifecycle.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENT_TOOLCHAIN_PACKAGES, DOCUMENT_TOOLCHAIN_TIMEOUT } from "../core/config.ts";
import { KeyedQueue, application, waitFor } from "../core/lifecycle.ts";
import { runProcess } from "../core/process.ts";
import { log } from "../core/log.ts";
import { DOCUMENT_TOOLCHAIN_MARKER, documentMarker, documentPackages } from "../../scripts/runtime/document-manifest.ts";

const expected = async () => documentMarker(DOCUMENT_TOOLCHAIN_PACKAGES, await readFile(requirements, "utf8"));
const requirements = fileURLToPath(new URL("../../scripts/runtime/requirements.txt", import.meta.url));
const provisioning = new KeyedQueue();
const verified = new Map<string, { fingerprint: string; at: number }>();
interface Check { promise: Promise<boolean>; controller: AbortController; consumers: number; done: boolean; }
const checking = new Map<string, Check>();
const READY_TTL = 5 * 60_000;

async function fingerprint(venvDir: string): Promise<string> {
  const paths = [venvPythonPath(venvDir), join(venvDir, DOCUMENT_TOOLCHAIN_MARKER), requirements];
  const metadata = await Promise.all(paths.map(async path => {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("文档环境文件缺失");
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  }));
  return JSON.stringify(metadata);
}

async function toolchainEnv() {
  const temporary = resolve("data/runtime/tmp/document-toolchain");
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
  const packages = documentPackages(await readFile(requirements, "utf8")).filter(line => {
    const marker = line.split(";")[1]?.trim();
    if (!marker) return true;
    if (!/^sys_platform == '[a-z0-9_]+'(?: or sys_platform == '[a-z0-9_]+')*$/.test(marker)) throw new Error("不支持的文档锁文件环境标记");
    return [...marker.matchAll(/'([a-z0-9_]+)'/g)].some(match => match[1] === process.platform);
  }).map(line => line.split(";")[0]!.trim());
  const code = "import importlib.metadata as m; expected=" + JSON.stringify(packages) +
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
    const target = resolve(venvDir);
    const stamp = await fingerprint(target);
    const cached = verified.get(target);
    if (cached?.fingerprint === stamp && Date.now() - cached.at < READY_TTL) {
      verified.delete(target); verified.set(target, cached);
      signal?.throwIfAborted();
      return true;
    }
    const content = await readFile(join(target, DOCUMENT_TOOLCHAIN_MARKER), "utf8");
    if (content.replace(/\r\n?/g, "\n").trim() !== await expected()) return false;
    const key = target + stamp;
    let job = checking.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const owner: Check = { controller, consumers: 0, done: false, promise: Promise.resolve(false) };
      owner.promise = application.track((async () => {
        if (!await verify(target, AbortSignal.any([application.signal, controller.signal])) || await fingerprint(target) !== stamp) return false;
        verified.delete(target);
        if (verified.size >= 128) verified.delete(verified.keys().next().value!);
        verified.set(target, { fingerprint: stamp, at: Date.now() });
        return true;
      })()).finally(() => { owner.done = true; if (checking.get(key) === owner) checking.delete(key); });
      job = owner;
      checking.set(key, owner);
    }
    job.consumers++;
    try { return await waitFor(job.promise, signal); }
    finally {
      job.consumers--;
      if (!job.consumers && !job.done) job.controller.abort(new Error("文档环境检查已全部取消"));
    }
  } catch (error) { signal?.throwIfAborted(); application.signal.throwIfAborted(); return false; }
}

export async function ensureDocumentToolchain(venvDir: string, signal?: AbortSignal): Promise<boolean> {
  const target = resolve(venvDir);
  return provisioning.run(target, async () => {
    const budget = AbortSignal.any([application.signal, AbortSignal.timeout(DOCUMENT_TOOLCHAIN_TIMEOUT), ...(signal ? [signal] : [])]);
    if (await documentToolchainReady(target, budget)) return true;
    verified.delete(target);
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
    await writeFile(join(target, DOCUMENT_TOOLCHAIN_MARKER), await expected(), "utf8");
    verified.set(target, { fingerprint: await fingerprint(target), at: Date.now() });
    return true;
  }, signal);
}
