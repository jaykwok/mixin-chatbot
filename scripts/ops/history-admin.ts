import { describeAge } from "../lib/age.ts";
import { redactSecrets } from "../lib/redact.ts";
// 查看各群会话占用；停机后清空指定群：在群库里为每位成员登记 /clear（机器人下次启动时先执行），
// 并把升级前的旧会话文件归档到 backup/rm。未交付记录独立保留；目录遍历使用实际存储段并拒绝链接。
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";
import { archiveFile, withMaintenance } from "../../src/core/maintenance.ts";
import { ingestBeforeArchive } from "../../src/agent/stats-ledger.ts";
import { GROUP_DATABASE } from "../../src/durable/groups.ts";
import { queueGroupClear, queueMemberCompaction } from "../../src/durable/offline.ts";
import { assertDataDirectory, byName, dataDirectoryNames, resolveGroupName, type GroupSelection } from "../lib/group-data.ts";
import { lastActivity, scanGroupHistory, scanHistory, type GroupHistory } from "../lib/history-scan.ts";
import { conversationTimings, historicalContext } from "../../src/durable/diagnostics.ts";

function usage(): void {
  console.log("用法：bun run history <命令>");
  console.log("");
  console.log("  list                 列出各群的会话历史（群库与旧会话文件的占用、最后活动）");
  console.log("  clear <群号>         清空该群全部成员的会话历史");
  console.log("  clear --all          清空所有群全部成员的会话历史；某个群失败时其余群照常清空");
  console.log("  compact <群号> <成员号码>  登记手动压缩，启动后执行并产生模型用量");
  console.log("  context <群号> <成员号码> [条目编号]  只读查看当前或历史模型上下文");
  console.log("  timings <群号> <成员号码>  只读统计官方响应/工具耗时及任务跨度");
  console.log("  --group-id / --storage-segment  明确使用原始群号或存储目录段，两者互斥");
  console.log("");
  console.log("  停机后执行：在群库里为每位成员登记清空，机器人下次启动时先执行（排队中的消息一并取消，");
  console.log("  与成员自己发 /clear 相同；旧上下文留在群库里，不释放空间）；升级前的旧会话文件移入 backup/rm。");
  console.log("  未交付消息另行保留。清空后每位成员的下一条消息都会开启全新会话。");
}


/** 扫描本身在 scripts/lib/history-scan.ts，宿主机上的运维界面直接调那一份。 */
export async function collect(root: string = GROUP_DATA_ROOT): Promise<GroupHistory[]> {
  return scanHistory(root);
}

/**
 * 接受外部群号或 list 输出的存储段，但只匹配已经验证的实际目录名。
 */
async function resolveGroupDir(groupId: string, root: string, kind: GroupSelection): Promise<string | null> {
  const name = await resolveGroupName(groupId, root, kind);
  return name ? join(root, name) : null;
}

/**
 * 清空本群历史：群库登记清空，旧会话文件归档。CLI 调用方须先持有维护租约（机器人已停止）。
 * notes 为 false 时不打印每群都相同的说明，由清空全部群时统一打印一次。
 */
