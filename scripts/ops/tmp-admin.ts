// User tmp inspection and offline maintenance. Plans preserve exact paths, identities and outcomes.
import { join, resolve } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { describeAge } from "../lib/age.ts";
import { cliArgs, groupOptions, groupSelection } from "../lib/cli.ts";
import { type GroupSelection } from "../lib/group-data.ts";
import { scanTmp, type UserTmp } from "../lib/tmp-scan.ts";
import { spaceName } from "../lib/history-scan.ts";
import { LAYOUT } from "../../src/core/config.ts";
import { DATA_DIR, STATE_DATABASE_PATH } from "../../src/core/storage.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { configuredRootlessTasks } from "../../src/core/task-backend.ts";
import type { ArchiveRemovalPlan } from "../../src/contracts/maintenance.ts";
import { durableMemberScope } from "../../src/durable/maintenance-view.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import { applyReclamation, previewReclamation } from "../../src/maintenance/reclaim.ts";

function usage(): void {
  console.log("用法：bun run tmp <命令>");
  console.log("  list                         列出成员临时目录占用");
  console.log("  preview --days <天数>|--all   保存可归档清单，核对会话上下文、待交付内容和可恢复任务");
  console.log("  purge --plan <ID> --digest <摘要>  执行或继续原归档清单");
  console.log("  purge --days <天数>|--all     预览后归档；运行时仍须停机并持有维护租约");
  console.log("  reclaim --days <天数>|--all   预览物理回收清单");
  console.log("  reclaim --plan <ID> --digest <摘要>  确认或继续物理回收");
  console.log("  discard                      预览可永久删除的归档（以归档清单证明，内容须与归档时一致）");
  console.log("  discard --plan <ID> --digest <摘要>  永久删除清单中的归档，释放磁盘空间");
  console.log("  --user <成员> --group <群号> 可限定预览；--group direct 为单聊空间；--group-id / --storage-segment 明确群参数含义");
  console.log("  预览只读取数据并保存清单，可在服务运行时进行；执行清单须停机并持有维护租约");
  console.log("  归档保存在 data/state/reclamation/backup/rm，用 discard 释放空间；--archive 可指定同挂载的 backup/rm");
  console.log("  Linux 服务身份写入的条目物理回收或删除归档需宿主维护身份显式传 --legacy --journal <私有事务目录> --recorded-root <服务内数据目录>；不会自动 sudo");
}

export async function collect(user?: string, root = DATA_DIR, group?: string, selection: GroupSelection = "auto"): Promise<UserTmp[]> {
  return scanTmp(root, user, group, selection);
}

async function list(user?: string, group?: string, selection: GroupSelection = "auto"): Promise<number> {
  const users = await collect(user, DATA_DIR, group, selection);
  for (const member of users) {
    console.log(`${member.user}（${spaceName(member.space)}）：${formatSize(member.bytes)}，${member.files} 个文件，最后改动于 ${describeAge(member.newest)}`);
    for (const entry of member.entries.slice(0, 3)) console.log(`  ${entry.name}  ${formatSize(entry.bytes)}（${describeAge(entry.newest)}）`);
    if (member.entries.length > 3) console.log(`  …… 另有 ${member.entries.length - 3} 个条目`);
  }
  console.log(`共 ${users.length} 个成员，合计 ${formatSize(users.reduce((sum, member) => sum + member.bytes, 0))}。`);
  console.log("年龄只用于筛选候选；执行前还会核对持久引用、运行状态、内容和实体。");
  return 0;
}

function options(root: string, archive?: string, legacy = false) {
  return { root: resolve(root), state: resolve(STATE_DATABASE_PATH), archive: resolve(archive ?? join(LAYOUT.reclamation, "backup", "rm")), scope: durableMemberScope, backend: legacy ? undefined : configuredRootlessTasks() };
}

