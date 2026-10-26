import { describeAge } from "../lib/age.ts";
import { redactSecrets } from "../lib/redact.ts";
// 查看各会话空间（单聊空间与各群）的会话占用；停机后清空指定空间：在会话库里为每位成员登记 /clear
// （机器人下次启动时先执行），未交付记录独立保留；目录遍历使用实际存储段并拒绝链接。
import { join } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { DATA_DIR } from "../../src/core/storage.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { queueMemberCompaction, queueSpaceClear } from "../../src/durable/offline.ts";
import { assertDataDirectory, byName, resolveGroupName, type GroupSelection } from "../lib/group-data.ts";
import { DATABASE, historySpaces, lastActivity, scanHistory, scanSpaceHistory, spaceName, type SpaceHistory } from "../lib/history-scan.ts";
import { conversationTimings, historicalContext } from "../../src/durable/diagnostics.ts";

function usage(): void {
  console.log("用法：bun run history <命令>");
  console.log("");
  console.log("  list                 列出各会话空间（单聊与各群）的会话历史（会话库的占用、最后活动）");
  console.log("  clear <群号>|--direct  清空该群（或单聊空间）全部成员的会话历史");
  console.log("  clear --all          清空所有空间全部成员的会话历史；某个空间失败时其余照常清空");
  console.log("  compact <群号>|--direct <成员号码>  登记手动压缩，启动后执行并产生模型用量");
  console.log("  context <群号>|--direct <成员号码> [条目编号]  只读查看当前或历史模型上下文");
  console.log("  timings <群号>|--direct <成员号码>  只读统计官方响应/工具耗时及任务跨度");
  console.log("  --group-id / --storage-segment  明确使用原始群号或存储目录段，两者互斥");
  console.log("");
  console.log("  停机后执行：在会话库里为每位成员登记清空，机器人下次启动时先执行（排队中的消息一并取消，");
  console.log("  与成员自己发 /clear 相同；旧上下文留在会话库里，不释放空间）。");
  console.log("  未交付消息另行保留。清空后每位成员的下一条消息都会开启全新会话。");
}


/** 扫描本身在 scripts/lib/history-scan.ts，宿主机上的运维界面直接调那一份。root 是数据目录。 */
export async function collect(root: string = DATA_DIR): Promise<SpaceHistory[]> {
  return scanHistory(root);
}

/**
 * 选择一个空间：`--direct` 是单聊空间；其余按外部群号或 list 输出的存储段，只匹配已经验证的实际群目录名。
 */
export async function resolveSpace(value: string, root: string = DATA_DIR, kind: GroupSelection = "auto"): Promise<string | null> {
  if (value === "--direct") return (await historySpaces(root)).includes("direct") ? "direct" : null;
  const name = await resolveGroupName(value, join(root, "conversations", "groups"), kind, root);
  return name ? `groups/${name}` : null;
}

/**
 * 清空一个空间的历史：会话库登记清空，登记新上下文。CLI 调用方须先持有维护租约（机器人已停止）。
 * notes 为 false 时不打印每个空间都相同的说明，由清空全部空间时统一打印一次。
 */
