// Statistics for the page. The ledger is read on this host, so statistics work with the bot stopped; only names need the
// bot, and members say so when it is not running (the state database is never opened behind its back). A stats view
// fixes the identity mode and gives each ledger identity a random key (and code, in anonymous mode) for as long as the
// page keeps it.
import type {
  Identity, IdentityMode, StatsGrain, StatsPeriodKey, StatsResponse, StatsTokens, ViewInfo,
} from "../../../ui/console/src/contract.ts";
import { addTokens, emptyTokens, type TokenTotals } from "../../../src/agent/stats-ledger.ts";
import { collectAll, collectComparisons, parseDate, type GroupStats, type Window } from "../stats-admin.ts";
import { comparisons, describeStatsWindow, engagement, PERIODS, periodWindow, STATS_NOTE, summarize, TOKEN_NOTE, trend } from "../stats-summary.ts";
import type { AuditLog } from "./audit.ts";
import type { BotReader } from "./bot.ts";
import { groupTitles } from "./group-titles.ts";
import { IDENTITY_SCOPE_NOTE, identityOf, lookupNames, MemberCodes, namesStatus, opaqueKey, type NameInfo } from "./identity.ts";
import { input, problemOf, type Route } from "./routes.ts";
import { cleanFor, parseMode, record, viewInfo, type StatsView, type Views } from "./views.ts";

/** Rows of the cross-group ranking sent to the page; the totals still count everyone. */
export const MAX_RANKING = 1_000;

/** A group as the ledger names it (the page shows the registered name: ./group-titles.ts). */
export const statsTitle = (group: string) => group === "direct" ? "单聊" : `群 ${group}`;

export interface StatsQuery { window: Window; period: StatsPeriodKey; group: string | null; grain: StatsGrain; user?: string }

/** Resolve only a random key already issued by this session's view. Raw numbers and other views' keys are rejected. */
export function statsMember(view: StatsView, member: unknown): string | undefined {
  if (member === undefined || member === null || member === "") return undefined;
  if (typeof member === "string") for (const [user, entry] of view.keys) if (entry.key === member) return user;
  return input("成员筛选无效，请从当前统计名单重新选择");
}

/** A local YYYY-MM-DD day as its first (or, with `end`, last) millisecond; empty means an open end. */
export function parseDay(value: unknown, end: boolean): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return input("日期应为 YYYY-MM-DD");
  try { return parseDate(value, end); } catch (error) { return input((error as Error).message); }
}

/** Filters of a request: a named period or a custom range (either end may be open), an optional group, a trend grain. */
export function parseStatsQuery(body: Record<string, unknown>, now: number): StatsQuery {
  const period = body.period ?? "30d";
  let window: Window;
  if (period === "custom") {
    window = { since: parseDay(body.since, false), until: parseDay(body.until, true) };
    if (window.since !== undefined && window.until !== undefined && window.since > window.until) input("起始日期晚于结束日期");
  } else if (typeof period === "string" && PERIODS.some(([key]) => key === period)) {
    window = periodWindow(period, now);
  } else {
    return input("未知的统计范围");
  }
  const group = body.group === undefined || body.group === null || body.group === "" ? null
    : typeof body.group === "string" && body.group.length <= 200 ? body.group : input("群筛选无效");
  const grain = body.grain ?? "day";
  if (grain !== "day" && grain !== "week" && grain !== "month") input("趋势粒度应为 day、week 或 month");
  return { window, period: period as StatsPeriodKey, group, grain: grain as StatsGrain };
}

const tokens = (value: TokenTotals): StatsTokens => ({ input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, totalTokens: value.totalTokens });

function merged(groups: GroupStats[], pick: (group: GroupStats) => Map<string, TokenTotals>) {
  const all = new Map<string, TokenTotals>();
  for (const group of groups) for (const [key, value] of pick(group)) {
    let into = all.get(key);
    if (!into) all.set(key, into = emptyTokens());
    addTokens(into, value);
  }
  return [...all].sort((a, b) => b[1].totalTokens - a[1].totalTokens || (a[0] < b[0] ? -1 : 1)).map(([key, value]) => ({ key, tokens: tokens(value) }));
}

const finite = (value: number) => Number.isFinite(value) ? value : null;

/**
 * Identities for `users` in this view: keys stay the same for the view's life, names are looked up for whoever has no
 * answer yet (a stopped bot or a failed lookup is asked again next time).
 */
