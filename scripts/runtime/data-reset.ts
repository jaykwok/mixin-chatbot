// A release boundary, not a chain of historical converters. Old readers run in the source release.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { DATA_VERSION, GROUP_ROOT_LEASE, VERSION_FILE, readDataVersion, readMetadata } from "../../src/core/data-version.ts";
import { digest, publishJson } from "../lib/atomic-file.ts";

const credentials = ["webhook-secret", "cloudflared-token"];
const tables = { stats_schema: "id", sources: "id", activity: "source, day", tool_counts: "source, day, kind, tool",
  usage_totals: "source, day, kind, provider, model", meta: "key" };
const stateKept = new Set(["service.lock", "deploy.lock", "deploy-transaction", "upgrade-transaction", "data-plan.json",
  "verify-only", "bot-port", "bot-domain", "deploy-mode", "group-data-root", "task-runtime", "cloudflared.pid", "cloudflared-managed"]);
export interface ResetPlan { from: number; markers: (string | null)[]; inputs: string; draft: string }
interface Move { area: "project" | "groups"; name: string; existed: boolean }
interface Journal { format: 1; deployment: string; groups: string; phase: "moving" | "prepared" | "restoring" | "restored";
  moves: Move[]; stats: string; draft: string; credentials: Record<string, string | null> }
const hash = (path: string) => digest(existsSync(path) ? readFileSync(path) : null);
const markers = (project: string, groups: string) => [hash(join(project, "data/state", VERSION_FILE)), hash(join(groups, VERSION_FILE))];

/** Malformed, half-written and newer pairs must never be interpreted as consent to reset. */
export function resetVersion(project: string, groups: string): number | null {
  const a = readDataVersion(join(project, "data/state", VERSION_FILE)), b = readDataVersion(join(groups, VERSION_FILE));
  if (!a && !b) return null;
  if (!a || !b || a.transaction !== b.transaction || a.dataVersion !== b.dataVersion)
    throw new Error("项目与群根的数据版本标记不成对；拒绝自动清理，请先恢复一致状态");
  if (a.dataVersion > DATA_VERSION) throw new Error("数据来自更新版本，禁止通过清理执行降级");
  return a.dataVersion < DATA_VERSION ? a.dataVersion : null;
}

