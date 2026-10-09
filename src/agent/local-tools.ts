import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createBashToolDefinition,
  getShellConfig,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeTypeFromFile,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BASH_DEFAULT_TIMEOUT } from "../core/config.ts";
import { log } from "../core/log.ts";
import { isPathInside } from "./paths.ts";
import { venvPythonPath } from "./python-toolchain.ts";
import { runProcess } from "../core/process.ts";
import { moveSystemTempOutput } from "./system-temp.ts";
import { assertTaskPathAllowed, configuredRootlessTasks, ISOLATED_PYTHON } from "../core/rootless-tasks.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
      throw new Error("写入仅允许当前用户 tmp；本群 workspace 和 index 只读");
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

/** Added to the official bash description; the Durable tool catalogue (src/durable/tools.ts) shows the same text. */
export const BASH_TOOL_NOTE = " Default timeout is " + BASH_DEFAULT_TIMEOUT +
  " seconds, maximum 3600. The workspace is reference material: only write to your own temp directory. All child processes are stopped when this command completes or is cancelled.";

function createBashTool(
  cwd: string,
  tempDir: string,
  phone: string,
  groupId: string,
  venvDir: string,
  materialsIndexPath: string,
  engine: Pick<LocalToolsOptions, "sessionEnvironment" | "onBashOutput">
) {
  const callerEnvironment = {
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
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
    PI_GROUP_ID: groupId,
    PI_USER_TMP: tempDir,
    // 解释器路径与索引位置都随群/平台变化，写死在提示词里迟早会过期；导出成变量后
    // 模型只要 "$PI_PYTHON"、"$PI_MATERIALS_INDEX" 即可，也不用再去探测 Scripts/ 还是 bin/。
    PI_PYTHON: configuredRootlessTasks() ? ISOLATED_PYTHON : venvPythonPath(venvDir),
    PI_MATERIALS_INDEX: materialsIndexPath,
    // Pi sets both markers itself, but only in its own CLI/RPC entrypoints. This
    // process embeds the SDK, so child commands need them exported explicitly.
    AI_AGENT: "pi",
    PI_CODING_AGENT: "true",
  };
  const shellExports = Object.entries(callerEnvironment)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  const official = createBashToolDefinition(cwd, {
    operations: {
      exec: async (command, executionCwd, { onData, signal, timeout, env }) => {
        const shell = getShellConfig();
        const seconds = timeout ?? BASH_DEFAULT_TIMEOUT;
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
          throw new Error("bash timeout 必须大于 0 且不超过 3600 秒");
        }
        const tee = engine.onBashOutput;
        try {
          const backend = configuredRootlessTasks();
          if (backend) {
            const task = await backend.create(tempDir);
            try {
              const isolatedEnv = Object.fromEntries(Object.entries(callerEnvironment).map(([key, value]) =>
                [key, value === tempDir || value.startsWith(tempDir + "/") ? task.path + value.slice(tempDir.length) : value]));
              const exports = Object.entries(isolatedEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
              const source = command.startsWith(shellExports + "\n") ? command.slice(shellExports.length + 1) : command;
              const readOnly = [cwd, dirname(materialsIndexPath)];
              return await task.run({ command: shell.shell, args: [...shell.args, exports + "\n" + source],
                cwd: executionCwd, env: isolatedEnv, signal, timeoutMs: seconds * 1000,
                onData: tee === undefined ? onData : (data) => { onData(data); tee(data); } }, readOnly);
            } finally { await task.seal(); }
          }
          return await runProcess({ command: shell.shell, args: [...shell.args, command],
            cwd: executionCwd, env, signal, timeoutMs: seconds * 1000,
            onData: tee === undefined ? onData : (data) => { onData(data); tee(data); } });
        } catch (error) {
          // 官方 Bash 只认 "aborted" 与 "timeout:<秒>"：认出后才把已产生的输出和完整输出文件
          // 写进错误，下面的包装再把文件搬进调用者 tmp；否则部分输出丢失、文件留在系统 TEMP。
          if (signal?.aborted) throw new Error("aborted", { cause: error });
          if (error instanceof Error && (error.message === `Command timed out after ${seconds} seconds`
            || error.name === "TimeoutError" || error.cause instanceof Error && error.cause.name === "TimeoutError")) {
            throw new Error(`timeout:${seconds}`, { cause: error });
          }
          throw error;
        }
      },
    },
    exposeSessionEnvironment: engine.sessionEnvironment ?? true,
    spawnHook: (context) => ({
      ...context,
      // Git Bash can replace inherited TMPDIR while starting; export inside the
      // shell so Pi commands consistently use the caller's isolated temp area.
      command: `${shellExports}\n${context.command}`,
      env: {
        ...context.env,
        ...callerEnvironment,
      },
    }),
  });

  const executeOfficial: typeof official.execute = async (...args) => {
    try {
      // 非零退出码是带 isError 的正常结果，同样要搬移完整输出。
      const result = await official.execute(...args);
      const details = result.details as Record<string, unknown> | undefined;
      // 展示截断时 details 带路径，超过 1 MiB 时结构化结果（codemode 脚本读取）也带同一路径；
      // 两处与文本必须一起改写，否则脚本拿到的是已搬走的旧文件。
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      const sources = [...new Set([details?.fullOutputPath, structured?.full_output_path])]
        .filter((path): path is string => typeof path === "string");
      if (!sources.length) return result;

      const moved = new Map<string, string>();
      for (const source of sources) {
        try {
          const destination = await moveSystemTempOutput(source, tempDir, "pi-bash-", ".log");
          if (destination !== source) moved.set(source, destination);
        } catch (error) {
          log.warn(`Pi bash 完整输出迁移失败: ${String(error)}`);
        }
      }
      if (!moved.size) return result;
      const relocate = (path: unknown) => (typeof path === "string" ? moved.get(path) ?? path : path);
      return {
        ...result,
        content: result.content.map((item) =>
          item.type === "text"
            ? { ...item, text: [...moved].reduce((text, [source, destination]) => text.replaceAll(source, destination), item.text) }
            : item
        ),
        details: details?.fullOutputPath === undefined ? details : { ...details, fullOutputPath: relocate(details.fullOutputPath) },
        ...(structured?.full_output_path !== undefined && {
          structuredContent: { ...structured, full_output_path: relocate(structured.full_output_path) },
        }),
      } as typeof result;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      let message = error.message;
      const paths = [...message.matchAll(/Full output: ([^\]\r\n]+)/g)].map(
        (match) => match[1]!.trim()
      );
      for (const source of paths) {
        try {
          const destination = await moveSystemTempOutput(source, tempDir, "pi-bash-", ".log");
          message = message.replaceAll(source, destination);
        } catch (moveError) {
          log.warn(`Pi bash 错误输出迁移失败: ${String(moveError)}`);
        }
      }
      if (message === error.message) throw error;
      const relocated = new Error(message, { cause: error });
      relocated.name = error.name;
      throw relocated;
    }
  };

  return defineTool({
    ...official,
    description: official.description + BASH_TOOL_NOTE,
    execute: executeOfficial,
  });
}

