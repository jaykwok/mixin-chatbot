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
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { log } from "../core/log.ts";
import { isPathInside } from "./paths.ts";

type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;

// Pi 0.82 的公开 CreateAgentSessionOptions 把 customTools 写成 ToolDefinition[]，
// 其可选 renderCall 参数导致具体工厂返回值在 strictFunctionTypes 下无法直接协变。
function asSdkTool(tool: ToolDefinition<any, any, any>): ToolDefinition {
  return {
    ...tool,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  } as unknown as ToolDefinition;
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
): BashToolDefinition {
  const official = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: true,
    spawnHook: (context) => ({
      ...context,
      env: {
        ...context.env,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
        XDG_CACHE_HOME: join(tempDir, ".cache"),
        npm_config_cache: join(tempDir, ".npm"),
        BUN_INSTALL_CACHE_DIR: join(tempDir, ".bun-install-cache"),
        PIP_CACHE_DIR: join(tempDir, ".cache", "pip"),
        PI_CALLER_PHONE: phone,
        PI_GROUP_ID: groupId,
        PI_USER_TMP: tempDir,
      },
    }),
  });

  const execute: typeof official.execute = async (...args) => {
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

  return { ...official, execute };
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

  return [
    asSdkTool(createReadToolDefinition(cwd, { operations: readOperations })),
    asSdkTool(createBashTool(cwd, tempDir, phone, groupId)),
    asSdkTool(createEditToolDefinition(cwd, { operations: editOperations })),
    asSdkTool(createWriteToolDefinition(cwd, { operations: writeOperations })),
  ];
}
