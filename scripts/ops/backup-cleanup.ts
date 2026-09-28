// 历史归档清理：扫描 backup/rm 和 backup/snapshots 的顶层条目，分类后写出清单；只按清单列出的精确路径删除。
//
//   scan（默认）                    只读扫描，写出 backup/cleanup/<报告名>/manifest.json 和便于查看的 manifest.tsv
//   apply <报告名>                  预演：逐条重新检查选为删除的条目，列出结果和确认码，不删除任何内容
//   apply <报告名> --confirm <码>   执行：删除前再逐条检查路径、链接和内容指纹，结果写入同一报告目录
//
// 名称格式只是线索：测试夹具归档（<夹具名>-<UUIDv4>）还要有内容证据才算“可确认测试数据”。疑似测试数据和
// 无法判断的条目从不删除；业务归档默认保留，要删除须在 manifest.json 中把该条的 action 改为 delete。
// 删除不可撤销，也不能靠 Git 找回；需要恢复的业务归档先另行备份。工具从不跟随链接。
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync,
  rmdirSync, unlinkSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { MIGRATION_FILE } from "../../src/core/data-version.ts";
import { cliArgs } from "../lib/cli.ts";

type Category = "confirmed-test" | "suspected-test" | "business" | "unknown";
type Kind = "directory" | "file" | "link" | "other";
type Action = "delete" | "keep";
export interface Entry {
  path: string; type: Kind; bytes: number; files: number; category: Category; basis: string[];
  suggested: Action; action: Action; fingerprint: string;
}
interface Manifest { format: 2; created: string; integrity: string; entries: Entry[] }
type Outcome = "deleted" | "would-delete" | "kept" | "changed" | "refused" | "missing" | "failed";
export interface Result { path: string; category: Category; bytes: number; outcome: Outcome; reason: string }

