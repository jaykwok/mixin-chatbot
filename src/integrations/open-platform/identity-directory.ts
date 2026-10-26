// 通讯录映射（方案 5.8）：事件 userId（imUserId）→ 手机号与姓名。
// 消息路径只同步读本地表，不调外部接口。表由目录扫描维护：
//   1. 从根部门（或管理员选定的范围部门）完整分页遍历子部门和成员，得到「手机号 → 姓名」；同一手机号姓名互相矛盾记为冲突；
//   2. 表里没有的手机号在遍历中一出现就调 detailByPhone 建立映射（ID 已属于别的号码的那些等遍历完再定）；遍历结束后发现
//      冲突的新号码撤回；另每次扫描复核约 1/30 的已有映射；
//   3. 遍历完整、验签解密全部成功、每页的列表和总页数都合法（directory.ts 的 pageOf）、每名成员都有手机号且没有冲突时，
//      才撤销本次缺席的手机号；撤销数超过有效映射 10% 且多于 20 条时保存候选并告警，等管理员按这一轮确认（入口在运维工具）。
// 只保存当前有效映射；被撤销或替换的旧 ID 不保留，再次出现时重新解析。表绑定当前应用和环境，换了就拒绝启动。
// 映射表是通讯录副本，与凭据同等敏感：日志只写计数，不写手机号、姓名和 ID。
import type { Database, Statement } from "bun:sqlite";
import { AsyncSemaphore } from "../../core/async-semaphore.ts";
import { log } from "../../core/log.ts";
import { type DirectoryClient, type Page, ROOT_DEPARTMENT } from "./directory.ts";

export interface DirectoryIdentity {
  readonly phone: string;
  readonly imUserId: string;
  readonly name: string;
}

export type ScanTrigger = "initial" | "daily" | "unknown" | "confirm" | "scope";

export interface ScanSummary {
  readonly id: number;
  readonly trigger: ScanTrigger;
  readonly startedAt: number;
  finishedAt?: number;
  /** 全部分页、验签和解密都成功。 */
  complete: boolean;
  departments: number;
  members: number;
  added: number;
  renamed: number;
  replaced: number;
  reverified: number;
  revoked: number;
  /** 超过阈值暂停撤销、等待确认的条数。 */
  pendingRevocations: number;
  conflicts: number;
  failures: number;
  error?: string;
}

export interface DirectoryStatus {
  readonly mappings: number;
  readonly lastScan?: ScanSummary;
  readonly lastCompleteAt?: number;
  readonly running?: { readonly trigger: ScanTrigger; readonly startedAt: number; readonly phase: string; readonly departments: number; readonly members: number; readonly resolved: number };
  readonly pending?: { readonly scanId: number; readonly count: number };
  /** 管理员选定的范围部门；没有时同步整个通讯录。 */
  readonly scope?: readonly string[];
}

