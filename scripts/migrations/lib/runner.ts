import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { lock as acquireLock } from "proper-lockfile";
import { spawn } from "node:child_process";
import { DATA_VERSION, MIGRATION_FILE, VERSION_FILE, migrationCommitted, readDataVersion, type DataVersion } from "../../../src/core/data-version.ts";
import { bytes, digest, fileDigest, info, json, ordinaryPath, publish, publishFile, publishJson } from "./io.ts";
import type { Context, Decisions } from "./types.ts";
import { v1 } from "../v1.ts";
import { describeMigrations } from "./preview.ts";

const migrations = [v1];
interface FileCopy { path: string; saved: string; hash: string | null }
type Kind = "migration" | "verification" | "registration";
interface Journal { format: 1; id: string; target: number; steps: number[]; deployment?: string; groups: string; backup: string | null; phase: "applying" | "validated" | "committed"; kind?: Kind; marker?: DataVersion; decisions: Decisions; files: FileCopy[] }
export interface Plan { format: 1; target: number; groups: string; decisions: Decisions; inputs: Record<string, string | null>; steps: string[]; files: string[] }
const statePath = (c: Context) => join(c.project, "data/state", MIGRATION_FILE);
const configPaths = (project: string) => ["data/config/runtime.json", "data/config/models.json", "data/runtime/pi/settings.json", "data/runtime/models-store.json"].map(path => join(project, path));
const markerPaths = (context: Context) => [join(context.project, "data/state", VERSION_FILE), join(context.groups, VERSION_FILE)];
function pairedMarker(context: Context): DataVersion | null {
  const [local, group] = markerPaths(context).map(readDataVersion);
  return local && group && local.dataVersion === DATA_VERSION && group.dataVersion === DATA_VERSION && local.transaction === group.transaction ? local : null;
}
async function inputs(context: Context) {
  const result: Record<string, string | null> = {};
  for (const path of configPaths(context.project)) { await ordinaryPath(context.project, path); result[relative(context.project, path)] = digest(await bytes(path)); }
  for (const [index, path] of markerPaths(context).entries()) {
    await ordinaryPath(index ? context.groups : context.project, path);
    result[`version-${index}`] = digest(await bytes(path));
  }
  return result;
}
async function validate(context: Context, configProject = context.project): Promise<void> {
  // Never block the event loop: the service lease heartbeat must run during validation.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../validate.ts", import.meta.url)), configProject, context.groups, context.project], {
      cwd: context.project, timeout: 120_000, killSignal: "SIGKILL", windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GROUP_DATA_ROOT: context.groups },
    });
    let errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`当前版本完整校验失败：${errors || code}`)));
  });
}
async function ensureRoots(context: Context) {
  for (const path of [context.project, context.groups]) {
    const stat = await info(path);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`目录不存在或不是普通目录：${path}；Docker 请使用服务挂载路径`);
  }
  if (context.project === context.groups) throw new Error("群根不能是项目根目录");
}
function selected(context: Context) {
  const local = readDataVersion(join(context.project, "data/state", VERSION_FILE));
  const group = readDataVersion(join(context.groups, VERSION_FILE));
  for (const marker of [local, group]) if (marker && marker.dataVersion > DATA_VERSION) throw new Error("数据比代码新，拒绝降级");
  // Restored roots are validated and brought forward from the older side, never rolled back.
  const from = Math.min(local?.dataVersion ?? 0, group?.dataVersion ?? 0);
  const steps = migrations.filter(m => m.to > from);
  if (steps.length !== DATA_VERSION - from || steps.some((step, index) => step.to !== from + index + 1)) throw new Error("数据版本已超出迁移保留期，请按 Git tag 逐级升级");
  return steps;
}
async function readJournal(context: Context): Promise<Journal | null> {
  const journal = await json(statePath(context)) as Journal | null;
  if (!journal) return null;
  if (journal.format !== 1 || !Number.isSafeInteger(journal.target) || journal.target < 1 || journal.target > DATA_VERSION || journal.groups !== context.groups || !/^[\da-f-]{36}$/.test(journal.id) || !Array.isArray(journal.files) || !Array.isArray(journal.steps) || !["applying", "validated", "committed"].includes(journal.phase) || ![undefined, "migration", "verification", "registration"].includes(journal.kind)) throw new Error("迁移状态无法识别，或群挂载与原事务不同");
  if (journal.kind === "verification") {
    if (journal.backup !== null || journal.files.length || journal.steps.length || journal.marker?.dataVersion !== journal.target || !journal.marker.transaction) throw new Error("只校验事务状态无效");
  } else if (journal.backup !== `backup/snapshots/migration-${journal.id}`) throw new Error("迁移备份路径无效");
  for (const file of journal.files) {
    if (!/^\d+$/.test(file.saved)) throw new Error("迁移备份条目无效");
    await ordinaryPath(file.path.startsWith(context.groups + "/") || file.path.startsWith(context.groups + "\\") ? context.groups : context.project, file.path);
  }
  if (journal.backup) await ordinaryPath(context.project, join(context.project, journal.backup));
  if (!committed(context, journal) && (journal.target !== DATA_VERSION || journal.steps.some(to => !migrations.some(m => m.to === to)))) throw new Error(`请先使用数据版本 ${journal.target} 的代码完成中断迁移`);
  return journal;
}
function committed(context: Context, journal: Journal) {
  return migrationCommitted(context.project, journal);
}

