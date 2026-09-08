import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { move } from "fs-extra";
import { basename, dirname, extname, join, resolve } from "node:path";
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

/** 使用 Pi 官方类型收窄助手，使独立工具可安全放入 customTools。 */
function asSdkTool<T extends ToolDefinition<any, any, any>>(tool: T) {
  return defineTool({
    ...tool,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  });
}

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

  /** 读取路径：可写根 + 只读根。 */
  async readable(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    this.assertReadable(canonical);
    return canonical;
  }

  async existing(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    this.assertInside(canonical);
    return canonical;
  }

  async writable(path: string): Promise<string> {
    const target = resolve(path);
    let cursor = target;

    while (true) {
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) {
          const canonical = await realpath(cursor).catch(() => null);
          if (!canonical) throw new Error(`拒绝写入悬空符号链接: ${path}`);
          this.assertInside(canonical);
          return target;
        }
        this.assertInside(await realpath(cursor));
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

async function moveOfficialBashOutput(
  source: string,
  tempDir: string
): Promise<string> {
  if (!basename(source).startsWith("pi-bash-") || extname(source) !== ".log") {
    return source;
  }

  const canonicalSource = await realpath(source);
  const canonicalSystemTemp = await realpath(tmpdir());
  const canonicalUserTemp = await realpath(tempDir);
  if (!isPathInside(canonicalSource, canonicalSystemTemp)) return source;
  if (isPathInside(canonicalSource, canonicalUserTemp)) return canonicalSource;

  const stem = basename(source, ".log");
  const destination = join(canonicalUserTemp, `${stem}-${randomUUID()}.log`);
  await move(canonicalSource, destination, { overwrite: false });
  return destination;
}

function createBashTool(
  cwd: string,
  tempDir: string,
  phone: string,
  groupId: string,
  venvDir: string,
  materialsIndexPath: string
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
    UV_PROJECT_ENVIRONMENT: venvDir,
    VIRTUAL_ENV: venvDir,
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
    PI_PYTHON: venvPythonPath(venvDir),
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
        return runProcess({ command: shell.shell, args: [...shell.args, command],
          cwd: executionCwd, env, signal, timeoutMs: seconds * 1000, onData });
      },
    },
    exposeSessionEnvironment: true,
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
      const result = await official.execute(...args);
      const details = result.details as Record<string, unknown> | undefined;
      const source = details?.fullOutputPath;
      if (typeof source !== "string") return result;

      try {
        const destination = await moveOfficialBashOutput(source, tempDir);
        if (destination === source) return result;
        return {
          ...result,
          content: result.content.map((item) =>
            item.type === "text"
              ? { ...item, text: item.text.replaceAll(source, destination) }
              : item
          ),
          details: { ...details, fullOutputPath: destination },
        };
      } catch (error) {
        log.warn(`Pi bash 完整输出迁移失败: ${String(error)}`);
        return result;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      let message = error.message;
      const paths = [...message.matchAll(/Full output: ([^\]\r\n]+)/g)].map(
        (match) => match[1]!.trim()
      );
      for (const source of paths) {
        try {
          const destination = await moveOfficialBashOutput(source, tempDir);
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
    description: official.description + " Default timeout is " + BASH_DEFAULT_TIMEOUT +
      " seconds, maximum 3600. The workspace is reference material: only write to your own temp directory. All child processes are stopped when this command completes or is cancelled.",
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
}

/** Pi 官方工具工厂 + 本项目的 workspace/tmp 边界和调用者环境。 */
export async function buildLocalTools(
  options: LocalToolsOptions
): Promise<ToolDefinition[]> {
  const { workspaceDir: cwd, tempDir, phone, groupId, venvDir } = options;
  const indexPath = resolve(options.materialsIndexPath);
  const guard = await AllowedPathGuard.create(
    [tempDir],
    [cwd, dirname(indexPath)]
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
  const bashTool = createBashTool(cwd, tempDir, phone, groupId, venvDir, indexPath);
  const editTool = createEditToolDefinition(cwd, { operations: editOperations });
  const writeTool = createWriteToolDefinition(cwd, { operations: writeOperations });

  return [readTool, bashTool, editTool, writeTool].map(asSdkTool);
}
