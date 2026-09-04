// 文档解析环境：群共享的 Python venv，装 pptx/docx/xlsx/pdf 的提取库。
//
// 装在 <group>/venv 而不是 workspace/.venv：workspace 是同步盘镜像，按约定只放资料，
// 往里建虚拟环境既污染同步源，也会被下一次同步删掉——真实日志里模型就因此反复
// 探测解释器、重装依赖，甚至在自己的 tmp 里另建了一个 venv。
//
// 备好之后，bash 工具把解释器路径导出为 PI_PYTHON，提示词直接告诉模型「已装好、直接用」。
// uv 不可用（例如容器镜像里没装）时整体降级：不报错，提示词退回「需要时自行创建」。
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DOCUMENT_TOOLCHAIN_PACKAGES,
  DOCUMENT_TOOLCHAIN_TIMEOUT,
} from "../core/config.ts";
import { log } from "../core/log.ts";

/** 装好标记：内容是包清单，清单变化时自动重装。 */
const MARKER_NAME = ".mixin-doc-toolchain";

/** venv 内解释器路径。Windows 在 Scripts/，其余平台在 bin/。 */
export function venvPythonPath(venvDir: string): string {
  return process.platform === "win32"
    ? join(resolve(venvDir), "Scripts", "python.exe")
    : join(resolve(venvDir), "bin", "python");
}

function markerPath(venvDir: string): string {
  return join(resolve(venvDir), MARKER_NAME);
}

function expectedMarker(): string {
  return [...DOCUMENT_TOOLCHAIN_PACKAGES].sort().join("\n");
}

/** 环境是否已经可用。提示词的措辞按它切换，不能猜。 */
export async function documentToolchainReady(venvDir: string): Promise<boolean> {
  try {
    const marker = await readFile(markerPath(venvDir), "utf8");
    // 换行归一化：运维在 Windows 上手写这个文件会写成 CRLF，逐字比对就会失配，
    // 于是每次启动都重建一遍 venv——无声，只是慢，而且会抹掉手动加装的包。
    return marker.replace(/\r\n?/g, "\n").trim() === expectedMarker();
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Windows 上 uv 常以 uv.cmd 形式安装，需要走 shell 解析。
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} 执行超时`));
    }, DOCUMENT_TOOLCHAIN_TIMEOUT);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} 退出码 ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

const provisioning = new Map<string, Promise<boolean>>();

async function provision(venvDir: string): Promise<boolean> {
  const target = resolve(venvDir);
  if (await documentToolchainReady(target)) return true;
  const started = Date.now();
  log.info(`开始准备文档解析环境 - ${target}`);
  try {
    // --allow-existing：uv 对已存在的 venv 直接报错退出，没有这个标志，包清单一变
    // 就再也装不进已部署的群——provision 会卡在第一步，环境永远停在旧清单上。
    // 用它而不是 --clear：清单变化只需要把新包补进去，重建会连带抹掉模型或运维
    // 临时装的东西；解释器被删时它也会补回来，坏掉的环境照样能自愈。
    await run("uv", ["venv", "--allow-existing", target]);
    await run("uv", [
      "pip",
      "install",
      "--python",
      venvPythonPath(target),
      ...DOCUMENT_TOOLCHAIN_PACKAGES,
    ]);
    await writeFile(markerPath(target), expectedMarker(), "utf8");
    log.info(
      `文档解析环境就绪 - 耗时: ${((Date.now() - started) / 1000).toFixed(2)}秒, 路径: ${target}`
    );
    return true;
  } catch (e) {
    // 降级而不是失败：没有它模型仍能靠自己装依赖，只是慢一些。
    log.warn(
      `文档解析环境准备失败，提示词将退回自助模式 - ${target}, 错误: ${String(e)}`
    );
    return false;
  }
}

/**
 * 确保环境就绪，同一目录并发只跑一次。
 *
 * 调用方通常不 await：建环境要联网装包，可能耗时数十秒，而会话创建发生在「正在思考」
 * 回执之前，阻塞在这里等于让用户对着空白等待。
 */
export function ensureDocumentToolchain(venvDir: string): Promise<boolean> {
  const key = resolve(venvDir);
  const existing = provisioning.get(key);
  if (existing) return existing;
  const task = provision(key).finally(() => {
    provisioning.delete(key);
  });
  provisioning.set(key, task);
  return task;
}