function reportPlan(plan: { id: string; digest: string; items: { status: string; source?: string; path?: string; reason?: string; evidence?: { bytes: number } }[] }): void {
  for (const item of plan.items) console.log(`[${item.status}] ${item.source ?? item.path}（${formatSize(item.evidence?.bytes ?? 0)}）${item.reason ? "：" + item.reason : ""}`);
  for (const status of ["ready", "kept", "deferred"]) {
    const items = plan.items.filter(item => item.status === status);
    console.log(`${status}：${items.length} 项、${formatSize(items.reduce((sum, item) => sum + (item.evidence?.bytes ?? 0), 0))}`);
  }
  console.log(`清单：${plan.id}\n摘要：${plan.digest}`);
}

const LABELS = { archived: "已归档", removed: "已物理回收", discarded: "已永久删除归档" } as const;
const ARCHIVED_NOTE = "归档尚未释放磁盘空间；原路径、目标路径和每项结果保存在清单中。用 discard 预览并确认后永久删除归档。";
const MESSAGES = {
  oneCommand: "只能指定一个命令",
  allAndDays: "--all 和 --days 不能同时使用",
  days: "--days 需要一个不小于 0 的天数",
  confirmScope: "执行清单只接受 --plan 和 --digest，不重新选择范围",
  discardScope: "discard 按已完成的归档清单处理，不接受 --days/--all/--user/--group",
  previewScope: "预览需要 --days <天数> 或 --all；执行原清单需要 --plan 和 --digest",
  previewOnly: "preview 不执行清单",
  legacyOnly: "--legacy/--journal 只用于物理回收或删除归档",
  recordedOnly: "--recorded-root 只用于服务身份条目的宿主维护（--legacy）",
  recordedRoot: "服务身份条目的宿主回收必须用 --recorded-root 指定服务看到的绝对数据目录，以核对容器路径引用",
  journal: "旧共享目录回收必须指定宿主私有 --journal",
  reclaimNext: (id: string, digest: string) => `核对清单后，使用 reclaim --plan ${id} --digest ${digest}（保留本次 --legacy/--journal/--recorded-root 参数）。`,
  discardNext: (id: string, digest: string) => `删除不可撤销。核对清单后，使用 discard --plan ${id} --digest ${digest} 永久删除（保留本次 --legacy/--journal/--recorded-root 参数）。`,
};

/** Totals of the whole list (every run so far), so printing it again never means more was freed. */
function reportProgress(progress: { outcomes: Record<string, { status: string; bytes: number; reason?: string; finishing?: true }> }, done: "archived" | "removed" | "discarded"): number {
  const outcomes = Object.entries(progress.outcomes);
  for (const [index, outcome] of outcomes) if (outcome.reason) console.log(`清单项 ${Number(index) + 1}：${outcome.finishing ? "收尾" : outcome.status}；${outcome.reason}`);
  const finished = outcomes.filter(([, item]) => item.status === (done === "archived" ? "archived" : "removed") && !item.finishing);
  const count = (status: string) => outcomes.filter(([, item]) => item.status === status).length;
  const deferred = count("deferred"), failed = count("failed"), missing = count("missing"), finishing = outcomes.filter(([, item]) => item.finishing).length;
  console.log(`本清单累计${LABELS[done]} ${finished.length} 项、${formatSize(finished.reduce((sum, [, item]) => sum + item.bytes, 0))}${finishing ? `；收尾 ${finishing} 项（此前已删除，不计入）` : ""}；保留 ${count("kept")} 项，待处置 ${deferred} 项，失败 ${failed} 项${missing ? `，已不存在 ${missing} 项` : ""}。`);
  if (done === "archived") console.log(ARCHIVED_NOTE);
  return deferred || failed ? 1 : 0;
}

function reportRemoval(plan: ArchiveRemovalPlan): void {
  for (const item of plan.items) console.log(`[${item.status}] ${item.destination}（${formatSize(item.evidence.bytes)}）${item.reason ? "：" + item.reason : ""}`);
  for (const skipped of plan.skipped) console.log(`[skipped] 归档清单 ${skipped.plan}：${skipped.reason}`);
  for (const status of ["ready", "kept", "deferred"]) {
    const items = plan.items.filter(item => item.status === status);
    console.log(`${status}：${items.length} 项、${formatSize(items.reduce((sum, item) => sum + item.evidence.bytes, 0))}`);
  }
  console.log(`清单：${plan.id}\n摘要：${plan.digest}`);
}

