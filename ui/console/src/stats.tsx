/** @jsxImportSource preact */
// Statistics: filters in one row, headline numbers, period comparisons, the trend, rankings and per-group tables. The
// ledger is read on the host, so this page works with the bot stopped (names then say so). A stats view fixes the
// identity mode; switching it opens a new view, and leaving the page closes it.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiFailure } from "./api.ts";
import type { IdentityMode, StatsGrain, StatsPeriodKey, StatsResponse, StatsTokens, ViewInfo } from "./contract.ts";
import { BarList, ColumnChart, ColumnTable, type ColumnPoint } from "./charts.tsx";
import { StatsExportDialog } from "./exports.tsx";
import { clock, compact, count, dateTime, percent } from "./format.ts";
import { Icon } from "./icons.tsx";
import { IdentityText, ModeBadge, ModeSwitch, NamesNotice, NamesObserved } from "./identity.tsx";
import { Banner, Card, EmptyState, Segmented } from "./ui.tsx";

const QUICK: [StatsPeriodKey, string][] = [["7d", "近 7 天"], ["30d", "近 30 天"], ["week", "本周"], ["month", "本月"], ["all", "全部"]];
const MORE: [StatsPeriodKey, string][] = [["today", "今天"], ["yesterday", "昨天"], ["last-week", "上周"], ["last-month", "上月"], ["custom", "自定义区间"]];
const RANK_PAGE = 50;

type Metric = "asks" | "people" | "tokens";
interface Filters { period: StatsPeriodKey; since: string; until: string; group: string | null; grain: StatsGrain; member: string | null }

const failureOf = (error: unknown) => error instanceof ApiFailure ? error : new ApiFailure(String(error), 0);
const average = (value: number) => value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, "");

/** A trend bucket as the axis shows it: 10-27, 10-27 起 (weeks), 2026-10 (months). */
function bucketText(key: string, grain: StatsGrain, long: boolean): string {
  if (grain === "month") return long ? `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月` : key;
  const [, month, day] = key.split("-");
  const short = `${month}-${day}`;
  if (!long) return short;
  return grain === "week" ? `${key} 起的一周` : key;
}

function change(current: number, previous: number): { text: string; direction: "up" | "down" | "flat" | "new" } {
  if (!previous) return current ? { text: "新增", direction: "new" } : { text: "—", direction: "flat" };
  const rate = (current - previous) / previous * 100;
  return { text: `${rate > 0 ? "+" : ""}${rate.toFixed(1)}%`, direction: rate > 0 ? "up" : rate < 0 ? "down" : "flat" };
}

function Delta({ current, previous }: { current: number; previous: number }) {
  const { text, direction } = change(current, previous);
  return <span class={`delta ${direction}`}>{direction === "up" ? "↑ " : direction === "down" ? "↓ " : ""}{text}</span>;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="tile">
      <div class="tile-label">{label}</div>
      <div class="tile-value">{value}</div>
      {sub && <div class="tile-sub">{sub}</div>}
    </div>
  );
}

const tokenTitle = (tokens: StatsTokens) =>
  `输入 ${count(tokens.input)} · 输出 ${count(tokens.output)} · 缓存读 ${count(tokens.cacheRead)} · 缓存写 ${count(tokens.cacheWrite)}`;