/** Traversal never follows links; reset roots and drafts cannot redirect writes outside the deployment. */
function plain(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error(`重置路径不能经过链接：${p}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(p) === p) return;
  }
}
function treeHash(path: string): string {
  const h = createHash("sha256");
  function walk(p: string, name: string) {
    if (!existsSync(p)) { h.update(JSON.stringify([name, "absent"])); return; }
    const info = lstatSync(p);
    if (info.isSymbolicLink()) throw new Error("配置草稿不能包含链接");
    if (info.isDirectory()) { h.update(JSON.stringify([name, "dir"])); for (const child of readdirSync(p).sort()) walk(join(p, child), name + "/" + child); }
    else if (info.isFile()) { h.update(JSON.stringify([name, "file", hash(p)])); }
    else throw new Error("配置不能包含特殊文件");
  }
  walk(path, ""); return h.digest("hex");
}
function inputHash(project: string): string {
  return createHash("sha256").update(treeHash(join(project, "data/config")))
    .update(hash(join(project, "data/runtime/pi/settings.json")) ?? "absent").digest("hex");
}
const secretHashes = (project: string) => Object.fromEntries(credentials.map(name => [name, hash(join(project, "data/config", name))]));
function assertSecrets(project: string) {
  const path = join(project, "data/config/webhook-secret"); plain(path);
  if (!existsSync(path) || !/^[a-f\d]{64}$/i.test(readFileSync(path, "utf8").trim())) throw new Error("升级重置必须保留有效的 webhook-secret，拒绝生成新密钥");
}

export async function prepareResetDraft(project: string, groups: string, draft: string): Promise<void> {
  if (resetVersion(project, groups) === null) throw new Error("只有较旧且成对的数据版本才允许重置");
  plain(project); plain(groups); plain(draft); assertSecrets(project);
  if (existsSync(draft)) throw new Error("重置配置目录已存在，请使用新的临时目录");
  await mkdir(join(draft, "data/config"), { recursive: true, mode: 0o700 });
  await mkdir(join(draft, "data/runtime/pi"), { recursive: true, mode: 0o700 });
  await mkdir(join(draft, "backup/rm"), { recursive: true, mode: 0o700 });
  const setting = (name: string, fallback: string) => existsSync(join(project, "data/state", name)) ? readFileSync(join(project, "data/state", name), "utf8").trim() : fallback;
  await publishJson(join(draft, "data/config/runtime.json"), { GROUP_DATA_ROOT: groups,
    BOT_PORT: setting("bot-port", "1011"), BOT_HOST: setting("deploy-mode", "direct") === "cloudflare" ? "127.0.0.1" : "0.0.0.0" });
  for (const name of credentials) if (existsSync(join(project, "data/config", name))) await cp(join(project, "data/config", name), join(draft, "data/config", name));
}

export function makeResetPlan(project: string, groups: string, draft: string): ResetPlan {
  const from = resetVersion(project, groups);
  if (from === null) throw new Error("本次不需要数据重置");
  plain(draft); assertSecrets(project);
  if (JSON.stringify(secretHashes(project)) !== JSON.stringify(secretHashes(draft))) throw new Error("草稿改变了入口凭证，拒绝切换");
  return { from, markers: markers(project, groups), inputs: inputHash(project), draft: treeHash(join(draft, "data")) };
}

/** Stable full-row digest includes identities, source cursors, unknown flags and costs, not just totals. */
export function statsDigest(path: string): string {
  plain(path);
  if (!existsSync(path)) throw new Error("统计库缺失，拒绝以空统计代替历史数据");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("BEGIN");
    const schema = db.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number } | null;
    if (schema?.version !== 2) throw new Error("只接受统计 schema 2；保留原件，另行转换统计后重试");
    if (JSON.stringify(db.query("PRAGMA integrity_check").values()) !== '[["ok"]]' || db.query("PRAGMA foreign_key_check").all().length)
      throw new Error("统计库完整性检查失败");
    const h = createHash("sha256");
    for (const [table, order] of Object.entries(tables)) {
      h.update(table);
      for (const row of db.query(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) h.update(JSON.stringify(row) + "\n");
    }
    return h.digest("hex");
  } finally { db.close(); }
}

function snapshotPath(project: string, deployment: string): string {
  if (!/^deploy-[A-Za-z0-9]+$/.test(deployment)) throw new Error("重置必须属于发布事务");
  return join(project, "backup/snapshots", deployment);
}
function paths(project: string, groups: string, deployment: string) {
  const snapshot = snapshotPath(project, deployment);
  const archive = join(groups, ".reset-" + deployment);
  const projectArchive = join(project, "data", ".reset-" + deployment);
  for (const p of [project, groups, snapshot, archive, projectArchive, join(project, "backup/statistics", deployment), join(project, "data/state"), join(project, "data/config"), join(project, "data/runtime")]) plain(p);
  const inside = (child: string, root: string) => { const rel = relative(resolve(root), resolve(child)); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")); };
  if (inside(project, groups) || inside(join(project, "data"), groups) || inside(groups, projectArchive) || inside(projectArchive, groups)
    || ["backup", "data/config", "data/runtime", "data/state"].some(name => inside(groups, join(project, name)) || inside(join(project, name), groups)))
    throw new Error("群根与项目管理目录重叠，拒绝重置");
  return { snapshot, archive, projectArchive, journal: join(snapshot, "reset.json"), draft: join(snapshot, "reset-config"),
    permanent: join(project, "backup/statistics", deployment) };
}
function movePaths(project: string, groups: string, projectArchive: string, archive: string, move: Move) {
  const root = move.area === "groups" ? groups : project;
  const target = resolve(root, move.name);
  if (!relative(root, target) || isAbsolute(relative(root, target)) || relative(root, target).startsWith("..") || resolve(target) === resolve(root)) throw new Error("重置条目越界");
  if (move.area === "groups" && (move.name.includes("/") || move.name.includes("\\") || [".", "..", GROUP_ROOT_LEASE].includes(move.name) || move.name.startsWith(".reset-") || /^stats\.sqlite(?:-wal|-shm|-journal)?$/.test(move.name))) throw new Error("重置群条目无效");
  if (move.area === "project" && !/^data\/(config|runtime|state\/[^/\\]+)$/.test(move.name)) throw new Error("重置项目条目无效");
  if (move.area === "project" && move.name.startsWith("data/state/") && stateKept.has(move.name.slice(11))) throw new Error("重置不能移动发布资源");
  const saved = move.area === "groups" ? join(archive, move.name) : join(projectArchive, move.name.slice("data/".length));
  plain(target); plain(saved);
  return { live: target, saved };
}
function readJournal(project: string, groups: string, deployment: string): Journal | null {
  // Ordinary upgrades also verify, finish and roll back. They have no reset paths to inspect.
  // lstat distinguishes an absent journal from an existing (including dangling) link.
  try { lstatSync(join(snapshotPath(project, deployment), "reset.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const p = paths(project, groups, deployment), journal = readMetadata(p.journal) as Journal | null;
  if (!journal || journal.format !== 1 || journal.deployment !== deployment || journal.groups !== resolve(groups)
    || !["moving", "prepared", "restoring", "restored"].includes(journal.phase) || !/^[a-f\d]{64}$/.test(journal.stats)
    || !/^[a-f\d]{64}$/.test(journal.draft) || !journal.credentials || !Array.isArray(journal.moves)) throw new Error("重置事务记录无效");
  const seen = new Set<string>();
  for (const move of journal.moves) {
    if (!move || !["project", "groups"].includes(move.area) || typeof move.name !== "string" || typeof move.existed !== "boolean") throw new Error("重置条目无效");
    const key = move.area + ":" + move.name;
    if (seen.has(key)) throw new Error("重置条目重复"); seen.add(key);
    movePaths(project, groups, p.projectArchive, p.archive, move);
  }
  return journal;
}

export async function applyReset(project: string, groups: string, deployment: string, plan?: ResetPlan): Promise<void> {
  const p = paths(project, groups, deployment);
  let journal = readJournal(project, groups, deployment);
  if (journal?.phase === "restored") throw new Error("该重置事务已回滚，请重新升级");
  if (!journal) {
    if (readdirSync(join(project, "data")).some(name => name.startsWith(".reset-"))) throw new Error("项目含未完成的重置，请先继续或回滚");
    if (!plan || JSON.stringify(makeResetPlan(project, groups, p.draft)) !== JSON.stringify(plan)) throw new Error("重置预览后配置、凭证或版本已变化，拒绝清理");
    const freeze = readMetadata(join(p.snapshot, "stats-frozen.json")) as { digest?: string; timezone?: string } | null;
    const stats = statsDigest(join(groups, "stats.sqlite"));
    if (freeze?.digest !== stats) throw new Error("缺少旧版完成补账的冻结凭据，或统计在冻结后变化");
    if (freeze.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone) throw new Error(`新旧统计时区不同（${freeze.timezone} → ${Intl.DateTimeFormat().resolvedOptions().timeZone}），拒绝切换`);
    await mkdir(p.permanent, { recursive: true, mode: 0o700 });
    const backup = join(p.permanent, "stats.sqlite");
    if (!existsSync(backup)) {
      const db = new Database(join(groups, "stats.sqlite"), { readonly: true });
      try { db.query("VACUUM INTO ?").run(backup); } finally { db.close(); }
    }
    if (statsDigest(backup) !== stats) throw new Error("统计备份核对失败");
    const baseline = new Database(backup, { readonly: true });
    try {
      const incomplete = baseline.query("SELECT COUNT(*) AS sources, COALESCE(SUM(pending), 0) AS lines FROM sources WHERE pending > 0").get();
      await publishJson(join(p.permanent, "baseline.json"), { schema: 2, digest: stats, timezone: freeze.timezone,
        incompleteJsonl: incomplete, at: new Date().toISOString() });
    } finally { baseline.close(); }
    const moves: Move[] = [];
    for (const name of readdirSync(groups)) {
      if (name === GROUP_ROOT_LEASE || /^stats\.sqlite(?:-wal|-shm|-journal)?$/.test(name)) continue;
      if (name.startsWith(".reset-")) throw new Error(`群根含未完成的重置 ${name}，请先继续或回滚`);
      moves.push({ area: "groups", name, existed: true });
    }
    for (const name of ["data/config", "data/runtime", ...readdirSync(join(project, "data/state")).filter(name => !stateKept.has(name)).map(name => "data/state/" + name)])
      moves.push({ area: "project", name, existed: existsSync(join(project, name)) });
    for (const move of moves) movePaths(project, groups, p.projectArchive, p.archive, move);
    journal = { format: 1, deployment, groups: resolve(groups), phase: "moving", moves, stats, draft: plan.draft, credentials: secretHashes(project) };
    // Durable intent precedes every rename. A retry sees either the source or its own saved copy.
    await publishJson(p.journal, journal);
  }
  if (journal.deployment !== deployment || journal.groups !== resolve(groups)) throw new Error("重置事务身份不符");
  if (journal.phase === "prepared") { verifyReset(project, groups, deployment); return; }
  if (journal.phase !== "moving") throw new Error("重置事务阶段无效");
  if (treeHash(join(p.draft, "data")) !== journal.draft) throw new Error("重置配置草稿在确认后变化");
  // data/, backup/ and an external group root are independent Docker mounts. Each rename stays on its source mount.
  await mkdir(p.archive, { recursive: true, mode: 0o700 });
  await mkdir(p.projectArchive, { recursive: true, mode: 0o700 });
  for (const move of journal.moves) {
    const { live, saved } = movePaths(project, groups, p.projectArchive, p.archive, move);
    if (move.existed && !existsSync(saved)) { await mkdir(dirname(saved), { recursive: true }); await rename(live, saved); }
  }
  // Copying an interrupted draft is repeatable; no service runs until this phase completes.
  for (const name of ["config", "runtime"]) await cp(join(p.draft, "data", name), join(project, "data", name), { recursive: true, force: true });
  // Generated host isolation metadata is a deployment resource, not user configuration.
  for (const name of ["data/config/task-deployment.json", "data/runtime/bot-launcher.ps1"]) {
    const saved = join(p.projectArchive, name.slice("data/".length));
    if (existsSync(saved)) { plain(saved); await cp(saved, join(project, name)); }
  }
  journal.phase = "prepared"; await publishJson(p.journal, journal);
  verifyReset(project, groups, deployment);
}

export function verifyReset(project: string, groups: string, deployment: string): void {
  const journal = readJournal(project, groups, deployment);
  if (!journal) return;
  if (journal.phase !== "prepared" || statsDigest(join(groups, "stats.sqlite")) !== journal.stats) throw new Error("重置前后统计不一致，禁止提交");
  if (JSON.stringify(secretHashes(project)) !== JSON.stringify(journal.credentials)) throw new Error("入口凭证在重置后变化，禁止提交");
}

export async function rollbackReset(project: string, groups: string, deployment: string): Promise<void> {
  const journal = readJournal(project, groups, deployment);
  if (!journal || journal.phase === "restored") return;
  const p = paths(project, groups, deployment);
  if (journal.groups !== resolve(groups) || journal.deployment !== deployment) throw new Error("重置恢复身份不符");
  if (statsDigest(join(groups, "stats.sqlite")) !== journal.stats) throw new Error("统计在冻结后变化，保持停机并保留原会话与统计备份，请先核查");
  journal.phase = "restoring"; await publishJson(p.journal, journal);
  for (const move of [...journal.moves].reverse()) {
    const { live, saved } = movePaths(project, groups, p.projectArchive, p.archive, move);
    if (existsSync(saved)) {
      await rm(live, { recursive: true, force: true }); await mkdir(dirname(live), { recursive: true }); await rename(saved, live);
    } else if (!move.existed) await rm(live, { recursive: true, force: true });
  }
  // New empty group databases created by verification cannot be mixed into the restored generation.
  const original = new Set(journal.moves.filter(m => m.area === "groups").map(m => m.name));
  for (const name of readdirSync(groups)) if (!original.has(name) && !name.startsWith(".") && !/^stats\.sqlite(?:-wal|-shm|-journal)?$/.test(name))
    await rm(join(groups, name), { recursive: true, force: true });
  await rm(p.archive, { recursive: true, force: true });
  await rm(p.projectArchive, { recursive: true, force: true });
  journal.phase = "restored"; await publishJson(p.journal, journal);
}

/** Only after commit and successful activation. The independent statistics backup is never part of this cleanup. */
export async function finishReset(project: string, groups: string, deployment: string): Promise<void> {
  const journal = readJournal(project, groups, deployment);
  if (!journal) return;
  const p = paths(project, groups, deployment);
  if (journal.phase !== "prepared" || journal.groups !== resolve(groups)) throw new Error("重置清理身份不符");
  await rm(p.archive, { recursive: true, force: true });
  await rm(p.projectArchive, { recursive: true, force: true });
}

export function resetArchiveName(deployment: string): string { return ".reset-" + deployment; }
