import { cacheReadRate, formatCacheRate } from "../../../lib/usage.ts";
import { byName } from "../../../lib/group-data.ts";
// 统计概览与可滚动明细；导出路径保留到下一次导出，显号只在当前明细内有效。
import { relative } from "node:path";
import { bar, columns as sideBySide, rule, status, table, tile, wrap } from "../render/widgets.ts";
import { pad, truncate, width } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import * as fmt from "../render/format.ts";
import { loadStatsOverview, type GroupStats, type Window } from "../data.ts";
import { collectComparisons, parseDate } from "../../stats-admin.ts";
import { change, comparisons, describeStatsWindow, PERIODS, periodWindow, summarize, trend, type ComparisonData, type Grain } from "../../stats-summary.ts";
import { PROJECT_DIR } from "../platform.ts";
import { writeReport } from "../report.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, ListFilter, moveSelection, pending, windowStart } from "./common.ts";

export class StatsView implements View {
  readonly id = "stats";
  readonly label = "统计";
  private overview: Loading<GroupStats[]> = { kind: "idle" };
  private root: string | undefined;
  private detail: GroupStats | null = null;
  private selected = 0;
  private window: Window = {};
  private comparisonData: ComparisonData | null = null;
  private grain: Grain = "day";
  private showTrend = false;
  private unmasked = false;
  private scroll = new Viewport();
  private lastReport: { path: string; unmasked: boolean } | null = null;
  private exporting = false;
  private opening = false;
  private revision = 0;
  private filter = new ListFilter();

  constructor(private readonly reportDir?: string) {}

  activity(): string | null {
    if (this.overview.kind === "loading") return "正在读取统计…";
    if (this.exporting) return "正在导出报表…";
    return this.opening ? "正在打开报表…" : null;
  }

  hints(): [string, string][] {
    const keys: [string, string][] = this.detail
      ? [["Esc", "返回"], ["↑↓", "滚动"], ["m", this.unmasked ? "打码" : "显号"]]
      : [["↑↓", "选择"], ["Enter", "明细"], ["/", "筛选"], ["w", "日期"]];
    keys.push(["e", this.exporting ? "导出中" : "导出"]);
    keys.push(["t", "汇总趋势"], ["g", "日/周/月"]);
    if (this.lastReport) keys.push(["o", this.opening ? "打开中" : "打开"]);
    return keys;
  }

  actions(): ViewAction[] {
    return [
      ...(this.detail
        ? [{ value: "escape", label: "返回群列表" }, { value: "m", label: this.unmasked ? "恢复成员号码打码" : "临时显示成员完整号码", description: "仅当前明细有效；导出的报表会沿用当前打码状态" }]
        : [{ value: "enter", label: "查看选中群的明细", disabled: !this.groups.length },
          { value: "/", label: "筛选群或成员", description: "按群名、成员号码或打码后的号码查找" }]),
      { value: "w", label: "选择日期范围", description: "今天、昨天、本周、上周、本月、上月、近 7/30 天、全部或自定义" },
      { value: "t", label: "切换汇总趋势", description: "查看筛选群的合计趋势" },
      { value: "g", label: "切换日/周/月粒度", description: "统计区间不变，切换趋势聚合粒度" },
      { value: "d", label: "自定义起止日期", description: this.describeWindow() },
      { value: "e", label: "导出当前范围的 HTML 报表", description: "导出所列群；在群明细中还会附上当前群的明细", disabled: this.exporting || this.overview.kind !== "ready" },
      { value: "o", label: "打开最近的报表", disabled: this.opening || !this.lastReport },
    ];
  }

  private get groups(): GroupStats[] {
    if (this.overview.kind !== "ready") return [];
    return this.overview.value.filter(group => this.filter.matches(
      group.group, ...group.users.flatMap(user => [user.user, fmt.maskUser(user.user)])
    ));
  }

  onLeave(): void { this.unmasked = false; }