export async function clearGroup(
  groupId: string,
  root: string = GROUP_DATA_ROOT,
  kind: GroupSelection = "auto",
  notes = true
): Promise<number> {
  const name = await resolveGroupName(groupId, root, kind);
  if (!name) {
    console.error(`在 ${root} 下找不到群 ${groupId}。用 list 查看现有的群。`);
    return 1;
  }
  const dir = join(root, name);

  // 只扫描目标群：别的群目录读不了不影响这个群。
  let target: GroupHistory | null;
  try { target = await scanGroupHistory(root, name); }
  catch (error) {
    console.error(`群 ${name} 的会话历史无法读取，本群未做任何改动：${String(error)}`);
    return 1;
  }
  if (!target) {
    console.log(`群 ${groupId} 下没有任何会话历史，无需清理。`);
    return 0;
  }

  // 群库先登记：登记失败（例如群库属于别的群）就整个不动，旧会话文件也不归档。
  if (target.database) {
    try {
      const queued = await queueGroupClear(join(dir, GROUP_DATABASE));
      if (queued) {
        const waiting = queued.waiting.length ? `，${queued.waiting.length} 位已有等待中的清空` : "";
        console.log(`群 ${target.group}：已在群库里为 ${queued.queued.length} 位成员登记清空${waiting}，机器人下次启动时先执行。`);
        if (notes) console.log(DATABASE_NOTE);
      }
    } catch (error) {
      console.error(`群库登记清空失败，本群未做任何改动：${String(error)}`);
      return 1;
    }
  }
  let failed = 0;
  if (target.users.length) {
    const legacy = target.users.reduce((total, user) => total + user.bytes, 0);
    console.log(`群 ${target.group}：即将归档 ${target.users.length} 位成员升级前的旧会话文件（${formatSize(legacy)}）。`);
  }
  let removed = 0;
  let freed = 0;
  for (const user of target.users) {
    try {
      await assertDataDirectory(dirname(user.path), root);
      const info = await lstat(user.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("历史文件已改变或是链接");
      // 先落账再归档：统计只认账本，这一步漏了这段历史就再也补不回来。
      await ingestBeforeArchive(root, target.group, user.user);
      await archiveFile(user.path);
      removed++;
      freed += user.bytes;
      console.log(`已归档 ${user.user} 的旧会话文件（${formatSize(user.bytes)}，最后活动于 ${describeAge(user.modified)}）`);
    } catch (error) {
      failed++;
      console.error(`清空失败 ${user.path}：${String(error)}`);
    }
  }

  console.log("");
  if (target.users.length) console.log(`已归档 ${removed} 位成员的旧会话文件，${formatSize(freed)} 移入 backup/rm。`);
  if (notes) console.log(RESULT_NOTE);
  if (failed > 0) {
    console.log(`${failed} 项清空失败，常见原因是机器人仍在占用这些文件——停下来再试一次。`);
    return 1;
  }
  return 0;
}

const DATABASE_NOTE = "旧上下文留在群库里，不释放空间；排队中的消息一并取消，与成员自己发 /clear 相同。";
const RESULT_NOTE = "每位成员的下一条消息都会开启全新会话；workspace、tmp、资料索引均未改动。";

/**
 * 清空所有有会话历史的群：在同一维护租约内逐群执行 clearGroup。某个群无法读取、被拒绝或失败时其余群照常清空，最后汇总；
 * 重新执行是安全的，已登记的清空不会重复登记。CLI 调用方须先持有维护租约（机器人已停止）。
 */
export async function clearAllGroups(root: string = GROUP_DATA_ROOT): Promise<number> {
  // 先只列出群目录，每个群的扫描各自兜底：一个群读不了只让这个群失败，不挡住其余群。
  const groups: GroupHistory[] = [];
  const failed: string[] = [];
  for (const name of await dataDirectoryNames(root, root)) {
    try {
      const history = await scanGroupHistory(root, name);
      if (history) groups.push(history);
    } catch (error) {
      console.error(`群 ${name} 的会话历史无法读取，跳过：${String(error)}`);
      failed.push(name);
    }
  }
  const total = groups.length + failed.length;
  if (total === 0) {
    console.log(`没有找到任何会话历史（群数据总根：${root}），无需清理。`);
    return 0;
  }
  groups.sort((a, b) => b.bytes - a.bytes || byName(a.group, b.group));
  console.log(`即将清空 ${groups.length} 个群的会话历史` + (failed.length ? `（另有 ${failed.length} 个群无法读取，未处理）。` : "。"));
  for (const group of groups) {
    console.log("");
    // 扫描结果是实际目录段，按目录段选择，不会与另一个群的原始群号混淆。
    const code = await clearGroup(group.group, root, "segment", false).catch((error) => {
      console.error(`群 ${group.group} 清空失败：${String(error)}`);
      return 1;
    });
    if (code !== 0) failed.push(group.group);
  }
  console.log("");
  if (groups.some((group) => group.database)) console.log(DATABASE_NOTE);
  console.log(RESULT_NOTE);
  if (failed.length) {
    console.log(`${total - failed.length}/${total} 个群已清空；未完成：${failed.join("、")}。处理原因后可重新执行，已登记的清空不会重复。`);
    return 1;
  }
  console.log(`${total} 个群已全部清空。`);
  return 0;
}

async function list(root: string = GROUP_DATA_ROOT): Promise<number> {
  const groups = await collect(root);
  if (groups.length === 0) {
    console.log(`没有找到任何会话历史（群数据总根：${root}）。`);
    return 0;
  }
  for (const group of groups) {
    console.log(`群 ${group.group}：${formatSize(group.bytes)}，最后活动于 ${describeAge(lastActivity(group))}`);
    if (group.database) console.log(`  群库 ${GROUP_DATABASE}  ${formatSize(group.database.bytes)}（${describeAge(group.database.modified)}）`);
    if (group.users.length) console.log(`  升级前的旧会话文件：${group.users.length} 位成员`);
    for (const user of group.users.slice(0, 5)) {
      console.log(`  ${user.user}  ${formatSize(user.bytes)}（${describeAge(user.modified)}）`);
    }
    if (group.users.length > 5) {
      console.log(`  …… 另有 ${group.users.length - 5} 位成员`);
    }
  }
  console.log("");
  console.log("清空某个群：bun run history clear <群号>；清空所有群：bun run history clear --all");
  return 0;
}

/** Called under the maintenance lease; opens no Harness and makes no model request. */
export async function compactMember(groupId: string, phone: string, root = GROUP_DATA_ROOT, kind: GroupSelection = "auto"): Promise<number> {
  const dir = await resolveGroupDir(groupId, root, kind);
  if (!dir) { console.error(`找不到群 ${groupId}，请先用 list 查看现有的群。`); return 1; }
  try {
    await assertDataDirectory(dir, root);
    const queued = await queueMemberCompaction(join(dir, GROUP_DATABASE), phone);
    console.log(queued.submissionId !== undefined
      ? `群 ${groupId}，成员 ${phone}：已有压缩摘要提交 ${queued.submissionId}，启动后写入会话；聊天记录保留在群库里。`
      : `群 ${groupId}，成员 ${phone}：${queued.created ? "已登记" : "已有"}压缩任务 ${queued.taskId}，启动后执行；聊天记录保留在群库里。`);
    return 0;
  } catch (error) { console.error(`登记压缩失败：${String(error)}`); return 1; }
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  switch (command) {
    case "context":
    case "timings": {
      const groupId = args[1], phone = args[2], rest = args.slice(3);
      if (!groupId || !phone || groupId.startsWith("--") || phone.startsWith("--")) throw new Error("需要群号和成员号码");
      const selection = rest.at(-1)?.startsWith("--") ? rest.pop() : undefined;
      const kind: GroupSelection = selection === "--storage-segment" ? "segment" : selection === "--group-id" ? "id" : "auto";
      if ((selection && kind === "auto") || rest.length > (command === "context" ? 1 : 0)) throw new Error("无法识别的诊断参数");
      const dir = await resolveGroupDir(groupId, GROUP_DATA_ROOT, kind);
      if (!dir) throw new Error("群目录不存在");
      const path = join(dir, GROUP_DATABASE);
      console.log(JSON.stringify(command === "context" ? await historicalContext(path, phone, rest[0] === undefined ? undefined : Number(rest[0]))
        : await conversationTimings(path, phone), null, 2));
      return 0;
    }
    case "compact": {
      const groupId = args[1], phone = args[2], selection = args[3];
      if (!groupId || !phone || groupId.startsWith("--") || phone.startsWith("--")) {
        console.error("compact 需要群号和成员号码：bun run history compact <群号> <成员号码>"); return 1;
      }
      const kind: GroupSelection = selection === "--storage-segment" ? "segment" : selection === "--group-id" ? "id" : "auto";
      if ((kind === "auto" && selection) || args[4]) { console.error("无法识别的 compact 参数"); return 1; }
      return withMaintenance(() => compactMember(groupId, phone, GROUP_DATA_ROOT, kind), GROUP_DATA_ROOT);
    }
    case "list":
    case "ls":
      return list();
    case "clear": {
      const groupId = args[1];
      // 清空全部群必须明确写 --all：漏写群号只报错，不会变成全部。
      if (groupId === "--all") {
        if (args[2] !== undefined) {
          console.error(`--all 不能再指定群或其他参数：${args[2]}`);
          return 1;
        }
        return withMaintenance(() => clearAllGroups(GROUP_DATA_ROOT), GROUP_DATA_ROOT);
      }
      if (!groupId || groupId.startsWith("--")) {
        console.error("clear 需要群号，或用 --all 清空所有群：bun run history clear <群号> | --all");
        return 1;
      }
      const selection = args[2];
      const kind: GroupSelection = selection === "--storage-segment" ? "segment" : selection === "--group-id" ? "id" : "auto";
      const unknown = kind === "auto" ? selection : args[3];
      if (unknown) {
        console.error(`无法识别的参数：${unknown}`);
        return 1;
      }
      return withMaintenance(() => clearGroup(groupId, GROUP_DATA_ROOT, kind), GROUP_DATA_ROOT);
    }
    default:
      usage();
      return command ? 1 : 0;
  }
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)).catch(error => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    return 1;
  }));
}
