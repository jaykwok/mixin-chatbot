// 在 TUI 里逐级浏览目录选一个文件：复用 app.choose（方向键、文字筛选、滚动），不另画一个模态框。
// 只列目录和 accept 认可的文件，隐藏以点开头的条目；链接按目标类型列出，坏链接不列。也可以直接输入路径。
// Windows 在盘符根目录再往上列出所有盘符。只读：不创建、不改动任何东西。
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import * as fmt from "../render/format.ts";
import type { AppApi, Choice } from "../view.ts";

export interface PickFileSpec {
  title: string;
  /** 跟在当前目录后面的一句说明。 */
  description?: string;
  start: string;
  accept(name: string): boolean;
}

/** 列表最多这么多项；更多时用文字筛选或直接输入路径。 */
const LIMIT = 2000;
const DRIVES = "";

function driveRoots(): string[] {
  return [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => `${letter}:\\`).filter(root => existsSync(root));
}

/** `dir` 里的子目录在前、可选文件在后，各按名称排序；读不了目录时抛出。 */
export function directoryChoices(dir: string, accept: (name: string) => boolean): Choice[] {
  const dirs: Choice[] = [], files: Choice[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    let kind: "dir" | "file" | null = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
    let stat;
    if (entry.isSymbolicLink() || kind === "file") {
      try { stat = statSync(path); } catch { continue; }
      kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
    }
    if (kind === "dir") dirs.push({ value: "d:" + path, label: entry.name + "/" });
    else if (kind === "file" && accept(entry.name)) {
      files.push({ value: "f:" + path, label: entry.name, description: `${fmt.bytes(stat!.size)} · 修改于 ${fmt.day(stat!.mtimeMs)}` });
    }
  }
  const byLabel = (a: Choice, b: Choice) => a.label.localeCompare(b.label);
  const all = [...dirs.sort(byLabel), ...files.sort(byLabel)];
  return all.length > LIMIT
    ? [...all.slice(0, LIMIT), { value: "@more", label: `另有 ${all.length - LIMIT} 项未列出`, description: "输入文字筛选，或选“输入路径…”", disabled: true }]
    : all;
}

/** 选中的文件的绝对路径；Esc 返回 null。 */
export async function pickFile(app: AppApi, spec: PickFileSpec, windows = process.platform === "win32"): Promise<string | null> {
  let dir = resolve(spec.start);
  let came: string | undefined;
  for (;;) {
    let entries: Choice[];
    try { entries = dir === DRIVES ? driveRoots().map(root => ({ value: "d:" + root, label: root })) : directoryChoices(dir, spec.accept); }
    catch (error) {
      app.toast("warn", `无法读取目录 ${dir}：${(error as NodeJS.ErrnoException).code ?? String(error)}`);
      const parent = dirname(dir);
      if (parent === dir) return null;
      came = dir; dir = parent;
      continue;
    }
    const root = dir !== DRIVES && parse(dir).root === dir;
    const up: Choice[] = dir === DRIVES || (root && !windows) ? [] : [{ value: "@up", label: "../", description: root ? "所有磁盘" : "上一级目录" }];
    const value = await app.choose({
      title: spec.title,
      description: (dir === DRIVES ? "所有磁盘" : dir) + (spec.description ? " · " + spec.description : ""),
      choices: [...up, { value: "@path", label: "输入路径…", description: "直接输入文件或目录的完整路径" }, ...entries],
      ...(came ? { initial: "d:" + came } : {}),
    });
    if (value === null) return null;
    if (value === "@up") { came = dir; dir = root ? DRIVES : dirname(dir); continue; }
    if (value.startsWith("f:")) return value.slice(2);
    if (value.startsWith("d:")) { came = undefined; dir = value.slice(2); continue; }
    const typed = (await app.ask("文件或目录的完整路径（Esc 返回列表）", dir === DRIVES ? "" : dir))?.trim();
    if (!typed) continue;
    const path = resolve(dir === DRIVES ? "" : dir, typed);
    let stat;
    try { stat = statSync(path); } catch { app.toast("warn", `找不到：${path}`); continue; }
    if (stat.isDirectory()) { came = undefined; dir = path; continue; }
    if (stat.isFile()) return path;
    app.toast("warn", `不是文件或目录：${path}`);
  }
}