  async refresh(app: AppApi, reset = false): Promise<void> {
    const revision = ++this.revision;
    if (this.root !== undefined && this.root !== app.deployment.groupDataRoot) {
      reset = true;
      this.detail = null;
      this.unmasked = false;
      this.selected = 0;
      this.scroll.reset();
      this.filter.clear();
    }
    this.root = app.deployment.groupDataRoot;
    if (reset || this.overview.kind !== "ready") this.overview = { kind: "loading" };
    app.redraw();
    try {
      const [groups, comparisonData] = await Promise.all([loadStatsOverview(app.deployment.groupDataRoot, this.window), collectComparisons(app.deployment.groupDataRoot, this.window)]);
      if (revision !== this.revision) return;
      this.comparisonData = comparisonData;
      this.overview = { kind: "ready", value: groups };
      this.selected = Math.min(this.selected, Math.max(0, this.groups.length - 1));
      if (this.detail) {
        this.detail = groups.find(group => group.group === this.detail!.group) ?? null;
        if (!this.detail) this.unmasked = false;
      }
    } catch (error) {
      if (revision === this.revision) this.overview = { kind: "error", message: "读取失败：" + String(error) };
    }
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (key.name === "t" && !this.detail) { this.showTrend = !this.showTrend; this.scroll.reset(); return true; }
    if (key.name === "g") { this.grain = this.grain === "day" ? "week" : this.grain === "week" ? "month" : "day"; this.scroll.reset(); return true; }
    if (key.name === "escape" && this.showTrend && !this.detail) { this.showTrend = false; this.scroll.reset(); return true; }
    if (key.name === "escape" && this.detail) {
      this.detail = null;
      this.unmasked = false;
      this.scroll.reset();
      return true;
    }
    if (key.name === "escape" && this.filter.clear()) { this.selected = 0; return true; }
    if (key.name === "/" && !this.detail) {
      if (await this.filter.edit(app, "筛选群名或成员")) this.selected = 0;
      return true;
    }
    if (key.name === "m" && this.detail) { this.unmasked = !this.unmasked; return true; }
    if (key.name === "w") { await this.pickPreset(app); return true; }
    if (key.name === "d") { await this.pickWindow(app); return true; }
    if (key.name === "e") { void this.export(app); return true; }
    if (key.name === "o" && this.lastReport) { void this.openReport(app); return true; }
    if (this.overview.kind !== "ready") return false;
    if (this.showTrend && !this.detail) return this.scroll.onKey(key.name);
    if (this.detail) return this.scroll.onKey(key.name);
    const groups = this.groups;
    const moved = moveSelection(key.name, this.selected, groups.length);
    if (moved !== null) { this.selected = moved; return true; }
    if (key.name === "enter" && groups[this.selected]) {
      this.detail = groups[this.selected]!;
      this.unmasked = false;
      this.scroll.reset();
      return true;
    }
    return false;
  }

  private async pickPreset(app: AppApi): Promise<void> {
    const value = await app.choose({
      title: "统计日期范围", description: "按本地自然日统计；自定义区间可只填写起始或结束日期。",
      choices: [
        ...PERIODS.map(([value, label]) => ({ value, label })), { value: "custom", label: "自定义起止日期" },
      ],
    });
    if (value === null) return;
    if (value === "custom") { await this.pickWindow(app); return; }
    this.window = periodWindow(value);
    this.reloadWindow(app);
  }

  private async pickWindow(app: AppApi): Promise<void> {
    const sinceRaw = await app.ask("起始日期 YYYY-MM-DD（留空不限，Esc 取消）", this.window.since === undefined ? "" : fmt.day(this.window.since));
    if (sinceRaw === null) return;
    let since: number | undefined;
    let until: number | undefined;
    try {
      since = sinceRaw.trim() ? parseDate(sinceRaw.trim(), false) : undefined;
      const untilRaw = await app.ask("结束日期 YYYY-MM-DD（留空至今，Esc 取消）", this.window.until === undefined ? "" : fmt.day(this.window.until));
      if (untilRaw === null) return;
      until = untilRaw.trim() ? parseDate(untilRaw.trim(), true) : undefined;
      if (since !== undefined && until !== undefined && since > until) throw new Error("起始日期晚于结束日期");
    } catch (error) {
      app.toast("warn", String(error instanceof Error ? error.message : error));
      return;
    }
    this.window = { since, until };
    this.reloadWindow(app);
  }

  private reloadWindow(app: AppApi): void {
    this.scroll.reset();
    app.toast("busy", `正在读取统计：${this.describeWindow()}`);
    // 只等待日期输入；refresh 的 revision 会丢弃之前日期范围的迟到结果。
    void this.refresh(app, true);
  }

