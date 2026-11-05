// The summary package of a closed push (push-plan-20261103.md section 8): a workbook with one row per recipient (a group
// is one row, with who replied), and per recipient a folder with the reply text and the reply attachments of the
// submission in effect. A package larger than one file may be (the native limit, or the relay's when one is configured)
// is split into numbered archives; an attachment that alone does not fit is listed as not packed.
import { formatSize } from "@earendil-works/pi-coding-agent";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeFileName } from "../durable/attachments.ts";
import { shortTime } from "./cards.ts";
import { memberGroup, type Push, type Recipient, type ReplyItem } from "./store.ts";
import { writeWorkbook, type Sheet } from "./xlsx.ts";
import { ZipWriter } from "./zip.ts";

/** A held attachment as the member's records have it. */
export type HeldFile = { state: string; path?: string; error?: string; actualSize?: number };

export type SummaryInput = {
  push: Push;
  recipients: readonly Recipient[];
  items: readonly ReplyItem[];
  /** Held attachments by ID. */
  files: ReadonlyMap<string, HeldFile>;
  /** An empty directory the package is written to. */
  dir: string;
  /** Largest archive one send may carry. */
  partBytes: number;
  now: number;
  /** How phones are written (the console's packages mask them). */
  phone?: (phone: string) => string;
  /** Stops the copying into the archives. */
  signal?: AbortSignal;
};

export type SummaryPart = { path: string; name: string; size: number };
export type SummaryPackage = { parts: SummaryPart[]; missingFiles: number };

const SEND_LABEL: Record<Recipient["sendState"], string> = { pending: "未发出", sending: "未发出", sent: "已发出", uncertain: "可能已发出", failed: "发送失败" };

// What an entry adds to an archive besides its data and twice its name: the local header and the central record.
const ENTRY_OVERHEAD = 30 + 46;
const END_RECORD = 22;
const ZIP_MAX = 0xffff_ffff;

/** The reply in effect: the items of the last submitted revision. */
export function effectiveItems(recipient: Pick<Recipient, "member" | "submitted">, items: readonly ReplyItem[]): ReplyItem[] {
  return recipient.submitted > 0 ? items.filter(item => item.member === recipient.member && item.revision === recipient.submitted) : [];
}

/** The texts of a reply; a group's name their senders (`张三：…`). */
export function replyText(items: readonly ReplyItem[]): string {
  return items.filter(item => item.kind === "text" && item.text).map(item => item.senderName ? `${item.senderName}：${item.text!}` : item.text!).join("\n\n");
}

/** Who sent a group's reply texts, in order of their first one. */
export function senders(items: readonly ReplyItem[]): string[] {
  return [...new Map(items.flatMap(item => item.sender ? [[item.sender, item.senderName ?? item.sender] as const] : [])).values()];
}

/** A phone as the console shows it by default: the first three and the last four digits. */
export const maskPhone = (phone: string) => phone.length <= 7 ? (phone.length <= 2 ? phone : `${phone.slice(0, 1)}***`) : `${phone.slice(0, 3)}****${phone.slice(-4)}`;

/** Where a held attachment's file is (still held, or recorded when the hold was released), or why it is not there. */
async function located(item: ReplyItem, files: ReadonlyMap<string, HeldFile>): Promise<{ path: string; size: number } | { missing: string }> {
  if (item.error) return { missing: item.error };
  const file = (item.attachment ? files.get(item.attachment) : undefined) ?? (item.path ? { state: "ready", path: item.path } : undefined);
  if (!file) return { missing: "附件记录已不存在" };
  if (file.state === "pending") return { missing: "还在下载" };
  if (file.state === "failed" || file.state === "rejected") return { missing: `下载失败：${file.error ?? "原因未知"}` };
  if (file.state !== "ready" || !file.path) return { missing: "附件已作废" };
  try { await access(file.path); return { path: file.path, size: (await stat(file.path)).size }; }
  catch { return { missing: "文件已被临时文件清理删除" }; }
}

type Entry = { name: string; size: number } & ({ path: string } | { data: Uint8Array });
const entrySize = (entry: Entry) => ENTRY_OVERHEAD + 2 * Buffer.byteLength(entry.name) + entry.size;