export async function clearSpace(
  value: string,
  root: string = DATA_DIR,
  kind: GroupSelection = "auto",
  notes = true
): Promise<number> {
  const label = value === "--direct" ? "单聊空间" : `群 ${value}`;
  const space = await resolveSpace(value, root, kind);
  if (!space) {
    console.error(`在 ${join(root, "conversations")} 下找不到${label}。用 list 查看现有的会话空间。`);
    return 1;
  }

  // 只扫描目标空间：别的空间读不了不影响这个。
  let target: SpaceHistory | null;
  try { target = await scanSpaceHistory(root, space); }
  catch (error) {
    console.error(`${spaceName(space)} 的会话历史无法读取，未做任何改动：${String(error)}`);
    return 1;
  }
  if (!target) {
    console.log(`${label}下没有任何会话历史，无需清理。`);
    return 0;
  }

  // 会话库先登记：登记失败（例如会话库属于别的空间）就整个不动。
  try {
    await assertDataDirectory(target.dir, root);
    const queued = await queueSpaceClear(join(target.dir, DATABASE));
    if (queued) {
      const waiting = queued.waiting.length ? `，${queued.waiting.length} 位已有等待中的清空` : "";
      console.log(`${spaceName(target.space)}：已在会话库里为 ${queued.queued.length} 位成员登记清空${waiting}，机器人下次启动时先执行。`);
      if (notes) console.log(DATABASE_NOTE);
    }
  } catch (error) {
    console.error(`会话库登记清空失败，${spaceName(target.space)} 未做任何改动：${String(error)}`);
    return 1;
  }
  if (notes) console.log(RESULT_NOTE);
  return 0;
}

const DATABASE_NOTE = "旧上下文留在会话库里，不释放空间；排队中的消息一并取消，与成员自己发 /clear 相同。";
const RESULT_NOTE = "每位成员的下一条消息都会开启全新会话；共享资料、tmp、资料索引和统计均未改动。";

/**
 * 清空所有有会话历史的空间：在同一维护租约内逐个执行 clearSpace。某个空间无法读取、被拒绝或失败时其余照常清空，
 * 最后汇总；重新执行是安全的，已登记的清空不会重复登记。CLI 调用方须先持有维护租约（机器人已停止）。
 */
export async function clearAllSpaces(root: string = DATA_DIR): Promise<number> {
  // 先只列出空间目录，每个空间的扫描各自兜底：一个读不了只让它失败，不挡住其余空间。
  const spaces: SpaceHistory[] = [];
  const failed: string[] = [];
  for (const space of await historySpaces(root)) {
    try {
      const history = await scanSpaceHistory(root, space);
      if (history) spaces.push(history);
    } catch (error) {
      console.error(`${spaceName(space)} 的会话历史无法读取，跳过：${String(error)}`);
      failed.push(spaceName(space));
    }
  }
  const total = spaces.length + failed.length;
  if (total === 0) {
    console.log(`没有找到任何会话历史（${join(root, "conversations")}），无需清理。`);
    return 0;
  }
  spaces.sort((a, b) => b.bytes - a.bytes || byName(a.space, b.space));
  console.log(`即将清空 ${spaces.length} 个会话空间的历史` + (failed.length ? `（另有 ${failed.length} 个无法读取，未处理）。` : "。"));
  for (const space of spaces) {
    console.log("");
    // 扫描结果是实际目录段，按目录段选择，不会与另一个群的原始群号混淆。
    const value = space.space === "direct" ? "--direct" : space.space.slice("groups/".length);
    const code = await clearSpace(value, root, "segment", false).catch((error) => {
      console.error(`${spaceName(space.space)} 清空失败：${String(error)}`);
      return 1;
    });
    if (code !== 0) failed.push(spaceName(space.space));
  }
  console.log("");
  console.log(DATABASE_NOTE);
  console.log(RESULT_NOTE);
  if (failed.length) {
    console.log(`${total - failed.length}/${total} 个会话空间已清空；未完成：${failed.join("、")}。处理原因后可重新执行，已登记的清空不会重复。`);
    return 1;
  }
  console.log(`${total} 个会话空间已全部清空。`);
  return 0;
}

async function list(root: string = DATA_DIR): Promise<number> {
  const spaces = await collect(root);
  if (spaces.length === 0) {
    console.log(`没有找到任何会话历史（${join(root, "conversations")}）。`);
    return 0;
  }
  for (const space of spaces) {
    console.log(`${spaceName(space.space)}：${formatSize(space.bytes)}，最后活动于 ${describeAge(lastActivity(space))}`);
    if (space.database) console.log(`  会话库 ${DATABASE}  ${formatSize(space.database.bytes)}（${describeAge(space.database.modified)}）`);
  }
  console.log("");
  console.log("清空某个群：bun run history clear <群号>；单聊空间：clear --direct；全部：clear --all");
  return 0;
}

