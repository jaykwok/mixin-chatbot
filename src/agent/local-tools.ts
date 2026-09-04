import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
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
import {
  runFileMutation,
  runFileMutations,
  runOpaqueWorkspaceOperation,
} from "./workspace-coordinator.ts";

const coordinatedBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds (optional, defaults to ${BASH_DEFAULT_TIMEOUT})`,
    })
  ),
  mutates: Type.Array(Type.String(), {
    description:
      "Workspace file paths this command may create, modify, rename, or delete. Use [] only for a read-only command; use ['.'] when the affected files cannot be enumerated. Paths outside the group workspace, such as your own temp directory, need no coordination and are ignored rather than rejected.",
  }),
});

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
      throw new Error("文件工具只能访问本群 workspace 或当前调用用户 tmp");
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
  await copyFile(canonicalSource, destination, constants.COPYFILE_EXCL);
  await unlink(canonicalSource);
  return destination;
}

function createBashTool(
  cwd: string,
  tempDir: string,
  phone: string,
  groupId: string,
  venvDir: string,
  materialsIndexPath: string
): ToolDefinition<typeof coordinatedBashSchema> {
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
    // Git Bash turns an empty heredoc into `< /dev/null`, which on Windows is the
    // NUL character device, and the CRT reports isatty(NUL) as true. `python -`
    // therefore believes it is interactive and starts the 3.13+ _pyrepl, whose
    // console-size probe on that handle fails (WinError 6 or 123 depending on what
    // stdin ended up being); the REPL swallows the error and loops, spewing
    // tracebacks at megabytes per second and never exiting — one such command wrote
    // 3.26GB before it was killed. The basic REPL just reads EOF and quits.
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

  const workspaceRoot = resolve(cwd);

  /**
   * `mutates` is scheduling metadata, never a boundary: the bash tool spawns a
   * real shell, so no declaration can contain where a command actually writes.
   * Its only job is taking FIFO locks on the shared group workspace. Paths
   * outside it — the caller's private tmp, most often — need no lock at all, so
   * they are dropped instead of rejected; declaring them honestly must not cost
   * the user a turn. A missing or malformed declaration falls back to the
   * workspace-wide lock, which is conservative and always safe.
   */
  const workspaceLockTargets = (mutates: unknown): string[] | "opaque" => {
    if (
      !Array.isArray(mutates) ||
      mutates.some((path) => typeof path !== "string")
    ) {
      return "opaque";
    }
    const targets = mutates.map((path) => resolve(workspaceRoot, path));
    if (targets.some((path) => path === workspaceRoot)) return "opaque";
    return targets.filter((path) => isPathInside(path, workspaceRoot));
  };

  const execute: ToolDefinition<typeof coordinatedBashSchema>["execute"] = (
    toolCallId,
    { mutates, ...input },
    signal,
    onUpdate,
    context
  ) => {
    // Pi leaves bash unbounded unless the model declares a timeout. Nobody is
    // watching a terminal here: a command that never exits (a stray REPL, a
    // prompt waiting on stdin, a wedged download) silently eats the whole turn —
    // the user keeps the "正在思考" ack and never gets an answer, later messages
    // only queue as steering, and the session slot never comes back. A declared
    // timeout always wins; this only fills the gap when there is none.
    const bounded =
      typeof input.timeout === "number" && Number.isFinite(input.timeout)
        ? input
        : { ...input, timeout: BASH_DEFAULT_TIMEOUT };
    const task = () =>
      executeOfficial(toolCallId, bounded, signal, onUpdate, context);
    const targets = workspaceLockTargets(mutates);
    if (targets === "opaque") {
      return runOpaqueWorkspaceOperation(cwd, task, signal);
    }
    return runFileMutations(cwd, targets, task, signal);
  };

  return {
    ...official,
    parameters: coordinatedBashSchema,
    prepareArguments: (args: unknown) => {
      const raw = args as Record<string, unknown>;
      const prepared = official.prepareArguments
        ? official.prepareArguments(args)
        : (raw as { command: string; timeout?: number });
      // Fail safe rather than loud: an omitted or malformed declaration becomes
      // the workspace-wide lock instead of throwing away the whole tool call.
      const declared = raw?.mutates;
      const mutates =
        Array.isArray(declared) && declared.every((path) => typeof path === "string")
          ? (declared as string[])
          : ["."];
      return { ...prepared, mutates };
    },
    description: `${official.description} Commands without an explicit timeout are stopped after ${BASH_DEFAULT_TIMEOUT} seconds; pass a larger timeout when a command legitimately needs longer. Before execution, declare every workspace path the command may create, modify, rename, or delete in mutates. Use an empty list only for read-only commands and ["."] for unknown or workspace-wide changes. Declared paths share FIFO locks with edit/write; paths outside the group workspace need no lock and are ignored. Do not start background workspace writers.`,
    execute,
  } as unknown as ToolDefinition<typeof coordinatedBashSchema>;
}

/**
 * Pi's own edit/write already wrap their mutation in withFileMutationQueue, so
 * this looks redundant — it is not. That queue only serializes edit against
 * write; this one shares its FIFO with the paths bash declares in `mutates`,
 * which is the only thing keeping a file edit from overlapping a bash command
 * that touches the same file, and it adds the workspace-level gate that keeps
 * both away from a workspace-wide (opaque) bash operation.
 */
function coordinateFileTool<T extends ToolDefinition<any, any, any>>(
  tool: T,
  cwd: string
): T {
  const execute: typeof tool.execute = (...args) => {
    const input = args[1] as { path?: unknown };
    if (typeof input?.path !== "string") return tool.execute(...args);
    return runFileMutation(
      cwd,
      resolve(cwd, input.path),
      () => tool.execute(...args),
      args[2]
    );
  };
  return { ...tool, execute };
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
    [cwd, tempDir],
    [dirname(indexPath)]
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
  const editTool = coordinateFileTool(
    createEditToolDefinition(cwd, { operations: editOperations }),
    cwd
  );
  const writeTool = coordinateFileTool(
    createWriteToolDefinition(cwd, { operations: writeOperations }),
    cwd
  );

  return [readTool, bashTool, editTool, writeTool].map(asSdkTool);
}
