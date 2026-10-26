// 事件 Stream 与通讯录同步的状态查看、暂停的大批撤销的确认，以及同步范围（选定部门，留空为整个通讯录）的修改。只经本机控制接口
// 读写运行中的服务：不另开 Stream 连接（同一应用只能有一条），不直接调用平台接口（部门列表由服务代查），输出不含凭据。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { matchesInstance } from "../../src/core/health.ts";
import type { StreamStatus } from "../../src/integrations/open-platform/stream.ts";
import type { DirectoryStatus } from "../../src/integrations/open-platform/identity-directory.ts";
import type { DepartmentInfo } from "../../src/integrations/open-platform/directory.ts";
import { ATTENTION_KINDS, type AttentionKind, type AttentionStatus } from "../../src/durable/attention.ts";
import { describeAge } from "../lib/age.ts";

export interface ServiceStatus { stream?: StreamStatus; directory?: DirectoryStatus; attention?: AttentionStatus; verificationOnly: boolean }

const INSTANCE_FILE = join("data", "state", "instance.json");

async function instance(file: string): Promise<{ port: number; token: string; instanceId: string; pid: number; startedAt: number }> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("读不到服务实例记录（data/state/instance.json）；服务可能没有运行"); }
}

/** 从运行中实例的 /health 读取 Stream 与通讯录状态；实例身份不符时报错。 */
export async function readServiceStatus(port?: number, file = INSTANCE_FILE): Promise<ServiceStatus> {
  const expected = await instance(file);
  const target = port ?? expected.port;
  const response = await fetch(`http://127.0.0.1:${target}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" })
    .catch(() => { throw new Error(`本机端口 ${target} 无响应；服务可能没有运行`); });
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!matchesInstance(body, expected, target)) throw new Error("本机端口上的服务不是当前实例");
  return { stream: body.stream as StreamStatus | undefined, directory: body.directory as DirectoryStatus | undefined,
    attention: body.attention as AttentionStatus | undefined, verificationOnly: body.verificationOnly === true };
}

/** 确认 `scanId` 那一轮暂停的撤销；服务随即重新完整扫描一次。 */
export async function confirmRevocations(scanId: number, port?: number, file = INSTANCE_FILE): Promise<string> {
  const { status, body } = await admin("/_admin/directory/confirm", { scanId }, port, file, 5000);
  if (status === 202) return "已确认；服务正在重新完整扫描通讯录，缺席成员都在确认名单内才撤销。";
  throw new Error(typeof body.message === "string" ? body.message : `服务拒绝了确认（HTTP ${status}）`);
}

/** POST 到运行中实例的本机控制接口；404 表示口令不符或接口不存在（验证实例）。 */
async function admin(path: string, body: unknown, port: number | undefined, file: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const expected = await instance(file);
  const response = await fetch(`http://127.0.0.1:${port ?? expected.port}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${expected.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 404) throw new Error("服务拒绝了请求：实例口令不符（服务可能刚重启，请重新查看），或这是不连接平台的验证实例");
  return { status: response.status, body: parsed };
}

/** 部门 `parent`（缺省为根部门 1）的直属子部门，由服务向平台查询。 */
export async function listDepartments(parent = "1", port?: number, file = INSTANCE_FILE): Promise<DepartmentInfo[]> {
  const { status, body } = await admin("/_admin/directory/departments", { parent }, port, file, 60_000);
  if (status !== 200) throw new Error(typeof body.message === "string" ? body.message : `服务拒绝了查询（HTTP ${status}）`);
  return body.departments as DepartmentInfo[];
}

/** 改同步范围（`undefined` 为整个通讯录）；服务核对部门、保存后立即重新扫描。返回核对过的部门，与现有范围相同时为 "unchanged"。 */
export async function changeScope(departments: string[] | undefined, port?: number, file = INSTANCE_FILE): Promise<DepartmentInfo[] | "unchanged"> {
  const { status, body } = await admin("/_admin/directory/scope", { departments: departments ?? null }, port, file, 60_000);
  if (status === 200 && body.status === "unchanged") return "unchanged";
  if (status !== 202) throw new Error(typeof body.message === "string" ? body.message : `服务拒绝了修改（HTTP ${status}）`);
  return body.departments as DepartmentInfo[];
}

/** 部门列表的一行：ID、人数、名称（制表符分隔）。 */
export function departmentRow(department: DepartmentInfo): string {
  return [department.id, department.count === undefined ? "-" : String(department.count), department.fullName ?? department.name]
    .map(field => field.replace(/[\t\r\n]/g, " ")).join("\t");
}

export function describeStream(stream: StreamStatus | undefined, verificationOnly = false): string {
  if (!stream) return verificationOnly ? "验证实例不连接 Stream" : "尚未启动";
  if (stream.connected) return `已连接${stream.connectedAt ? `（连上于 ${describeAge(stream.connectedAt)}）` : ""}，启动以来重连 ${stream.reconnects} 次`;
  const since = stream.disconnectedSince ? `（断开于 ${describeAge(stream.disconnectedSince)}）` : "";
  return `未连接${since}${stream.lastDisconnect ? `：${stream.lastDisconnect.reason}` : ""}`;
}

export function describeDirectory(directory: DirectoryStatus | undefined): string[] {
  if (!directory) return ["通讯录：未知"];
  const lines = [`通讯录映射：${directory.mappings} 个`,
    `同步范围：${directory.scope ? `${directory.scope.length} 个部门（${directory.scope.join("、")}）及其子部门` : "整个通讯录"}`];
  if (directory.lastCompleteAt) lines.push(`最近完整同步：${describeAge(directory.lastCompleteAt)}`);
  else lines.push("最近完整同步：还没有");
  if (directory.running) lines.push(`正在同步（${directory.running.phase}）：部门 ${directory.running.departments}，成员 ${directory.running.members}，已解析 ${directory.running.resolved}`);
  const last = directory.lastScan;
  if (last && !last.complete) lines.push(`上一轮不完整${last.error ? `：${last.error}` : ""}`);
  if (directory.pending) lines.push(`待确认撤销：${directory.pending.count} 个成员（第 ${directory.pending.scanId} 轮）`);
  return lines;
}

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  parked: "停住的任务", faulted: "出错的任务", deliveryAbandoned: "超时放弃的交付", notSent: "未发出的模型请求", statsRegressed: "统计回退",
};

