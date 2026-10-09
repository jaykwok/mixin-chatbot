import { describeAge } from "../lib/age.ts";
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
import { assertDataDirectory, resolveGroupName, type GroupSelection } from "../lib/group-data.ts";
import { lastActivity, scanHistory, type GroupHistory } from "../lib/history-scan.ts";
import { conversationTimings, historicalContext } from "../../src/durable/diagnostics.ts";

function usage(): void {
  console.log("用法：bun run history <命令>");
  console.log("");
  console.log("  list                 列出各群的会话历史（群库与旧会话文件的占用、最后活动）");
  console.log("  clear <群号>         清空该群全部成员的会话历史");
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
 */
export async function clearGroup(
  groupId: string,
  root: string = GROUP_DATA_ROOT,
  kind: GroupSelection = "auto"
): Promise<number> {
  const dir = await resolveGroupDir(groupId, root, kind);
  if (!dir) {
    console.error(`在 ${root} 下找不到群 ${groupId}。用 list 查看现有的群。`);
    return 1;
  }

  const groups = await collect(root);
  const target = groups.find((group) => join(root, group.group) === dir);
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
        console.log("旧上下文留在群库里，不释放空间；排队中的消息一并取消，与成员自己发 /clear 相同。");
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
  console.log("每位成员的下一条消息都会开启全新会话；workspace、tmp、资料索引均未改动。");
  if (failed > 0) {
    console.log(`${failed} 项清空失败，常见原因是机器人仍在占用这些文件——停下来再试一次。`);
    return 1;
  }
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
  console.log("清空某个群：bun run history clear <群号>");
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
      // 群号必须显式给出：没有「清空全部群」这个入口，它只会在手滑时出现。
      if (!groupId || groupId.startsWith("--")) {
        console.error("clear 需要群号：bun run history clear <群号>");
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
  process.exit(await main(process.argv.slice(2)));
}