export async function committedDeployment(context: Context, deployment: string): Promise<boolean> {
  const journal = await readJournal(context);
  return !!journal && journal.deployment === deployment && committed(context, journal);
}

export async function preview(context: Context, validatePreview = true): Promise<{ plan?: Plan; decisions: Awaited<ReturnType<typeof v1.preview>>["decisions"]; pending: boolean }> {
  await ensureRoots(context);
  const journal = await readJournal(context);
  if (journal && !committed(context, journal)) return { pending: true, decisions: [], plan: undefined };
  const steps = selected(context);
  const initialInputs = await inputs(context);
  const { descriptions, files } = await describeMigrations(context, steps, configPaths(context.project), validatePreview ? staging => validate(context, staging) : undefined);
  if (JSON.stringify(initialInputs) !== JSON.stringify(await inputs(context))) throw new Error("预览期间配置或版本标记变化，请重新预览");
  const decisions = descriptions.flatMap(result => result.decisions);
  const plan: Plan = { format: 1, target: DATA_VERSION, groups: context.groups, decisions: context.decisions,
    inputs: initialInputs, steps: descriptions.flatMap(result => result.steps), files };
  return { plan, decisions, pending: false };
}

async function withLease<T>(context: Context, run: () => Promise<T>): Promise<T> {
  await ensureRoots(context);
  await ordinaryPath(context.project, statePath(context));
  await mkdir(dirname(statePath(context)), { recursive: true });
  // Explicit require never auto-installs packages. An interrupted Windows install can
  // use its preserved dependency snapshot to restore data before restoring old code.
  const require = createRequire(import.meta.url);
  let lock: typeof acquireLock;
  try { lock = (require("proper-lockfile") as { lock: typeof acquireLock }).lock; }
  catch {
    const deployment = process.env.BOT_DEPLOY_BACKUP_ID;
    if (!deployment || !/^deploy-[A-Za-z0-9-]+$/.test(deployment)) throw new Error("迁移运行环境缺少依赖；请使用目标镜像或恢复部署依赖后继续");
    const backup = join(context.project, "backup/snapshots", deployment, "node_modules/proper-lockfile");
    await ordinaryPath(context.project, backup);
    lock = (require(backup) as { lock: typeof acquireLock }).lock;
  }
  let release: () => Promise<void>;
  try { release = await lock(join(context.project, "data/state/service"), { realpath: false, stale: 30000, update: 5000, retries: 0 }); }
  catch (error) { throw new Error("无法取得维护租约；请先停机，异常退出后等待 35 秒再重试", { cause: error }); }
  try { return await run(); } finally { await release(); }
}

