import { dayKey } from "../../src/agent/stats-ledger.ts";
import { byName } from "../lib/group-data.ts";
import type { GroupStats, Window } from "./stats-admin.ts";

export const PERIODS = [
  ["all", "全部"], ["today", "今天"], ["yesterday", "昨天"], ["week", "本周"],
  ["last-week", "上周"], ["month", "本月"], ["last-month", "上月"], ["7d", "近 7 天"], ["30d", "近 30 天"],
] as const;
export type StatsPeriod = typeof PERIODS[number][0];
export type Grain = "day" | "week" | "month";
const start = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d; };
const end = (d: Date) => { const copy = new Date(d); copy.setHours(23, 59, 59, 999); return copy.getTime(); };
const shift = (d: Date, days: number) => { const copy = new Date(d); copy.setDate(copy.getDate() + days); return copy; };
const ordinal = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
const monthShift = (d: Date, months: number) => {
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  target.setDate(Math.min(d.getDate(), new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
  return target;
};

export function periodWindow(period: string, now = Date.now()): Window {
  if (!PERIODS.some(([key]) => key === period)) throw new Error(`未知统计范围：${period}；可选 ${PERIODS.map(([key]) => key).join("、")}`);
  if (period === "all") return {};
  const today = start(now);
  let from = new Date(today), to = new Date(today);
  if (period === "yesterday") from = to = shift(today, -1);
  if (period === "week" || period === "last-week") {
    from = shift(today, -((today.getDay() + 6) % 7));
    if (period === "last-week") { to = shift(from, -1); from = shift(from, -7); }
  }
  if (period === "month") from.setDate(1);
  if (period === "last-month") { from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = new Date(today.getFullYear(), today.getMonth(), 0); }
  if (period === "7d" || period === "30d") from = shift(today, -(period === "7d" ? 6 : 29));
  return { since: from.getTime(), until: end(to), period: period as StatsPeriod };
}

export function describeStatsWindow(window: Window): string {
  if (window.since === undefined && window.until === undefined) return "全部区间";
  return `${window.since === undefined ? "最早" : dayKey(window.since)} ~ ${window.until === undefined ? "至今" : dayKey(window.until)}`;
}

export function comparisonWindows(window: Window): { previous: Window; yearAgo: Window } | null {
  if (window.since === undefined || window.until === undefined) return null;
  const from = start(window.since), to = start(window.until);
  const days = ordinal(to) - ordinal(from) + 1;
  if (days <= 0) throw new Error("统计起始日期晚于结束日期");
  let previousFrom = shift(from, -days), previousTo = shift(from, -1);
  if (window.period === "week" || window.period === "last-week") {
    previousFrom = shift(from, -7); previousTo = shift(to, -7);
  } else if (window.period === "month" || window.period === "last-month") {
    previousFrom = monthShift(from, -1);
    previousTo = window.period === "last-month" ? new Date(from.getFullYear(), from.getMonth(), 0) : monthShift(to, -1);
  }
  // Leap-day boundaries clamp to Feb 28. A full calendar month compares with a full calendar month.
  const yearFrom = monthShift(from, -12);
  const yearTo = window.period === "last-month" ? new Date(yearFrom.getFullYear(), yearFrom.getMonth() + 1, 0) : monthShift(to, -12);
  return {
    previous: { since: previousFrom.getTime(), until: end(previousTo) },
    yearAgo: { since: yearFrom.getTime(), until: end(yearTo) },
  };
}

export interface ComparisonData { previous: { window: Window; groups: GroupStats[] }; yearAgo: { window: Window; groups: GroupStats[] } }
export interface TrendPoint { date: string; asks: number; replies: number; askers: Set<string>; files: number; images: number; cost: number; unknownCost: number; missingUsage: number }

/** Counts identities in the ledger, including a person appearing in several groups only once. */
export function summarize(groups: GroupStats[]) {
  const users = new Map<string, { user: string; asks: number; days: Set<string>; groups: Set<string> }>();
  for (const group of groups) for (const user of group.users) {
    if (!user.asks) continue;
    let entry = users.get(user.user);
    if (!entry) users.set(user.user, entry = { user: user.user, asks: 0, days: new Set(), groups: new Set() });
    entry.asks += user.asks;
    entry.groups.add(group.group);
    for (const day of user.days) entry.days.add(day);
  }
  const ranking = [...users.values()].sort((a, b) => b.asks - a.asks || byName(a.user, b.user));
  const asks = groups.reduce((sum, group) => sum + group.asks, 0);
  return { asks, people: ranking.length, average: ranking.length ? asks / ranking.length : 0, ranking,
    activeDays: new Set(groups.flatMap(group => [...group.days])).size };
}

/** Zero-fill natural days. Open bounds use the first/last recorded day, never inventing earlier history. */
export function trend(groups: GroupStats[], window: Window, grain: Grain = "day"): TrendPoint[] {
  const observed = groups.flatMap(group => [...group.daily.keys(), ...group.usage.days.keys()]).sort();
  const first = window.since === undefined ? observed[0] : dayKey(window.since);
  const last = window.until === undefined ? observed.at(-1) : dayKey(window.until);
  if (!first || !last) return [];
  const dateOf = (key: string) => { const [y, m, d] = key.split("-").map(Number); return new Date(y!, m! - 1, d!); };
  const points = new Map<string, TrendPoint>();
  for (let date = dateOf(first); dayKey(date.getTime()) <= last; date = shift(date, 1)) {
    const day = dayKey(date.getTime());
    const key = grain === "month" ? day.slice(0, 7) : grain === "week" ? dayKey(shift(date, -((date.getDay() + 6) % 7)).getTime()) : day;
    let point = points.get(key);
    if (!point) points.set(key, point = { date: key, asks: 0, replies: 0, askers: new Set(), files: 0, images: 0, cost: 0, unknownCost: 0, missingUsage: 0 });
    for (const group of groups) {
      const daily = group.daily.get(day);
      if (daily) {
        point.asks += daily.asks; point.replies += daily.replies;
        point.files += daily.files; point.images += daily.images;
        for (const user of daily.askers) point.askers.add(user);
      }
      point.cost += group.usage.days.get(day)?.cost ?? 0;
      point.unknownCost += group.usage.days.get(day)?.unknownCost ?? 0;
      point.missingUsage += group.usage.days.get(day)?.missingUsage ?? 0;
    }
  }
  return [...points.values()];
}

export function change(current: number, previous: number): string {
  if (!previous) return current ? "新增（基期无记录）" : "—（两期均无记录）";
  const rate = (current - previous) / previous * 100;
  return `${rate > 0 ? "+" : ""}${rate.toFixed(1)}%`;
}

export function engagement(groups: GroupStats[], window: Window) {
  const summary = summarize(groups), days = trend(groups, window);
  const peak = days.reduce<TrendPoint | null>((best, day) => day.asks > (best?.asks ?? 0) ? day : best, null);
  return { days: days.length, dailyAverage: days.length ? summary.asks / days.length : 0,
    activeRate: days.length ? summary.activeDays / days.length : 0, peak,
    topFiveShare: summary.asks ? summary.ranking.slice(0, 5).reduce((sum, user) => sum + user.asks, 0) / summary.asks : 0 };
}

export function comparisons(data: ComparisonData | null | undefined, groups?: Set<string>) {
  if (!data) return [];
  return ([ ["环比", data.previous], ["同比", data.yearAgo] ] as const).map(([label, period]) => ({
    label, window: period.window, ...summarize(groups ? period.groups.filter(group => groups.has(group.group)) : period.groups),
  }));
}

export const STATS_NOTE = "按账本成员标识跨群去重；覆盖人数指实际提问人数，不代表群总人数。周从周一开始，按服务本地自然日统计；无记录日期补 0，不代表历史采集完整。包含今天的区间尚未结束，对比不按小时对齐；本周、本月与上周、上月已到达的自然日比较，其他自定义区间与前一等长区间比较；同比按去年同日期（闰日截到月末）。全部或单边区间不计算同比环比。";