const AREAS = ["rm", "snapshots"] as const;
const LABELS: Record<Category, string> = { "confirmed-test": "可确认测试数据", "suspected-test": "疑似测试数据", business: "业务归档", unknown: "无法判断" };
const OUTCOMES: Record<Outcome, string> = {
  deleted: "已删除", "would-delete": "将删除", kept: "保留", changed: "扫描后有变化，跳过", refused: "拒绝", missing: "已不存在", failed: "删除失败",
};
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// tests/helpers/temp.ts 的 archiveFixture 把夹具移入回收区时命名为 <夹具名>-<UUIDv4>；仓库历史中只有它这样命名。
const HELPER_NAME = /^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 运维归档都以时间或 GUID 开头：lifecycle.sh（秒-随机数-随机数-原名）、lifecycle.ps1（GUID-原名）、maintenance.ts（毫秒-UUID-原名）。
const PRODUCTION_NAMES = [/^\d{9,11}-\d{1,5}-\d{1,5}-./, /^[0-9a-f]{32}-./, new RegExp(`^\\d{13}-${UUID}-.`)];
// 事务快照：Linux 用 mktemp 生成 deploy-XXXXXXXX，Windows 用 deploy-/tunnel-<GUID>。
const TRANSACTION_NAME = /^(?:deploy-[A-Za-z0-9]{8}|(?:deploy|tunnel)-[0-9a-f]{32})$/;
const MIGRATION_NAME = new RegExp(`^migration-${UUID}$`);
const POINTERS = ["deploy-transaction", "upgrade-transaction", "update-transaction"];
const REPORT_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ENTRY_PATH = /^backup\/(rm|snapshots)\/([^/\\\u0000-\u001f\u007f]+)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SMALL_FILE = 256 * 1024, FILLER_MIN = 1024 * 1024, FILLER_MAX = 64 * 1024 * 1024;
// mkdtemp 的 6 位随机后缀；要求含大写字母或数字，排除恰好以 6 个小写字母结尾的普通名称。
const FIXTURE_DIR = /^.+-(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6}$/;
// 测试临时根：项目 tmp/test-fixtures、backup/tmp/test-fixtures、tmp/tests-XXXXXX/fixtures、WSL 的 /tmp/mixin-tests/tests-XXXXXX/fixtures。
const TEST_ROOT = /(?:^|[\\/])(?:tmp|mixin-tests)[\\/]+(?:test-fixtures|tests-[A-Za-z0-9]{6}[\\/]+fixtures)[\\/]/;
// RFC 6761 保留的 .test 域名；只认 URL、邮箱或引号中的主机名，排除 foo.test.ts 和 pattern.test(...)。
const TEST_DOMAIN = /(?:\/\/|@|["'=\s])((?:[a-z0-9-]+\.)+test)(?=[/:"'\s?#,]|$)/i;

interface Tree { lines: string[]; bytes: number; files: number; links: string[]; unreadable: string[] }
const newTree = (): Tree => ({ lines: [], bytes: 0, files: 0, links: [], unreadable: [] });
const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);
const kindOf = (stat: BigIntStats): Kind => stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
const stripBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** 不跟随链接地遍历；扫描和删除前复查都完整读取普通文件，将 SHA-256 纳入指纹。 */
function walk(path: string, rel: string, tree: Tree, visit?: (rel: string, size: number, content: FileContent) => void): void {
  let stat: BigIntStats;
  try { stat = lstatSync(path, { bigint: true }); }
  catch (error) { tree.unreadable.push(`${rel}（${code(error)}）`); return; }
  const kind = kindOf(stat);
  tree.lines.push([rel, kind, stat.size, stat.mtimeNs, stat.dev, stat.ino].join("\0"));
  if (kind === "link") { tree.links.push(rel); return; }
  if (kind === "directory") {
    let children: string[];
    try { children = readdirSync(path).sort(); }
    catch (error) { tree.unreadable.push(`${rel}（${code(error)}）`); return; }
    for (const child of children) walk(join(path, child), rel === "." ? child : `${rel}/${child}`, tree, visit);
    return;
  }
  tree.files++; tree.bytes += Number(stat.size);
  if (kind !== "file") { tree.unreadable.push(`${rel}（不是普通文件）`); return; }
  try {
    const content = readContent(path, stat, visit !== undefined);
    tree.lines.push(JSON.stringify([rel, "sha256", content.digest]));
    visit?.(rel, Number(stat.size), content);
  } catch (error) { tree.unreadable.push(`${rel}（${code(error)}）`); }
}
const fingerprint = (tree: Tree) => sha256(tree.lines.sort().join("\n"));

interface FileContent { digest: string; small: Buffer | null; filler: number | null }

/** 同一次读取产生内容摘要和分类证据；内存有界，不把整个大文件载入内存。 */
function readContent(path: string, expected: BigIntStats, evidence: boolean): FileContent {
  const size = Number(expected.size);
  const chunk = Buffer.alloc(Math.max(1, Math.min(size, 1024 * 1024)));
  const small = evidence && size <= SMALL_FILE ? Buffer.alloc(size) : null;
  const hash = createHash("sha256");
  // O_NOFOLLOW 拒绝检查后换入的文件链接；fstat 同时核对打开的文件身份。
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const unchanged = (stat: BigIntStats) => stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino
    && stat.size === expected.size && stat.mtimeNs === expected.mtimeNs && stat.ctimeNs === expected.ctimeNs;
  try {
    if (!unchanged(fstatSync(fd, { bigint: true }))) throw new Error("文件在打开前变化");
    let offset = 0, fill: Buffer | null = null;
    let uniform = evidence && size >= FILLER_MIN && size <= FILLER_MAX;
    while (offset < size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (read === 0) throw new Error("文件在读取中缩短");
      const bytes = chunk.subarray(0, read);
      hash.update(bytes);
      if (small) bytes.copy(small, offset);
      if (uniform) {
        fill ??= Buffer.alloc(chunk.length, chunk[0]!);
        uniform = bytes.equals(fill.subarray(0, read));
      }
      offset += read;
    }
    if (!unchanged(fstatSync(fd, { bigint: true })) || !unchanged(lstatSync(path, { bigint: true }))) {
      throw new Error("文件在读取中变化");
    }
    return { digest: hash.digest("hex"), small, filler: uniform && fill ? fill[0]! : null };
  } finally { closeSync(fd); }
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (code(error) === "ENOENT") return null; throw error; }
}

