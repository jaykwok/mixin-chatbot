// 资料索引：把群 workspace 里的资料列成一份可 grep 的清单，写到 <group>/index/materials.md。
//
// 为什么放在 workspace 外面：workspace 是外部同步盘的镜像，按约定只放资料。任何多出来的
// 文件都会污染同步源，并可能被下一次同步当作外来内容删除。用户 tmp 也不行——那是每个
// 用户各自的草稿区，还会被 tmp 清理命令删掉，而索引是全群共用、需要长期存在的。
//
// 为什么要有它：模型每次找材料都在重复遍历同一棵目录树。清单一次生成、多轮复用，模型
// grep 一次就能定位到路径、大小和版本日期。清单本身可能上百 KB，所以不进 system prompt，
// 只把目录概览和清单路径注入提示词，正文交给模型按需检索。
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import {
  MATERIALS_INDEX_MAX_DEPTH,
  MATERIALS_INDEX_MAX_FILES,
  MATERIALS_INDEX_TTL,
} from "../core/config.ts";
import { log } from "../core/log.ts";

/** 与具体群无关的噪声目录；点开头的目录（.git/.venv/.cache）一律跳过。 */
const ALWAYS_SKIPPED = new Set(["node_modules", "__pycache__", "$RECYCLE.BIN"]);

export interface MaterialsIndexSummary {
  /** 清单文件的绝对路径，直接写进提示词供模型 grep。 */
  path: string;
  totalFiles: number;
  totalBytes: number;
  generatedAt: number;
  /** 顶层目录概览，注入提示词让模型先缩小范围再检索。 */
  topLevel: { name: string; files: number; bytes: number }[];
  /** 触碰文件数或深度上限时为 true，提示词里会说明清单不完整。 */
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
  } catch {
    return []; // 可选文件，缺失是正常状态。
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
    if (truncated) return;
    if (depth > MATERIALS_INDEX_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      log.warn(`资料索引跳过无法读取的目录: ${dir} (${String(e)})`);
      return;
    }
    for (const child of children) {
      if (truncated) return;
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
    .sort((a, b) => b.files - a.files);
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
      "- ⚠️ 已达扫描上限，清单不完整；未收录的部分需要用 find 自行定位。"
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
  refreshing?: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();
const building = new Map<string, Promise<MaterialsIndexSummary | null>>();

/**
 * 返回可用的索引摘要，没有则重建。
 *
 * 进程内每个群只会阻塞扫描一次：首次（缓存为空）等待结果，之后过期只在后台刷新并立刻
 * 返回旧摘要。会话创建发生在「🤔 正在思考」回执之前，让用户对着空白等一次全量扫描是
 * 不可接受的；索引晚十几分钟更新，代价只是模型可能查不到刚同步进来的新文件。
 */
export async function ensureMaterialsIndex(
  options: EnsureOptions,
  now = Date.now()
): Promise<MaterialsIndexSummary | null> {
  const key = resolve(options.indexPath);
  const cached = cache.get(key);
  if (cached) {
    if (
      now - cached.summary.generatedAt >= MATERIALS_INDEX_TTL &&
      !cached.refreshing
    ) {
      cached.refreshing = rebuild(options)
        .then((summary) => cache.set(key, { summary }))
        .catch((e) => {
          log.error(`资料索引后台刷新失败 - ${String(e)}`);
          cached.refreshing = undefined;
        });
    }
    return cached.summary;
  }

  const inFlight = building.get(key);
  if (inFlight) return inFlight;

  const build = rebuild(options)
    .then((summary) => {
      cache.set(key, { summary });
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
  return build;
}

/** 测试用：清空进程内缓存。 */
export function resetMaterialsIndexCache(): void {
  cache.clear();
  building.clear();
}
