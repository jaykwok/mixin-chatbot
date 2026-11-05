// Exports, generated on demand and streamed straight into the browser's download: page by page from the bot's read
// channel (never its SQL queue), with nothing written on this host. The page asks for a ticket with an API request
// (checked and audited), then lets the browser fetch `/download/<ticket>` as a plain download, so the file goes to disk
// through the browser instead of filling the page's memory. A ticket is random, used once, valid for a minute and only
// for the login that asked for it; the outcome (sent, interrupted, failed) is audited and kept for the page to poll.
import type {
  EntryPage, EntryView, ExportFormat, ExportState, ExportStatus, ExportTicket, IdentityMode, NamesStatus, RequestView,
} from "../../../ui/console/src/contract.ts";
import { READ_LIMITS } from "../../../src/durable/read/protocol.ts";
import { maskUser } from "../shared/format.ts";
import { renderReport } from "../shared/report.ts";
import { collectAll, collectComparisons } from "../stats-admin.ts";
import { describeStatsWindow, STATS_NOTE } from "../stats-summary.ts";
import type { AuditLog } from "./audit.ts";
import type { BotReader } from "./bot.ts";
import { groupTitles, type GroupTitles } from "./group-titles.ts";
import {
  attachment, csvRow, jsonWriter, localTime, markdownWriter, personalMark, safeFileName, stampOf, timezoneName, utcOffset,
  type ConversationHeader, type ExportIdentity,
} from "./export-format.ts";
import { SECURITY_HEADERS } from "./guard.ts";
import { IDENTITY_SCOPE_NOTE, identityOf, lookupNames, MemberCodes, opaqueKey, type NameInfo } from "./identity.ts";
import { ApiProblem, input, problemOf, type Route } from "./routes.ts";
import { parseDay, parseStatsQuery, statsMember, statsTitle, type StatsQuery } from "./stats.ts";
import { cleanFor, cleanRequests, membersInOrder, parseMode, record, type Views } from "./views.ts";

/** A ticket not used within this time is void. */
const TICKET_MS = 60_000;
/** No export runs longer than this, however fast the browser reads. */
export const EXPORT_LIMIT_MS = 30 * 60_000;
/** Pause between two bot reads of one export, so an export never takes the read channel back to back. */
const PAGE_GAP_MS = 20;
/** Exports waiting for their download or running, across all logins. */
export const MAX_ACTIVE_EXPORTS = 2;
/** Finished exports stay pollable this long. */
const KEEP_FINISHED_MS = 10 * 60_000;
const TEXT_CHUNK = 64 * 1024;
const CSV_ROWS_PER_CHUNK = 500;

/** The export was stopped from outside: the browser went away, the login ended, the console exits, the time limit. */
class ExportStopped extends Error { override name = "ExportStopped"; }

interface Job {
  id: string; session: string; createdAt: number; expiresAt: number;
  mode: IdentityMode; format: ExportFormat; scope: string;
  filename: string; fallback: string; contentType: string;
  state: ExportState; rows: number; bytes: number; error?: string; finishedAt?: number;
  /** The producer wrote everything, including the completion mark. */
  complete: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  /** Rewrites member numbers in a failure for the audit, which never holds a complete number. */
  auditClean: (text: string) => string;
  produce(job: Job, signal: AbortSignal): AsyncGenerator<string>;
}

type Spec = Pick<Job, "format" | "scope" | "filename" | "fallback" | "contentType" | "auditClean" | "produce">;

export interface ExportDeps {
  bot: BotReader; audit: AuditLog; views: Views;
  /** The data directory: the statistics ledger is read from it. */
  root: string;
  now?: () => number;
  gapMs?: number;
  limitMs?: number;
  ticketMs?: number;
}

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

/** A member's export identity: this export's number plus what the mode allows. */
function exportIdentity(mode: IdentityMode, user: string, name: NameInfo | undefined, code: string): ExportIdentity {
  const { key: _key, ...shown } = identityOf(mode, "", user, name, code);
  return { number: code, ...shown };
}

/** Text in pieces of about `size` UTF-16 units, never splitting a surrogate pair. */
function* pieces(text: string, size = TEXT_CHUNK): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(start, end);
    start = end;
  }
}