/** 当前不能删除的条目：未完成事务的快照和归档，以及迁移日志引用的快照和事务。每次使用时重新读取。 */
function protectedPaths(project: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const pointer of ["deploy-transaction", "upgrade-transaction"]) {
    const name = readText(join(project, "data/state", pointer))?.trim();
    if (!name || !TRANSACTION_NAME.test(name)) continue;
    for (const area of AREAS) paths.set(`backup/${area}/${name}`, `未完成的事务正在使用（data/state/${pointer}）`);
  }
  const text = readText(join(project, "data/state", MIGRATION_FILE));
  if (text !== null) {
    let journal: { backup?: unknown; deployment?: unknown };
    try { journal = JSON.parse(stripBom(text)); }
    catch { throw new Error(`迁移日志 data/state/${MIGRATION_FILE} 无法解析，无法判断哪些快照仍在使用；请先检查该文件`); }
    if (typeof journal.backup === "string") paths.set(journal.backup, `当前迁移日志 data/state/${MIGRATION_FILE} 引用的迁移快照`);
    if (typeof journal.deployment === "string" && TRANSACTION_NAME.test(journal.deployment)) {
      for (const area of AREAS) paths.set(`backup/${area}/${journal.deployment}`, `当前迁移日志 data/state/${MIGRATION_FILE} 引用的事务`);
    }
  }
  return paths;
}

const pendingPointer = (project: string) => POINTERS.find(name => {
  try { lstatSync(join(project, "data/state", name)); return true; }
  catch (error) { if (code(error) === "ENOENT") return false; throw error; }
});