export function StatsPage() {
  // The mode asked for (each request opens a view); the switch shows the mode of the view actually open.
  const [mode, setMode] = useState<{ mode: IdentityMode; confirm: boolean }>({ mode: "default", confirm: false });
  const [view, setView] = useState<ViewInfo | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [filters, setFilters] = useState<Filters>({ period: "30d", since: "", until: "", group: null, grain: "day", member: null });
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [groups, setGroups] = useState<Map<string, string>>(new Map());
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [metric, setMetric] = useState<Metric>("asks");
  const [table, setTable] = useState(false);
  const [rankAll, setRankAll] = useState(false);
  const [rankPage, setRankPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const current = useRef<string | null>(null);
  const reopened = useRef(false);

  // A view per identity mode; the previous one is closed. Leaving the page closes the last.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setOpenFailed(false);
    api<{ view: ViewInfo }>("/api/views/stats", { method: "POST", body: { mode: mode.mode, confirm: mode.confirm || undefined }, intent: true })
      .then(result => {
        if (!live) { close(result.view.id); return; }
        if (current.current) close(current.current);
        ++sequence.current;
        current.current = result.view.id;
        setData(null); setMembers(new Map()); setFilters(value => ({ ...value, member: null }));
        setView(result.view);
      }, failure => {
        if (!live) return;
        // The view that was open (if any) stays, in its own mode; retrying asks for the new mode again.
        setError(failureOf(failure));
        setOpenFailed(true);
        setLoading(false);
      });
    return () => { live = false; };
  }, [mode]);
  useEffect(() => () => { if (current.current) close(current.current); }, []);

  const custom = filters.period === "custom";
  const rangeError = custom && filters.since && filters.until && filters.since > filters.until ? "起始日期晚于结束日期" : null;

  useEffect(() => {
    if (!view || rangeError) return;
    const id = ++sequence.current;
    setLoading(true);
    api<StatsResponse>("/api/stats", {
      method: "POST", intent: true,
      body: { view: view.id, period: filters.period, group: filters.group, grain: filters.grain,
        ...(filters.member ? { member: filters.member } : {}),
        ...(custom ? { since: filters.since || undefined, until: filters.until || undefined } : {}) },
    }).then(result => {
      if (id !== sequence.current) return;
      reopened.current = false;
      setData(result);
      setError(null);
      setLoading(false);
      setMembers(known => {
        const next = new Map(known);
        for (const row of [...result.ranking, ...result.members ?? []]) next.set(row.identity.key, row.identity.label);
        if (result.member) next.set(result.member.key, result.member.label);
        return next;
      });
      if (result.group === null) setGroups(known => {
        const next = new Map(known);
        for (const group of result.groups) next.set(group.group, group.title);
        return next;
      });
    }, failure => {
      if (id !== sequence.current) return;
      const problem = failureOf(failure);
      setLoading(false);
      // The view went (the console restarted or the session holds too many): open a new one, never in full mode unasked.
      // Once only: a fresh view that is gone again at once shows the error instead of reopening in a loop.
      if (problem.code === "view-gone" && !reopened.current) {
        reopened.current = true;
        if (view.mode === "full") setNotice("统计视图已过期，已回到默认模式；需要完整身份请重新确认。");
        setView(null);
        setMode({ mode: view.mode === "full" ? "default" : view.mode, confirm: false });
        return;
      }
      setError(problem);
    });
  }, [view, filters, refresh, rangeError]);

  // Anything the user asks for may reopen a gone view once more.
  const set = (patch: Partial<Filters>) => { reopened.current = false; setFilters(value => ({ ...value, ...patch })); setRankPage(0); };
  const reload = () => { reopened.current = false; setRefresh(value => value + 1); };

  const points = useMemo<ColumnPoint[]>(() => (data?.trend ?? []).map(point => ({
    key: point.date, label: bucketText(point.date, data!.grain, true),
    value: metric === "asks" ? point.asks : metric === "people" ? point.people : point.tokens,
    detail: [["提问次数", count(point.asks)], ["提问人数", count(point.people)], ["Token", count(point.tokens)]],
  })), [data, metric]);

  const groupLabel = filters.group === null ? "全部群和单聊" : groups.get(filters.group) ?? filters.group;
  const summary = data?.summary;
  const empty = data !== null && data.summary.asks === 0 && data.groups.every(group => group.asks === 0 && group.tokens.totalTokens === 0);
  const ranking = data?.ranking ?? [];

  return (
    <>
      <div class="page-header">
        <div>
          <h1 class="page-title">统计</h1>
          <p class="page-desc">
            {data ? <>{data.window.label} · {groupLabel}{data.member ? ` · ${data.member.label}` : ""} · 读取于 {clock(data.observedAt)}</> : "提问量、成员排行、趋势与导出"}
          </p>
        </div>
        <div class="page-actions">
          {view && <ModeBadge mode={view.mode} />}
          <ModeSwitch mode={view?.mode ?? mode.mode} disabled={loading} what="统计页面"
            onChange={(next, confirm) => { reopened.current = false; setNotice(null); setError(null); setMode({ mode: next, confirm }); }} />
          <button type="button" class="btn" disabled={!data || loading || !!error || !!rangeError} onClick={() => setExporting(true)}><Icon name="download" />导出</button>
          <button type="button" class="btn ghost icon-btn" aria-label="刷新统计" title="刷新" disabled={!view} onClick={reload}>
            <Icon name="refresh" class={loading && data ? "spin" : undefined} />
          </button>
        </div>
      </div>

      <div class="filter-bar" role="toolbar" aria-label="统计筛选">
        <Segmented label="统计区间" value={filters.period} onChange={period => set({ period })}
          options={QUICK.map(([value, label]) => ({ value, label }))} />
        <select class="select" aria-label="更多区间" value={QUICK.some(([key]) => key === filters.period) ? "" : filters.period}
          onChange={event => { const value = (event.target as HTMLSelectElement).value as StatsPeriodKey; if (value) set({ period: value }); }}>
          <option value="">更多区间…</option>
          {MORE.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {custom && (
          <div class="date-range">
            <input type="date" aria-label="起始日期" value={filters.since} onChange={event => set({ since: (event.target as HTMLInputElement).value })} />
            <span class="muted">至</span>
            <input type="date" aria-label="结束日期" value={filters.until} onChange={event => set({ until: (event.target as HTMLInputElement).value })} />
          </div>
        )}
        <select class="select" aria-label="群筛选" value={filters.group ?? ""}
          onChange={event => set({ group: (event.target as HTMLSelectElement).value || null })}>
          <option value="">全部群和单聊</option>
          {[...groups].sort((a, b) => Number(b[0] === "direct") - Number(a[0] === "direct") || a[1].localeCompare(b[1], "zh-CN"))
            .map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        </select>
        <select class="select" aria-label="成员筛选" title="名单来自已查看的统计范围；找不到成员时可调整空间或时间。" value={filters.member ?? ""} disabled={!view || !members.size}
          onChange={event => set({ member: event.currentTarget.value || null })}>
          <option value="">全部成员</option>
          {[...members].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {filters.group !== null && <button type="button" class="btn ghost small-btn" onClick={() => set({ group: null })}><Icon name="x" size={14} />清除群筛选</button>}
      </div>

      {rangeError && <Banner tone="warn" icon="alert" title={rangeError} />}
      {notice && <Banner tone="warn" icon="shield" title={notice} />}
      {error && (
        <Banner tone="danger" icon="alert" title="读取统计失败"
          action={<button type="button" class="btn" onClick={() => { setError(null); if (openFailed || !view) setMode({ ...mode }); else reload(); }}>重试</button>}>
          {error.message}{data && "（下面是上一次读取的结果）"}
        </Banner>
      )}
      {data && <NamesNotice names={data.names} />}

      {!data && !error && <EmptyState icon="loader" title="正在读取账本…" />}
      {data && summary && (
        <div class={`stats-body${loading ? " refreshing" : ""}`} aria-busy={loading}>
          {empty ? (
            <EmptyState icon="chart" title="这个区间没有提问记录" action={filters.period !== "all" && <button type="button" class="btn" onClick={() => set({ period: "all" })}>查看全部时间</button>}>
              换一个区间或清除群筛选试试。
            </EmptyState>
          ) : (
            <div class="grid">
              <div class="tiles span-12">
                <Tile label="提问次数" value={count(summary.asks)} sub={summary.peak ? `峰值 ${summary.peak.date} · ${count(summary.peak.asks)} 次` : undefined} />
                <Tile label="提问人数" value={count(summary.people)} sub={`前 5 名占 ${percent(summary.topFiveShare)}`} />
                <Tile label="人均提问" value={average(summary.average)} />
                <Tile label="日均提问" value={average(summary.dailyAverage)} sub={`共 ${count(summary.days)} 天`} />
                <Tile label="活跃天数" value={`${count(summary.activeDays)} 天`} sub={`占 ${percent(summary.activeRate)}`} />
                <Tile label="Token" value={compact(summary.tokens.totalTokens)} sub={`输入 ${compact(summary.tokens.input)} · 输出 ${compact(summary.tokens.output)}`} />
              </div>

              {data.comparisons.length > 0 && (
                <Card title="对比" icon="activity" span={12} flush>
                  <div class="table-wrap">
                    <table class="data-table">
                      <thead><tr><th>对比</th><th>区间</th><th class="num">提问次数</th><th class="num">提问人数</th><th class="num">人均提问</th></tr></thead>
                      <tbody>
                        {data.comparisons.map(row => (
                          <tr key={row.label}>
                            <td>{row.label}</td><td class="muted">{row.window}</td>
                            <td class="num">{count(row.asks)} <Delta current={summary.asks} previous={row.asks} /></td>
                            <td class="num">{count(row.people)} <Delta current={summary.people} previous={row.people} /></td>
                            <td class="num">{average(row.average)} <Delta current={summary.average} previous={row.average} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              <Card title="趋势" icon="chart" span={12}
                aside={<div class="card-tools">
                  <Segmented label="趋势指标" size="small" value={metric} onChange={setMetric}
                    options={[{ value: "asks", label: "提问次数" }, { value: "people", label: "提问人数" }, { value: "tokens", label: "Token" }]} />
                  <Segmented label="趋势粒度" size="small" value={filters.grain} onChange={grain => set({ grain })}
                    options={[{ value: "day", label: "日" }, { value: "week", label: "周" }, { value: "month", label: "月" }]} />
                  <button type="button" class={`btn ghost icon-btn${table ? " active" : ""}`} aria-pressed={table} aria-label="以表格显示" title="以表格显示"
                    onClick={() => setTable(value => !value)}><Icon name="table" /></button>
                </div>}>
                {points.length === 0 ? <p class="muted">没有可画的日期。</p>
                  : table ? <ColumnTable points={points} columns={["提问次数", "提问人数", "Token"]} />
                  : <ColumnChart points={points} name={metric === "asks" ? "提问次数" : metric === "people" ? "提问人数" : "Token"}
                      format={value => metric === "tokens" ? `${count(value)} token` : metric === "people" ? `${count(value)} 人` : `${count(value)} 次`}
                      axis={compact} axisLabel={point => bucketText(point.key, data.grain, false)} />}
                {data.grain === "day" && points.length > 120 && !table && (
                  <p class="card-note">区间较长，按周或按月查看更清楚。</p>
                )}
              </Card>

              <Card title="提问排行" icon="users" span={filters.group === null ? 6 : 12}
                aside={ranking.length > 10 && <button type="button" class="btn ghost small-btn" onClick={() => { setRankAll(value => !value); setRankPage(0); }}>
                  {rankAll ? "收起" : `全部 ${count(ranking.length)} 人`}</button>}>
                {rankAll ? (
                  <RankingTable data={data} page={rankPage} onPage={setRankPage} />
                ) : (
                  <BarList rows={ranking.slice(0, 10).map((row, index) => ({
                    key: row.identity.key, label: <><span class="rank">{index + 1}</span><IdentityText identity={row.identity} compact /></>,
                    value: row.asks, text: `${count(row.asks)} 次`, title: `${row.identity.label} · 活跃 ${row.activeDays} 天 · ${row.groups} 个群`,
                  }))} />
                )}
                {ranking.length >= 1_000 && <p class="card-note">只列出前 1,000 名；合计仍按全部成员计算。</p>}
              </Card>

              {filters.group === null && (
                <Card title="群与单聊" icon="messages" span={6}>
                  <BarList rows={[...data.groups].sort((a, b) => b.asks - a.asks).slice(0, 12).map(group => ({
                    key: group.group, label: group.title, value: group.asks, text: `${count(group.asks)} 次 · ${count(group.people)} 人`,
                    title: `${group.title} · 活跃 ${group.activeDays} 天 · Token ${count(group.tokens.totalTokens)}${group.lastAt ? ` · 最近 ${dateTime(group.lastAt)}` : ""}；点击只看这个群`,
                    onClick: () => set({ group: group.group }),
                  }))} />
                  {data.groups.length > 12 && <p class="card-note">另有 {data.groups.length - 12} 个群，见下方表格。</p>}
                </Card>
              )}

              {data.members && (
                <Card title={`${groupLabel}的成员`} icon="users" span={12} flush>
                  <div class="table-wrap tall">
                    <table class="data-table">
                      <thead><tr><th>成员</th><th class="num">提问次数</th><th class="num">活跃天数</th><th>首次提问</th><th>最近提问</th></tr></thead>
                      <tbody>
                        {data.members.map(row => (
                          <tr key={row.identity.key}>
                            <td><IdentityText identity={row.identity} /></td><td class="num">{count(row.asks)}</td><td class="num">{count(row.activeDays)}</td>
                            <td class="muted">{dateTime(row.firstAt)}</td><td class="muted">{dateTime(row.lastAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {filters.group === null && data.groups.length > 0 && (
                <Card title="各群明细" icon="table" span={12} flush>
                  <div class="table-wrap tall">
                    <table class="data-table">
                      <thead><tr><th>群</th><th class="num">提问次数</th><th class="num">提问人数</th><th class="num">活跃天数</th><th class="num">Token</th><th>最近提问</th><th /></tr></thead>
                      <tbody>
                        {[...data.groups].sort((a, b) => b.asks - a.asks || b.tokens.totalTokens - a.tokens.totalTokens).map(group => (
                          <tr key={group.group}>
                            <td>{group.title}</td><td class="num">{count(group.asks)}</td><td class="num">{count(group.people)}</td>
                            <td class="num">{count(group.activeDays)}</td><td class="num" title={tokenTitle(group.tokens)}>{compact(group.tokens.totalTokens)}</td>
                            <td class="muted">{group.lastAt ? dateTime(group.lastAt) : "—"}</td>
                            <td><button type="button" class="btn ghost small-btn" onClick={() => set({ group: group.group })}>只看此群</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              <Card title="模型 Token" icon="sparkles" span={6}>
                <BarList empty="区间内没有模型用量" rows={data.models.slice(0, 10).map(row => ({
                  key: row.key, label: <span class="mono">{row.key}</span>, value: row.tokens.totalTokens, text: compact(row.tokens.totalTokens), title: tokenTitle(row.tokens),
                }))} />
              </Card>
              <Card title="工具 Token" icon="wrench" span={6}>
                <BarList empty="区间内没有工具自身的模型用量" rows={data.tools.slice(0, 10).map(row => ({
                  key: row.key, label: <span class="mono">{row.key}</span>, value: row.tokens.totalTokens, text: compact(row.tokens.totalTokens), title: tokenTitle(row.tokens),
                }))} />
              </Card>
            </div>
          )}
          <div class="notes">
            <p><strong>统计口径</strong>{data.notes.stats}</p>
            <p><strong>Token</strong>{data.notes.tokens}</p>
            <p><strong>身份</strong>{data.notes.identity} <NamesObserved names={data.names} /></p>
          </div>
        </div>
      )}

      {exporting && data && view && (
        <StatsExportDialog viewMode={view.mode} period={filters.period} since={filters.since} until={filters.until} group={filters.group}
          view={view.id} member={data.member?.key ?? null} windowLabel={data.window.label}
          groupLabel={groupLabel + (data.member ? ` · ${data.member.label}` : "")} onClose={() => setExporting(false)} />
      )}
    </>
  );
}

function RankingTable({ data, page, onPage }: { data: StatsResponse; page: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(data.ranking.length / RANK_PAGE));
  const rows = data.ranking.slice(page * RANK_PAGE, (page + 1) * RANK_PAGE);
  return (
    <>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th class="num">#</th><th>成员</th><th class="num">提问次数</th><th class="num">活跃天数</th><th class="num">群数</th></tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.identity.key}>
                <td class="num muted">{page * RANK_PAGE + index + 1}</td><td><IdentityText identity={row.identity} /></td>
                <td class="num">{count(row.asks)}</td><td class="num">{count(row.activeDays)}</td><td class="num">{count(row.groups)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div class="pager">
          <button type="button" class="btn small-btn" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
          <span class="muted">{page + 1} / {pages}</span>
          <button type="button" class="btn small-btn" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>下一页</button>
        </div>
      )}
    </>
  );
}

function close(id: string) {
  api("/api/views/close", { method: "POST", body: { view: id }, quiet: true }).catch(() => {});
}
