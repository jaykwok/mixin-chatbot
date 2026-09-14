// 总览。回答三个问题：它活着吗、今天被用了多少、有什么该我处理的。
//
// 「待办」是这一页的核心，也是整个界面存在的理由：原来这些结论散在 doctor、stat、tmp-ls
// 和 git 四条命令里，得分别跑一遍再自己拼。这里把它们合成一张按严重度排序的清单。
//
// 清单后半段是四个常驻入口，和告警同在一张表里，回车都是「去处理」——它们是同一个动作，
// 分成两处反而要多学一套操作。告警排在前面并带颜色符号，入口一律是灰色的 ○；
// 分隔线右端只数真正需要关注的条数，所以「有没有事」看那个数字，不必去数列表行数。

import { columnChart, columns as sideBySide, fields, mark, rule, table, tile } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import type { StatusName } from "../render/theme.ts";
import * as fmt from "../render/format.ts";
import {
  loadRecentStats,
  loadDiskUsage,
  loadGit,
  loadTmp,
  type DailyPoint,
  type GitState,
  type RecentStats,
  type UserTmp,
} from "../data.ts";
import { PROJECT_DIR } from "../platform.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";
import { join } from "node:path";

const TREND_DAYS = 14;
/** 超过这些天没动过的 tmp 条目算「可以清了」，与 tmp-purge --days 的默认建议一致。 */
const STALE_DAYS = 30;
/** 趋势图矮于这个行数就不画了——两三行的柱子分不出高低，指标块里的火花线反而更诚实。 */
const MIN_CHART_ROWS = 3;
/** 左右两栏之间的空列。一列不够：待办那栏的文字会和右边的标签连成一句话。 */
const COLUMN_GAP = 3;

interface Snapshot {
  today: RecentStats["today"] | null;
  trend: DailyPoint[];
  tmp: UserTmp[] | null;
  disk: number | null;
  git: GitState | null;
}

interface Todo {
  status: StatusName;
  text: string;
  hint: string;
  target: string;
}

export class OverviewView implements View {
  readonly id = "overview";
  readonly label = "总览";
  private state: Loading<Snapshot> = { kind: "idle" };
  private selected = 0;
  private root: string | undefined;
  private revision = 0;
  private loading = new Set<string>();
  private errors = new Map<string, Todo>();

  hints(): [string, string][] {
    return [["↑↓", "选择事项"], ["Enter", "前往处理"]];
  }

  actions(): ViewAction[] {
    return [
      { value: "enter", label: "处理选中事项", disabled: this.state.kind !== "ready" },
      { value: "health", label: "检查服务健康", description: "检查服务、隧道与配置，查看修复建议" },
      { value: "logs", label: "查看运行日志", description: "跟随最新输出，筛选异常与任务记录" },
      { value: "stats", label: "查看用量与报表", description: "按日期、群与成员查看使用情况" },
      { value: "maintain", label: "管理服务与部署", description: "启动、重启、升级和修复" },
    ];
  }

  async refresh(app: AppApi): Promise<void> {
    const revision = ++this.revision;
    const root = app.deployment.groupDataRoot;
    const snapshot: Snapshot = this.state.kind === "ready" && (this.root === undefined || this.root === root) ? { ...this.state.value }
      : { today: null, trend: [], tmp: null, disk: null, git: null };
    this.root = root;
    // "ready" means the page has a snapshot to render, including placeholders.
    // Per-source loading/errors below track data readiness; navigation stays usable.
    this.state = { kind: "ready", value: snapshot };
    this.loading = new Set(["stats", "tmp", "disk", "git"]);
    this.errors.clear();
    app.redraw();

    // 今日用量、目录和 Git 独立到达；慢扫描不能挡住已经读到的指标与常用入口。
    const read = async <T>(id: string, label: string, target: string, load: () => Promise<T>, apply: (value: T) => void) => {
      let update: () => void;
      try {
        const value = await load();
        update = () => apply(value);
      } catch (error) {
        update = () => this.errors.set(id, { status: "warn", text: `${label}读取失败：${String(error)}`,
          hint: target === "stats" ? "统计" : target === "maintain" ? "系统" : "数据", target });
      }
      if (revision !== this.revision) return;
      const selected = this.todos(snapshot)[this.selected];
      update();
      const todos = this.todos(snapshot);
      const index = todos.findIndex(todo => todo.text === selected?.text && todo.target === selected.target);
      this.selected = index >= 0 ? index : Math.max(0, Math.min(this.selected, todos.length - 1));
      this.loading.delete(id);
      app.redraw();
    };
    await Promise.all([
      read("stats", "统计", "stats", () => loadRecentStats(root, TREND_DAYS), value => {
        snapshot.today = value.today;
        snapshot.trend = value.trend;
      }),
      read("tmp", "临时目录", "storage", () => loadTmp(root), value => { snapshot.tmp = value; }),
      read("disk", "磁盘占用", "storage", () => loadDiskUsage([join(PROJECT_DIR, "data"), root]), value => { snapshot.disk = value; }),
      read("git", "版本", "maintain", loadGit, value => { snapshot.git = value; }),
    ]);
  }