/** What a statistics export says about the names it shows. */
function namesNote(mode: IdentityMode, status: NamesStatus | undefined): string {
  if (mode === "anonymous") return "成员只用本文件内的编号表示；编号每次导出重新随机分配，与号码无关。";
  const numbers = mode === "full" ? "含完整号码，注意分发范围。" : "号码已打码（保留前三后四）。";
  const read = status?.observedAt === undefined ? "" : `（读取于 ${localTime(status.observedAt)}）`;
  switch (status?.state) {
    case "offline": return `机器人未运行，姓名不可用，成员只显示号码。${numbers}`;
    case "failed": return `姓名查询失败或暂不可用，成员只显示号码。${numbers}`;
    case "partial": return `部分成员的姓名查询失败，这些成员只显示号码；其余为导出时通讯录缓存中的姓名${read}。${numbers}`;
    default: return `姓名为导出时通讯录缓存中的姓名${read}，不代表提问时的名字；未找到的成员只显示号码。${numbers}`;
  }
}

const NAME_STATE_TEXT: Record<string, string> = { named: "有姓名" };

export class Exports {
  readonly #jobs = new Map<string, Job>();
  readonly #deps: Required<ExportDeps>;

  constructor(deps: ExportDeps) {
    this.#deps = { now: Date.now, gapMs: PAGE_GAP_MS, limitMs: EXPORT_LIMIT_MS, ticketMs: TICKET_MS, ...deps };
  }

  routes(): Record<string, Route> {
    return {
      "POST /api/exports": {
        run: async ({ session, body, signal }) => {
          // A statistics file is named by the group's registered name (from the bot, when it runs).
          const titles = record(body).type === "stats" ? await groupTitles(this.#deps.bot, signal) : undefined;
          return this.#create(session.label, record(body), titles);
        },
      },
      "POST /api/exports/status": { run: async ({ session, body }) => this.status(session.label, record(body).id) },
    };
  }

  // ─── Tickets ──────────────────────────────────────────────────────────────

  #create(session: string, body: Record<string, unknown>, titles?: GroupTitles): ExportTicket {
    const mode = parseMode(body.mode, body.confirm);
    this.#prune();
    const active = [...this.#jobs.values()].filter(job => job.state === "ready" || job.state === "running").length;
    if (active >= MAX_ACTIVE_EXPORTS) throw new ApiProblem(429, "busy", `已有 ${MAX_ACTIVE_EXPORTS} 个导出在进行，请等其中一个结束后再导出`);
    const spec = body.type === "conversation" ? this.#conversation(session, body, mode)
      : body.type === "stats" ? this.#stats(session, body, mode, titles)
      : input("导出类型应为 conversation 或 stats");
    const now = this.#deps.now();
    const job: Job = { ...spec, id: opaqueKey(), session, createdAt: now, expiresAt: now + this.#deps.ticketMs, mode, state: "ready", rows: 0, bytes: 0,
      complete: false, controller: new AbortController() };
    try {
      if (mode === "full") this.#deps.audit.write({ action: "identity-full", session, scope: job.scope, mode, export: job.id });
      this.#deps.audit.write({ action: "export-request", session, scope: job.scope, mode, export: job.id, format: job.format });
    } catch (error) { throw problemOf(error); }
    this.#jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      if (job.state !== "ready") return;
      job.state = "expired";
      this.#record(job, "export-interrupted", "下载链接到期未使用，已作废");
    }, this.#deps.ticketMs);
    job.timer.unref?.();
    return { id: job.id, url: `/download/${job.id}`, filename: job.filename, expiresAt: job.expiresAt };
  }

  status(session: string, id: unknown): ExportStatus {
    this.#prune();
    const job = typeof id === "string" ? this.#jobs.get(id) : undefined;
    if (!job || job.session !== session) throw new ApiProblem(404, "not-found", "没有这个导出，或它已结束较久");
    return { id: job.id, state: job.state, filename: job.filename, rows: job.rows, bytes: job.bytes, ...(job.error ? { error: job.error } : {}) };
  }

