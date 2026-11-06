// 通讯录映射（方案 5.8）：事件 userId（imUserId）→ 手机号与姓名。
// 消息路径只同步读本地表，不调外部接口。表由目录扫描维护。每次扫描先完整分页遍历范围内的部门和成员，得到「手机号 → 姓名」，
// 同一手机号姓名互相矛盾记为冲突；遍历完整指验签解密全部成功、每页的列表和总页数都合法（directory.ts 的 pageOf）、每名成员
// 都有手机号。扫描分两种，开始时决定：
//   - 应用新范围：保存的范围（directory-scope.ts）与生效范围不同。表里已有的号码沿用 ID，新号码解析进临时名单；遍历完整、
//     没有冲突、新号码没有临时性的解析失败时，在一个事务里整表换成新名单并记下生效范围，不受撤销人数的限制。否则（或被
//     更新的范围取代）一行不改，旧范围继续生效。
//   - 日常同步（含还没有生效记录时：首次部署后的第一轮）：表里没有的号码在遍历中一出现就解析并加入（ID 已
//     属于别的号码的那些等遍历完再定，遍历后发现冲突的撤回）；完整且无冲突的一轮撤销缺席的手机号。一次缺席超过有效映射 10%
//     且多于 20 条时先不撤销，过一段时间再完整同步一轮复核，两轮都缺席的才撤销。
// 不完整、有冲突或新号码没查成的一轮自动重试。每次扫描另复核约 1/30 的已有映射。只保存当前有效映射；被撤销或替换的旧 ID
// 不保留，再次出现时重新解析。表绑定当前应用和环境，换了就拒绝启动。
// 没有保存的范围（未设置）时不扫描：已有映射照常查询、不删除；保存了范围后立即开始。
// 遍历同时记下部门树和部门成员（department-tree.ts，推送按部门展开用）：日常同步遍历完整时替换；应用新范围时与新名单一起替换。
// 映射表是通讯录副本，与凭据同等敏感：日志只写计数，不写手机号、姓名和 ID。
import type { Database, Statement } from "bun:sqlite";
import { AsyncSemaphore } from "../../core/async-semaphore.ts";
import { log } from "../../core/log.ts";
import { PlatformRequestError } from "./client.ts";
import { DepartmentTree, emptyWalk, type TreeWalk } from "./department-tree.ts";
import type { DirectoryClient, Page } from "./directory.ts";
import { type DirectoryScope, parseScopeRecord, ROOT_DEPARTMENT, sameScope, scopeDepartments, scopeRecord } from "./directory-scope.ts";

export interface DirectoryIdentity {
  readonly phone: string;
  readonly imUserId: string;
  readonly name: string;
}

/** initial：还没有生效记录时启动；scope：保存了新范围（或启动时继续未完成的应用）；recheck：大批缺席后的复核；retry：上一轮没成。 */
export type ScanTrigger = "initial" | "daily" | "unknown" | "scope" | "recheck" | "retry";
/** apply：应用新范围（临时名单，一次切换）；routine：日常同步。 */
export type ScanMode = "apply" | "routine";

export interface ScanSummary {
  readonly id: number;
  readonly trigger: ScanTrigger;
  readonly mode?: ScanMode;
  readonly scope?: DirectoryScope;
  readonly startedAt: number;
  finishedAt?: number;
  /** 全部分页、验签和解密都成功，每名成员都有手机号（应用新范围时还要新号码都查成或被平台明确拒绝）。 */
  complete: boolean;
  /** 被更新的范围取代而中止：不算失败。 */
  superseded?: true;
  departments: number;
  members: number;
  added: number;
  renamed: number;
  replaced: number;
  reverified: number;
  revoked: number;
  /** 一次缺席太多、等复核的条数。 */
  suspected: number;
  conflicts: number;
  failures: number;
  error?: string;
}

/**
 * effective：名单按保存的范围建成；applying：正在按它同步，之前的名单仍然生效；failed：上一次没成，之前的名单仍然生效，等重试；
 * unset：没有保存的范围，不同步。
 */
export type ScopeState = "applying" | "effective" | "failed" | "unset";

export interface DirectoryStatus {
  readonly mappings: number;
  /** 保存的范围；未设置时没有。 */
  readonly scope?: DirectoryScope;
  readonly state: ScopeState;
  /** 名单按哪个范围建成、何时生效；还没有完成过首次同步时没有。 */
  readonly effective?: { readonly scope: DirectoryScope; readonly since: number };
  /** 上一轮没成的原因（没有扫描在进行时）。 */
  readonly failure?: string;
  /** 下一次自动重试的时间。 */
  readonly retryAt?: number;
  /** 一次缺席太多、等复核的人数和复核时间。 */
  readonly recheck?: { readonly count: number; readonly at: number };
  readonly lastScan?: ScanSummary;
  readonly lastCompleteAt?: number;
  readonly running?: { readonly trigger: ScanTrigger; readonly mode: ScanMode; readonly startedAt: number; readonly phase: string;
    readonly departments: number; readonly members: number; readonly resolved: number };
}

