/*
 * Adapted from Pi 0.85.1, packages/coding-agent/src/utils/paths.ts.
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Windows 上 Git Bash 和 WSL 写法的盘符路径（成员 shell 里 `pwd` 打印 `/d/x`）转成 `D:\x`；其他路径和其他平台不变。
 * 所有工具一致：成员环境的 absolutePath（Durable 的 read、edit、write）也用它。
 */
export function fromShellPath(path: string): string {
  if (process.platform !== "win32" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}` : path;
}

/**
 * Durable 工具的路径语义（tools/path-utils + 成员环境的 absolutePath）。上游未公开该函数；send_file 和文档工具用这份，
 * tests/agent/tool-path.test.ts 用官方 write 工具做差分回归，升级 Pi 时必须一起核对。
 * 来源：packages/coding-agent/src/utils/paths.ts（MIT）。
 */
function normalizePath(input: string, toolPath: boolean): string {
  let path = toolPath ? input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ") : input;
  if (toolPath && path.startsWith("@")) path = path.slice(1);
  path = fromShellPath(path);
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

export function resolveToolPath(path: string, cwd: string): string {
  const normalized = normalizePath(path, true);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizePath(cwd, false), normalized);
}