  private async export(app: AppApi): Promise<void> {
    if (this.exporting || this.overview.kind !== "ready") return;
    this.exporting = true;
    app.toast("busy", "正在导出报表…");
    const unmasked = this.unmasked && this.detail !== null;
    try {
      const groups = this.groups;
      if (this.detail && !groups.some(group => group.group === this.detail!.group)) groups.push(this.detail);
      const path = await writeReport({
        groups, detail: this.detail, window: this.window,
        comparisons: this.comparisonData,
        comparisonScope: this.filter.value ? groups.map(group => group.group) : undefined,
        deployment: app.deployment, unmasked, dir: this.reportDir,
      });
      this.lastReport = { path, unmasked };
      app.toast("ok", "报表已保存，按 o 打开；路径保留在本页顶部");
    } catch (error) { app.toast("danger", "导出失败：" + String(error)); }
    finally { this.exporting = false; app.redraw(); }
  }

  private async openReport(app: AppApi): Promise<void> {
    if (this.opening || !this.lastReport) return;
    this.opening = true;
    app.toast("busy", "正在打开报表…");
    try { await app.openFile(this.lastReport.path); }
    catch (error) { app.toast("warn", "打开报表失败：" + String(error)); }
    finally { this.opening = false; app.redraw(); }
  }

