// Per-invocation filesystem capability and supervised shell for Durable's native tools.
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, ok, ExecutionError, FileError, StreamDecoder, type ExecutionEnv, type ShellExecOptions, type Result, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { BASH_DEFAULT_TIMEOUT } from "../core/config.ts";
import { scopeKey, type Scope } from "../core/layout.ts";
import { isPathInside } from "../contracts/paths.ts";
import { venvPythonPath } from "../agent/python-toolchain.ts";
import { runProcess, timedCommand } from "../core/process.ts";
import { ProcessFailure } from "../../scripts/lib/process.ts";
import { holdDirectory } from "../core/held-directory.ts";
import { assertTaskPathAllowed, configuredRootlessTasks, finishTask, ISOLATED_PYTHON } from "../core/task-backend.ts";

/**
 * The shell for string commands: Pi's discovery (Git Bash first on Windows). Both WSL launchers it can find are refused:
 * their bash runs inside WSL, with other paths and processes the supervised runner cannot reap. Since Pi 1.4.0 the
 * legacy launcher (System32\bash.exe) comes back with `commandTransport: "stdin"`, which the argv-only runner cannot
 * carry either, and an app execution alias (…\WindowsApps\bash.exe, which starts wsl.exe) counts as found on PATH.
 * @internal Exported for tests only; knip --production skips `@internal`.
 */
export function memberShell(config: ReturnType<typeof getShellConfig> = getShellConfig()): { shell: string; args: string[] } {
  if (config.commandTransport === "stdin" || (process.platform === "win32" && /(^|\\)windowsapps\\[^\\]+$/i.test(win32.normalize(config.shell)))) {
    throw new Error(`${config.shell} 是 Windows 自带的 WSL 启动器，不能运行 bash 工具；请安装 Git for Windows，并让它的 bash.exe 在 PATH 中排在前面`);
  }
  return { shell: config.shell, args: config.args };
}

function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
class AllowedPathGuard {
  private constructor(
    private readonly roots: string[],
    /**
     * 可读但不可写的目录。资料索引住在 workspace 外面（workspace 是同步盘镜像，只放
     * 资料），模型仍然需要能 read 它——否则每次查索引都要先吃一次「只能访问」的拒绝。
     */
    private readonly readOnlyRoots: string[]
  ) {}

  static async create(
    roots: string[],
    readOnlyRoots: string[] = []
  ): Promise<AllowedPathGuard> {
    const canonical = await Promise.all(
      roots.map((root) => realpath(resolve(root)))
    );
    // 只读根是可选能力，目录还没建出来时安静跳过，不能因此让整套工具建不起来。
    const canonicalReadOnly = (
      await Promise.all(
        readOnlyRoots.map((root) => realpath(resolve(root)).catch(() => null))
      )
    ).filter((root): root is string => root !== null);
    return new AllowedPathGuard(canonical, canonicalReadOnly);
  }

  private assertInside(path: string): void {
    if (!this.roots.some((root) => isPathInside(path, root))) {
      throw new Error("写入仅允许本次请求的 tmp 目录；应用共享资料 workspace 和 index 只读");
    }
  }

  private assertReadable(path: string): void {
    if (this.readOnlyRoots.some((root) => isPathInside(path, root))) return;
    this.assertInside(path);
  }

  private assertWritable(path: string): void {
    this.assertInside(path);
    if (configuredRootlessTasks() && this.roots.some(root => [".isolated-work", ".office-jobs", "codemode", ".document-cache"]
      .some(name => isPathInside(path, join(root, name))))) throw new Error("任务登记与结果目录只读，请在本次 bash 的 PI_USER_TMP 中写入");
  }

  private async refuseManagement(path: string): Promise<void> {
    await assertTaskPathAllowed(path);
  }

  /** 读取路径：可写根 + 只读根。 */
  async readable(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    await this.refuseManagement(canonical);
    this.assertReadable(canonical);
    return canonical;
  }

  async existing(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    await this.refuseManagement(canonical);
    this.assertWritable(canonical);
    return canonical;
  }

  async writable(path: string): Promise<string> {
    const target = resolve(path);
    await this.refuseManagement(target);
    this.assertWritable(target);
    let cursor = target;

    while (true) {
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) {
          const canonical = await realpath(cursor).catch(() => null);
          if (!canonical) throw new Error(`拒绝写入悬空符号链接: ${path}`);
          await this.refuseManagement(canonical);
          this.assertWritable(canonical);
          return target;
        }
        const canonical = await realpath(cursor);
        await this.refuseManagement(canonical);
        this.assertWritable(canonical);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(cursor);
        if (parent === cursor) throw new Error(`找不到允许的父目录: ${path}`);
        cursor = parent;
      }
    }
  }
}


