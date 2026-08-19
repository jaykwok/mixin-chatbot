import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { log } from "../core/log.ts";
import { isPathInside } from "./paths.ts";
import {
  runFileMutation,
  runFileMutations,
  runOpaqueWorkspaceOperation,
} from "./workspace-coordinator.ts";

const coordinatedBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })
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
  private constructor(private readonly roots: string[]) {}

  static async create(roots: string[]): Promise<AllowedPathGuard> {
    return new AllowedPathGuard(
      await Promise.all(roots.map((root) => realpath(resolve(root))))
    );
  }

  private assertInside(path: string): void {
    if (!this.roots.some((root) => isPathInside(path, root))) {
      throw new Error("文件工具只能访问本群 workspace 或当前调用用户 tmp");
    }
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

async function detectImageMimeType(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) {
      return "image/gif";
    }
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      return "image/webp";
    }
    if (bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM") {
      return "image/bmp";
    }
    return null;
  } finally {
    await handle.close();
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
  groupId: string
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
    UV_PROJECT_ENVIRONMENT: join(cwd, ".venv"),
    VIRTUAL_ENV: join(cwd, ".venv"),
    PYTHONIOENCODING: "utf-8",
    PI_CALLER_PHONE: phone,
    PI_GROUP_ID: groupId,
    PI_USER_TMP: tempDir,
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
    const task = () =>
      executeOfficial(toolCallId, input, signal, onUpdate, context);
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
    description: `${official.description} Before execution, declare every workspace path the command may create, modify, rename, or delete in mutates. Use an empty list only for read-only commands and ["."] for unknown or workspace-wide changes. Declared paths share FIFO locks with edit/write; paths outside the group workspace need no lock and are ignored. Do not start background workspace writers.`,
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

/** Pi 官方工具工厂 + 本项目的 workspace/tmp 边界和调用者环境。 */
export async function buildLocalTools(
  cwd: string,
  tempDir: string,
  phone: string,
  groupId: string
): Promise<ToolDefinition[]> {
  const guard = await AllowedPathGuard.create([cwd, tempDir]);
  const readOperations = {
    readFile: async (path: string) => readFile(await guard.existing(path)),
    access: async (path: string) => {
      await access(await guard.existing(path), constants.R_OK);
    },
    detectImageMimeType: async (path: string) =>
      detectImageMimeType(await guard.existing(path)),
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
  const bashTool = createBashTool(cwd, tempDir, phone, groupId);
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