export interface DirectoryOptions {
  /** 所有通讯录请求的总速率上限（次/秒）。 */
  readonly perSecond?: number;
  readonly concurrency?: number;
  /** 未知 ID 触发扫描的冷却时间。 */
  readonly unknownCooldownMs?: number;
  /** 保存的范围（data/config/directory.json）；undefined 为未设置：不扫描，已有映射照常查询。 */
  readonly scope: DirectoryScope | undefined;
  /** 大批缺席到复核的间隔。 */
  readonly recheckDelayMs?: number;
  /** 连续失败后的重试间隔，用完后一直用最后一个。 */
  readonly retryDelaysMs?: readonly number[];
  readonly now?: () => number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS member_directory (
  phone TEXT PRIMARY KEY, im_user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_verified_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_binding (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), app TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  complete INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_failures (phone TEXT PRIMARY KEY, attempts INTEGER NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_effective (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), scope TEXT NOT NULL, since INTEGER NOT NULL) STRICT;
`;
const KEEP_SCANS = 50;
const REVOKE_RATIO = 0.1;
const REVOKE_MIN = 20;
const REVERIFY_SHARE = 30;
const RECHECK_DELAY_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

/** 总速率与并发同时受限的执行器。 */
class Pacer {
  readonly #slots: AsyncSemaphore;
  readonly #interval: number;
  #next = 0;
  constructor(perSecond: number, concurrency: number, private readonly signal: AbortSignal) {
    this.#slots = new AsyncSemaphore(concurrency);
    this.#interval = 1000 / perSecond;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.#slots.acquire(this.signal);
    try {
      const now = Date.now();
      const at = Math.max(now, this.#next);
      this.#next = at + this.#interval;
      if (at > now) await Bun.sleep(at - now);
      this.signal.throwIfAborted();
      return await work();
    } finally { release(); }
  }
}

/**
 * 平台对这个号码本身的明确答复：2xx 或 4xx 响应里的业务码，或答复里没有 imUserId（例如账号未开通）。这个人暂不映射，
 * 不影响其他人。网络、鉴权、限流、5xx、验签解密失败和答复与查询不符，只说明这一次没查成。
 */
function memberRefusal(error: unknown): boolean {
  return error instanceof PlatformRequestError && error.kind === "rejected" && error.status !== undefined
    && error.status < 500 && error.status !== 401 && error.status !== 429;
}

type Row = { phone: string; imUserId: string; name: string; verifiedAt: number };
type Running = { trigger: ScanTrigger; mode: ScanMode; target: DirectoryScope; startedAt: number; phase: string; departments: number; members: number;
  resolved: number; controller: AbortController; done: Promise<ScanSummary> };
/** 一轮扫描的上下文；resolving 收集在途的解析，中止时等它们结束。 */
type Round = { state: Running; summary: ScanSummary; client: DirectoryClient; pacer: Pacer; signal: AbortSignal; resolving: Promise<void>[] };
/** 遍历结果：范围内的手机号 → 姓名，同一号码姓名矛盾的号码，部门树。 */
type Walk = { seen: Map<string, string>; conflicted: Set<string>; tree: TreeWalk };
type Resolved = { imUserId: string } | { transient: boolean };
type FollowUp = { kind: "retry" | "recheck"; at: number; timer: ReturnType<typeof setTimeout> };

const SCOPE_CHANGED = "通讯录范围已变更，已重新开始同步";
const SCOPE_UNSET = "还没有设置通讯录同步范围，不同步";

export class IdentityDirectory {
  readonly #db: Database;
  /** 同步范围内的部门树（推送用）。 */
  readonly departments: DepartmentTree;
  readonly #lookup: Statement<DirectoryIdentity, [string]>;
  readonly #byPhone: Statement<DirectoryIdentity, [string]>;
  readonly #perSecond: number;
  readonly #concurrency: number;
  readonly #cooldown: number;
  readonly #recheckDelay: number;
  readonly #retryDelays: readonly number[];
  readonly #now: () => number;
  #running: Running | undefined;
  #requested: DirectoryScope | undefined;
  #effective: { scope: DirectoryScope; since: number } | undefined;
  /** 日常同步发现的大批缺席：这些号码，发现的时间。只在内存里，重启后由下一轮日常同步重新发现。 */
  #suspect: { phones: Set<string>; at: number } | undefined;
  #followUp: FollowUp | undefined;
  #retries = 0;
  #changing: Promise<void> = Promise.resolve();
  #lastUnknownScan = -Infinity;
  /** 本次启动以来遍历读到的选定部门路径：正在应用的范围还不在部门树里时，显示范围用它。 */
  readonly #chosenPaths = new Map<string, string>();

  constructor(db: Database, binding: string, options: DirectoryOptions) {
    this.#db = db;
    // 平台未公布限流；2026-10-24 实测部门列表与 detailByPhone 到 80 次/秒都没有 429（p95 < 90 ms），按用户决定取 80。
    // 80 次/秒约需 7 个并发，并发留余量，让限速器而不是并发决定速度。
    this.#perSecond = options.perSecond ?? 80;
    this.#concurrency = options.concurrency ?? 12;
    this.#requested = options.scope;
    this.#cooldown = options.unknownCooldownMs ?? 30 * 60_000;
    this.#recheckDelay = options.recheckDelayMs ?? RECHECK_DELAY_MS;
    this.#retryDelays = options.retryDelaysMs?.length ? options.retryDelaysMs : RETRY_DELAYS_MS;
    this.#now = options.now ?? Date.now;
    db.exec(SCHEMA);
    this.departments = new DepartmentTree(db);
    db.transaction(() => {
      const current = (db.query("SELECT app FROM directory_binding WHERE singleton = 1").get() as { app: string } | null)?.app;
      if (current === binding) return;
      // 整个数据目录绑定一个应用（部署记录在启动前已核对）；这里再拒绝一次，不清空通讯录后沿用另一个应用的会话。
      if (current !== undefined) throw new Error("通讯录属于另一个应用或平台环境，拒绝启动；如需改用另一个应用，请在新目录全新部署");
      db.query("INSERT INTO directory_binding (singleton, app) VALUES (1, ?)").run(binding);
    })();
    const effective = db.query("SELECT scope, since FROM directory_effective WHERE singleton = 1").get() as { scope: string; since: number } | null;
    if (effective) {
      // 生效记录只决定下一轮怎么扫：读不懂时按没有记录处理（日常同步，带复核），完成后重写。
      try { this.#effective = { scope: parseScopeRecord(effective.scope), since: effective.since }; }
      catch (error) { log.warn(`通讯录生效范围的记录无法识别，下一轮按日常同步处理：${String(error)}`); }
    }
    this.#lookup = db.query("SELECT phone, im_user_id AS imUserId, name FROM member_directory WHERE im_user_id = ?");
    this.#byPhone = db.query("SELECT phone, im_user_id AS imUserId, name FROM member_directory WHERE phone = ?");
  }

  /** 同步查询：事件 userId 当前对应的成员；没有有效映射时为 undefined。 */
  lookup(imUserId: string): DirectoryIdentity | undefined {
    return this.#lookup.get(imUserId) ?? undefined;
  }

  /** 同步查询：手机号当前对应的成员，即同步范围内有有效映射的人（推送按它核对对象）；没有时为 undefined。 */
  byPhone(phone: string): DirectoryIdentity | undefined {
    return this.#byPhone.get(phone) ?? undefined;
  }

  get mappings(): number {
    return (this.#db.query("SELECT count(*) AS n FROM member_directory").get() as { n: number }).n;
  }

  /** 保存的范围；未设置时为 undefined。 */
  get scope(): DirectoryScope | undefined { return this.#requested; }

  /** 没有保存的范围：不同步。 */
  get unset(): boolean { return this.#requested === undefined; }

  /** 生效的名单只含选定部门的成员（还没有生效记录时看保存的范围）。 */
  get scoped(): boolean { return (this.#effective?.scope ?? this.#requested)?.kind === "departments"; }

  /** 名单按保存的范围建成。 */
  get settled(): boolean {
    return this.#requested !== undefined && this.#effective !== undefined && sameScope(this.#effective.scope, this.#requested);
  }

  /** 保存的范围还没生效：正在应用或等重试，之前的名单仍然生效。 */
  get applying(): boolean { return this.#requested !== undefined && !this.settled; }

  /** 还没有完成过一次完整扫描（首次同步进行中或失败）。 */
  get initializing(): boolean {
    return this.#db.query("SELECT 1 FROM directory_scans WHERE complete = 1 LIMIT 1").get() === null;
  }

  /** 启动时要立即开始的同步：保存的范围还没生效就继续应用（还没有生效记录时为首次同步）；已生效或未设置时为 undefined。 */
  startupTrigger(): "initial" | "scope" | undefined {
    if (this.#requested === undefined || this.settled) return undefined;
    return this.#effective ? "scope" : "initial";
  }

  status(): DirectoryStatus {
    const last = this.#db.query("SELECT summary FROM directory_scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { summary: string } | null;
    const complete = this.#db.query("SELECT finished_at AS at FROM directory_scans WHERE complete = 1 ORDER BY id DESC LIMIT 1").get() as { at: number } | null;
    const lastScan = last ? JSON.parse(last.summary) as ScanSummary : undefined;
    const running = this.#running, followUp = this.#followUp, suspect = this.#suspect;
    const failure = !running && lastScan && !lastScan.superseded && (!lastScan.complete || lastScan.conflicts > 0)
      ? lastScan.error ?? "上一轮同步没有完成" : undefined;
    return {
      mappings: this.mappings,
      ...(this.#requested ? { scope: this.#requested } : {}),
      state: !this.#requested ? "unset" : this.settled ? "effective" : failure ? "failed" : "applying",
      ...(this.#effective ? { effective: { scope: this.#effective.scope, since: this.#effective.since } } : {}),
      ...(failure ? { failure } : {}),
      ...(followUp?.kind === "retry" ? { retryAt: followUp.at } : {}),
      ...(suspect ? { recheck: { count: suspect.phones.size, at: suspect.at + this.#recheckDelay } } : {}),
      ...(lastScan ? { lastScan } : {}),
      ...(complete ? { lastCompleteAt: complete.at } : {}),
      ...(running ? { running: { trigger: running.trigger, mode: running.mode, startedAt: running.startedAt, phase: running.phase,
        departments: running.departments, members: running.members, resolved: running.resolved } } : {}),
    };
  }

  /**
   * 保存的范围和生效范围里各部门的路径（控制台显示范围用；不调用平台）：本次启动以来遍历读到的，或部门树里的。
   * 两处都没有的部门不列出。
   */
  scopePaths(): Record<string, string> {
    const ids = [...new Set([this.#requested, this.#effective?.scope].flatMap(scope => scope ? scopeDepartments(scope) ?? [] : []))];
    const tree = this.departments.paths(ids);
    return Object.fromEntries(ids.flatMap(id => {
      const path = this.#chosenPaths.get(id) ?? tree.get(id);
      return path ? [[id, path]] : [];
    }));
  }

  /**
   * 未知或已失效的 userId：触发一次扫描（同一时间只跑一个；未知触发有冷却；未设置范围时不扫描）。返回是否新开始了扫描。
   */
  requestScan(client: DirectoryClient, signal: AbortSignal): boolean {
    if (this.#requested === undefined || this.#running || this.#now() - this.#lastUnknownScan < this.#cooldown) return false;
    this.#lastUnknownScan = this.#now();
    this.#start("unknown", client, signal);
    return true;
  }

  /**
   * 保存新的同步范围（部门已由调用方向平台核对）并立即开始应用。多次更换按调用顺序逐个处理，最后保存的那个生效：`persist`
   * 写范围文件，随后正在进行的扫描中止（中止的应用不改任何映射），按新范围开始扫描。与保存的范围相同时：已生效答 unchanged；
   * 正在应用则不重来，上次没成就立即重试（started）。改回当前生效的范围时取消未完成的应用，不扫描（cancelled）。
   * 从未设置改成任何范围都立即开始扫描（started）。
   */
  async changeScope(scope: DirectoryScope, client: DirectoryClient, signal: AbortSignal,
    persist: (scope: DirectoryScope) => Promise<void>): Promise<"unchanged" | "started" | "cancelled"> {
    const previous = this.#changing, turn = Promise.withResolvers<void>();
    this.#changing = turn.promise;
    await previous;
    try {
      const requested = this.#requested;
      if (requested && sameScope(scope, requested)) {
        if (this.settled) return "unchanged";
        if (!this.#running) this.#start(this.#effective ? "scope" : "initial", client, signal);
        return "started";
      }
      await persist(scope);
      this.#requested = scope;
      this.#suspect = undefined;
      this.#retries = 0;
      this.#cancelFollowUp();
      const running = this.#running;
      if (running) {
        running.controller.abort(new Error(SCOPE_CHANGED));
        await running.done.catch(() => undefined);
      }
      if (requested && this.settled) return "cancelled";
      // 中止与这里之间，未知成员触发的扫描已按新范围开始时，scan 交回那一次。
      if (!signal.aborted) this.#start(!requested && !this.#effective ? "initial" : "scope", client, signal);
      return "started";
    } finally { turn.resolve(); }
  }

  /** 运行一次扫描；已有扫描在跑时返回那一次的结果。未设置范围时拒绝。 */
  scan(trigger: ScanTrigger, client: DirectoryClient, signal: AbortSignal): Promise<ScanSummary> {
    if (this.#running) return this.#running.done;
    const target = this.#requested;
    if (!target) return Promise.reject(new Error(SCOPE_UNSET));
    this.#cancelFollowUp();
    const mode: ScanMode = this.#effective && !sameScope(this.#effective.scope, target) ? "apply" : "routine";
    const state: Running = { trigger, mode, target, startedAt: this.#now(), phase: "遍历部门", departments: 0, members: 0, resolved: 0,
      controller: new AbortController(), done: undefined as unknown as Promise<ScanSummary> };
    this.#running = state;
    state.done = this.#scan(state, client, signal).finally(() => { if (this.#running === state) this.#running = undefined; });
    return state.done;
  }

  /** 在后台开始一次扫描；失败只记日志（服务停止时不记）。 */
  #start(trigger: ScanTrigger, client: DirectoryClient, signal: AbortSignal): void {
    void this.scan(trigger, client, signal).catch(error => { if (!signal.aborted) log.error(`通讯录同步失败：${String(error)}`); });
  }

  async #scan(state: Running, client: DirectoryClient, service: AbortSignal): Promise<ScanSummary> {
    const signal = AbortSignal.any([service, state.controller.signal]);
    const db = this.#db;
    const id = Number(db.query("INSERT INTO directory_scans (trigger, started_at, summary) VALUES (?, ?, '{}')").run(state.trigger, state.startedAt).lastInsertRowid);
    const summary: ScanSummary = { id, trigger: state.trigger, mode: state.mode, scope: state.target, startedAt: state.startedAt, complete: true,
      departments: 0, members: 0, added: 0, renamed: 0, replaced: 0, reverified: 0, revoked: 0, suspected: 0, conflicts: 0, failures: 0 };
    const round: Round = { state, summary, client, pacer: new Pacer(this.#perSecond, this.#concurrency, signal), signal, resolving: [] };
    const label = state.mode === "apply" ? "应用新范围" : "日常同步";
    log.info(`通讯录同步开始（${state.trigger}，${label}）`);
    let retry = false;
    try {
      retry = state.mode === "apply" ? await this.#apply(round) : await this.#routine(round);
    } catch (error) {
      summary.complete = false;
      // 已拿到结果的解析会在中止后写完映射；等它们结束，这一轮才算结束。
      await Promise.allSettled(round.resolving);
      // 换范围中止的一轮不算失败：新一轮随即开始。
      if (!state.controller.signal.aborted || service.aborted) {
        summary.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      summary.superseded = true;
      summary.error = SCOPE_CHANGED;
    } finally {
      summary.finishedAt = this.#now();
      db.query("UPDATE directory_scans SET finished_at = ?, complete = ?, summary = ? WHERE id = ?")
        .run(summary.finishedAt, summary.complete && summary.conflicts === 0 ? 1 : 0, JSON.stringify(summary), id);
      db.query("DELETE FROM directory_scans WHERE id <= ? AND id NOT IN (SELECT id FROM directory_scans WHERE complete = 1 ORDER BY id DESC LIMIT 1)").run(id - KEEP_SCANS);
      if (!service.aborted && !summary.superseded) this.#followUpAfter(!summary.complete || summary.conflicts > 0 || retry, client, service);
      log.info(`通讯录同步结束（${state.trigger}，${label}）：${summary.complete ? "完整" : "不完整"}，部门 ${summary.departments}，成员 ${summary.members}，` +
        `新增 ${summary.added}，替换 ${summary.replaced}，复核 ${summary.reverified}，撤销 ${summary.revoked}，待复核 ${summary.suspected}，` +
        `冲突 ${summary.conflicts}，解析失败 ${summary.failures}，有效映射 ${this.mappings}${summary.error ? `；${summary.error}` : ""}` +
        (this.#followUp ? `；${Math.ceil((this.#followUp.at - this.#now()) / 60_000)} 分钟后${this.#followUp.kind === "retry" ? "重试" : "复核"}` : ""));
    }
    return summary;
  }

  /**
   * 应用新范围：新名单在内存里备齐，检查都通过后一个事务换上，并记下生效范围。返回是否要重试（没换上时总要）。
   */
  async #apply(round: Round): Promise<boolean> {
    const { state, summary, signal } = round, db = this.#db;
    const rows = this.#rows();
    const staged = new Map<string, string>();
    let unresolved = 0;
    const walk: Walk = { seen: new Map(), conflicted: new Set(), tree: emptyWalk() };
    await this.#walk(round, walk, phone => {
      if (rows.has(phone)) return;
      this.#background(round, (async () => {
        const result = await this.#resolve(round, phone);
        if ("imUserId" in result) staged.set(phone, result.imUserId);
        else if (result.transient) unresolved++;
      })());
    });
    state.phase = "解析新成员";
    await Promise.all(round.resolving);
    const { seen, conflicted } = walk;
    if (summary.complete && unresolved) {
      summary.complete = false;
      summary.error = `${unresolved} 名新成员的身份没有查成（网络或平台故障）`;
    }
    if (!summary.complete || conflicted.size) {
      summary.error = `${summary.error ?? `通讯录有 ${conflicted.size} 个手机号对应不同姓名`}；新范围暂不应用，之前的名单继续生效`;
      log.warn(`通讯录同步：${summary.error}`);
      return true;
    }

    // 复核约 1/30 的沿用映射（最久未复核的先）；没查成的沿用原 ID。
    state.phase = "复核已有映射";
    const verified = new Map<string, string>();
    const due = [...rows.values()].filter(row => seen.has(row.phone)).sort((a, b) => a.verifiedAt - b.verifiedAt).slice(0, Math.ceil(rows.size / REVERIFY_SHARE));
    await Promise.all(due.map(async row => {
      const result = await this.#resolve(round, row.phone);
      if ("imUserId" in result) { summary.reverified++; verified.set(row.phone, result.imUserId); }
    }));

    // 新名单：一个平台 ID 只能对应一个手机号。平台明确拒绝的新号码不在名单里。
    const now = this.#now();
    const list = new Map<string, Row>();
    for (const [phone, name] of seen) {
      const row = rows.get(phone), imUserId = verified.get(phone) ?? staged.get(phone) ?? row?.imUserId;
      if (imUserId !== undefined) list.set(phone, { phone, imUserId, name, verifiedAt: row && !verified.has(phone) ? row.verifiedAt : now });
    }
    const owners = new Set<string>();
    for (const entry of list.values()) { if (owners.has(entry.imUserId)) summary.conflicts++; else owners.add(entry.imUserId); }
    if (summary.conflicts) {
      summary.error = `新名单里有 ${summary.conflicts} 个平台 ID 同时对应多个手机号；新范围暂不应用，之前的名单继续生效`;
      log.warn(`通讯录同步：${summary.error}`);
      return true;
    }
    for (const entry of list.values()) {
      const row = rows.get(entry.phone);
      if (!row) summary.added++;
      else {
        if (row.imUserId !== entry.imUserId) summary.replaced++;
        if (row.name !== entry.name) summary.renamed++;
      }
    }
    summary.revoked = [...rows.keys()].filter(phone => !list.has(phone)).length;

    // 一次切换：被更新的范围取代的一轮到这里已经中止。
    signal.throwIfAborted();
    state.phase = "应用新名单";
    const failed = (db.query("SELECT phone FROM directory_failures").all() as { phone: string }[]).map(row => row.phone).filter(phone => !seen.has(phone));
    db.transaction(() => {
      db.exec("DELETE FROM member_directory");
      const insert = db.query("INSERT INTO member_directory (phone, im_user_id, name, last_verified_at) VALUES (?, ?, ?, ?)");
      for (const entry of list.values()) insert.run(entry.phone, entry.imUserId, entry.name, entry.verifiedAt);
      const forget = db.query("DELETE FROM directory_failures WHERE phone = ?");
      for (const phone of failed) forget.run(phone);
      this.departments.replace(walk.tree, now);
      this.#recordEffective(state.target, now);
    })();
    this.#effective = { scope: state.target, since: now };
    this.#suspect = undefined;
    return false;
  }

  /** 日常同步：边遍历边加入新成员，完整且无冲突时按复核规则撤销缺席成员。返回是否要因新号码没查成而重试。 */
  async #routine(round: Round): Promise<boolean> {
    const { state, summary } = round, db = this.#db;
    const rows = this.#rows();
    let unresolved = 0;
    // 新号码一出现就解析，成员不必等整个通讯录走完；ID 已属于另一个号码时，要看完整目录里旧号码还在不在，留到遍历之后。
    const walk: Walk = { seen: new Map(), conflicted: new Set(), tree: emptyWalk() };
    const early = new Set<string>();
    const deferred: [string, string, string][] = [];
    await this.#walk(round, walk, (phone, name) => {
      if (rows.has(phone)) return;
      this.#background(round, (async () => {
        const result = await this.#resolve(round, phone);
        if (!("imUserId" in result)) { if (result.transient) unresolved++; return; }
        if (walk.conflicted.has(phone)) return;
        let owned = false;
        this.#assign(phone, result.imUserId, name, () => { owned = true; return false; });
        if (owned) deferred.push([phone, result.imUserId, name]);
        else { summary.added++; early.add(phone); }
      })());
    });
    const { seen, conflicted } = walk;
    if (summary.complete) db.transaction(() => this.departments.replace(walk.tree, this.#now()))();

    // 等新号码解析完；遍历中建立、后来发现姓名冲突的映射撤回；ID 归属待定的按完整目录决定；更新已有成员的姓名。
    state.phase = "解析新成员";
    await Promise.all(round.resolving);
    for (const phone of conflicted) if (early.has(phone)) {
      db.query("DELETE FROM member_directory WHERE phone = ?").run(phone);
      summary.added--;
    }
    for (const [phone, imUserId, name] of deferred) {
      if (conflicted.has(phone)) continue;
      const outcome = this.#assign(phone, imUserId, name, owner => summary.complete && !seen.has(owner));
      if (outcome === "conflict") summary.conflicts++;
      else summary.replaced++;
    }
    for (const [phone, name] of seen) {
      const row = rows.get(phone);
      if (row !== undefined && !conflicted.has(phone) && row.name !== name) {
        db.query("UPDATE member_directory SET name = ? WHERE phone = ?").run(name, phone); summary.renamed++;
      }
    }

    // 复核约 1/30 的已有映射（最久未复核的先），ID 变化时原子替换。
    state.phase = "复核已有映射";
    const due = [...rows.values()].filter(row => seen.has(row.phone) && !conflicted.has(row.phone))
      .sort((a, b) => a.verifiedAt - b.verifiedAt).slice(0, Math.ceil(rows.size / REVERIFY_SHARE));
    await Promise.all(due.map(async row => {
      const result = await this.#resolve(round, row.phone);
      if (!("imUserId" in result)) return;
      summary.reverified++;
      if (result.imUserId === row.imUserId) {
        db.query("UPDATE member_directory SET last_verified_at = ? WHERE phone = ?").run(this.#now(), row.phone);
        return;
      }
      const outcome = this.#assign(row.phone, result.imUserId, seen.get(row.phone) ?? row.name, owner => summary.complete && !seen.has(owner));
      if (outcome !== "conflict") { summary.replaced++; return; }
      // The old ID is known to be stale; the new one belongs to another present member. Fail closed for this phone.
      db.query("DELETE FROM member_directory WHERE phone = ? AND im_user_id = ?").run(row.phone, row.imUserId);
      summary.conflicts++;
    }));

    // 对账：只有完整且无冲突的一轮才撤销缺席的手机号。
    state.phase = "对账";
    if (!summary.complete || summary.conflicts > 0) {
      if (summary.conflicts > 0) summary.error ??= `通讯录有 ${summary.conflicts} 处身份冲突，本轮不撤销缺席成员`;
      if (summary.conflicts > 0) log.warn(`通讯录同步：${summary.error}`);
    } else this.#reconcile(round, seen);
    return unresolved > 0;
  }

  /**
   * 撤销完整一轮里缺席的成员。一次缺席超过有效映射 10% 且多于 20 条时先不撤销，等复核：复核时间之后的完整一轮仍缺席的才撤销
   * （新缺席的人数再按同样的规则判断）；复核时间之前的一轮不撤销，只把重新出现的人移出待复核名单。没有生效记录且没有待复核的
   * 成员时，这一轮记为生效。
   */
  #reconcile(round: Round, seen: Map<string, string>): void {
    const { state, summary } = round, db = this.#db, now = this.#now();
    const mapped = (db.query("SELECT phone FROM member_directory").all() as { phone: string }[]).map(row => row.phone);
    const absent = mapped.filter(phone => !seen.has(phone));
    const suspect = this.#suspect;
    let revoke: string[] = [], next: { phones: Set<string>; at: number } | undefined;
    if (suspect && state.startedAt < suspect.at + this.#recheckDelay) {
      const still = new Set(absent.filter(phone => suspect.phones.has(phone)));
      if (still.size) next = { phones: still, at: suspect.at };
    } else {
      const confirmed = suspect ? absent.filter(phone => suspect.phones.has(phone)) : [];
      const fresh = suspect ? absent.filter(phone => !suspect.phones.has(phone)) : absent;
      const large = fresh.length > mapped.length * REVOKE_RATIO && fresh.length > REVOKE_MIN;
      revoke = large ? confirmed : [...confirmed, ...fresh];
      if (large) {
        next = { phones: new Set(fresh), at: now };
        log.warn(`通讯录同步：${fresh.length} 个成员（有效映射 ${mapped.length} 个）本轮缺席，超过一次撤销的上限；` +
          `${Math.ceil(this.#recheckDelay / 60_000)} 分钟后再完整同步一轮复核，仍缺席的才撤销`);
      }
    }
    const record = !next && !this.#effective;
    db.transaction(() => {
      const remove = db.query("DELETE FROM member_directory WHERE phone = ?");
      for (const phone of revoke) remove.run(phone);
      if (record) this.#recordEffective(state.target, now);
    })();
    if (record) this.#effective = { scope: state.target, since: now };
    this.#suspect = next;
    summary.revoked = revoke.length;
    summary.suspected = next?.phones.size ?? 0;
  }

  /**
   * 完整遍历范围内的部门，把成员记进 walk；`fresh` 在每个号码第一次出现时调用。遍历不完整时 summary.complete 为 false 并写明原因。
   */
  async #walk(round: Round, walk: Walk, fresh: (phone: string, name: string) => void): Promise<void> {
    const { state, summary, client, pacer, signal } = round;
    const chosen = scopeDepartments(state.target);
    const visited = new Set<string>(chosen ?? [ROOT_DEPARTMENT]);
    let level = [...visited];
    // The chosen departments' names and full paths; a failed lookup only leaves a placeholder name in the tree.
    if (chosen) {
      await Promise.all(chosen.map(async id => {
        try {
          const info = await pacer.run(() => client.department(id, signal));
          walk.tree.tops.set(id, { name: info.name, path: info.fullName ?? info.name });
          this.#chosenPaths.set(id, info.fullName ?? info.name);
        } catch (error) {
          signal.throwIfAborted();
          walk.tree.tops.set(id, { name: `部门 ${id}`, path: `部门 ${id}` });
          log.warn(`通讯录同步：没有读到一个同步范围部门的名称，部门树里暂用编号：${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    }
    let unidentified = 0;
    const paged = async <T>(fetch: (page: number) => Promise<Page<T>>): Promise<T[]> => {
      const first = await pacer.run(() => fetch(1));
      const rest = await Promise.all(Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => pacer.run(() => fetch(i + 2))));
      for (const page of [first, ...rest]) unidentified += page.unidentified ?? 0;
      return [first, ...rest].flatMap(page => [...page.items]);
    };
    while (level.length) {
      const next: string[] = [];
      await Promise.all(level.map(async dept => {
        try {
          const [children, members] = await Promise.all([
            paged(page => client.departments(dept, page, signal)),
            paged(page => client.members(dept, page, signal)),
          ]);
          for (const child of children) {
            if (dept === ROOT_DEPARTMENT) { if (!chosen) walk.tree.tops.set(child.id, { name: child.name, path: child.name }); }
            else walk.tree.nodes.set(child.id, { name: child.name, parent: dept });
            if (!visited.has(child.id)) { visited.add(child.id); next.push(child.id); }
          }
          walk.tree.members.set(dept, members.map(member => member.phone));
          for (const member of members) {
            const known = walk.seen.get(member.phone);
            if (known !== undefined && known !== member.name) walk.conflicted.add(member.phone);
            walk.seen.set(member.phone, member.name);
            if (known === undefined) fresh(member.phone, member.name);
          }
          state.members = walk.seen.size;
        } catch (error) {
          signal.throwIfAborted();
          summary.complete = false;
          summary.error ??= `部门遍历失败：${error instanceof Error ? error.message : String(error)}`;
        }
        state.departments++;
      }));
      level = next;
    }
    if (unidentified) {
      summary.complete = false;
      summary.error ??= `通讯录有 ${unidentified} 名成员未返回手机号，本轮不撤销缺席成员`;
    }
    summary.departments = visited.size;
    summary.members = walk.seen.size;
    summary.conflicts += walk.conflicted.size;
  }

  /** 按手机号查平台 ID；没查成的记进 directory_failures。transient：不是平台对这个号码的明确答复。 */
  async #resolve(round: Round, phone: string): Promise<Resolved> {
    const { state, summary, client, pacer, signal } = round, db = this.#db;
    try {
      const detail = await pacer.run(() => client.detailByPhone(phone, signal));
      db.query("DELETE FROM directory_failures WHERE phone = ?").run(phone);
      return { imUserId: detail.imUserId };
    } catch (error) {
      signal.throwIfAborted();
      summary.failures++;
      db.query(`INSERT INTO directory_failures (phone, attempts, error, at) VALUES (?, 1, ?, ?)
        ON CONFLICT (phone) DO UPDATE SET attempts = attempts + 1, error = excluded.error, at = excluded.at`)
        .run(phone, error instanceof Error ? error.message : String(error), this.#now());
      return { transient: !memberRefusal(error) };
    } finally { state.resolved++; }
  }

  /** 遍历中开始的解析：遍历中止时随之中止，由遍历的错误代表这一轮，不留未处理的拒绝。 */
  #background(round: Round, work: Promise<void>): void {
    work.catch(() => undefined);
    round.resolving.push(work);
  }

  #rows(): Map<string, Row> {
    const rows = this.#db.query("SELECT phone, im_user_id AS imUserId, name, last_verified_at AS verifiedAt FROM member_directory").all() as Row[];
    return new Map(rows.map(row => [row.phone, row]));
  }

  #recordEffective(scope: DirectoryScope, since: number): void {
    this.#db.query("INSERT INTO directory_effective (singleton, scope, since) VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET scope = excluded.scope, since = excluded.since")
      .run(scopeRecord(scope), since);
  }

  /** 一轮结束后的自动跟进：没成（或有新号码没查成）按退避重试；成了而有待复核的成员时，到复核时间再完整同步一轮。 */
  #followUpAfter(retry: boolean, client: DirectoryClient, signal: AbortSignal): void {
    if (retry) {
      const delay = this.#retryDelays[Math.min(this.#retries, this.#retryDelays.length - 1)]!;
      this.#retries++;
      this.#schedule("retry", delay, client, signal);
      return;
    }
    this.#retries = 0;
    if (this.#suspect) this.#schedule("recheck", Math.max(0, this.#suspect.at + this.#recheckDelay - this.#now()), client, signal);
  }

  #schedule(kind: FollowUp["kind"], delay: number, client: DirectoryClient, signal: AbortSignal): void {
    this.#cancelFollowUp();
    const timer = setTimeout(() => {
      this.#followUp = undefined;
      if (!signal.aborted) this.#start(kind, client, signal);
    }, delay);
    timer.unref();
    this.#followUp = { kind, at: this.#now() + delay, timer };
  }

  #cancelFollowUp(): void {
    if (this.#followUp) clearTimeout(this.#followUp.timer);
    this.#followUp = undefined;
  }

  /**
   * 在一个事务里让手机号指向 imUserId。ID 已属于另一个手机号时，只有 `replaceable(旧号码)`（本轮完整目录确认旧号码已不在）
   * 才把映射移给新号码；否则不合并，记冲突。
   */
  #assign(phone: string, imUserId: string, name: string, replaceable: (owner: string) => boolean): "added" | "replaced" | "conflict" {
    const db = this.#db;
    return db.transaction(() => {
      const owner = (db.query("SELECT phone FROM member_directory WHERE im_user_id = ?").get(imUserId) as { phone: string } | null)?.phone;
      if (owner !== undefined && owner !== phone) {
        if (!replaceable(owner)) return "conflict" as const;
        db.query("DELETE FROM member_directory WHERE phone = ?").run(owner);
      }
      const existed = db.query("SELECT 1 FROM member_directory WHERE phone = ?").get(phone) !== null;
      db.query(`INSERT INTO member_directory (phone, im_user_id, name, last_verified_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (phone) DO UPDATE SET im_user_id = excluded.im_user_id, name = excluded.name, last_verified_at = excluded.last_verified_at`)
        .run(phone, imUserId, name, this.#now());
      return owner !== undefined || existed ? "replaced" as const : "added" as const;
    })();
  }
}