  /** 告警按严重度排序在前，常用入口固定在后；attention 只数前半段。 */
  private todos(snapshot: Snapshot): Todo[] {
    const list: Todo[] = [...this.errors.values()];
    const { git } = snapshot;

    if (git?.dirty) {
      list.push({
        status: "danger",
        text: "已跟踪文件有未提交改动，升级会被拒绝",
        hint: "系统",
        target: "maintain",
      });
    }
    if (git && git.behind > 0) {
      list.push({
        status: "warn",
        text: `origin/main 领先 ${git.behind} 个提交`,
        hint: "系统",
        target: "maintain",
      });
    }
    if (git && git.ahead > 0 && git.branch === "main") {
      list.push({
        status: "serious",
        text: `本地有 ${git.ahead} 个未推送的提交，无法快进升级`,
        hint: "系统",
        target: "maintain",
      });
    }

    const { stale, total } = this.tmpBytes(snapshot);
    if (stale > 0) {
      list.push({
        status: "warn",
        text: `tmp 占用 ${fmt.bytes(total)}，其中 ${fmt.bytes(stale)} 超过 ${STALE_DAYS} 天未改动`,
        hint: "数据",
        target: "storage",
      });
    }

    list.push({ status: "idle", text: "查看服务、隧道与配置的逐项体检", hint: "监控", target: "health" });
    const severity: Record<string, number> = { danger: 0, serious: 1, warn: 2, idle: 3 };
    return [
      ...list.sort((a, b) => severity[a.status]! - severity[b.status]!),
      { status: "idle", text: "查看运行日志，排查异常与任务", hint: "监控", target: "logs" },
      { status: "idle", text: "查看群用量，导出使用报表", hint: "统计", target: "stats" },
      { status: "idle", text: "启动、重启、升级与部署修复", hint: "系统", target: "maintain" },
    ];
  }

  /** 需要关注的条数，不含常驻入口——分隔线右端报的就是这个数。 */
  private attention(snapshot: Snapshot): number {
    return this.todos(snapshot).filter(todo => todo.status !== "idle").length;
  }

  /** 临时目录的总占用，以及其中超过 STALE_DAYS 没动过、可以归档的那部分。 */
  private tmpBytes(snapshot: Snapshot): { total: number; stale: number } {
    const cutoff = Date.now() - STALE_DAYS * 86_400_000;
    let stale = 0;
    for (const user of snapshot.tmp ?? []) {
      for (const entry of user.entries) if (entry.newest <= cutoff) stale += entry.bytes;
    }
    return { total: (snapshot.tmp ?? []).reduce((sum, user) => sum + user.bytes, 0), stale };
  }

  onKey(key: { name: string }, app: AppApi): boolean {
    if (["health", "logs", "stats", "maintain"].includes(key.name)) { app.go(key.name); return true; }
    if (this.state.kind !== "ready") return false;
    const todos = this.todos(this.state.value);
    const moved = moveSelection(key.name, this.selected, todos.length);
    if (moved !== null) { this.selected = moved; return true; }
    if (key.name === "enter" && todos[this.selected]) { app.go(todos[this.selected]!.target); return true; }
    return false;
  }

  /**
   * 四个指标块。
   *
   * 变化量用中性的次级色加箭头，不用红绿：提问变多既不是好消息也不是坏消息，
   * 而红绿在这个界面里已经被「出没出问题」占用了，借去表示「涨没涨」会让两种意思互相污染。
   */
  private tiles(ctx: ViewContext, snapshot: Snapshot): string[] {
    const { theme, width: total } = ctx;
    const { asks, people, files } = snapshot.today ?? { asks: 0, people: 0, files: 0 };
    const trend = snapshot.trend;
    const yesterday = trend.at(-2);
    const { total: tmp } = this.tmpBytes(snapshot);
    const placeholder = (id: string) => this.errors.has(id) ? "读取失败" : "读取中";

    const change = (now: number, before: number | undefined): { text: string } | undefined => {
      if (before === undefined || (before === 0 && now === 0)) return undefined;
      const diff = now - before;
      if (diff === 0) return { text: "持平" };
      return { text: `${diff > 0 ? "↑" : "↓"}${Math.abs(diff)}` };
    };

    const specs = [
      // 峰值不在这里标：下面趋势图的标题里已经有一个，同一个数字在一屏上出现两次没有意义。
      { label: "今日提问", value: snapshot.today ? `${fmt.count(asks)} 次` : placeholder("stats"), delta: change(asks, yesterday?.asks),
        trend: trend.map(point => point.asks) },
      { label: "活跃成员", value: snapshot.today ? `${fmt.count(people)} 人次` : placeholder("stats"), delta: change(people, yesterday?.people),
        trend: trend.map(point => point.people) },
      { label: "已送附件", value: snapshot.today ? `${fmt.count(files)} 份` : placeholder("stats"), delta: change(files, yesterday?.files),
        trend: trend.map(point => point.files) },
      // 磁盘没有历史值，换个更该问的问题：这些占用里临时目录占了多大一块。
      // 只画一段、配一行文字说明它是什么——两段不同颜色而没有图例，等于让颜色单独承载语义，
      // 何况「其中多少可以清理」在下面的待办里已经用整句话写着了。
      { label: "数据占用", value: snapshot.disk === null ? placeholder("disk") : fmt.bytes(snapshot.disk),
        ...(snapshot.disk !== null && snapshot.tmp !== null
          ? { meter: { total: snapshot.disk, segments: [{ value: tmp, color: "accent" as const }] } } : {}),
        foot: snapshot.tmp === null ? `tmp ${placeholder("tmp")}` : `tmp ${fmt.bytes(tmp)}` },
    ];

    // 左右各留一列装订线，四块之间留两列——指标块没有边框，块与块之间只剩留白在分隔。
    const inner = total - 2;
    const cell = Math.floor((inner - 6) / 4);
    const widths = [cell, cell, cell, inner - 6 - cell * 3];
    return sideBySide(specs.map((spec, i) => tile(theme, { ...spec, width: widths[i]! })), widths, 2)
      .map(line => pad(` ${line}`, total));
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "暂无数据");
    if (waiting) return waiting;
    const snapshot = (this.state as { value: Snapshot }).value;
    const todos = this.todos(snapshot);
    const wide = total >= 96;