/** backup/ 及其下的目录必须是真实目录：工具不经过链接或目录联接。缺失返回 false。 */
function realDirectory(path: string, label: string): boolean {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (code(error) === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} 是链接或不是目录；工具不跟随链接，请人工检查`);
  return true;
}

function inspect(project: string, area: typeof AREAS[number], name: string, protect: Map<string, string>): Entry {
  const path = `backup/${area}/${name}`, absolute = join(project, path);
  const tree = newTree();
  const production = area === "rm" && PRODUCTION_NAMES.some(pattern => pattern.test(name));
  const helper = area === "rm" && !production ? HELPER_NAME.exec(name)?.[1] : undefined;
  const self = helper && FIXTURE_DIR.test(helper) ? Buffer.from(helper) : null;
  let fillerEvidence: string | null = null;
  const found: { evidence: string | null } = { evidence: null };
  walk(absolute, ".", tree, helper === undefined ? undefined : (rel, bytes, read) => {
    if (found.evidence) return;
    if (read.filler !== null) fillerEvidence ??= `${rel} 是 ${size(bytes)} 的单字节填充文件（0x${read.filler.toString(16).padStart(2, "0")}）`;
    const content = read.small;
    if (!content) return;
    if (self && content.includes(self)) { found.evidence = `${rel} 中出现该夹具目录自己的随机名称 ${helper}`; return; }
    const text = content.toString("utf8");
    const root = TEST_ROOT.exec(text);
    if (root) { found.evidence = `${rel} 引用测试临时目录（${root[0]}）`; return; }
    const domain = TEST_DOMAIN.exec(text);
    if (domain) found.evidence = `${rel} 含 RFC 6761 保留的测试域名 ${domain[1]}`;
  });
  found.evidence ??= fillerEvidence;
  const top = tree.lines.find(line => line.startsWith(".\0"));
  const type = (top?.split("\0")[1] ?? "other") as Kind;
  const more = (list: string[]) => list[0] + (list.length > 1 ? ` 等 ${list.length} 处` : "");
  let category: Category, basis: string[];
  if (!top) [category, basis] = ["unknown", [`无法读取：${tree.unreadable[0]}`]];
  else if (type === "link") [category, basis] = ["unknown", ["条目本身是链接或目录联接；工具不跟随链接"]];
  else if (area === "snapshots") {
    if (type === "directory" && TRANSACTION_NAME.test(name)) [category, basis] = ["business", ["部署、升级或隧道快照：操作失败、回滚或清理未完成时保留，用于恢复"]];
    else if (type === "directory" && MIGRATION_NAME.test(name)) [category, basis] = ["business", ["数据迁移快照：迁移前的数据库和配置副本"]];
    else [category, basis] = ["unknown", ["不是已知格式的快照"]];
  } else if (type === "directory" && TRANSACTION_NAME.test(name)) {
    [category, basis] = ["business", ["部署、升级或隧道事务期间移入的原文件（该事务没有成功完成时保留）"]];
  } else if (production) {
    [category, basis] = ["business", ["运维或人工归档：名称以时间或 GUID 开头，是 lifecycle.sh、lifecycle.ps1 或 maintenance.ts 的归档格式"]];
  } else if (helper !== undefined) {
    const clue = `名称是测试夹具的归档格式 <夹具名>-<UUIDv4>（夹具名 ${helper}）；名称只作线索`;
    if (tree.links.length) [category, basis] = ["unknown", [clue, `内部含链接 ${more(tree.links)}；工具不处理含链接的条目`]];
    else if (tree.unreadable.length) [category, basis] = ["unknown", [clue, `部分内容无法读取：${more(tree.unreadable)}`]];
    else if (found.evidence) [category, basis] = ["confirmed-test", [clue, found.evidence]];
    else [category, basis] = ["suspected-test", [clue, "没有找到内容证据（夹具自己的随机名称、测试临时目录、单字节填充文件或 .test 域名）"]];
  } else [category, basis] = ["unknown", ["名称不符合任何已知的归档格式"]];
  if (category === "business" && tree.links.length) basis.push(`内部含链接 ${more(tree.links)}；工具不会删除`);
  if (category === "business" && tree.unreadable.length) basis.push(`部分内容无法读取：${more(tree.unreadable)}；工具不会删除`);
  const reason = protect.get(path);
  if (reason) basis.push(reason + "；工具不会删除");
  const suggested: Action = category === "confirmed-test" && !reason ? "delete" : "keep";
  return { path, type, bytes: tree.bytes, files: tree.files, category, basis, suggested, action: suggested, fingerprint: fingerprint(tree) };
}

/** 除 action 以外的内容都受保护：改动分类、路径或指纹会使整份清单失效。 */
function integrity(created: string, entries: Entry[]): string {
  return sha256(JSON.stringify([created, entries.map(e => [e.path, e.type, e.bytes, e.files, e.category, e.basis, e.suggested, e.fingerprint])]));
}

/** 每个条目一行，便于逐条修改 action。 */
function manifestText(manifest: Manifest): string {
  const head = JSON.stringify({ format: manifest.format, created: manifest.created, integrity: manifest.integrity });
  return head.slice(0, -1) + ',"entries":[\n' + manifest.entries.map(entry => JSON.stringify(entry)).join(",\n") + "\n]}\n";
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const tsvCell = (value: string | number) => String(value).replace(/[\t\r\n]/g, " ");
const timestamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function publish(path: string, content: string): void {
  writeFileSync(path + ".tmp", content, { flag: "w" });
  renameSync(path + ".tmp", path);
}

function reportDirectory(project: string, report: string): string {
  if (!REPORT_NAME.test(report)) throw new Error(`报告名无效：${report}`);
  realDirectory(join(project, "backup"), "backup");
  const directory = join(project, "backup/cleanup", report);
  if (!realDirectory(join(project, "backup/cleanup"), "backup/cleanup") || !realDirectory(directory, `backup/cleanup/${report}`)) {
    throw new Error(`找不到报告 backup/cleanup/${report}`);
  }
  return directory;
}

export interface ScanReport { report: string | null; entries: Entry[]; skipped: string[] }

/** 只读扫描；唯一的写入是 backup/cleanup/<报告名>/ 下的清单。 */
export function scan(project: string, progress?: (done: number, total: number) => void): ScanReport {
  if (!realDirectory(join(project, "backup"), "backup")) return { report: null, entries: [], skipped: [] };
  realDirectory(join(project, "backup/cleanup"), "backup/cleanup");
  const skipped = readdirSync(join(project, "backup")).filter(name => name !== "cleanup" && !(AREAS as readonly string[]).includes(name)).sort();
  const protect = protectedPaths(project);
  const names = AREAS.flatMap(area => realDirectory(join(project, "backup", area), `backup/${area}`)
    ? readdirSync(join(project, "backup", area)).sort().map(name => [area, name] as const) : []);
  const entries = names.map(([area, name], index) => {
    if (index && index % 2000 === 0) progress?.(index, names.length);
    return inspect(project, area, name, protect);
  });
  const created = new Date();
  const report = `${timestamp(created)}-${randomBytes(3).toString("hex")}`;
  const directory = join(project, "backup/cleanup", report);
  mkdirSync(directory, { recursive: true });
  const manifest: Manifest = { format: 2, created: created.toISOString(), integrity: integrity(created.toISOString(), entries), entries };
  publish(join(directory, "manifest.json"), manifestText(manifest));
  const order: Category[] = ["confirmed-test", "business", "suspected-test", "unknown"];
  const rows = [...entries].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || b.bytes - a.bytes);
  publish(join(directory, "manifest.tsv"), [
    "# 仅供查看。要改变某条的处理方式，编辑 manifest.json 中该条的 action（delete 或 keep）；其他字段改动会使清单失效。",
    "# 疑似测试数据和无法判断的条目即使改为 delete 也不会删除。",
    ["动作", "分类", "大小", "字节", "文件数", "路径", "依据"].join("\t"),
    ...rows.map(e => [e.action, LABELS[e.category], size(e.bytes), e.bytes, e.files, e.path, e.basis.join("；")].map(tsvCell).join("\t")),
  ].join("\n") + "\n");
  return { report, entries, skipped };
}

function parseManifest(bytes: Buffer): Manifest {
  let value: any;
  try { value = JSON.parse(stripBom(bytes.toString("utf8"))); }
  catch { throw new Error("清单无效：manifest.json 不是有效的 JSON"); }
  const invalid = (detail: string): never => { throw new Error(`清单无效：${detail}；请重新扫描`); };
  if (value?.format === 1) invalid("旧版清单没有文件内容摘要");
  if (!value || value.format !== 2 || typeof value.created !== "string" || !HEX64.test(value.integrity) || !Array.isArray(value.entries)) invalid("格式不符");
  const seen = new Set<string>();
  for (const e of value.entries) {
    const match = typeof e?.path === "string" ? ENTRY_PATH.exec(e.path) : null;
    if (!match || match[2] === "." || match[2] === ".." || (process.platform === "win32" && /[<>:"|?*]|[. ]$/.test(match[2]!))) invalid(`路径越界或格式不符：${JSON.stringify(e?.path)}`);
    if (seen.has(e.path)) invalid(`路径重复：${e.path}`);
    seen.add(e.path);
    if (!["directory", "file", "link", "other"].includes(e.type) || !Object.hasOwn(LABELS, e.category) || !["delete", "keep"].includes(e.action) ||
        !["delete", "keep"].includes(e.suggested) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !Number.isSafeInteger(e.files) || e.files < 0 ||
        !Array.isArray(e.basis) || e.basis.some((line: unknown) => typeof line !== "string") || !HEX64.test(e.fingerprint)) invalid(`条目字段无效：${e.path}`);
  }
  if (integrity(value.created, value.entries) !== value.integrity) invalid("除 action 以外的内容被改动过");
  return value as Manifest;
}

/** 删除一个已核对的条目；遇到链接立即停止（核对后才出现的链接说明条目又变了）。 */
function remove(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`删除过程中出现链接：${path}`);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) remove(join(path, child));
    rmdirSync(path);
    return;
  }
  try { unlinkSync(path); }
  catch (error) {
    // Windows 的只读属性会阻止删除；去掉只读后重试一次。
    if (process.platform !== "win32" || code(error) !== "EPERM") throw error;
    chmodSync(path, 0o666);
    unlinkSync(path);
  }
}

function evaluate(project: string, entry: Entry, execute: boolean): Result {
  const result = (outcome: Outcome, reason: string, bytes = entry.bytes): Result => ({ path: entry.path, category: entry.category, bytes, outcome, reason });
  if (entry.action !== "delete") return result("kept", "清单动作为保留");
  if (entry.category !== "confirmed-test" && entry.category !== "business") return result("kept", `${LABELS[entry.category]}从不删除`);
  const pointer = pendingPointer(project);
  if (pointer) return result("refused", `出现未完成的部署或升级（data/state/${pointer}）`);
  const reason = protectedPaths(project).get(entry.path);
  if (reason) return result("refused", reason);
  const [, area, name] = ENTRY_PATH.exec(entry.path)!;
  try {
    realDirectory(join(project, "backup"), "backup");
    if (!realDirectory(join(project, "backup", area!), `backup/${area}`)) return result("missing", `backup/${area} 已不存在`);
  } catch (error) { return result("refused", (error as Error).message); }
  const path = join(project, "backup", area!, name!);
  let stat: BigIntStats;
  try { stat = lstatSync(path, { bigint: true }); }
  catch (error) { return code(error) === "ENOENT" ? result("missing", "扫描后已被移走或删除") : result("failed", `无法读取：${code(error)}`); }
  if (stat.isSymbolicLink()) return result("refused", "条目现在是链接或目录联接");
  if (kindOf(stat) !== entry.type) return result("changed", `类型由 ${entry.type} 变为 ${kindOf(stat)}`);
  const tree = newTree();
  walk(path, ".", tree);
  if (tree.links.length) return result("refused", `条目内含链接 ${tree.links[0]}；工具不删除含链接的条目，请人工处理`);
  if (tree.unreadable.length) return result("refused", `部分内容无法读取：${tree.unreadable[0]}`);
  if (fingerprint(tree) !== entry.fingerprint) return result("changed", "扫描后内容有变化（文件增删、改动或替换）；重新扫描后再决定", tree.bytes);
  if (!execute) return result("would-delete", entry.category === "business" ? "业务归档：需要恢复的请先另行备份" : "", tree.bytes);
  try { remove(path); }
  catch (error) { return result("failed", `删除中断，条目可能已部分删除：${(error as Error).message}`, tree.bytes); }
  return result("deleted", "", tree.bytes);
}

export interface ApplyReport { code: string; results: Result[]; resultFile: string | null }

/** 预演（不传确认码）或执行。确认码是 manifest.json 的 SHA-256 前 16 位：预演后改动清单会使它失效。 */
export function apply(project: string, report: string, confirm?: string, progress?: (done: number, total: number) => void): ApplyReport {
  const directory = reportDirectory(project, report);
  const bytes = readFileSync(join(directory, "manifest.json"));
  const manifest = parseManifest(bytes);
  const confirmation = sha256(bytes).slice(0, 16);
  const pointer = pendingPointer(project);
  if (pointer) throw new Error(`有未完成的部署或升级（data/state/${pointer}），先继续或回滚那次操作，再清理备份`);
  protectedPaths(project); // 迁移日志无法解析时在处理任何条目之前停止；每个条目删除前还会重新读取。
  if (confirm !== undefined && confirm !== confirmation) throw new Error("确认码与当前清单不符：清单在预演后被改动过，或确认码输入有误；请重新预演");
  const execute = confirm !== undefined;
  let resultFile: string | null = null;
  if (execute) {
    resultFile = join(directory, `result-${timestamp(new Date())}-${randomBytes(3).toString("hex")}`);
    // 逐条追加，进程中断时也留下已处理条目的记录。
    writeFileSync(resultFile + ".tsv", ["结果", "分类", "大小", "字节", "路径", "说明"].join("\t") + "\n", { flag: "wx" });
  }
  const results = manifest.entries.map((entry, index) => {
    if (index && index % 2000 === 0) progress?.(index, manifest.entries.length);
    const result = evaluate(project, entry, execute);
    if (resultFile) appendFileSync(resultFile + ".tsv", [OUTCOMES[result.outcome], LABELS[result.category], size(result.bytes), result.bytes, result.path, result.reason].map(tsvCell).join("\t") + "\n");
    return result;
  });
  if (resultFile) publish(resultFile + ".json", JSON.stringify({ format: 1, report, manifest: sha256(bytes), finished: new Date().toISOString(), results }, null, 1) + "\n");
  return { code: confirmation, results, resultFile };
}

function totals<T>(items: T[], key: (item: T) => string, bytes: (item: T) => number): Map<string, { count: number; bytes: number }> {
  const map = new Map<string, { count: number; bytes: number }>();
  for (const item of items) {
    const total = map.get(key(item)) ?? { count: 0, bytes: 0 };
    total.count++; total.bytes += bytes(item);
    map.set(key(item), total);
  }
  return map;
}

function printScan(scanned: ScanReport): void {
  if (!scanned.report) { console.log("没有 backup 目录，无需清理。"); return; }
  const byCategory = totals(scanned.entries, entry => entry.category, entry => entry.bytes);
  console.log(`已扫描 backup/rm 和 backup/snapshots 的 ${scanned.entries.length} 个顶层条目；没有删除任何内容。`);
  for (const category of Object.keys(LABELS) as Category[]) {
    const total = byCategory.get(category) ?? { count: 0, bytes: 0 };
    console.log(`  ${LABELS[category]}：${total.count} 个，${size(total.bytes)}`);
  }
  // 疑似和无法判断的条目按夹具名前缀汇总，便于人工判断。
  for (const category of ["suspected-test", "unknown"] as const) {
    const entries = scanned.entries.filter(entry => entry.category === category);
    if (!entries.length) continue;
    const prefix = (entry: Entry) => entry.path.replace(/^backup\/[^/]+\//, "").replace(HELPER_NAME, "$1").replace(/-[A-Za-z0-9]{6}$/, "-*");
    console.log(`${LABELS[category]}按名称前缀（前 10 项）：`);
    for (const [name, total] of [...totals(entries, prefix, entry => entry.bytes)].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10)) {
      console.log(`  ${name}：${total.count} 个，${size(total.bytes)}`);
    }
  }
  if (scanned.skipped.length) console.log(`backup/ 下未扫描：${scanned.skipped.join("、")}`);
  console.log("");
  console.log(`清单：backup/cleanup/${scanned.report}/manifest.json（查看用 manifest.tsv）`);
  console.log("建议动作：只删除可确认测试数据；其余保留。要删除某个业务归档，先另行备份，再把 manifest.json 中该条的 action 改为 delete。");
  console.log("下一步预演（不删除）：");
  console.log(`  Linux：./scripts/ops/ops.sh backup-clean ${scanned.report}`);
  console.log(`  Windows：scripts\\ops\\ops.ps1 backup-clean ${scanned.report}`);
}

function printApply(report: string, applied: ApplyReport, execute: boolean): number {
  const byOutcome = totals(applied.results, result => result.outcome, result => result.bytes);
  console.log(execute ? `已按清单 ${report} 处理：` : `预演清单 ${report}（没有删除任何内容）：`);
  for (const outcome of Object.keys(OUTCOMES) as Outcome[]) {
    const total = byOutcome.get(outcome);
    if (total) console.log(`  ${OUTCOMES[outcome]}：${total.count} 个，${size(total.bytes)}`);
  }
  for (const result of applied.results.filter(result => ["changed", "refused", "missing", "failed"].includes(result.outcome)).slice(0, 20)) {
    console.log(`  [${OUTCOMES[result.outcome]}] ${result.path}：${result.reason}`);
  }
  const business = applied.results.filter(result => result.category === "business" && (result.outcome === "would-delete" || result.outcome === "deleted"));
  if (business.length) {
    console.log(execute ? "已删除的业务归档：" : "以下业务归档将被永久删除；需要恢复的请先另行备份：");
    for (const result of business) console.log(`  ${result.path}（${size(result.bytes)}）`);
  }
  if (execute) {
    console.log(`结果：${applied.resultFile}.json（逐条记录 ${applied.resultFile}.tsv）；疑似和无法判断的条目仍保留在原处。`);
    return byOutcome.has("failed") ? 1 : 0;
  }
  console.log("");
  console.log(`确认码：${applied.code}`);
  console.log("删除不可撤销，也不能用 Git 找回。确认后执行：");
  console.log(`  Linux：./scripts/ops/ops.sh backup-clean ${report} --confirm ${applied.code}`);
  console.log(`  Windows：scripts\\ops\\ops.ps1 backup-clean ${report} -ConfirmCode ${applied.code}`);
  return 0;
}

function usage(): void {
  console.log("用法：bun run scripts/ops/backup-cleanup.ts [scan | apply <报告名> [--confirm <确认码>]]");
  console.log("");
  console.log("  scan                         只读扫描 backup/rm 和 backup/snapshots，分类并写出清单（默认）");
  console.log("  apply <报告名>               预演：重新检查清单中选为删除的条目，给出确认码，不删除");
  console.log("  apply <报告名> --confirm <码> 按清单的精确路径删除；执行前逐条重新检查，结果写入报告目录");
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = cliArgs(args, { confirm: { type: "string" } });
  const [command = "scan", report, ...extra] = positionals;
  if (extra.length) throw new Error("参数过多");
  const progress = (done: number, total: number) => console.error(`…… ${done}/${total}`);
  const project = process.cwd();
  switch (command) {
    case "scan":
      if (report !== undefined || values.confirm !== undefined) throw new Error("scan 不接受其他参数");
      printScan(scan(project, progress));
      return 0;
    case "apply":
      if (!report) throw new Error("apply 需要报告名（backup/cleanup 下的目录名）");
      return printApply(report, apply(project, report, values.confirm, progress), values.confirm !== undefined);
    default:
      usage();
      return command === "help" ? 0 : 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); return 1; }));
}
