// 群共享资料清单写在 workspace 之外，避免被外部同步覆盖。
// 提示词只提供清单路径；概览和正文按需检索，不随扫描结果改变缓存前缀。
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import {
  MATERIALS_INDEX_MAX_DEPTH,
  MATERIALS_INDEX_MAX_FILES,
  MATERIALS_INDEX_TTL,
} from "../core/config.ts";
import { log } from "../core/log.ts";
import { application } from "../core/lifecycle.ts";

/** 与具体群无关的噪声目录；点开头的目录（.git/.venv/.cache）一律跳过。 */
const ALWAYS_SKIPPED = new Set(["node_modules", "__pycache__", "$RECYCLE.BIN"]);

export interface MaterialsIndexSummary {
  /** 清单文件的绝对路径，直接写进提示词供模型 grep。 */
  path: string;
  totalFiles: number;
  totalBytes: number;
  generatedAt: number;
  /** 顶层目录概览，同时写入清单正文。 */
  topLevel: { name: string; files: number; bytes: number }[];
  /** 触碰扫描上限或存在不可读条目时为 true，清单正文会说明不完整。 */
  truncated: boolean;
}

interface FileEntry {
  path: string;
  size: number;
  mtime: number;
}

interface ScanResult {
  entries: FileEntry[];
  truncated: boolean;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 读取人工维护的排除前缀。每行一个 workspace 相对路径（POSIX 分隔符），`#` 开头为注释。
 * 同步盘常见的回收站、历史归档目录写在这里，避免上千个已删除文件顶掉真正的资料。
 */
export async function loadIgnorePrefixes(ignorePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase());
}

function isIgnored(relPath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  const target = relPath.toLowerCase();
  return prefixes.some(
    (prefix) => target === prefix || target.startsWith(`${prefix}/`)
  );
}

/**
 * 遍历 workspace 收集文件。软链接整体跳过：同步盘里的链接可能指向树外甚至成环，而索引
 * 的用途只是定位本群资料。
 */
export async function scanWorkspace(
  workspaceDir: string,
  ignorePrefixes: string[] = []
): Promise<ScanResult> {
  const root = resolve(workspaceDir);
  const entries: FileEntry[] = [];
  let truncated = false;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    application.signal.throwIfAborted();
    if (entries.length >= MATERIALS_INDEX_MAX_FILES) { truncated = true; return; }
    if (depth > MATERIALS_INDEX_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      log.warn(`资料索引跳过无法读取的目录: ${dir} (${String(e)})`);
      truncated = true;
      return;
    }
    for (const child of children) {
      application.signal.throwIfAborted();
      if (entries.length >= MATERIALS_INDEX_MAX_FILES) { truncated = true; return; }
      if (child.isSymbolicLink()) continue;
      if (child.name.startsWith(".") || ALWAYS_SKIPPED.has(child.name)) continue;
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (isIgnored(childRel, ignorePrefixes)) continue;
      const childPath = join(dir, child.name);
      if (child.isDirectory()) {
        await walk(childPath, childRel, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      if (entries.length >= MATERIALS_INDEX_MAX_FILES) {
        truncated = true;
        return;
      }
      try {
        const info = await stat(childPath);
        entries.push({ path: childRel, size: info.size, mtime: info.mtimeMs });
      } catch (e) {
        log.warn(`资料索引跳过无法统计的文件: ${childPath} (${String(e)})`);
        truncated = true;
      }
    }
  };

  await walk(root, "", 1);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated };
}