    const out = this.tiles(ctx, snapshot);
    out.push(gap(total));

    // 下半屏先按内容要多少给多少：待办列表最少留三行，部署信息固定六行，剩下的才归趋势图。
    const listRows = Math.max(3, Math.min(todos.length, 8));
    const bottom = Math.max(listRows, wide ? 6 : 0) + 1;
    const chartRoom = height - out.length - bottom - 2;

    if (snapshot.today && chartRoom >= MIN_CHART_ROWS + 2) {
      const peak = Math.max(0, ...snapshot.trend.map(point => point.asks));
      out.push(rule(theme, total, `近 ${TREND_DAYS} 天提问`,
        `峰值 ${peak} · 今日 ${snapshot.today.groups} 群 / ${snapshot.today.images} 图`));
      out.push(...columnChart(theme, {
        width: total, height: Math.min(6, chartRoom - 2), values: snapshot.trend.map(point => point.asks),
        labels: snapshot.trend.map(point => point.day.slice(5)),
      }));
      out.push(gap(total));
    }

    const mainWidth = wide ? Math.floor(total * 0.64) : total;
    const sideWidth = total - mainWidth - COLUMN_GAP;
    const attention = this.attention(snapshot);
    const room = Math.max(1, height - out.length - 1);
    const start = windowStart(this.selected, todos.length, room);

    const tasks = [
      rule(theme, mainWidth, "待处理与常用入口", attention ? `${attention} 项待关注` : "日常管理",
        attention ? "warn" : "accent"),
      ...table(theme, {
        width: mainWidth,
        rows: todos.slice(start, start + room),
        selected: this.selected - start,
        gap: 1,
        columns: [
          { header: "", size: 2, render: (todo) => mark(theme, todo.status) },
          { header: "", flex: 1, render: (todo) => todo.text },
          { header: "", size: 7, align: "right", render: (todo) => theme.c("muted", `→ ${todo.hint}`) },
        ],
      }),
    ];

    const version = snapshot.git ? `${snapshot.git.branch}@${fmt.shortSha(snapshot.git.sha)}`
      : this.loading.has("git") ? "版本读取中" : this.errors.has("git") ? "版本读取失败" : "非 git 部署";
    if (!wide) {
      out.push(...tasks);
      out.push(pad(` ${theme.c("muted", describeDeployment(ctx, version))}`, total));
      return out;
    }

    const info = [
      rule(theme, sideWidth, "部署"),
      ...fields(theme, [
        ["运行方式", ctx.deployment.runtime === "docker" ? "Docker" : "计划任务"],
        ["监听端口", String(ctx.deployment.port)],
        ["域名", ctx.deployment.domain || "未设置"],
        ["版本", snapshot.git ? fmt.shortSha(snapshot.git.sha) : version],
        ["分支", snapshot.git?.branch || "—"],
        ["数据根", ctx.deployment.groupDataRootIsCustom ? ctx.deployment.groupDataRoot : "data/groups"],
      ], sideWidth, 9),
    ];
    out.push(...sideBySide([tasks, info], [mainWidth, sideWidth], COLUMN_GAP));
    return out;
  }
}

/** 窄窗口下部署信息压成一行，只留需要核对的几项。 */
function describeDeployment(ctx: ViewContext, version: string): string {
  return [
    ctx.deployment.runtime === "docker" ? "Docker" : "计划任务",
    `:${ctx.deployment.port}`,
    ctx.deployment.domain || "未设域名",
    version,
  ].join(" · ");
}