export async function buildSummary(input: SummaryInput): Promise<SummaryPackage> {
  const { push, recipients, items, now } = input, phone = input.phone ?? (value => value);
  const limit = Math.min(input.partBytes, ZIP_MAX);
  const base = safeFileName(`推送汇总-${push.subject}-${push.id}`);
  const workbookName = `${base}.xlsx`, workbook = join(input.dir, workbookName);
  const time = (at: number | null) => at === null ? null : shortTime(at, now);
  const groups = recipients.some(recipient => memberGroup(recipient.member) !== undefined);
  const columns: Sheet["columns"] = [
    { title: groups ? "姓名或群" : "姓名", width: 12 }, { title: "手机号", width: 15 }, { title: "发送", width: 10 }, { title: groups ? "确认时间（群为首次）" : "确认时间", width: 13 },
    ...(groups ? [{ title: "群里点击次数", width: 8 }] : []),
    ...(push.mode === "options" ? [{ title: "选择", width: 14 }, { title: "选择时间", width: 13 }] : []),
    ...(push.mode === "reply" ? [{ title: "回复时间", width: 13 }, { title: "回复文字", width: 60 }, { title: "附件", width: 40 }] : []),
    ...(push.mode === "reply" && groups ? [{ title: "群里的回复人", width: 24 }] : []),
  ];
  const rows: (string | number | null)[][] = [], entries: Entry[] = [];
  let missingFiles = 0, index = 0;
  for (const recipient of recipients) {
    index++;
    const own = effectiveItems(recipient, items), group = memberGroup(recipient.member) !== undefined;
    const row: (string | number | null)[] = [recipient.name, group ? "群" : phone(recipient.member), SEND_LABEL[recipient.sendState], time(recipient.ackedAt)];
    if (groups) row.push(group ? recipient.clicks : null);
    if (push.mode === "options") row.push(recipient.choice === null ? null : push.options[recipient.choice] ?? null, time(recipient.choiceAt));
    if (push.mode === "reply") {
      const folder = `回复/${String(index).padStart(3, "0")}-${safeFileName(recipient.name)}${group ? "" : `-${recipient.member.slice(-4)}`}`;
      const names: string[] = [], lines: string[] = [];
      let n = 0;
      for (const item of own) {
        if (item.kind === "text") continue;
        const label = item.name ?? "附件";
        const name = `${folder}/${String(++n).padStart(2, "0")}-${safeFileName(label)}`;
        let where = await located(item, input.files);
        if ("path" in where && entrySize({ name, size: where.size, path: where.path }) + END_RECORD > limit) where = { missing: `${formatSize(where.size)}，超过单个文件的发送上限` };
        if ("missing" in where) {
          missingFiles++;
          names.push(`${label}（未打包：${where.missing}）`);
          lines.push(`- ${label}：未打包，${where.missing}`);
          continue;
        }
        entries.push({ name, size: where.size, path: where.path });
        names.push(label);
        lines.push(`- ${label}：${name.slice(folder.length + 1)}`);
      }
      const text = replyText(own);
      row.push(time(recipient.submittedAt), text || null, names.join("\n") || null);
      if (groups) row.push(group ? senders(own).join("、") || null : null);
      if (own.length) {
        const data = new TextEncoder().encode([`${group ? `群「${recipient.name}」` : `${recipient.name}（${phone(recipient.member)}）`}的回复，提交于 ${time(recipient.submittedAt)}`,
          "", text || "（没有文字）", ...(lines.length ? ["", "附件：", ...lines] : [])].join("\n") + "\n");
        entries.push({ name: `${folder}/回复.txt`, size: data.length, data });
      }
    }
    rows.push(row);
  }
  await writeWorkbook(workbook, { name: "汇总", columns, rows }, now);
  entries.unshift({ name: workbookName, size: (await stat(workbook)).size, path: workbook });

  // Entries in order; a new archive starts when the next entry would not fit.
  const paths: string[] = [];
  let zip: ZipWriter | undefined, used = 0;
  try {
    for (const entry of entries) {
      const need = entrySize(entry);
      if (zip && used + need + END_RECORD > limit) { await zip.close(); zip = undefined; }
      if (!zip) {
        const path = join(input.dir, `part-${paths.length + 1}.zip`);
        zip = await ZipWriter.create(path, now);
        paths.push(path);
        used = 0;
      }
      if ("data" in entry) await zip.addBuffer(entry.name, entry.data);
      else await zip.addFile(entry.name, entry.path, input.signal);
      used += need;
    }
    await zip!.close();
  } catch (error) { await zip?.abort(); throw error; }
  const parts = await Promise.all(paths.map(async (path, at) => ({ path, size: (await stat(path)).size,
    name: paths.length === 1 ? `${base}.zip` : `${base}-${at + 1}of${paths.length}.zip` })));
  return { parts, missingFiles };
}