export interface LocalToolsOptions {
  /** 群共享 workspace，同时是 agent 的 cwd。 */
  workspaceDir: string;
  /** 当前调用用户的临时目录。 */
  tempDir: string;
  phone: string;
  groupId: string;
  /** 文档解析用的群共享 venv，位于 workspace 之外。 */
  venvDir: string;
  /** 资料索引文件路径；所在目录对 read 只读放行。 */
  materialsIndexPath: string;
  /** Enabled modules may expose application-owned instructions for read only. */
  resourceReadDirs?: string[];
  /**
   * Pi's session variables for bash (PI_SESSION_ID, PI_SESSION_FILE, PI_PROVIDER, PI_MODEL, PI_REASONING_LEVEL), read
   * from the AgentSession tool context. Default true; the Durable engine has no session object and turns them off.
   */
  sessionEnvironment?: boolean;
  /** Raw bash output as it arrives, besides the official tool's own accumulation (Durable: the call's `api.output`). Must not throw. */
  onBashOutput?: (data: Buffer) => void;
}

/** Pi 官方工具工厂 + 本项目的 workspace/tmp 边界和调用者环境。 */
export async function buildLocalTools(
  options: LocalToolsOptions
): Promise<ToolDefinition[]> {
  const { workspaceDir: cwd, tempDir, phone, groupId, venvDir } = options;
  const indexPath = resolve(options.materialsIndexPath);
  const guard = await AllowedPathGuard.create(
    [tempDir],
    [cwd, dirname(indexPath), ...(options.resourceReadDirs ?? [])]
  );
  const readOperations = {
    readFile: async (path: string) => readFile(await guard.readable(path)),
    access: async (path: string) => {
      await access(await guard.readable(path), constants.R_OK);
    },
    // Pi 的 read 工具默认就用这个嗅探器；同名覆盖只是为了先过路径边界。
    detectImageMimeType: async (path: string) =>
      detectSupportedImageMimeTypeFromFile(await guard.readable(path)),
  };
  const writeOperations = {
    writeFile: async (path: string, content: string) =>
      writeFile(await guard.writable(path), content, "utf8"),
    mkdir: async (path: string) => {
      await mkdir(await guard.writable(path), { recursive: true });
    },
  };
  const editOperations = {
    readFile: readOperations.readFile,
    writeFile: writeOperations.writeFile,
    access: async (path: string) => {
      await access(
        await guard.existing(path),
        constants.R_OK | constants.W_OK
      );
    },
  };

  const readTool = createReadToolDefinition(cwd, { operations: readOperations });
  const bashTool = createBashTool(cwd, tempDir, phone, groupId, venvDir, indexPath, options);
  const editTool = createEditToolDefinition(cwd, { operations: editOperations });
  const writeTool = createWriteToolDefinition(cwd, { operations: writeOperations });

  return [readTool, bashTool, editTool, writeTool].map(tool => defineTool(tool));
}
