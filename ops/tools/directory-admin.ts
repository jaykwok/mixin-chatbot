// 事件 Stream 与通讯录同步的状态查看，以及同步范围（整个通讯录或选定部门，必须明确选择）的修改：保存即开始应用。只经本机控制接口
// 读写运行中的服务：不另开 Stream 连接（同一应用只能有一条），不直接调用平台接口（部门列表和名称由服务代查），输出不含凭据。
// 部门只能逐层勾选，不接受手填的部门 ID：控制台的选择器，或终端向导（scope 不带参数，ops/config/directory-scope-wizard.ts，
// 与部署时同一套选择）；两者都用这里的查询和 changeScope。scope all 直接选择整个通讯录。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { matchesInstance } from "../../src/core/health.ts";
import type { StreamStatus } from "../../src/integrations/open-platform/stream.ts";
import type { DirectoryStatus } from "../../src/integrations/open-platform/identity-directory.ts";
import type { DepartmentDescription, DepartmentDetail, DepartmentInfo } from "../../src/integrations/open-platform/directory.ts";
import { scopeChoiceHint, WHOLE_DIRECTORY, type DirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { ATTENTION_KINDS, type AttentionKind, type AttentionStatus } from "../../src/durable/attention.ts";
import { describeAge, describeUntil } from "../lib/age.ts";

export interface ServiceStatus { stream?: StreamStatus; directory?: DirectoryStatus; attention?: AttentionStatus; verificationOnly: boolean }

export const INSTANCE_FILE = join("data", "state", "instance.json");

async function instance(file: string): Promise<{ port: number; token: string; instanceId: string; pid: number; startedAt: number }> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("读不到服务实例记录（data/state/instance.json）；服务可能没有运行"); }
}

