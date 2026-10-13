// What a worker may see: explicit inputs copied into a private read-only snapshot, read-only host paths that are not
// manager or task state, and an allow-listed environment. Its output may hold only directories and regular files.
import { type FileHandle, mkdir, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isPathInside } from "../../contracts/paths.ts";

/** Normalized, de-duplicated inputs below `temp`, outermost only (a selected parent already covers its children). */
export function selectInputs(temp: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length > 128) throw new Error("任务输入最多 128 个路径");
  const selected = [...new Set(paths.map(path => {
    if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("任务输入路径无效");
    const canonical = resolve(temp, path);
    if (canonical === temp || !isPathInside(canonical, temp)) throw new Error("任务输入必须位于当前用户 tmp 内，不能选择整个 tmp");
    return relative(temp, canonical);
  }))].sort();
  return selected.filter(path => !selected.some(parent => parent !== path && path.startsWith(parent + "/")));
}

/** Read-only host exports must not reach the control root, another task, a parent of tmp or the shared system tmp. */
export function assertReadOnlyExport(source: string, canonical: string, controlRoot: string, temp: string): void {
  if (controlRoot === canonical || controlRoot.startsWith(canonical + "/") || canonical.startsWith(controlRoot + "/") || temp.startsWith(canonical + "/")
    || canonical.startsWith(join(temp, ".isolated-work") + "/") || source === "/tmp") throw new Error("不得向工作进程导出管理根、其他任务或共享系统 tmp");
}

const allowedEnvironment = new Set(["TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONDONTWRITEBYTECODE", "PYTHON_BASIC_REPL",
  "XDG_CACHE_HOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PI_USER_TMP", "PI_PYTHON", "PI_MATERIALS_INDEX", "PI_CALLER_PHONE", "PI_GROUP_ID", "AI_AGENT", "PI_CODING_AGENT",
  "npm_config_cache", "BUN_INSTALL_CACHE_DIR", "PIP_CACHE_DIR", "UV_CACHE_DIR"]);

export function workerEnvironment(env: NodeJS.ProcessEnv | undefined): [string, string | undefined][] {
  return Object.entries(env ?? {}).filter(([key]) => allowedEnvironment.has(key));
}

/** Copy one selected input. Every ancestor is opened relative to a held fd, so a symlink swap cannot import host files. */
export async function snapshotInput(root: string, parts: string[], destination: string, signal: AbortSignal, budget: { entries: number; totalBytes: number }) {
  let selected = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (parts.length > 64) throw new Error("任务输入目录超过 64 层");
    for (const [index, part] of parts.entries()) {
      const child = await open(`/proc/self/fd/${selected.fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (index < parts.length - 1 ? constants.O_DIRECTORY : 0));
      await selected.close(); selected = child;
    }
    const copy = async (file: FileHandle, path: string, depth: number) => {
      signal.throwIfAborted();
      if (depth > 64) throw new Error("任务输入目录超过 64 层");
      if (++budget.entries > 20_000) throw new Error("任务输入超过 20000 个条目");
      const info = await file.stat();
      if (info.isDirectory()) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        for (const name of await readdir(`/proc/self/fd/${file.fd}`)) {
          const child = await open(`/proc/self/fd/${file.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { await copy(child, join(path, name), depth + 1); } finally { await child.close(); }
        }
      } else if (info.isFile()) {
        if (info.size > 128 * 1024 * 1024) throw new Error("任务输入单文件超过 128 MiB");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const output = await open(path, "wx", 0o600); let size = 0;
        try {
          // Bun's FileHandle streams with autoClose:false can retain pipeline completion and lose handle ownership.
          // Explicit fd reads/writes keep both handles owned until the finally blocks below.
          const buffer = Buffer.alloc(64 * 1024);
          while (true) {
            signal.throwIfAborted();
            const { bytesRead } = await file.read(buffer, 0, buffer.length, size); if (!bytesRead) break;
            budget.totalBytes += bytesRead;
            if (size + bytesRead > 128 * 1024 * 1024 || budget.totalBytes > 256 * 1024 * 1024) throw new Error("任务输入超过 256 MiB");
            let written = 0;
            while (written < bytesRead) {
              const { bytesWritten } = await output.write(buffer, written, bytesRead - written, size + written);
              if (!bytesWritten) throw new Error("任务快照写入未取得进展"); written += bytesWritten;
            }
            size += bytesRead;
          }
          await output.sync();
        } finally { await output.close(); }
      } else throw new Error("任务输入包含 FIFO 或其他特殊文件");
    };
    await copy(selected, destination, parts.length);
  } finally { await selected.close(); }
}

/** A worker-created link/FIFO must never become a host-manager input after the worker exits. */
export async function validateWork(path: string) {
  let count = 0;
  const visit = async (directory: FileHandle, depth: number) => {
    if (depth > 64) throw new Error("任务产物目录超过 64 层");
    for (const name of await readdir(`/proc/self/fd/${directory.fd}`)) {
      if (++count > 20_000) throw new Error("任务产物超过 20000 个条目");
      const child = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const info = await child.stat();
        if (info.isDirectory()) await visit(child, depth + 1);
        else if (!info.isFile()) throw new Error("任务产物包含 FIFO 或其他特殊文件，拒绝向管理端导出");
      } finally { await child.close(); }
    }
  };
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await visit(directory, 0); } finally { await directory.close(); }
}
