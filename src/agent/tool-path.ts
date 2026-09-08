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
 * Pi 0.85.1 resolveToCwd 的路径语义。上游未公开该函数；这里只适配工具路径，
 * 用官方 edit/write 的 operations 接口做差分回归，升级 Pi 时必须一起核对。
 * 来源：packages/coding-agent/src/utils/paths.ts（MIT）。
 */
function normalizePath(input: string, toolPath: boolean): string {
  let path = toolPath ? input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ") : input;
  if (toolPath && path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
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