/** Called under the maintenance lease; opens no Harness and makes no model request. */
export async function compactMember(value: string, phone: string, root = DATA_DIR, kind: GroupSelection = "auto"): Promise<number> {
  const space = await resolveSpace(value, root, kind);
  const label = value === "--direct" ? "单聊空间" : `群 ${value}`;
  if (!space) { console.error(`找不到${label}，请先用 list 查看现有的会话空间。`); return 1; }
  try {
    const dir = join(root, "conversations", ...space.split("/"));
    await assertDataDirectory(dir, root);
    const queued = await queueMemberCompaction(join(dir, DATABASE), phone);
    console.log(queued.submissionId !== undefined
      ? `${label}，成员 ${phone}：已有压缩摘要提交 ${queued.submissionId}，启动后写入会话；聊天记录保留在会话库里。`
      : `${label}，成员 ${phone}：${queued.created ? "已登记" : "已有"}压缩任务 ${queued.taskId}，启动后执行；聊天记录保留在会话库里。`);
    return 0;
  } catch (error) { console.error(`登记压缩失败：${String(error)}`); return 1; }
}

function selection(value: string | undefined): GroupSelection {
  return value === "--storage-segment" ? "segment" : value === "--group-id" ? "id" : "auto";
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  switch (command) {
    case "context":
    case "timings": {
      const value = args[1], phone = args[2], rest = args.slice(3);
      if (!value || !phone || (value.startsWith("--") && value !== "--direct") || phone.startsWith("--")) throw new Error("需要群号（或 --direct）和成员号码");
      const option = rest.at(-1)?.startsWith("--") ? rest.pop() : undefined;
      const kind = selection(option);
      if ((option && (kind === "auto" || value === "--direct")) || rest.length > (command === "context" ? 1 : 0)) throw new Error("无法识别的诊断参数");
      const space = await resolveSpace(value, DATA_DIR, kind);
      if (!space) throw new Error("会话空间不存在");
      const path = join(DATA_DIR, "conversations", ...space.split("/"), DATABASE);
      console.log(JSON.stringify(command === "context" ? await historicalContext(path, phone, rest[0] === undefined ? undefined : Number(rest[0]))
        : await conversationTimings(path, phone), null, 2));
      return 0;
    }
    case "compact": {
      const value = args[1], phone = args[2], option = args[3];
      if (!value || !phone || (value.startsWith("--") && value !== "--direct") || phone.startsWith("--")) {
        console.error("compact 需要群号（或 --direct）和成员号码：bun run history compact <群号>|--direct <成员号码>"); return 1;
      }
      const kind = selection(option);
      if ((option && (kind === "auto" || value === "--direct")) || args[4]) { console.error("无法识别的 compact 参数"); return 1; }
      return withMaintenance(() => compactMember(value, phone, DATA_DIR, kind));
    }
    case "list":
    case "ls":
      return list();
    case "clear": {
      const value = args[1];
      // 清空全部必须明确写 --all：漏写群号只报错，不会变成全部。
      if (value === "--all") {
        if (args[2] !== undefined) {
          console.error(`--all 不能再指定群或其他参数：${args[2]}`);
          return 1;
        }
        return withMaintenance(() => clearAllSpaces(DATA_DIR));
      }
      if (!value || (value.startsWith("--") && value !== "--direct")) {
        console.error("clear 需要群号，或用 --direct 清空单聊空间、--all 清空全部：bun run history clear <群号>|--direct|--all");
        return 1;
      }
      const option = args[2];
      const kind = selection(option);
      const unknown = kind === "auto" || value === "--direct" ? option : args[3];
      if (unknown) {
        console.error(`无法识别的参数：${unknown}`);
        return 1;
      }
      return withMaintenance(() => clearSpace(value, DATA_DIR, kind));
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