  #conversation(session: string, body: Record<string, unknown>, mode: IdentityMode): Spec {
    const view = this.#deps.views.get(session, body.view, "space");
    const format = body.format === "json" || body.format === "markdown" ? body.format : input("会话导出格式应为 json 或 markdown");
    const since = parseDay(body.since, false) ?? null, until = parseDay(body.until, true) ?? null;
    if (since !== null && until !== null && since > until) input("起始日期晚于结束日期");
    const one = body.member === null || body.member === undefined ? null
      : (typeof body.member === "string" ? view.members.get(body.member) : undefined) ?? input("这个视图里没有该成员");
    // Numbers in this export only: drawn afresh for every export, whatever the view showed.
    const codes = new MemberCodes();
    const plan: ConversationPlan = {
      space: view.space, generation: view.generation, title: view.title, truncated: one === null && view.truncated,
      scope: one === null ? "space" : "member", since, until,
      members: (one ? [one] : membersInOrder(view)).map(member => ({ phone: member.phone, conversation: member.conversation, createdAt: member.createdAt, code: codes.next() })),
    };
    const first = plan.members[0];
    const who = one === null ? `全部 ${plan.members.length} 位成员` : mode === "anonymous" ? `成员 ${first!.code}` : maskUser(one.phone);
    const stamp = stampOf(this.#deps.now()), extension = format === "json" ? "json" : "md";
    const fileWho = one === null ? "全部成员" : mode === "anonymous" ? `成员${first!.code}` : maskUser(one.phone).replaceAll("*", "x");
    const phones = () => plan.members.map(member => member.phone);
    return {
      format, scope: `${view.space} ${who}`,
      filename: safeFileName(`会话-${plan.title}-${fileWho}-${personalMark(mode).file}-${stamp}.${extension}`),
      fallback: `mixin-conversation-${stamp}.${extension}`,
      contentType: format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      auditClean: cleanFor({ mode: mode === "full" ? "default" : mode, phones }),
      produce: (job, signal) => conversationChunks(job, plan, this.#reader(signal), signal),
    };
  }

  #stats(session: string, body: Record<string, unknown>, mode: IdentityMode, titles?: GroupTitles): Spec {
    const format = body.format === "html" || body.format === "csv" ? body.format : input("统计导出格式应为 html 或 csv");
    const query = parseStatsQuery(body, this.#deps.now());
    if (body.member !== undefined && body.member !== null && body.member !== "") {
      query.user = statsMember(this.#deps.views.get(session, body.view, "stats"), body.member);
    }
    const stamp = stampOf(this.#deps.now());
    // The audit names the group by its segment; the file by its title.
    const one = query.user === undefined ? "" : "-单个成员";
    const scope = (query.group === null ? "全部" : statsTitle(query.group)) + one;
    const title = (query.group === null ? "全部" : titles?.group(query.group) ?? statsTitle(query.group)) + one;
    const users = new Set<string>(query.user === undefined ? [] : [query.user]);
    return {
      format, scope: `stats ${scope} ${describeStatsWindow(query.window)}`,
      filename: safeFileName(`使用统计-${title}-${personalMark(mode).file}-${stamp}.${format}`),
      fallback: `mixin-stats-${stamp}.${format}`,
      contentType: format === "html" ? "text/html; charset=utf-8" : "text/csv; charset=utf-8",
      auditClean: cleanFor({ mode: mode === "full" ? "default" : mode, phones: () => users }),
      produce: (job, signal) => statsChunks(job, query, users, { ...this.#reader(signal), root: this.#deps.root }, signal),
    };
  }

  #reader(signal: AbortSignal): Reader {
    return {
      bot: this.#deps.bot, now: this.#deps.now,
      gap: async () => { await Bun.sleep(this.#deps.gapMs); signal.throwIfAborted(); },
    };
  }

  // ─── Downloads ────────────────────────────────────────────────────────────

  /** The download of a ticket: a stream that reads one more page only when the browser has taken the last one. */
  download(ticket: string, context: { session: { label: string }; signal: AbortSignal }): Response {
    this.#prune();
    const job = this.#jobs.get(ticket);
    if (!job || job.session !== context.session.label) return plain(404, "导出链接无效或已过期，请在控制台重新导出。");
    if (job.state === "expired") return plain(410, "导出链接已过期，请在控制台重新导出。");
    if (job.state !== "ready") return plain(410, "导出链接只能使用一次，请在控制台重新导出。");
    job.state = "running";
    clearTimeout(job.timer);
    const stop = (reason: string) => { if (!job.controller.signal.aborted) job.controller.abort(new ExportStopped(reason)); };
    context.signal.addEventListener("abort", () => stop("浏览器断开了下载"), { once: true });
    job.timer = setTimeout(() => stop(`导出超过 ${Math.round(this.#deps.limitMs / 60_000)} 分钟上限`), this.#deps.limitMs);
    job.timer.unref?.();

    const chunks = job.produce(job, job.controller.signal);
    const encoder = new TextEncoder();
    const settle = () => {
      if (job.complete) this.#finish(job, "sent");
      else if (job.controller.signal.aborted) this.#finish(job, "interrupted", job.error ?? (job.controller.signal.reason as Error).message);
      else this.#finish(job, "failed", job.error ?? "导出未完成");
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        for (;;) {
          let next: IteratorResult<string>;
          try { next = await chunks.next(); }
          catch (error) {
            // Statistics fail before their first byte: the browser shows a failed download rather than a partial file.
            job.error ??= this.#failure(error, job.controller.signal);
            settle();
            try { controller.error(new Error(job.error)); } catch {}
            return;
          }
          if (next.done) {
            settle();
            try { controller.close(); } catch {}
            return;
          }
          if (!next.value) continue;
          const bytes = encoder.encode(next.value);
          job.bytes += bytes.length;
          try { controller.enqueue(bytes); } catch {}
          return;
        }
      },
      cancel: () => {
        stop("浏览器断开了下载");
        this.#finish(job, "interrupted", "浏览器断开了下载");
        void chunks.return(undefined).catch(() => {});
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: 200,
      headers: { ...SECURITY_HEADERS, "Content-Type": job.contentType, "Content-Disposition": attachment(job.filename, job.fallback) },
    });
  }

  #failure(error: unknown, signal: AbortSignal): string {
    if (signal.aborted) return signal.reason instanceof ExportStopped ? signal.reason.message : "导出已停止";
    const problem = problemOf(error);
    if (problem instanceof ApiProblem) return problem.message;
    console.error(`控制台导出出错：${error instanceof Error ? error.message : String(error)}`);
    return "控制台内部错误，详情见运行控制台的终端";
  }

  #finish(job: Job, state: "sent" | "interrupted" | "failed", error?: string): void {
    if (job.finishedAt !== undefined) return;
    job.finishedAt = this.#deps.now();
    job.state = state;
    if (error !== undefined) job.error = error;
    clearTimeout(job.timer);
    this.#record(job, state === "sent" ? "export-sent" : state === "interrupted" ? "export-interrupted" : "export-failed", error);
  }

  #record(job: Job, action: "export-sent" | "export-interrupted" | "export-failed", note?: string): void {
    job.finishedAt ??= this.#deps.now();
    try {
      this.#deps.audit.write({ action, session: job.session, scope: job.scope, mode: job.mode, export: job.id, format: job.format,
        rows: job.rows, bytes: job.bytes, ...(note === undefined ? {} : { note: job.auditClean(note) }) });
    } catch (failure) {
      // The file has already gone out (or never will); the terminal is the only place left to say so.
      console.error(`导出 ${job.id} 的审计记录写入失败：${(failure as Error).message}`);
    }
  }

  /** Stops a login's exports (it ended) and forgets them. */
  end(session: string, reason = "登录已结束"): void {
    for (const job of [...this.#jobs.values()]) {
      if (job.session !== session) continue;
      this.#stop(job, reason);
      this.#jobs.delete(job.id);
    }
  }

  /** Stops every export (the console exits); the audit says so before the port closes. */
  endAll(reason = "控制台已退出"): void {
    for (const job of this.#jobs.values()) this.#stop(job, reason);
    this.#jobs.clear();
  }

  #stop(job: Job, reason: string): void {
    if (job.state === "running") {
      job.controller.abort(new ExportStopped(reason));
      this.#finish(job, "interrupted", reason);
    } else if (job.state === "ready") {
      job.state = "expired";
      clearTimeout(job.timer);
      this.#record(job, "export-interrupted", reason);
    }
  }

  #prune(): void {
    const now = this.#deps.now();
    for (const job of [...this.#jobs.values()]) {
      if (job.finishedAt !== undefined && job.state !== "running" && now - job.finishedAt > KEEP_FINISHED_MS) this.#jobs.delete(job.id);
    }
  }

  /** Exports held now, for tests. */
  get size(): number { return this.#jobs.size; }
}

// ─── Producers ──────────────────────────────────────────────────────────────

interface Reader { bot: BotReader; now: () => number; gap: () => Promise<void> }

interface ConversationPlan {
  space: string; generation: string; title: string; truncated: boolean; scope: "member" | "space";
  since: number | null; until: number | null;
  members: { phone: string; conversation: number; createdAt: number | null; code: string }[];
}

/**
 * A conversation export: fixes each conversation's last entry first, then reads entries up to it in id order, one short
 * read at a time with a pause between reads. Any failure still ends the file, with `complete: false` and the reason.
 */
async function* conversationChunks(job: Job, plan: ConversationPlan, reader: Reader, signal: AbortSignal): AsyncGenerator<string> {
  const { bot, now } = reader;
  const writer = job.format === "json" ? jsonWriter() : markdownWriter();
  const at = { space: plan.space, generation: plan.generation };
  const clean = cleanFor({ mode: job.mode, phones: () => plan.members.map(member => member.phone) });
  const header: ConversationHeader = {
    mode: job.mode, exportedAt: now(), space: plan.space, title: plan.title, generation: plan.generation, scope: plan.scope,
    members: plan.members.length, truncatedMembers: plan.truncated, since: plan.since, until: plan.until, fixedAt: null, names: { state: "skipped" },
  };
  let pending = "", started = false, members = 0, entries = 0;
  try {
    const upper = new Map<number, number | null>();
    for (let start = 0; start < plan.members.length; start += READ_LIMITS.conversations) {
      const result = await bot.read<{ upper: Record<string, number | null>; observedAt: number }>({ op: "bounds", ...at,
        conversations: plan.members.slice(start, start + READ_LIMITS.conversations).map(member => member.conversation) }, signal);
      for (const [id, value] of Object.entries(result.upper)) upper.set(Number(id), value);
      header.fixedAt = result.observedAt;
      await reader.gap();
    }
    let names = new Map<string, NameInfo>();
    if (job.mode !== "anonymous") {
      const looked = await lookupNames(bot, plan.members.map(member => member.phone), signal);
      names = looked.names;
      header.names = looked.status;
    }
    yield writer.header(header);
    started = true;
    for (const member of plan.members) {
      const top = upper.get(member.conversation) ?? null;
      pending = writer.member({ identity: exportIdentity(job.mode, member.phone, names.get(member.phone), member.code), memberSince: member.createdAt, upperEntry: top });
      members++;
      if (top === null) {
        pending += writer.memberEnd(null);
      } else {
        // An entry without its own time (a plain /clear) goes with the entry before it.
        let included = plan.since === null;
        for (let cursor: number | null = null; ;) {
          const page: EntryPage = await bot.read<EntryPage>({ op: "entries", ...at, conversation: member.conversation, older: false, cursor, upper: top,
            limit: READ_LIMITS.entries }, signal);
          for (const item of page.items) {
            if (item.at !== null) included = (plan.since === null || item.at >= plan.since) && (plan.until === null || item.at <= plan.until);
            if (!included) continue;
            let entry: EntryView = item;
            if (item.parts.some(part => "truncated" in part && part.truncated !== undefined)) {
              entry = (await bot.read<{ entry: EntryView | null }>({ op: "entry", ...at, conversation: member.conversation, id: item.id }, signal)).entry ?? item;
            }
            pending += writer.entry(entry);
            entries++;
            job.rows++;
          }
          yield pending;
          pending = "";
          if (page.next === null) break;
          cursor = page.next;
          await reader.gap();
        }
        const records = await bot.read<{ items: RequestView[]; total: number; observedAt: number }>(
          { op: "requests", ...at, conversation: member.conversation, phone: member.phone }, signal);
        pending += writer.memberEnd({ observedAt: records.observedAt, total: records.total, items: cleanRequests(records.items, clean) });
      }
      yield pending;
      pending = "";
      await reader.gap();
    }
    job.complete = true;
    yield writer.end({ complete: true, endedAt: now(), members, entries });
  } catch (error) {
    job.error = signal.aborted ? (signal.reason instanceof ExportStopped ? signal.reason.message : "导出已停止")
      : (() => { const problem = problemOf(error, clean); return problem instanceof ApiProblem ? problem.message : internal(error); })();
    yield (started ? pending : writer.header(header)) + writer.end({ complete: false, endedAt: now(), members, entries, error: job.error });
  }
}

function internal(error: unknown): string {
  console.error(`控制台导出出错：${error instanceof Error ? error.message : String(error)}`);
  return "控制台内部错误，详情见运行控制台的终端";
}

/**
 * A statistics export: the ledger is read on this host (the bot may be stopped), names come from the bot when it runs.
 * Everything is computed before the first byte, so a failure is a failed download, never a partial file.
 */
async function* statsChunks(job: Job, query: StatsQuery, users: Set<string>, reader: Reader & { root: string }, signal: AbortSignal): AsyncGenerator<string> {
  const all = await collectAll(reader.root, query.window, query.user);
  const selected = query.group === null ? all : all.filter(group => group.group === query.group);
  for (const group of selected) for (const row of group.users) users.add(row.user);
  const looked = job.mode === "anonymous" ? undefined : await lookupNames(reader.bot, users, signal);
  const titles = await groupTitles(reader.bot, signal);
  signal.throwIfAborted();
  const codes = new MemberCodes(), identities = new Map<string, ExportIdentity>();
  const identity = (user: string) => {
    let found = identities.get(user);
    if (!found) identities.set(user, found = exportIdentity(job.mode, user, looked?.names.get(user), codes.next()));
    return found;
  };
  const exportedAt = reader.now();
  const mark = personalMark(job.mode);
  const note = (query.user === undefined ? "" : "本次导出仅包含所选成员。") + namesNote(job.mode, looked?.status);

  if (job.format === "html") {
    const comparisons = await collectComparisons(reader.root, query.window, query.user);
    signal.throwIfAborted();
    const html = renderReport({
      groups: selected, detail: query.group === null ? null : selected[0] ?? null, window: query.window,
      identity: { label: user => identity(user).label, note: `${note}${IDENTITY_SCOPE_NOTE}`, banner: mark.banner },
      comparisons, comparisonScope: query.group === null ? undefined : [query.group], groupTitle: titles.group,
    }, exportedAt);
    job.rows = identities.size;
    yield* pieces(html);
    job.complete = true;
    return;
  }

  const named = job.mode !== "anonymous";
  let text = "\uFEFF" + [
    `# 量子密信应用机器人使用统计（按群、按成员）`,
    `# ${mark.banner}`,
    `# 区间：${describeStatsWindow(query.window)}${query.group === null ? "" : `；${titles.group(query.group)}`}`,
    `# 导出时间：${localTime(exportedAt)}（${timezoneName()}，UTC${utcOffset(exportedAt)}）`,
    `# 身份：${note}${IDENTITY_SCOPE_NOTE}`,
    `# 统计口径：${STATS_NOTE}`,
  ].map(line => csvRow([line])).join("") + "\r\n"
    + csvRow(["群", "群名称", "成员编号", ...named ? ["姓名", "号码", "姓名状态"] : [], "提问次数", "活跃天数", "首次提问", "最近提问"]);
  let count = 0;
  for (const group of selected) {
    for (const row of group.users) {
      const id = identity(row.user);
      text += csvRow([group.group, titles.group(group.group), id.number,
        ...named ? [id.name ?? "", id.phone ?? "", NAME_STATE_TEXT[id.nameState ?? ""] ?? id.nameNote ?? ""] : [],
        row.asks, row.days.size, localTime(row.firstAt), localTime(row.lastAt)]);
      job.rows++;
      if (++count % CSV_ROWS_PER_CHUNK === 0) { yield text; text = ""; }
    }
  }
  yield text + csvRow([`# 导出完成：${job.rows} 行`]);
  job.complete = true;
}