export interface DirectoryOptions {
  /** 所有通讯录请求的总速率上限（次/秒）。 */
  readonly perSecond?: number;
  readonly concurrency?: number;
  /** 未知 ID 触发扫描的冷却时间。 */
  readonly unknownCooldownMs?: number;
  /** 只同步这些部门及其子部门（data/config/directory.json）；缺省为整个通讯录。 */
  readonly scope?: readonly string[];
  readonly now?: () => number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS member_directory (
  phone TEXT PRIMARY KEY, im_user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_verified_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_binding (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), app TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  complete INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS directory_pending_revocations (scan_id INTEGER NOT NULL, phone TEXT NOT NULL, PRIMARY KEY (scan_id, phone)) STRICT;
CREATE TABLE IF NOT EXISTS directory_failures (phone TEXT PRIMARY KEY, attempts INTEGER NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
`;
const KEEP_SCANS = 50;
const REVOKE_RATIO = 0.1;
const REVOKE_MIN = 20;
const REVERIFY_SHARE = 30;

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

type Row = { phone: string; imUserId: string; name: string; verifiedAt: number };
type Running = { trigger: ScanTrigger; startedAt: number; phase: string; departments: number; members: number; resolved: number;
  controller: AbortController; done: Promise<ScanSummary> };

const SCOPE_CHANGED = "通讯录范围已变更，已重新开始同步";

export class IdentityDirectory {
  readonly #db: Database;
  readonly #lookup: Statement<DirectoryIdentity, [string]>;
  readonly #perSecond: number;
  readonly #concurrency: number;
  readonly #cooldown: number;
  readonly #now: () => number;
  #running: Running | undefined;
  #scope: readonly string[] | undefined;
  #lastUnknownScan = -Infinity;

  constructor(db: Database, binding: string, options: DirectoryOptions = {}) {
    this.#db = db;
    // 平台未公布限流；2026-10-24 实测部门列表与 detailByPhone 到 80 次/秒都没有 429（p95 < 90 ms），按用户决定取 80。
    // 80 次/秒约需 7 个并发，并发留余量，让限速器而不是并发决定速度。
    this.#perSecond = options.perSecond ?? 80;
    this.#concurrency = options.concurrency ?? 12;
    this.#scope = options.scope;
    this.#cooldown = options.unknownCooldownMs ?? 30 * 60_000;
    this.#now = options.now ?? Date.now;
    db.exec(SCHEMA);
    db.transaction(() => {
      const current = (db.query("SELECT app FROM directory_binding WHERE singleton = 1").get() as { app: string } | null)?.app;
      if (current === binding) return;
      // 整个数据目录绑定一个应用（部署记录在启动前已核对）；这里再拒绝一次，不清空通讯录后沿用另一个应用的会话。
      if (current !== undefined) throw new Error("通讯录属于另一个应用或平台环境，拒绝启动；如需改用另一个应用，请在新目录全新部署");
      db.query("INSERT INTO directory_binding (singleton, app) VALUES (1, ?)").run(binding);
    })();
    this.#lookup = db.query("SELECT phone, im_user_id AS imUserId, name FROM member_directory WHERE im_user_id = ?");
  }

  /** 同步查询：事件 userId 当前对应的成员；没有有效映射时为 undefined。 */
  lookup(imUserId: string): DirectoryIdentity | undefined {
    return this.#lookup.get(imUserId) ?? undefined;
  }

  get mappings(): number {
    return (this.#db.query("SELECT count(*) AS n FROM member_directory").get() as { n: number }).n;
  }

  /** 只同步管理员选定的部门。 */
  get scoped(): boolean { return this.#scope !== undefined; }

  /** 还没有完成过一次完整扫描（首次同步进行中或失败）。 */
  get initializing(): boolean {
    return this.#db.query("SELECT 1 FROM directory_scans WHERE complete = 1 LIMIT 1").get() === null;
  }

  status(): DirectoryStatus {
    const last = this.#db.query("SELECT summary FROM directory_scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { summary: string } | null;
    const complete = this.#db.query("SELECT finished_at AS at FROM directory_scans WHERE complete = 1 ORDER BY id DESC LIMIT 1").get() as { at: number } | null;
    const pending = this.#db.query("SELECT scan_id AS scanId, count(*) AS count FROM directory_pending_revocations GROUP BY scan_id ORDER BY scan_id DESC LIMIT 1").get() as { scanId: number; count: number } | null;
    const running = this.#running;
    return {
      mappings: this.mappings,
      ...(last ? { lastScan: JSON.parse(last.summary) as ScanSummary } : {}),
      ...(complete ? { lastCompleteAt: complete.at } : {}),
      ...(running ? { running: { trigger: running.trigger, startedAt: running.startedAt, phase: running.phase, departments: running.departments, members: running.members, resolved: running.resolved } } : {}),
      ...(pending ? { pending } : {}),
      ...(this.#scope ? { scope: this.#scope } : {}),
    };
  }

  /**
   * 未知或已失效的 userId：触发一次扫描（同一时间只跑一个；未知触发有冷却）。返回是否新开始了扫描。
   */
  requestScan(client: DirectoryClient, signal: AbortSignal): boolean {
    if (this.#running || this.#now() - this.#lastUnknownScan < this.#cooldown) return false;
    this.#lastUnknownScan = this.#now();
    void this.scan("unknown", client, signal).catch(error => log.error(`通讯录同步失败：${String(error)}`));
    return true;
  }

  /**
   * 管理员确认暂停的大批撤销：`scanId` 必须是最近一次暂停的那一轮（确认绑定到看过的名单）。重新完整扫描一次，
   * 缺席成员全部在确认名单内才撤销；名单之外又有人缺席时再次暂停。
   */
  confirmRevocations(scanId: number, client: DirectoryClient, signal: AbortSignal): "started" | "stale" | "busy" {
    if (this.status().pending?.scanId !== scanId) return "stale";
    if (this.#running) return "busy";
    void this.scan("confirm", client, signal, scanId).catch(error => { if (!signal.aborted) log.error(`通讯录同步失败：${String(error)}`); });
    return "started";
  }

  /**
   * 换范围（`undefined` 为整个通讯录）并立即按新范围重新扫描：正在进行的扫描中止（记为不完整，不撤销任何人）。
   * 范围文件由调用方先写好。缩小范围后，范围外成员按缺席处理，超过撤销阈值时同样等管理员确认。
   */
  async changeScope(scope: readonly string[] | undefined, client: DirectoryClient, signal: AbortSignal): Promise<void> {
    this.#scope = scope;
    const running = this.#running;
    if (running) {
      running.controller.abort(new Error(SCOPE_CHANGED));
      await running.done.catch(() => undefined);
    }
    // 同时到达的另一次更换已按最新范围开始扫描。
    if (this.#running || signal.aborted) return;
    void this.scan("scope", client, signal).catch(error => { if (!signal.aborted) log.error(`通讯录同步失败：${String(error)}`); });
  }

  /** 运行一次扫描；已有扫描在跑时返回那一次的结果。`confirm` 携带管理员确认的那一轮的 ID。 */
  scan(trigger: ScanTrigger, client: DirectoryClient, signal: AbortSignal, confirmed?: number): Promise<ScanSummary> {
    if (this.#running) return this.#running.done;
    const startedAt = this.#now();
    const state: Running = { trigger, startedAt, phase: "遍历部门", departments: 0, members: 0, resolved: 0,
      controller: new AbortController(), done: undefined as unknown as Promise<ScanSummary> };
    this.#running = state;
    state.done = this.#scan(state, client, signal, confirmed).finally(() => { if (this.#running === state) this.#running = undefined; });
    return state.done;
  }

  async #scan(state: Running, client: DirectoryClient, service: AbortSignal, confirmed?: number): Promise<ScanSummary> {
    const signal = AbortSignal.any([service, state.controller.signal]);
    const db = this.#db;
    const id = Number(db.query("INSERT INTO directory_scans (trigger, started_at, summary) VALUES (?, ?, '{}')").run(state.trigger, state.startedAt).lastInsertRowid);
    const summary: ScanSummary = { id, trigger: state.trigger, startedAt: state.startedAt, complete: true, departments: 0, members: 0, added: 0, renamed: 0,
      replaced: 0, reverified: 0, revoked: 0, pendingRevocations: 0, conflicts: 0, failures: 0 };
    const pacer = new Pacer(this.#perSecond, this.#concurrency, signal);
    log.info(`通讯录同步开始（${state.trigger}）`);
    const resolving: Promise<void>[] = [];
    try {
      const rows = new Map((db.query("SELECT phone, im_user_id AS imUserId, name, last_verified_at AS verifiedAt FROM member_directory").all() as Row[]).map(row => [row.phone, row]));
      const resolve = async (phone: string): Promise<string | undefined> => {
        try {
          const detail = await pacer.run(() => client.detailByPhone(phone, signal));
          db.query("DELETE FROM directory_failures WHERE phone = ?").run(phone);
          return detail.imUserId;
        } catch (error) {
          signal.throwIfAborted();
          summary.failures++;
          db.query(`INSERT INTO directory_failures (phone, attempts, error, at) VALUES (?, 1, ?, ?)
            ON CONFLICT (phone) DO UPDATE SET attempts = attempts + 1, error = excluded.error, at = excluded.at`)
            .run(phone, error instanceof Error ? error.message : String(error), this.#now());
          return undefined;
        } finally { state.resolved++; }
      };
      // 1. 完整遍历范围内的部门。新号码一出现就解析，成员不必等整个通讯录走完；ID 已属于另一个号码时，
      //    要看完整目录里旧号码还在不在，留到遍历之后。
      const seen = new Map<string, string>();
      const conflicted = new Set<string>();
      const early = new Set<string>();
      const deferred: [string, string, string][] = [];
      const resolveFresh = (phone: string, name: string) => {
        const work = (async () => {
          const imUserId = await resolve(phone);
          if (imUserId === undefined || conflicted.has(phone)) return;
          let owned = false;
          this.#assign(phone, imUserId, name, () => { owned = true; return false; });
          if (owned) deferred.push([phone, imUserId, name]);
          else { summary.added++; early.add(phone); }
        })();
        // 遍历中止时这些解析随之中止，由遍历的错误代表这一轮；不留未处理的拒绝。
        work.catch(() => undefined);
        resolving.push(work);
      };
      const visited = new Set<string>(this.#scope ?? [ROOT_DEPARTMENT]);
      let level = [...visited];
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
            for (const child of children) if (!visited.has(child)) { visited.add(child); next.push(child); }
            for (const member of members) {
              const known = seen.get(member.phone);
              if (known !== undefined && known !== member.name) conflicted.add(member.phone);
              seen.set(member.phone, member.name);
              if (known === undefined && !rows.has(member.phone)) resolveFresh(member.phone, member.name);
            }
            state.members = seen.size;
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
      summary.members = seen.size;
      summary.conflicts += conflicted.size;

      // 2. 等新号码解析完；遍历中建立、后来发现姓名冲突的映射撤回；ID 归属待定的按完整目录决定；更新已有成员的姓名。
      state.phase = "解析新成员";
      await Promise.all(resolving);
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

      // 3. 复核约 1/30 的已有映射（最久未复核的先），ID 变化时原子替换。
      state.phase = "复核已有映射";
      const due = [...rows.values()].filter(row => seen.has(row.phone) && !conflicted.has(row.phone))
        .sort((a, b) => a.verifiedAt - b.verifiedAt).slice(0, Math.ceil(rows.size / REVERIFY_SHARE));
      await Promise.all(due.map(async row => {
        const imUserId = await resolve(row.phone);
        if (imUserId === undefined) return;
        summary.reverified++;
        if (imUserId === row.imUserId) {
          db.query("UPDATE member_directory SET last_verified_at = ? WHERE phone = ?").run(this.#now(), row.phone);
          return;
        }
        const outcome = this.#assign(row.phone, imUserId, seen.get(row.phone) ?? row.name, owner => summary.complete && !seen.has(owner));
        if (outcome !== "conflict") { summary.replaced++; return; }
        // The old ID is known to be stale; the new one belongs to another present member. Fail closed for this phone.
        db.query("DELETE FROM member_directory WHERE phone = ? AND im_user_id = ?").run(row.phone, row.imUserId);
        summary.conflicts++;
      }));

      // 4. 对账：只有完整且无冲突的一轮才撤销缺席的手机号。
      state.phase = "对账";
      if (!summary.complete || summary.conflicts > 0) {
        if (summary.conflicts > 0) log.warn(`通讯录有 ${summary.conflicts} 处身份冲突，本轮不撤销缺席成员`);
      } else {
        const absent = (db.query("SELECT phone FROM member_directory").all() as { phone: string }[]).map(row => row.phone).filter(phone => !seen.has(phone));
        const total = this.mappings;
        const approved = confirmed === undefined ? undefined
          : new Set((db.query("SELECT phone FROM directory_pending_revocations WHERE scan_id = ?").all(confirmed) as { phone: string }[]).map(row => row.phone));
        const blocked = absent.length > total * REVOKE_RATIO && absent.length > REVOKE_MIN && !(approved && absent.every(phone => approved.has(phone)));
        db.transaction(() => {
          db.exec("DELETE FROM directory_pending_revocations");
          if (blocked) {
            const insert = db.query("INSERT INTO directory_pending_revocations (scan_id, phone) VALUES (?, ?)");
            for (const phone of absent) insert.run(id, phone);
            summary.pendingRevocations = absent.length;
          } else {
            const remove = db.query("DELETE FROM member_directory WHERE phone = ?");
            for (const phone of absent) remove.run(phone);
            summary.revoked = absent.length;
          }
        })();
        if (blocked) log.warn(`通讯录同步：${absent.length} 个成员（有效映射 ${total} 个）本轮缺席，超过撤销阈值，已暂停撤销，等待管理员确认`);
      }
    } catch (error) {
      summary.complete = false;
      // 已拿到结果的解析会在中止后写完映射；等它们结束，这一轮才算结束。
      await Promise.allSettled(resolving);
      // 换范围中止的一轮不算失败：新一轮随即开始。
      if (!state.controller.signal.aborted || service.aborted) {
        summary.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      summary.error = SCOPE_CHANGED;
    } finally {
      summary.finishedAt = this.#now();
      db.query("UPDATE directory_scans SET finished_at = ?, complete = ?, summary = ? WHERE id = ?")
        .run(summary.finishedAt, summary.complete && summary.conflicts === 0 ? 1 : 0, JSON.stringify(summary), id);
      db.query("DELETE FROM directory_scans WHERE id <= ? AND id NOT IN (SELECT id FROM directory_scans WHERE complete = 1 ORDER BY id DESC LIMIT 1)").run(id - KEEP_SCANS);
      log.info(`通讯录同步结束（${state.trigger}）：${summary.complete ? "完整" : "不完整"}，部门 ${summary.departments}，成员 ${summary.members}，` +
        `新增 ${summary.added}，替换 ${summary.replaced}，复核 ${summary.reverified}，撤销 ${summary.revoked}，待确认 ${summary.pendingRevocations}，` +
        `冲突 ${summary.conflicts}，解析失败 ${summary.failures}，有效映射 ${this.mappings}${summary.error ? `；${summary.error}` : ""}`);
    }
    return summary;
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