/** 最近一次在这么久以内的事件才算待留意；更早的只列出、不再告警（计数要到服务重启才清零）。 */
export const ATTENTION_RECENT_MS = 24 * 3600_000;

/** 自服务本次启动以来需要留意的事件，每类一项（次数、最近一次的空间和时间）；没有时为空。 */
export function describeAttention(attention: AttentionStatus | undefined, now = Date.now()):
  { kind: AttentionKind; recent: boolean; text: string }[] {
  return ATTENTION_KINDS.flatMap(kind => {
    const entry = attention?.[kind];
    return entry && entry.count > 0 ? [{ kind, recent: now - entry.lastAt < ATTENTION_RECENT_MS,
      text: `${ATTENTION_LABELS[kind]} ${entry.count} 次（最近 ${entry.space}，${describeAge(entry.lastAt)}）` }] : [];
  });
}

/** 体检行（状态、名称、详情，制表符分隔）：断开超过两分钟算失败；待确认撤销和不完整的同步算待核验。 */
export function doctorRows(status: ServiceStatus, now = Date.now()): string[] {
  const rows: string[] = [];
  if (!status.verificationOnly) {
    const stream = status.stream;
    const state = stream?.connected ? "pass" : stream?.disconnectedSince && now - stream.disconnectedSince < 120_000 ? "warn" : "fail";
    rows.push([state, "事件 Stream", describeStream(stream)].join("\t"));
  }
  const directory = status.directory;
  const incomplete = directory?.lastScan && !directory.lastScan.complete;
  rows.push([directory?.pending || incomplete || !directory?.lastCompleteAt ? "warn" : "pass", "通讯录同步",
    describeDirectory(directory).join("；")].join("\t"));
  // 旧版服务的 /health 没有这一项，此时不出这一行。
  if (status.attention) {
    const events = describeAttention(status.attention, now);
    rows.push([events.some(event => event.recent) ? "warn" : "pass", "运行状况",
      events.length ? `自本次启动：${events.map(event => event.text).join("；")}` : "自本次启动没有需要留意的事件"].join("\t"));
  }
  return rows;
}

if (import.meta.main) {
  const [action, value] = process.argv.slice(2);
  try {
    if (action === "doctor") {
      for (const row of doctorRows(await readServiceStatus())) console.log(row.replace(/[\r\n]/g, " "));
    } else if (action === "status" || action === undefined) {
      const status = await readServiceStatus();
      console.log(`事件 Stream：${describeStream(status.stream, status.verificationOnly)}`);
      for (const line of describeDirectory(status.directory)) console.log(line);
      if (status.attention) for (const event of describeAttention(status.attention)) console.log(`自本次启动：${event.text}`);
      if (status.directory?.pending) console.log(`确认撤销：directory-confirm ${status.directory.pending.scanId}`);
    } else if (action === "confirm" && value && /^[1-9][0-9]*$/.test(value)) {
      console.log(await confirmRevocations(Number(value)));
    } else if (action === "departments") {
      const departments = await listDepartments(value || "1");
      console.log(`部门 ${value || "1"} 的直属子部门 ${departments.length} 个（ID、人数、名称）：`);
      for (const department of departments) console.log(departmentRow(department));
    } else if (action === "scope") {
      // 留空为整个通讯录。
      const ids = (value ?? "").split(/[\s,，、]+/).filter(Boolean);
      const departments = ids.length ? ids : undefined;
      const checked = await changeScope(departments);
      if (checked === "unchanged") console.log(`同步范围未变（${departments ? departments.join("、") : "整个通讯录"}），未重新同步。`);
      else if (!departments) console.log("已改为同步整个通讯录，服务已重新开始同步。");
      else {
        console.log(`已改为只同步以下 ${checked.length} 个部门及其子部门，服务已重新开始同步（ID、人数、名称）：`);
        for (const department of checked) console.log(departmentRow(department));
        console.log("范围外成员的映射会在这一轮完整同步后撤销；超过撤销阈值时需要用 directory-confirm 确认。");
      }
    } else {
      console.log("用法：bun run scripts/ops/directory-admin.ts status | doctor | confirm <轮次> | departments [部门ID] | scope [部门ID,…]（留空为整个通讯录）");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