export interface MemberEnvOptions {
  /** The member's tmp: readable (attachments, earlier requests' files), its caches, the managed task directories. */
  tempDir: string;
  /** The request's own directory below the member's tmp: the only write root, and the model's temp directory. */
  requestDir?: string;
  workspaceDir: string; phone: string; scope: Scope; venvDir: string;
  materialsIndexPath: string; resourceReadDirs?: readonly string[]; inputPaths?: readonly string[];
}

export async function createMemberEnv(options: MemberEnvOptions): Promise<ExecutionEnv> {
  const { workspaceDir: cwd, tempDir, phone, scope, venvDir, materialsIndexPath } = options;
  const work = options.requestDir ?? tempDir;
  const guard = await AllowedPathGuard.create([work], [tempDir, cwd, dirname(materialsIndexPath), ...options.resourceReadDirs ?? []]);
  const node = new NodeExecutionEnv({ cwd });
  const callerEnvironment = {
    TMPDIR: work,
    TMP: work,
    TEMP: work,
    XDG_CACHE_HOME: join(tempDir, ".cache"),
    npm_config_cache: join(tempDir, ".npm"),
    BUN_INSTALL_CACHE_DIR: join(tempDir, ".bun-install-cache"),
    PIP_CACHE_DIR: join(tempDir, ".cache", "pip"),
    UV_CACHE_DIR: join(tempDir, ".cache", "uv"),
    // 文档解析环境在 workspace 外：workspace 是同步盘镜像，往里建 .venv 会污染同步源，
    // 并被下一次同步删掉。
    UV_PROJECT_ENVIRONMENT: configuredRootlessTasks() ? "/app/.venv" : venvDir,
    VIRTUAL_ENV: configuredRootlessTasks() ? "/app/.venv" : venvDir,
    PYTHONIOENCODING: "utf-8",
    // PYTHONIOENCODING 只管住 stdout/stderr；open() 的默认编码仍随系统 ANSI 代码页走，
    // 在中文 Windows 上就是 GBK，读写 UTF-8 中间文件会直接乱码或抛 UnicodeDecodeError。
    // PYTHONUTF8 等价于每条命令都加 -X utf8，模型不必再自己想起来加。
    PYTHONUTF8: "1",
    // Git Bash 默认 locale 为 C，coreutils 会把中文文件名转义成八进制打印，模型据此
    // 拼出的路径打不开文件。资料文件名几乎全是中文，这里必须显式声明 UTF-8。
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    // Windows NUL may be reported as a TTY after an empty Git Bash heredoc.
    // The basic REPL handles that EOF without starting the console-only _pyrepl.
    PYTHON_BASIC_REPL: "1",
    PI_CALLER_PHONE: phone,
    PI_SPACE: scopeKey(scope),
    PI_USER_TMP: work,
    // 解释器路径与索引位置都随部署/平台变化，写死在提示词里迟早会过期；导出成变量后
    // 模型只要 "$PI_PYTHON"、"$PI_MATERIALS_INDEX" 即可，也不用再去探测 Scripts/ 还是 bin/。
    PI_PYTHON: configuredRootlessTasks() ? ISOLATED_PYTHON : venvPythonPath(venvDir),
    PI_MATERIALS_INDEX: materialsIndexPath,
    // Pi sets both markers itself, but only in its own CLI/RPC entrypoints. This
    // process embeds the SDK, so child commands need them exported explicitly.
    AI_AGENT: "pi",
    PI_CODING_AGENT: "true",
  };

  const absolute = (path: string) => resolve(cwd, path);
  const methods: Partial<ExecutionEnv> = { id: node.id, cwd,
    absolutePath: node.absolutePath.bind(node), joinPath: node.joinPath.bind(node),
    cleanup: async () => {},
    exec: (command, execOptions, context) => executeMember(command, execOptions, context, options, callerEnvironment),
  };
  const reads = ["readTextFile", "openTextLineReader", "readTextLines", "readBinaryFile", "openBinaryReader", "fileInfo", "canonicalPath", "exists"] as const;
  for (const name of reads) (methods as any)[name] = async (path: string, ...args: any[]) => {
    try {
      const allowed = await guard.readable(absolute(path));
      const result = await (node[name] as Function).call(node, allowed, ...args);
      if (name === "openBinaryReader" && result.ok) {
        const reader = result.value;
        return ok({ ...reader, info: reader.info.bind(reader), scanLines: reader.scanLines.bind(reader), close: reader.close.bind(reader),
          read: (offset: number, length: number, context: Context) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024)
              return Promise.resolve(err(new FileError("invalid", "Binary read exceeds bounded range")));
            return reader.read(offset, length, context);
          } });
      }
      return result;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (name === "exists" && missing) return ok(false);
      return err(new FileError(missing ? "not_found" : "permission_denied", String(error), path));
    }
  };
  for (const name of ["writeFile", "appendFile", "createDir"] as const) (methods as any)[name] = async (path: string, ...args: any[]) => {
    try { return await (node[name] as Function).call(node, await guard.writable(absolute(path)), ...args); }
    catch (error) { return err(new FileError("permission_denied", String(error), path)); }
  };
  // An allowlist, never a fallback to the unrestricted Node environment.
  return new Proxy(methods as ExecutionEnv, { get(target, name) {
    if (name === "then" || typeof name !== "string") return undefined;
    if (name in target) return Reflect.get(target, name);
    return async () => err(new FileError("not_supported", String(name) + " is unavailable to member tools"));
  } });
}

