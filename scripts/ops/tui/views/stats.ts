import { formatCacheRate } from "../../../lib/usage.ts";
// 统计概览与可滚动明细；导出路径保留到下一次导出，显号只在当前明细内有效。
import { relative } from "node:path";
import { bar, box, table, wrap } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import * as fmt from "../render/format.ts";
import { loadStatsOverview, type GroupStats, type Window } from "../data.ts";
import { parseDate } from "../../stats-admin.ts";
import { PROJECT_DIR } from "../platform.ts";
import { writeReport } from "../report.ts";
import type { AppApi, Loading, View, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";

export class StatsView implements View {
  readonly id = "stats";
  readonly label = "统计";
  private overview: Loading<GroupStats[]> = { kind: "idle" };
  private detail: GroupStats | null = null;
  private selected = 0;
  private window: Window = {};
  private unmasked = false;
  private scroll = new Viewport();
  private lastReport: { path: string; unmasked: boolean } | null = null;
  private revision = 0;

  constructor(private readonly reportDir?: string) {}

  hints(): [string, string][] {
    const keys: [string, string][] = this.detail
      ? [["Esc", "返回"], ["↑↓", "滚动"], ["m", this.unmasked ? "打码" : "显号"], ["e", "导出"]]
      : [["↑↓", "选择"], ["Enter", "明细"], ["d", "区间"], ["e", "导出"]];
    if (this.lastReport) keys.push(["o", "打开"]);
    return keys;
  }

  onLeave(): void { this.unmasked = false; }

  async refresh(app: AppApi): Promise<void> {
    const revision = ++this.revision;
    this.overview = { kind: "loading" };
    app.redraw();
    try {
      const groups = await loadStatsOverview(app.deployment.groupDataRoot, this.window);
      if (revision !== this.revision) return;
      this.overview = { kind: "ready", value: groups };
      this.selected = Math.min(this.selected, Math.max(0, groups.length - 1));
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
    if (key.name === "escape" && this.detail) {
      this.detail = null;
      this.unmasked = false;
      this.scroll.reset();
      return true;
    }
    if (key.name === "m" && this.detail) { this.unmasked = !this.unmasked; return true; }
    if (key.name === "d") { await this.pickWindow(app); return true; }
    if (key.name === "e") { await this.export(app); return true; }
    if (key.name === "o" && this.lastReport) { await app.openFile(this.lastReport.path); return true; }
    if (this.overview.kind !== "ready") return false;
    if (this.detail) return this.scroll.onKey(key.name);
    const groups = this.overview.value;
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
    this.scroll.reset();
    await this.refresh(app);
    if (this.overview.kind === "ready") app.toast("ok", this.describeWindow());
  }

  private async export(app: AppApi): Promise<void> {
    if (this.overview.kind !== "ready") return;
    const unmasked = this.unmasked && this.detail !== null;
    try {
      const path = await writeReport({
        groups: this.overview.value, detail: this.detail, window: this.window,
        deployment: app.deployment, unmasked, dir: this.reportDir,
      });
      this.lastReport = { path, unmasked };
      app.toast("ok", "报表已保存，按 o 打开；路径保留在本页顶部");
    } catch (error) { app.toast("danger", "导出失败：" + String(error)); }
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
    const waiting = pending(theme, total, this.overview, "该区间内没有使用记录");
    if (waiting) return [...report, ...waiting];
    const groups = (this.overview as { value: GroupStats[] }).value;
    if (groups.length === 0) return [...report, gap(total), pad("  该区间内没有使用记录；按 d 调整区间", total)];
    return [...report, ...(this.detail ? this.renderDetail(innerCtx, this.detail) : this.renderOverview(innerCtx, groups))];
  }

  private renderOverview(ctx: ViewContext, groups: GroupStats[]): string[] {
    const { theme, width: total, height } = ctx;
    const people = groups.reduce((sum, group) => sum + group.users.length, 0);
    const asks = groups.reduce((sum, group) => sum + group.asks, 0);
    const max = Math.max(...groups.map(group => group.asks));
    const room = Math.max(1, height - 5);
    const start = windowStart(this.selected, groups.length, room);
    const nameSize = Math.min(30, Math.max(12, Math.floor(total * 0.28)));
    const barSize = Math.max(1, total - 4 - 2 - nameSize - 26 - 10);
    return box(theme, {
      width: total, title: "统计", note: this.describeWindow(), accent: "accent",
      body: [
        theme.c("muted", "共 " + groups.length + " 个群 · " + people + " 成员人次 · " + asks + " 次提问"),
        theme.c("muted", "显示 " + (start + 1) + "–" + Math.min(start + room, groups.length) + " / " + groups.length),
        ...table(theme, {
          width: total - 4, rows: groups.slice(start, start + room), selected: this.selected - start,
          columns: [
            { header: "群", size: nameSize, render: group => group.group },
            { header: "人数", size: 5, align: "right", render: group => String(group.users.length) },
            { header: "提问", size: 6, align: "right", render: group => String(group.asks) },
            { header: "", size: barSize, render: group => bar(theme, group.asks, max, barSize) },
            { header: "附件", size: 5, align: "right", render: group => String(group.delivered.get("send_file") ?? 0) },
            { header: "最后活动", size: 10, align: "right", render: group => fmt.since(group.lastAt) },
          ],
        }),
      ],
    });
  }

  private renderDetail(ctx: ViewContext, stats: GroupStats): string[] {
    const { theme, width: total, height } = ctx;
    const summary = box(theme, {
      width: total, title: "统计 › " + stats.group, note: this.describeWindow(), accent: "accent",
      body: [
        stats.asks + " 次提问 · " + stats.users.length + " 人 · " + stats.days.size + " 天活跃 · " + stats.replies + " 轮处理",
        "附件 " + (stats.delivered.get("send_file") ?? 0) + " 份 · 图片 " + (stats.delivered.get("send_image") ?? 0) + " 张",
        "模型用量：输入 " + fmt.count(stats.tokens.input) + " · 输出 " + fmt.count(stats.tokens.output) + " · 缓存 " + fmt.count(stats.tokens.cacheRead),
        "缓存写入 " + fmt.count(stats.tokens.cacheWrite) + " · 加权读率 " + formatCacheRate(stats.tokens),
        "已知估算 $" + stats.tokens.cost.toFixed(4) + " · 费用未知 " + stats.tokens.unknownCost + " 条 · 用量不完整 " + stats.tokens.missingUsage + " 条",
      ],
    });
    const months = [...stats.months].sort((a, b) => a[0].localeCompare(b[0]));
    const max = Math.max(0, ...months.map(([, month]) => month.asks));
    const graphWidth = Math.max(8, total - 38);
    const content = [
      theme.bold("成员"),
      ...table(theme, {
        width: total - 4, rows: stats.users, marker: 0,
        columns: [
          { header: "成员", flex: 1, render: user => this.unmasked ? user.user : fmt.maskUser(user.user) },
          { header: "提问", size: 6, align: "right", render: user => String(user.asks) },
          { header: "附件", size: 5, align: "right", render: user => String(user.files) },
          { header: "活跃天", size: 6, align: "right", render: user => String(user.days.size) },
          { header: "最后活动", size: 10, align: "right", render: user => fmt.day(user.lastAt) },
        ],
      }),
      "", theme.bold("按月"),
      ...months.map(([month, value]) => pad(month, 9) + " " + bar(theme, value.asks, max, graphWidth) +
        pad(String(value.asks) + " 次", 10, "right") + pad(String(value.users.size) + " 人", 8, "right")),
      "", theme.bold("工具调用"),
      ...[...stats.tools].sort((a, b) => b[1] - a[1]).map(([tool, count]) => tool + " · " + count + " 次"),
      ...(stats.skipped ? ["", "跳过 " + stats.skipped + " 行无法解析的记录"] : []),
    ];
    const visible = this.scroll.slice(content.flatMap(line => wrap(line, total - 4)), Math.max(1, height - summary.length - 3));
    return [...summary, gap(total), ...box(theme, {
      width: total, title: this.unmasked ? "明细 · 完整号码" : "明细 · 已打码",
      note: this.scroll.label, body: visible,
    })];
  }
}