function summarizeTopLevel(entries: FileEntry[]): MaterialsIndexSummary["topLevel"] {
  const byTop = new Map<string, { files: number; bytes: number }>();
  for (const entry of entries) {
    const slash = entry.path.indexOf("/");
    const name = slash === -1 ? "（根目录）" : `${entry.path.slice(0, slash)}/`;
    const bucket = byTop.get(name) ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += entry.size;
    byTop.set(name, bucket);
  }
  return [...byTop]
    .map(([name, bucket]) => ({ name, ...bucket }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 渲染清单正文。每行一个文件，供模型用 grep 检索，不要求可读性优先。 */
export function renderMaterialsIndex(
  workspaceDir: string,
  scan: ScanResult,
  generatedAt: number
): string {
  const totalBytes = scan.entries.reduce((sum, entry) => sum + entry.size, 0);
  const topLevel = summarizeTopLevel(scan.entries);
  const lines = [
    "# 本群资料索引（自动生成，勿手工编辑）",
    "",
    `- 资料根目录：${resolve(workspaceDir).replace(/\\/g, "/")}`,
    `- 生成时间：${formatDateTime(generatedAt)}`,
    `- 文件数：${scan.entries.length}，总大小：${formatSize(totalBytes)}`,
    "- 用法：下面「文件清单」每行一个文件，格式为 `相对路径 | 大小 | 修改日期`。",
    "  用 grep 按关键词检索，不要整份读取。路径相对于资料根目录。",
  ];
  if (scan.truncated) {
    lines.push(
      "- ⚠️ 扫描受限或有无法读取的条目，清单不完整；未收录的部分需要定向遍历定位。"
    );
  }
  lines.push("", "## 目录概览", "");
  for (const dir of topLevel) {
    lines.push(`- ${dir.name} — ${dir.files} 个文件，${formatSize(dir.bytes)}`);
  }
  lines.push("", "## 文件清单", "");
  for (const entry of scan.entries) {
    lines.push(`${entry.path} | ${formatSize(entry.size)} | ${formatDate(entry.mtime)}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function writeIndexFile(indexPath: string, content: string): Promise<void> {
  const temp = `${indexPath}.tmp`;
  await writeFile(temp, content, "utf8");
  // 模型可能正在 grep 上一版；先写临时文件再原子替换，避免读到半份清单。
  await rename(temp, indexPath);
}

async function rebuild(options: EnsureOptions): Promise<MaterialsIndexSummary> {
  const started = Date.now();
  const ignorePrefixes = await loadIgnorePrefixes(options.ignorePath);
  const scan = await scanWorkspace(options.workspaceDir, ignorePrefixes);
  const generatedAt = Date.now();
  await writeIndexFile(
    options.indexPath,
    renderMaterialsIndex(options.workspaceDir, scan, generatedAt)
  );
  const summary: MaterialsIndexSummary = {
    path: resolve(options.indexPath),
    totalFiles: scan.entries.length,
    totalBytes: scan.entries.reduce((sum, entry) => sum + entry.size, 0),
    generatedAt,
    topLevel: summarizeTopLevel(scan.entries),
    truncated: scan.truncated,
  };
  log.info(
    `资料索引已更新 - 文件: ${summary.totalFiles}, 大小: ${formatSize(summary.totalBytes)}, 耗时: ${((Date.now() - started) / 1000).toFixed(2)}秒, 路径: ${summary.path}`
  );
  return summary;
}

export interface EnsureOptions {
  workspaceDir: string;
  indexPath: string;
  ignorePath: string;
}

interface CacheEntry {
  summary: MaterialsIndexSummary;
}

const cache = new Map<string, CacheEntry>();
const building = new Map<string, Promise<MaterialsIndexSummary | null>>();
function rememberSummary(key: string, summary: MaterialsIndexSummary): void {
  cache.delete(key);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, { summary });
}

/**
 * 返回可用的索引摘要，没有则重建。
 *
 * 无缓存时等待扫描；TTL 到期后返回旧摘要并在后台刷新。同一路径的所有扫描共用
 * building，缓存被淘汰后也不会与尚未完成的刷新重复写文件。
 */
export async function ensureMaterialsIndex(
  options: EnsureOptions,
  now = Date.now()
): Promise<MaterialsIndexSummary | null> {
  const key = resolve(options.indexPath);
  const cached = cache.get(key);
  if (cached && now - cached.summary.generatedAt < MATERIALS_INDEX_TTL) return cached.summary;

  const inFlight = building.get(key);
  if (inFlight) return cached?.summary ?? inFlight;

  const build = application.track(rebuild(options))
    .then((summary) => {
      rememberSummary(key, summary);
      return summary;
    })
    .catch((e) => {
      // 索引是加速手段，不是必需品：失败时退回让模型自己 find，不能阻断会话创建。
      log.error(`资料索引生成失败，本次会话退回目录遍历 - ${String(e)}`);
      return null;
    })
    .finally(() => {
      building.delete(key);
    });
  building.set(key, build);
  return cached?.summary ?? build;
}