/** 请求的时限，再加上调用方的取消（控制台取消请求或退出）。 */
const limited = (timeoutMs: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

/** 从运行中实例的 /health 读取 Stream 与通讯录状态；实例身份不符时报错。调用方取消时抛出取消的原因。 */
export async function readServiceStatus(port?: number, file = INSTANCE_FILE, signal?: AbortSignal): Promise<ServiceStatus> {
  const expected = await instance(file);
  const target = port ?? expected.port;
  const response = await fetch(`http://127.0.0.1:${target}/health`, { signal: limited(3000, signal), redirect: "error" })
    .catch(() => { signal?.throwIfAborted(); throw new Error(`本机端口 ${target} 无响应；服务可能没有运行`); });
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  signal?.throwIfAborted();
  if (!matchesInstance(body, expected, target)) throw new Error("本机端口上的服务不是当前实例");
  return { stream: body.stream as StreamStatus | undefined, directory: directoryStatus(body.directory),
    attention: body.attention as AttentionStatus | undefined, verificationOnly: body.verificationOnly === true };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** /health 里的通讯录状态。 */
export function directoryStatus(raw: unknown): DirectoryStatus | undefined {
  return isRecord(raw) && typeof raw.mappings === "number" ? raw as unknown as DirectoryStatus : undefined;
}

/**
 * 服务等平台的接口自己限时 60 秒（src/server/http-app.ts 的 PLATFORM_WAIT_MS），到时答复超时；这里多等一些，
 * 好让服务的说明先到。控制台关闭请求时服务随即取消对应的平台查询。
 */
const PLATFORM_ROUTE_TIMEOUT_MS = 75_000;

/**
 * POST 到运行中实例的本机控制接口；404 表示口令不符或接口不存在（验证实例）。`signal` 是调用方的取消：
 * 取消时抛出取消的原因，连接随之关闭。
 */
export async function adminPost(path: string, body: unknown, port: number | undefined, file: string, timeoutMs: number,
  signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await adminFetch(path, body, port, file, timeoutMs, signal);
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  signal?.throwIfAborted();
  if (response.status === 404) throw new Error(REFUSED_404);
  return { status: response.status, body: parsed };
}

const REFUSED_404 = "服务拒绝了请求：实例口令不符（服务可能刚重启，请重新查看），或这是不连接平台的验证实例";

/**
 * 同 adminPost，但答复为 200 时原样交回（文件下载按流读取，时限覆盖到读完）；其他状态读出说明后报错。
 */
export async function adminStream(path: string, body: unknown, file: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const response = await adminFetch(path, body, undefined, file, timeoutMs, signal);
  if (response.status === 200) return response;
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  signal?.throwIfAborted();
  if (response.status === 404) throw new Error(REFUSED_404);
  throw new Error(typeof parsed.message === "string" ? parsed.message : `服务拒绝了请求（HTTP ${response.status}）`);
}

async function adminFetch(path: string, body: unknown, port: number | undefined, file: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const expected = await instance(file);
  const target = port ?? expected.port;
  return fetch(`http://127.0.0.1:${target}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${expected.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: limited(timeoutMs, signal), redirect: "error",
  }).catch((error: unknown) => {
    signal?.throwIfAborted();
    throw new Error((error as Error).name === "TimeoutError" ? `服务 ${Math.ceil(timeoutMs / 1000)} 秒内没有答复，请稍后重试`
      : `本机端口 ${target} 无响应；服务可能没有运行`);
  });
}

/** 部门 `parent`（缺省为根部门 1）的直属子部门，由服务向平台查询。 */
export async function listDepartments(parent = "1", port?: number, file = INSTANCE_FILE, signal?: AbortSignal): Promise<DepartmentInfo[]> {
  const { status, body } = await adminPost("/_admin/directory/departments", { parent }, port, file, PLATFORM_ROUTE_TIMEOUT_MS, signal);
  if (status !== 200) throw new Error(typeof body.message === "string" ? body.message : `服务拒绝了查询（HTTP ${status}）`);
  return body.departments as DepartmentInfo[];
}

/**
 * 保存的范围和生效范围里各部门的路径，取自服务的部门树（不调用平台，很快）。读不到时（服务没有这个接口、口令不符、
 * 没有答复）为空，范围按部门 ID 显示。调用方取消时抛出取消的原因。
 */
export async function readScopePaths(port?: number, file = INSTANCE_FILE, signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const { status, body } = await adminPost("/_admin/directory/scope-paths", {}, port, file, 3000, signal);
    if (status === 200 && isRecord(body.paths))
      return Object.fromEntries(Object.entries(body.paths).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { signal?.throwIfAborted(); }
  return {};
}

/**
 * 部门的名称、完整路径和上级链，由服务向平台查询。平台明确拒绝的部门（不存在等）单列；
 * 其他失败（网络、平台故障）使整次查询失败，可以重试。
 */
export async function describeDepartments(ids: readonly string[], port?: number, file = INSTANCE_FILE, timeoutMs = PLATFORM_ROUTE_TIMEOUT_MS,
  signal?: AbortSignal): Promise<DepartmentDescription> {
  const { status, body } = await adminPost("/_admin/directory/department-details", { ids }, port, file, timeoutMs, signal);
  if (status !== 200) throw new Error(typeof body.message === "string" ? body.message : `服务拒绝了查询（HTTP ${status}）`);
  return { departments: body.departments as DepartmentDetail[], unavailable: body.unavailable as DepartmentDescription["unavailable"] };
}

/** 部门的显示路径：一级部门到本部门的名称（不含根部门）；上级链未知时用平台的完整路径。 */
export function departmentPath(department: DepartmentDetail): string {
  const name = department.name || department.id;
  return department.ancestors ? [...department.ancestors.map(item => item.name || item.id), name].join(" / ") : department.fullName ?? name;
}

export type ScopeChange = { status: "unchanged" } | { status: "started" | "cancelled"; departments: DepartmentInfo[] };

/**
 * 改同步范围；服务核对部门、保存后立即开始应用。started：正在应用（之前的名单在完成前仍然生效）；
 * unchanged：与保存的范围相同且已生效；cancelled：改回了当前生效的范围，未完成的应用取消。核对过的部门随结果交回。
 */
export async function changeScope(scope: DirectoryScope, port?: number, file = INSTANCE_FILE): Promise<ScopeChange> {
  const request = scope.kind === "all" ? { all: true } : { departments: scope.departments };
  const { status, body } = await adminPost("/_admin/directory/scope", request, port, file, PLATFORM_ROUTE_TIMEOUT_MS);
  if (status === 200 && body.status === "unchanged") return { status: "unchanged" };
  if ((status === 202 && body.status === "started") || (status === 200 && body.status === "cancelled"))
    return { status: body.status, departments: body.departments as DepartmentInfo[] };
  throw new Error(typeof body.message === "string" ? body.message : `服务拒绝了修改（HTTP ${status}）`);
}

/** 服务保存的同步范围、它是否已生效，以及当前名单按哪个范围建成（还没有完整同步过时为 null）。 */
export interface SavedScope {
  /** undefined 为未设置（不同步）。 */
  readonly scope: DirectoryScope | undefined;
  /** 否则正在应用、应用失败（之前的名单仍然生效）或未设置。 */
  readonly settled: boolean;
  readonly effective: DirectoryScope | null;
}

/**
 * 部门选择（控制台的选择器与终端向导）的数据来源：当前范围、直属子部门和部门详情，以及保存。默认经服务的本机控制接口，
 * 测试换成假的。signal 中止时取消查询；保存没有取消。
 */
export interface DepartmentSource {
  scope(signal?: AbortSignal): Promise<SavedScope>;
  children(parent: string, signal?: AbortSignal): Promise<DepartmentInfo[]>;
  describe(ids: readonly string[], signal?: AbortSignal): Promise<DepartmentDescription>;
  /** 保存并开始应用；服务先向平台核对部门，任何一个不存在、无权读取或没核对成都不改。 */
  save(scope: DirectoryScope): Promise<ScopeChange>;
}

export function serviceDepartments(file = INSTANCE_FILE): DepartmentSource {
  return {
    async scope(signal) {
      const service = await readServiceStatus(undefined, file, signal);
      if (service.verificationOnly) throw new Error("这是不连接平台的验证实例，不能读取部门");
      const directory = service.directory;
      if (!directory) throw new Error("服务没有报告通讯录状态；请等服务启动完成后再试");
      return { scope: directory.scope, settled: directory.state === "effective", effective: directory.effective?.scope ?? null };
    },
    children: (parent, signal) => listDepartments(parent, undefined, file, signal),
    describe: (ids, signal) => describeDepartments(ids, undefined, file, undefined, signal),
    save: scope => changeScope(scope, undefined, file),
  };
}

/** 范围说明里按路径列出的部门数；更多时写“等”。 */
const NAMED_DEPARTMENTS = 5;

/**
 * 范围的一句话说明。给了 `paths`（服务部门树里的路径，见 readScopePaths）时按路径列出部门，路径未知的写部门 ID；
 * 没给时只列部门 ID。
 */
export function describeScope(scope: DirectoryScope | undefined, paths?: Readonly<Record<string, string>>): string {
  if (!scope) return "未设置（不同步）";
  if (scope.kind === "all") return "整个通讯录";
  const count = scope.departments.length;
  if (!paths) return `${count} 个部门（${scope.departments.join("、")}）及其子部门`;
  const named = scope.departments.slice(0, NAMED_DEPARTMENTS).map(id => paths[id] ?? `部门 ${id}`).join("；");
  return `${count} 个部门及其子部门：${named}${count > NAMED_DEPARTMENTS ? " 等" : ""}`;
}

/** 保存范围后说明它何时、对谁生效（控制台的选择器与命令行共用）。 */
export const SCOPE_APPLY_NOTE = "服务立即按新范围完整同步，完成前之前的名单仍然生效；完成后范围外成员不能再向机器人发起新请求，" +
  "已有会话和统计保留，已接收的请求照常完成";

/** 命令行开始应用后的提示（scope all 与终端向导共用）。 */
export const SCOPE_PROGRESS_HINT = "用 directory 查看进度；没成时服务自动重试，也可以再执行一次立即重试。";

/** 保存范围的结果（控制台的选择器与命令行共用）；开始应用时列出服务核对过的部门。 */
export function describeScopeChange(scope: DirectoryScope, result: ScopeChange): string[] {
  const named = describeScope(scope);
  if (result.status === "unchanged") return [`同步范围未变（${named}），已经生效，未重新同步。`];
  if (result.status === "cancelled") return [`已改回当前生效的范围（${named}），未完成的范围应用已取消。`];
  return [`已保存，服务正在应用新范围：${scope.kind === "departments" ? `只同步以下 ${result.departments.length} 个部门及其子部门（ID、人数、名称）` : "整个通讯录"}`,
    ...result.departments.map(departmentRow), `${SCOPE_APPLY_NOTE}。`];
}

/**
 * 保存结果的一句话（控制台选择器的提示与终端向导的结尾共用）。unset：选择前服务还没有保存范围；changed：选择与保存的范围不同
 * （没变时是同一范围再保存一次，立即重新应用）。
 */
export function scopeChangeSummary(result: ScopeChange, before: { unset: boolean; changed: boolean }): string {
  return result.status === "unchanged" ? "同步范围没有变化，已经生效"
    : result.status === "cancelled" ? "已改回当前生效的范围"
    : before.unset ? "已保存，服务开始按这个范围同步通讯录"
    : !before.changed ? "已重新开始应用同步范围（完成前之前的名单仍然生效）"
    : "已保存，正在应用新范围（完成前之前的名单仍然生效）";
}

/** 部门列表的一行：ID、人数、名称（制表符分隔）。 */
export function departmentRow(department: DepartmentInfo): string {
  return [department.id, department.count === undefined ? "-" : String(department.count), department.fullName ?? department.name]
    .map(field => field.replace(/[\t\r\n]/g, " ")).join("\t");
}

/** 同步范围内各部门的一行（ID、人数、路径）；服务查不到名称时说明原因，范围本身照常按 ID 显示。 */
export async function scopeRows(scope: readonly string[], port?: number, file = INSTANCE_FILE): Promise<string[]> {
  let described: DepartmentDescription;
  try { described = await describeDepartments(scope, port, file, 30_000); }
  catch (error) { return [`范围内部门的名称未能读取：${error instanceof Error ? error.message : String(error)}`]; }
  const found = new Map(described.departments.map(department => [department.id, department]));
  const refused = new Map(described.unavailable.map(item => [item.id, item.message]));
  return ["范围内的部门（ID、人数、路径）：", ...scope.map(id => {
    const department = found.get(id);
    const refusal = refused.get(id);
    return departmentRow(department ? { ...department, fullName: departmentPath(department) }
      : { id, name: refusal ? `平台拒绝：${refusal}` : "读取失败：服务没有返回这个部门" });
  })];
}

export function describeStream(stream: StreamStatus | undefined, verificationOnly = false): string {
  if (!stream) return verificationOnly ? "验证实例不连接 Stream" : "尚未启动";
  if (stream.connected) return `已连接${stream.connectedAt ? `（连上于 ${describeAge(stream.connectedAt)}）` : ""}，启动以来重连 ${stream.reconnects} 次`;
  const since = stream.disconnectedSince ? `（断开于 ${describeAge(stream.disconnectedSince)}）` : "";
  return `未连接${since}${stream.lastDisconnect ? `：${stream.lastDisconnect.reason}` : ""}`;
}

/** 同步范围的状态：已生效、正在应用（之前的名单仍然生效）、应用失败（等自动重试）或未设置（不同步）。`paths` 见 describeScope。 */
export function describeScopeState(directory: DirectoryStatus, paths?: Readonly<Record<string, string>>): string {
  if (directory.state === "unset") return `未设置：不同步通讯录，不认识的成员无法确认身份；${scopeChoiceHint()}`;
  if (directory.state === "effective") return `已生效${directory.effective ? `（${describeAge(directory.effective.since)}完成）` : ""}`;
  const previous = directory.effective ? `之前的范围（${describeScope(directory.effective.scope, paths)}）` : directory.mappings ? "之前的名单" : "";
  if (directory.state === "applying") return previous ? `正在应用，完成前${previous}仍然生效` : "正在进行首次同步";
  const retry = directory.retryAt ? `${describeUntil(directory.retryAt)}自动重试` : "稍后自动重试";
  return `应用失败：${directory.failure ?? "上一轮同步没有完成"}；${previous ? `${previous}仍然生效，` : ""}${retry}，用同一范围再保存一次可立即重试`;
}

export function describeDirectory(directory: DirectoryStatus | undefined): string[] {
  if (!directory) return ["通讯录：未知"];
  const lines = [`通讯录映射：${directory.mappings} 个`, `同步范围：${describeScope(directory.scope)}`, `范围状态：${describeScopeState(directory)}`];
  if (directory.lastCompleteAt) lines.push(`最近完整同步：${describeAge(directory.lastCompleteAt)}`);
  else lines.push("最近完整同步：还没有");
  const running = directory.running;
  if (running) lines.push(`正在同步（${running.mode === "apply" ? "应用新范围" : "日常同步"}，${running.phase}）：部门 ${running.departments}，成员 ${running.members}，已解析 ${running.resolved}`);
  // 应用失败的原因已在范围状态里。
  if (directory.failure && directory.state === "effective")
    lines.push(`上一轮没有完成：${directory.failure}${directory.retryAt ? `（${describeUntil(directory.retryAt)}自动重试）` : ""}`);
  if (directory.recheck) lines.push(`大批成员缺席：${directory.recheck.count} 个，${describeUntil(directory.recheck.at)}再完整同步一轮复核，仍缺席的才撤销`);
  return lines;
}

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  interrupted: "反复中断而结束的任务", faulted: "出错的任务", deliveryAbandoned: "超时放弃的交付", notSent: "未发出的模型请求", statsRegressed: "统计回退",
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

/** 体检行（状态、名称、详情，制表符分隔）：断开超过两分钟和未设置同步范围算失败；范围尚未生效、没成的同步和待复核的缺席算待核验。 */
export function doctorRows(status: ServiceStatus, now = Date.now()): string[] {
  const rows: string[] = [];
  if (!status.verificationOnly) {
    const stream = status.stream;
    const state = stream?.connected ? "pass" : stream?.disconnectedSince && now - stream.disconnectedSince < 120_000 ? "warn" : "fail";
    rows.push([state, "事件 Stream", describeStream(stream)].join("\t"));
  }
  const directory = status.directory;
  const settled = directory?.state === "effective" && !directory.failure && !directory.recheck && directory.lastCompleteAt;
  rows.push([directory?.state === "unset" ? "fail" : settled ? "pass" : "warn", "通讯录同步", describeDirectory(directory).join("；")].join("\t"));
  if (status.attention) {
    const events = describeAttention(status.attention, now);
    rows.push([events.some(event => event.recent) ? "warn" : "pass", "运行状况",
      events.length ? `自本次启动：${events.map(event => event.text).join("；")}` : "自本次启动没有需要留意的事件"].join("\t"));
  }
  return rows;
}

const USAGE = "用法：bun run ops/tools/directory-admin.ts status | doctor | scope [all]（不带 all 时在终端里逐层勾选部门；不接受部门 ID）";

/**
 * 命令行入口，返回退出码：0 完成；1 失败（服务没有运行、拒绝了请求等）；2 用法错误（未知、重复或多余的参数，部门 ID），
 * 或没有终端运行向导（不默认整个通讯录）；130 在向导里取消（什么都没改）。
 */
export async function main(argv: readonly string[], terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)): Promise<number> {
  const [action = "status", ...rest] = argv;
  try {
    if (action === "doctor" && !rest.length) {
      for (const row of doctorRows(await readServiceStatus())) console.log(row.replace(/[\r\n]/g, " "));
      return 0;
    }
    if (action === "status" && !rest.length) {
      const status = await readServiceStatus();
      console.log(`事件 Stream：${describeStream(status.stream, status.verificationOnly)}`);
      for (const line of describeDirectory(status.directory)) console.log(line);
      if (status.directory?.scope?.kind === "departments") for (const line of await scopeRows(status.directory.scope.departments)) console.log(line);
      if (status.attention) for (const event of describeAttention(status.attention)) console.log(`自本次启动：${event.text}`);
      return 0;
    }
    // ops.ps1 不带范围时传空串，按不带参数处理。
    const value = action === "scope" && rest.length <= 1 ? (rest[0] ?? "").trim() : undefined;
    if (value === "all") {
      const result = await changeScope(WHOLE_DIRECTORY);
      for (const line of describeScopeChange(WHOLE_DIRECTORY, result)) console.log(line);
      if (result.status === "started") console.log(SCOPE_PROGRESS_HINT);
      return 0;
    }
    if (value) {
      console.error(`命令行不接受部门 ID，只接受 all（整个通讯录）；${scopeChoiceHint()}`);
      return 2;
    }
    if (value === undefined) {
      console.error(USAGE);
      return 2;
    }
    if (!terminal) {
      console.error(`没有终端，不能逐层勾选部门，也不默认整个通讯录；${scopeChoiceHint()}`);
      return 2;
    }
    const { changeScopeInTerminal } = await import("../config/directory-scope-wizard.ts");
    return await changeScopeInTerminal(serviceDepartments());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// 不用顶层 await：scope 动态加载的终端向导又导入本文件；按 ECMAScript 规范，本文件还没求值完时两边会互相等待
// （Node 会卡住；Bun 1.4.4 实测不会，但不依赖这一点）。
if (import.meta.main) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