async function identities(view: StatsView, bot: BotReader, users: readonly string[], signal: AbortSignal) {
  const pending = view.mode === "anonymous" ? [] : users.filter(user => {
    const state = view.names.get(user)?.state;
    return state !== "named" && state !== "missing" && state !== "summary";
  });
  const fresh = pending.length ? await lookupNames(bot, pending, signal) : undefined;
  for (const [user, info] of fresh?.names ?? []) if (info.state !== "offline" && info.state !== "failed") view.names.set(user, info);
  const info = (user: string): NameInfo | undefined => view.names.get(user) ?? fresh?.names.get(user);
  const of = (user: string): Identity => {
    let entry = view.keys.get(user);
    if (!entry) view.keys.set(user, entry = view.mode === "anonymous" ? { key: opaqueKey(), code: view.codes.next() } : { key: opaqueKey() });
    return identityOf(view.mode, entry.key, user, info(user), entry.code);
  };
  const names = view.mode === "anonymous" ? { state: "skipped" as const }
    : namesStatus(users.map(user => info(user) ?? { state: "failed" as const }), fresh?.status.note);
  return { of, names };
}

export interface StatsDeps { bot: BotReader; audit: AuditLog; views: Views; root: string; now?: () => number }

export function statsRoutes({ bot, audit, views, root, now = Date.now }: StatsDeps): Record<string, Route> {
  return {
    "POST /api/views/stats": {
      async run({ session, body }) {
        const mode: IdentityMode = parseMode(record(body).mode, record(body).confirm);
        const view: StatsView = { id: opaqueKey(), session: session.label, mode, createdAt: now(), codes: new MemberCodes(), names: new Map(),
          kind: "stats", keys: new Map() };
        try {
          if (mode === "full") audit.write({ action: "identity-full", session: session.label, scope: "stats", mode });
          audit.write({ action: "view-open", session: session.label, scope: "stats", mode });
        } catch (error) { throw problemOf(error); }
        views.add(view);
        return { view: viewInfo(view) } satisfies { view: ViewInfo };
      },
    },

    "POST /api/stats": {
      slow: true,
      async run({ session, body: raw, signal }) {
        const body = record(raw);
        const view = views.get(session.label, body.view, "stats");
        const query = parseStatsQuery(body, now());
        query.user = statsMember(view, body.member);
        try {
          const all = await collectAll(root, query.window, query.user);
          const selected = query.group === null ? all : all.filter(group => group.group === query.group);
          const scope = query.group === null ? undefined : new Set([query.group]);
          const periods = comparisons(await collectComparisons(root, query.window, query.user), scope);
          const summary = summarize(selected), activity = engagement(selected, query.window);
          const ranking = summary.ranking.slice(0, MAX_RANKING);
          const members = query.group === null ? null : selected[0]?.users ?? [];
          const { of, names } = await identities(view, bot, [...new Set([...ranking.map(row => row.user), ...members?.map(row => row.user) ?? [],
            ...query.user === undefined ? [] : [query.user]])], signal);
          const total = emptyTokens();
          for (const group of selected) addTokens(total, group.tokens);
          const titles = await groupTitles(bot, signal);
          return {
            window: { label: describeStatsWindow(query.window), since: query.window.since ?? null, until: query.window.until ?? null, period: query.period },
            group: query.group,
            member: query.user === undefined ? null : of(query.user),
            observedAt: now(),
            names,
            summary: { asks: summary.asks, people: summary.people, average: summary.average, activeDays: summary.activeDays, days: activity.days,
              dailyAverage: activity.dailyAverage, activeRate: activity.activeRate,
              peak: activity.peak && { date: activity.peak.date, asks: activity.peak.asks }, topFiveShare: activity.topFiveShare, tokens: tokens(total) },
            comparisons: periods.map(period => ({ label: period.label, window: describeStatsWindow(period.window), asks: period.asks, people: period.people, average: period.average })),
            trend: trend(selected, query.window, query.grain).map(point => ({ date: point.date, asks: point.asks, people: point.askers.size, tokens: point.tokens.totalTokens })),
            grain: query.grain,
            groups: selected.map(group => ({ group: group.group, title: titles.group(group.group), asks: group.asks, people: summarize([group]).people,
              activeDays: group.days.size, tokens: tokens(group.tokens), firstAt: finite(group.firstAt), lastAt: finite(group.lastAt) })),
            ranking: ranking.map(row => ({ identity: of(row.user), asks: row.asks, activeDays: row.days.size, groups: row.groups.size })),
            members: members && members.map(row => ({ identity: of(row.user), asks: row.asks, activeDays: row.days.size, firstAt: row.firstAt, lastAt: row.lastAt })),
            models: merged(selected, group => group.models),
            tools: merged(selected, group => group.tools),
            notes: { stats: STATS_NOTE, tokens: TOKEN_NOTE, identity: IDENTITY_SCOPE_NOTE },
          } satisfies StatsResponse;
        } catch (error) {
          throw problemOf(error, cleanFor({ mode: view.mode, phones: () => view.keys.keys() }));
        }
      },
    },
  };
}