/** Caller holds maintenance leases. This compatibility entry also uses the saved exact plan. */
export async function purge(days: number, user?: string, root = DATA_DIR, group?: string, selection: GroupSelection = "auto", archive?: string, planId?: string): Promise<number> {
  const input = options(root, archive), plan = await previewTmpArchive(input, days, user, group, selection, planId);
  reportPlan(plan);
  return reportProgress(await applyTmpArchive(input, plan.id, plan.digest), "archived");
}

async function main(args: string[]): Promise<number> {
  const { values, positionals } = cliArgs(args, { ...groupOptions, all: { type: "boolean" }, days: { type: "string" },
    user: { type: "string" }, group: { type: "string" }, plan: { type: "string" }, digest: { type: "string" },
    archive: { type: "string" }, journal: { type: "string" }, legacy: { type: "boolean" }, "recorded-root": { type: "string" } });
  if (positionals.length > 1) throw new Error(MESSAGES.oneCommand);
  const command = positionals[0], selection = groupSelection(values, values.group);
  if (values.all && values.days !== undefined) throw new Error(MESSAGES.allAndDays);
  const days = values.all ? 0 : values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) throw new Error(MESSAGES.days);
  if (command === "list" || command === "ls") return list(values.user, values.group, selection);
  if (!["preview", "purge", "reclaim", "discard"].includes(command ?? "")) { usage(); return command ? 1 : 0; }
  const confirming = values.digest !== undefined;
  if (confirming && (!values.plan || days !== undefined || values.group || values.user)) throw new Error(MESSAGES.confirmScope);
  if (command === "discard" && (days !== undefined || values.group || values.user)) throw new Error(MESSAGES.discardScope);
  if (command !== "discard" && !confirming && days === undefined) throw new Error(MESSAGES.previewScope);
  if (command === "preview" && confirming) throw new Error(MESSAGES.previewOnly);
  if (!["reclaim", "discard"].includes(command!) && (values.legacy || values.journal)) throw new Error(MESSAGES.legacyOnly);
  if (values["recorded-root"] && !values.legacy) throw new Error(MESSAGES.recordedOnly);
  if (values.legacy && (!values["recorded-root"] || !values["recorded-root"].startsWith("/") || resolve(values["recorded-root"]) !== values["recorded-root"])) {
    throw new Error(MESSAGES.recordedRoot);
  }
  if (values.legacy && !values.journal) throw new Error(MESSAGES.journal);
  const run = async () => {
    const input = options(DATA_DIR, values.archive, values.legacy);
    if (command === "reclaim") {
      const reclaim = { root: input.root, state: input.state, scope: input.scope, directory: resolve(values.journal ?? join(LAYOUT.reclamation, "plans")),
        backend: values.legacy ? undefined : input.backend, legacy: values.legacy, recordedRoot: values["recorded-root"] };
      if (confirming) return reportProgress(await applyReclamation(reclaim, values.plan!, values.digest!), "removed");
      const plan = await previewReclamation(reclaim, days!, values.user, values.group, selection, values.plan); reportPlan(plan);
      console.log(MESSAGES.reclaimNext(plan.id, plan.digest));
      return 0;
    }
    if (command === "discard") {
      const discard = { ...input, legacy: values.legacy, ...(values.journal ? { journal: resolve(values.journal) } : {}),
        ...(values["recorded-root"] ? { recordedRoot: values["recorded-root"] } : {}) };
      if (confirming) return reportProgress(await applyArchiveRemoval(discard, values.plan!, values.digest!), "discarded");
      const plan = await previewArchiveRemoval(discard, values.plan); reportRemoval(plan);
      console.log(MESSAGES.discardNext(plan.id, plan.digest));
      return 0;
    }
    if (confirming) return reportProgress(await applyTmpArchive(input, values.plan!, values.digest!), "archived");
    if (command === "purge") return purge(days!, values.user, DATA_DIR, values.group, selection, values.archive, values.plan);
    const plan = await previewTmpArchive(input, days!, values.user, values.group, selection, values.plan); reportPlan(plan);
    return 0;
  };
  // Previews only read and save their plan, so they run beside the service; every confirmation rechecks under the lease.
  return confirming || command === "purge" ? withMaintenance(run) : run();
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); return 1; }));