export async function apply(context: Context, plan?: Plan): Promise<void> {
  await withLease(context, async () => {
    let journal = await readJournal(context);
    // Keep the last commit receipt on disk until the new journal is ready to publish.
    if (journal && committed(context, journal)) journal = null;
    if (!journal) {
      if (!plan || plan.format !== 1 || plan.target !== DATA_VERSION || plan.groups !== context.groups || JSON.stringify(plan.inputs) !== JSON.stringify(await inputs(context))) throw new Error("配置在预览后变化或预览缺失，请重新预览；未迁移");
      context = { ...context, decisions: plan.decisions };
      const steps = selected(context), marker = pairedMarker(context);
      const kind: Kind = steps.length ? "migration" : marker ? "verification" : "registration";
      const { descriptions, files: declared } = await describeMigrations(context, steps, configPaths(context.project));
      if (descriptions.some(p => p.decisions.length)) throw new Error("迁移决策不完整");
      const paths = new Set(kind === "verification" ? [] : markerPaths(context));
      const state = join(context.project, "data/state");
      if (kind === "migration") {
        for (const path of [...declared, ...configPaths(context.project)]) paths.add(path);
        const databases = new Set([join(state, "agent.sqlite"), join(state, "relay.sqlite"), join(context.groups, "stats.sqlite")]);
        for (const entry of await readdir(state)) if (entry.endsWith(".sqlite")) databases.add(join(state, entry));
        for (const db of databases) for (const suffix of ["", "-wal", "-shm", "-journal"]) paths.add(db + suffix);
      }
      const id = randomUUID(), backup = kind === "verification" ? null : `backup/snapshots/migration-${id}`;
      if (backup) {
        await ordinaryPath(context.project, join(context.project, backup));
        await mkdir(join(context.project, backup), { recursive: true });
      }
      const files: FileCopy[] = [];
      for (const path of paths) {
        const base = path.startsWith(context.groups + "/") || path.startsWith(context.groups + "\\") ? context.groups : context.project;
        await ordinaryPath(base, path);
        const saved = String(files.length), target = join(context.project, backup!, saved);
        const present = await info(path);
        if (present) {
          if (!present.isFile()) throw new Error(`备份目标不是普通文件：${path}`);
          await publishFile(target, path);
        }
        files.push({ path, saved, hash: present ? await fileDigest(target) : null });
      }
      if (JSON.stringify(plan.inputs) !== JSON.stringify(await inputs(context))) throw new Error("备份期间配置被修改，请重新预览");
      journal = { format: 1, id, target: DATA_VERSION, steps: steps.map(m => m.to), kind, marker: marker ?? undefined, deployment: process.env.BOT_DEPLOY_BACKUP_ID,
        groups: context.groups, backup, phase: "applying", decisions: context.decisions, files };
      if (backup) await publishJson(join(context.project, backup, "manifest.json"), journal);
      await publishJson(statePath(context), journal);
    }
    context = { ...context, decisions: journal.decisions };
    // Restart every idempotent step after interruption, including between the two marker writes.
    for (const to of journal.steps) { const step = migrations.find(m => m.to === to)!; await step.apply(context); await step.validate(context); }
    await validate(context);
    journal.phase = "validated";
    await publishJson(statePath(context), journal);
  });
}

export async function commit(context: Context): Promise<void> {
  await withLease(context, async () => {
    const journal = await readJournal(context);
    if (!journal || journal.target !== DATA_VERSION || !["validated", "committed"].includes(journal.phase)) throw new Error("迁移尚未完成校验");
    if (committed(context, journal)) {
      if (!pairedMarker(context)) throw new Error("已提交事务的标记不成对，请通过升级重新校验并登记");
      if (journal.phase !== "committed") { journal.phase = "committed"; await publishJson(statePath(context), journal); }
      return;
    }
    await validate(context);
    if (journal.kind === "verification") {
      const marker = pairedMarker(context);
      if (!marker || marker.transaction !== journal.marker?.transaction) throw new Error("校验期间版本标记变化，请重新升级登记");
    } else {
      const marker = { dataVersion: DATA_VERSION, transaction: journal.id };
      await publishJson(join(context.groups, VERSION_FILE), marker);
      // This is the data commit point. Keep the journal as a durable commit receipt.
      await publishJson(join(context.project, "data/state", VERSION_FILE), marker);
    }
    journal.phase = "committed";
    await publishJson(statePath(context), journal);
    if (process.env.BOT_UPDATE_COMMIT_FILE) await publish(process.env.BOT_UPDATE_COMMIT_FILE, "committed\n");
  });
}

export async function rollback(context: Context, deployment?: string): Promise<boolean> {
  return withLease(context, async () => {
    const journal = await readJournal(context);
    if (!journal) return true;
    if (deployment && journal.deployment !== deployment) {
      if (committed(context, journal)) return true;
      throw new Error("未提交迁移属于另一部署事务，请使用原快照恢复");
    }
    if (committed(context, journal)) return false;
    // Validate every backup before overwriting anything. Restore SQLite sidecars with their database.
    for (const file of journal.files) if (file.hash !== null && await fileDigest(join(context.project, journal.backup!, file.saved)) !== file.hash) throw new Error("备份缺失或损坏；保持停机，请人工恢复");
    for (const file of journal.files) {
      if (file.hash === null) await unlink(file.path).catch(error => { if (error.code !== "ENOENT") throw error; });
      else await publishFile(file.path, join(context.project, journal.backup!, file.saved));
    }
    await unlink(statePath(context));
    return true;
  });
}