  private describeWindow(): string {
    if (this.window.since === undefined && this.window.until === undefined) return "全部区间";
    return (this.window.since === undefined ? "最早" : fmt.day(this.window.since)) + " ~ " +
      (this.window.until === undefined ? "至今" : fmt.day(this.window.until));
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total } = ctx;
    const report = this.lastReport ? [
      pad(" 最近报表 · " + (this.lastReport.unmasked ? "含完整号码" : "已打码") + " · o 打开", total),
      ...wrap(relative(PROJECT_DIR, this.lastReport.path), total - 2).map(line => pad(" " + theme.c("muted", line), total)),
    ] : [];
    const innerCtx = { ...ctx, height: ctx.height - report.length };
    const waiting = this.overview.kind === "ready" ? null : pending(theme, total, this.overview, "该区间内没有使用记录");
    if (waiting) return [...report, ...waiting];
    const groups = this.groups;
    if (groups.length === 0 && this.filter.value && !this.detail) return [...report, gap(total),
      pad(this.filter.value ? `  没有匹配「${this.filter.value}」的群或成员；/ 修改，Esc 清除` : "  该区间内没有使用记录；按 w 选择日期", total)];
    return [...report, ...(this.detail ? this.renderDetail(innerCtx, this.detail) : this.renderOverview(innerCtx, groups))];
  }

  /**
   * 群列表：一条细线 + 一张铺满剩余高度的表。
   *
   * 原来这张表套在框里，四条边吃掉两行高度和四列宽度，而框里第一件事又是两行灰字元信息——
   * 于是真正的数据只剩下不到一半屏幕，下面空着九行。现在把汇总塞进分隔线的右端，
   * 翻页和筛选状态放到最后一行，中间全给表。
   */
  private renderOverview(ctx: ViewContext, groups: GroupStats[]): string[] {
    const { theme, width: total, height } = ctx;
    const summary = summarize(groups);
    const { people, asks } = summary;
    const scope = this.filter.value ? new Set(groups.map(group => group.group)) : undefined;
    const notes = [
      pad(` 覆盖提问 ${people} 人（跨群去重） · 人均 ${summary.average.toFixed(1)} 次 · ${summary.activeDays} 天活跃`, total),
      pad(" 提问最多 · " + (summary.ranking.slice(0, 3).map(user => `${fmt.maskUser(user.user)} ${user.asks} 次`).join(" · ") || "无提问记录"), total),
      ...this.comparisonLines(groups, total, scope),
    ];
    const max = Math.max(...groups.map(group => group.asks));
    const room = Math.max(1, height - 3 - notes.length);
    const start = windowStart(this.selected, groups.length, room);
    const nameSize = Math.min(30, Math.max(12, Math.floor(total * 0.28)));
    const barSize = Math.max(1, total - 2 - nameSize - 26 - 10);
    const loaded = this.overview.kind === "ready" ? this.overview.value.length : 0;
    const body = [
      rule(theme, total, "统计 · " + this.describeWindow(),
        groups.length + " 群 · " + asks + " 次提问", "accent"),
      ...notes,
      ...(this.showTrend ? this.scroll.slice(this.trendRows(theme, groups, total), room + 1) : table(theme, {
        width: total, rows: groups.slice(start, start + room), selected: this.selected - start,
        columns: [
          { header: "群", size: nameSize, render: group => group.group },
          { header: "人数", size: 5, align: "right", render: group => String(summarize([group]).people) },
          { header: "提问", size: 6, align: "right", render: group => String(group.asks) },
          { header: "", size: barSize, render: group => bar(theme, group.asks, max, barSize) },
          { header: "附件", size: 5, align: "right", render: group => String(group.delivered.get("send_file") ?? 0) },
          { header: "最后活动", size: 10, align: "right", render: group => fmt.since(group.lastAt) },
        ],
      })),
    ];
    // 状态行钉在正文最后一行，不跟在表格屁股后面：群少的时候它会停在半空中，
    // 下面又空着十来行，看起来像页面没加载完。
    while (body.length < height - 1) body.push(gap(total));
    body.push(pad(" " + theme.c("muted", this.showTrend ? `${this.grainLabel} · ${this.scroll.label} · g 日/周/月 · t 返回群列表` : this.filter.value
      ? this.filter.describe(groups.length, loaded)
      : (start + 1) + "–" + Math.min(start + room, groups.length) + " / " + groups.length + " · / 筛选 · w 日期"), total));
    return body;
  }

  /** 四个指标块：把原来那五行「A 多少 · B 多少 · C 多少」的流水账拆成有层级的数字。 */
  private detailTiles(ctx: ViewContext, stats: GroupStats): string[] {
    const { theme, width: total } = ctx;
    const months = [...stats.months].sort((a, b) => a[0].localeCompare(b[0]));
    const rate = cacheReadRate(stats.tokens);
    const specs = [
      { label: "提问", value: fmt.count(stats.asks) + " 次", trend: months.map(([, month]) => month.asks),
        foot: stats.replies + " 轮处理" },
      { label: "提问人数", value: summarize([stats]).people + " 人", foot: stats.days.size + " 天活跃" },
      { label: "已送附件", value: (stats.delivered.get("send_file") ?? 0) + " 份",
        foot: "图片 " + (stats.delivered.get("send_image") ?? 0) + " 张" },
      // 缓存读率是个比例，用仪表而不是又一个百分数——它解释了左边那笔开销为什么是这个数。
      { label: "模型开销", value: "$" + stats.tokens.cost.toFixed(4),
        ...(rate === null ? {} : { meter: { total: 1, segments: [{ value: rate, color: "accent" as const }] } }),
        foot: "缓存读率 " + formatCacheRate(stats.tokens) },
    ];
    const inner = total - 2;
    const cell = Math.floor((inner - 6) / 4);
    const widths = [cell, cell, cell, inner - 6 - cell * 3];
    return sideBySide(specs.map((spec, i) => tile(theme, { ...spec, width: widths[i]! })), widths, 2)
      .map(line => pad(" " + line, total));
  }

  private get grainLabel(): string { return this.grain === "day" ? "按日" : this.grain === "week" ? "按周（周一）" : "按月"; }

  private comparisonLines(groups: GroupStats[], size: number, scope?: Set<string>): string[] {
    const current = summarize(groups);
    return comparisons(this.comparisonData, scope).map(period => pad(
      ` ${period.label} ${describeStatsWindow(period.window)} · 提问 ${change(current.asks, period.asks)} · 人数 ${change(current.people, period.people)}`, size));
  }

  private trendRows(theme: ViewContext["theme"], groups: GroupStats[], size: number): string[] {
    return [rule(theme, size, this.grainLabel + " · g 切换粒度"), ...table(theme, {
      width: size, rows: trend(groups, this.window, this.grain),
      columns: [
        { header: "日期", flex: 1, render: row => row.date },
        { header: "提问", size: 6, align: "right", render: row => String(row.asks) },
        { header: "人数", size: 5, align: "right", render: row => String(row.askers.size) },
        { header: "文件", size: 5, align: "right", render: row => String(row.files) },
      ],
    })];
  }

  /** 模型直接发起的调用在前；脚本里的子调用另起一组，不和它们相加。 */
  private toolRows(theme: ViewContext["theme"], stats: GroupStats, size: number): string[] {
    const rows = (tools: Map<string, number>, prefix = "") => [...tools].sort((a, b) => b[1] - a[1] || byName(a[0], b[0])).map(([tool, count]) => {
      const name = truncate(prefix + tool, Math.max(1, size - 9));
      return pad(" " + name + pad(theme.c("muted", count + " 次"), Math.max(0, size - 1 - width(name)), "right"), size);
    });
    return stats.nested.size ? [...rows(stats.tools), pad(" " + theme.c("muted", "脚本子调用"), size), ...rows(stats.nested, "↳ ")] : rows(stats.tools);
  }

  /**
   * 群明细：指标块在上，成员表和按月/工具分列左右。
   *
   * 按月趋势原来排在成员表后面，要滚过几十行才看得到——而它恰恰是一个群最值得看的东西。
   * 宽窗口下把它挪到右栏，两边都在第一屏；窄窗口下没有第二栏可用，才退回上下叠放。
   */
  private renderDetail(ctx: ViewContext, stats: GroupStats): string[] {
    const { theme, width: total, height } = ctx;
    const wide = total >= 96;
    const out = [
      rule(theme, total, "统计 › " + stats.group, this.describeWindow(), "accent"),
      ...this.detailTiles(ctx, stats),
      ...this.comparisonLines([stats], total, new Set([stats.group])),
      gap(total),
    ];
    // 数据本身有缺口时必须说出来，否则上面那笔开销看起来比实际更确定。
    const caveats = [
      stats.tokens.unknownCost ? "费用未知 " + stats.tokens.unknownCost + " 条" : "",
      stats.tokens.missingUsage ? "用量不完整 " + stats.tokens.missingUsage + " 条" : "",
      stats.skipped ? "跳过 " + stats.skipped + " 行无法解析的记录" : "",
      stats.nestedIncomplete ? "子调用记录不完整 " + stats.nestedIncomplete + " 次，计数可能偏少" : "",
      stats.legacySources ? "旧口径账目 " + stats.legacySources + " 个会话" : "",
    ].filter(Boolean);

    const listWidth = wide ? Math.floor(total * 0.6) : total;
    const sideWidth = total - listWidth - 2;
    const room = Math.max(1, height - out.length - caveats.length - 1);
    const rows = table(theme, {
      // marker 只在有选中行时才画箭头；这里给 1 是为了让表格和同屏其他内容共用同一条装订线。
      width: listWidth, rows: stats.users, marker: 1,
      columns: [
        { header: "成员", flex: 1, render: user => this.unmasked ? user.user : fmt.maskUser(user.user) },
        { header: "提问", size: 5, align: "right", render: user => String(user.asks) },
        { header: "附件", size: 5, align: "right", render: user => String(user.files) },
        { header: "活跃天", size: 6, align: "right", render: user => String(user.days.size) },
        { header: "最后活动", size: 10, align: "right", render: user => fmt.day(user.lastAt) },
      ],
    });
    const header = rows[0]!;

    // 窄窗口没有第二栏可用，按月和工具就接在成员表后面进同一个滚动区——它们必须始终滚得到，
    // 放不下不等于可以不给。宽窗口才把它们挪到右栏，两边同时落在第一屏。
    const side = [
      ...this.trendRows(theme, [stats], wide ? sideWidth : total), gap(wide ? sideWidth : total),
      rule(theme, wide ? sideWidth : total, "工具调用"), ...this.toolRows(theme, stats, wide ? sideWidth : total),
    ];
    // Scroll both columns together so long daily histories never disappear below the member list.
    const scrolling = wide ? sideBySide([rows.slice(1), side], [listWidth, sideWidth], 2) : [...rows.slice(1), gap(total), ...side];
    // 先切片再取 label：Viewport 的计数是在 slice 里算出来的，顺序反了会一直显示上一帧的数。
    const visible = this.scroll.slice(scrolling, Math.max(1, room - 2));
    const members = [
      rule(theme, total, this.unmasked ? "成员 · 完整号码" : "成员 · 已打码", this.scroll.label),
      pad(header, total), ...visible,
    ];

    out.push(...members);
    if (caveats.length) out.push(pad(" " + status(theme, "warn", caveats.join(" · ")), total));
    return out;
  }
}