async function executeMember(command: string | readonly string[], opts: ShellExecOptions = {}, context: Context,
  member: MemberEnvOptions, callerEnvironment: Record<string, string>): Promise<Result<ShellExecResult, ExecutionError>> {
  const seconds = opts.timeout ?? BASH_DEFAULT_TIMEOUT;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return err(new ExecutionError("timeout", "bash timeout 必须大于 0 且不超过 3600 秒"));
  const held = await holdDirectory(member.tempDir, []);
  const name = "pi-bash-" + randomUUID() + ".log";
  let file: Awaited<ReturnType<import("../core/held-directory.ts").Entries["create"]>> | undefined;
  let writing = Promise.resolve();
  let bytes = 0, lines = 0;
  const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() };
  const path = join(member.tempDir, name);
  let failure: unknown, code = 0;
  try {
    file = await held.use(entries => entries.create(name, true));
    const shell = typeof command === "string" ? memberShell() : undefined;
    const backend = configuredRootlessTasks();
    const task = await backend?.create(member.tempDir);
    try {
      const explicit = { ...opts.env, ...callerEnvironment };
      // The task directory stands in for the request's directory, or for the member's tmp outside a run.
      if (task) for (const [key, value] of Object.entries(explicit)) {
        const base = [member.requestDir, member.tempDir].find(dir => dir !== undefined && value && (value === dir || value.startsWith(dir + "/") || value.startsWith(dir + "\\")));
        if (base !== undefined) explicit[key] = task.path + value.slice(base.length);
      }
      const environment = { ...(task || opts.inheritEnv === false ? {} : process.env), ...explicit };
      const exports = Object.entries(explicit).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]))
        .map(([key, value]) => "export " + key + "=" + shellQuote(value)).join("\n");
      const processOptions = { command: typeof command === "string" ? shell!.shell : command[0]!,
        args: typeof command === "string" ? [...shell!.args, exports + "\n" + command] : [...command.slice(1)],
        cwd: opts.cwd ?? member.workspaceDir, env: environment, signal: context.abortSignal, timeoutMs: seconds * 1000,
        onOutput: (data: Buffer, stream: "stdout" | "stderr") => {
          bytes += data.length; for (const byte of data) if (byte === 10) lines++;
          const copy = Buffer.from(data); writing = writing.then(async () => { await file!.handle.writeFile(copy); });
          void writing.catch(() => {});
          const text = decoders[stream].decode(data); if (text) opts.onOutput?.(text, context, { stream });
        } };
      const result = task ? await timedCommand(() => task.run(processOptions, [member.workspaceDir, dirname(member.materialsIndexPath)], { paths: member.inputPaths ?? [] }))
        : await runProcess(processOptions);
      code = result.exitCode;
    } catch (error) { failure = error; }
    finally { if (backend && task) await finishTask(backend, task, "keep"); }
    for (const stream of ["stdout", "stderr"] as const) { const text = decoders[stream].decode(); if (text) opts.onOutput?.(text, context, { stream }); }
    await writing;
    const spill = bytes > (opts.spill?.afterBytes ?? Infinity) || lines > (opts.spill?.afterLines ?? Infinity);
    await file.handle.sync();
    if (spill) {
      const real = await realpath(path);
      const info = await lstat(path, { bigint: true });
      if (!isPathInside(real, await realpath(member.tempDir)) || info.dev !== file.identity.dev || info.ino !== file.identity.ino)
        throw new Error("bash output path changed while writing");
    }
    await file.close(!spill); file = undefined;
    if (failure) {
      const error = new ExecutionError(context.abortSignal?.aborted ? "aborted" : failure instanceof ProcessFailure && failure.kind === "timeout" ? "timeout" : "unknown", String(failure));
      if (spill) error.spillPath = path;
      return err(error);
    }
    return ok({ exitCode: code, ...(spill ? { spillPath: path } : {}) });
  } finally { await writing.catch(() => {}); await file?.close(true); await held.release(); }
}
