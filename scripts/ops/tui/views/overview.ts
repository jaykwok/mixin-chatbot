// 总览。回答三个问题：它活着吗、今天被用了多少、有什么该我处理的。
//
// 「待办」是这一页的核心，也是整个界面存在的理由：原来这些结论散在 doctor、stat、tmp-ls
// 和 git 四条命令里，得分别跑一遍再自己拼。这里把它们合成一张按严重度排序的清单。
//
// 有告警时清单只列告警（服务没运行排在最前，回车直达「启动」），常用入口压成表下一行提示；
// 没有告警时才列出常用入口，入口一律是灰色的 ○，回车同样是「去处理」。
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
  probeService,
  type DailyPoint,
  type GitState,
  type RecentStats,
  type Service,
  type UserTmp,
} from "../data.ts";
import { PROJECT_DIR } from "../platform.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";
import { versionFacts, versionRows, type VersionFacts } from "../../version-info.ts";
import { describeAttention } from "../../directory-admin.ts";

const TREND_DAYS = 14;
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
  /** 事件 Stream 与通讯录同步取自服务的 /health；服务没应答时为 unreachable。 */
  service: Service | null;
  /** 运行中（或最近部署）的程序版本、数据格式，与本地工具版本。 */
  version: VersionFacts | null;
}

/** Stream 断开不到这么久算正在重连，超过才按故障提示——与体检的判定一致。 */
const STREAM_GRACE_MS = 120_000;

interface Todo {
  status: StatusName;
  text: string;
  hint: string;
  target: string;
  /** 目标页预选的一项。 */
  focus?: string;
}

/** 有告警时代替常用入口的一行提示。 */
const ENTRY_HINT = "日志、体检、统计、数据与部署见顶部分区（←→ 或数字键切换）";

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
    ];
  }

  async refresh(app: AppApi): Promise<void> {
    const revision = ++this.revision;
    const root = app.deployment.dataRoot;
    const snapshot: Snapshot = this.state.kind === "ready" && (this.root === undefined || this.root === root) ? { ...this.state.value }
      : { today: null, trend: [], tmp: null, disk: null, git: null, service: null, version: null };
    this.root = root;
    // "ready" means the page has a snapshot to render, including placeholders.
    // Per-source loading/errors below track data readiness; navigation stays usable.
    this.state = { kind: "ready", value: snapshot };
    this.loading = new Set(["stats", "tmp", "disk", "git", "service", "version"]);
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
          hint: target === "stats" ? "统计" : target === "maintain" ? "系统" : target === "health" ? "监控" : "数据", target });
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
    const git = loadGit(), service = probeService(app.deployment.port);
    await Promise.all([
      read("stats", "统计", "stats", () => loadRecentStats(root, TREND_DAYS), value => {
        snapshot.today = value.today;
        snapshot.trend = value.trend;
      }),
      read("tmp", "临时目录", "storage", () => loadTmp(root), value => { snapshot.tmp = value; }),
      read("disk", "磁盘占用", "storage", () => loadDiskUsage([root]), value => { snapshot.disk = value; }),
      read("git", "代码", "maintain", () => git, value => { snapshot.git = value; }),
      read("service", "服务状态", "health", () => service, value => { snapshot.service = value; }),
      // 本地构建取自同一次 Git 查询，不另起进程。
      read("version", "版本", "health", async () => {
        const [running, local] = await Promise.all([service, git.catch(() => null)]);
        return versionFacts(PROJECT_DIR, running.program, local ? local.sha.slice(0, 12) + (local.dirty ? "-dirty" : "") : "");
      }, value => { snapshot.version = value; }),
    ]);
  }

  /** 告警按严重度排序；没有告警时才是常用入口。 */
  private todos(snapshot: Snapshot): Todo[] {
    const list: Todo[] = [...this.errors.values()];
    const { git, service } = snapshot;

    if (service?.state === "unreachable") {
      list.push({ status: "danger", text: "机器人未运行或没有应答，群里的消息不会被处理", hint: "系统", target: "maintain", focus: "start" });
    } else if (service?.state === "stopping") {
      list.push({ status: "warn", text: "机器人正在停止，停止后不再处理消息", hint: "系统", target: "maintain" });
    } else if (service?.state === "verifying") {
      list.push({ status: "warn", text: "这是不连接平台的验证实例，不处理群消息", hint: "监控", target: "health" });
    }
    // 计数自服务启动、到重启才清零：只把最近一天内发生过的列为待办，细节在日志里。窄栏放不下「自本次启动」，体检行里有。
    for (const event of describeAttention(service?.state === "ready" ? service.attention : undefined)) {
      if (!event.recent) continue;
      list.push({ status: event.kind === "parked" || event.kind === "faulted" ? "serious" : "warn",
        text: event.text, hint: "监控", target: "logs" });
    }

    const stream = service?.state === "ready" ? service.stream : undefined;
    if (stream && !stream.connected) {
      const since = stream.disconnectedSince;
      const long = !since || Date.now() - since >= STREAM_GRACE_MS;
      list.push({
        status: long ? "danger" : "warn",
        text: `事件 Stream ${long ? "未连接，收不到群消息" : "刚断开，正在重连"}${stream.lastDisconnect ? `：${stream.lastDisconnect.reason}` : ""}`,
        hint: "监控",
        target: "health",
      });
    }
    const directory = service?.directory;
    if (directory?.pending) {
      list.push({
        status: "serious",
        text: `通讯录第 ${directory.pending.scanId} 轮缺席 ${directory.pending.count} 人，撤销已暂停待确认`,
        hint: "系统",
        target: "directory",
      });
    } else if (directory?.lastScan && !directory.lastScan.complete) {
      list.push({ status: "warn", text: "上一轮通讯录同步没有完成", hint: "系统", target: "directory" });
    }

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

    const severity: Record<string, number> = { danger: 0, serious: 1, warn: 2, idle: 3 };
    if (list.length) return list.sort((a, b) => severity[a.status]! - severity[b.status]!);

    // File age does not establish that current conversations or pending deliveries released it.
    // Offer inspection without repeatedly presenting retained data as a cleanup warning.
    return [
      ...(this.tmpBytes(snapshot).total > 0 ? [{ status: "idle", text: "查看临时文件占用与可归档清单", hint: "数据", target: "storage" } as Todo] : []),
      { status: "idle", text: "查看服务、Stream 与配置的逐项体检", hint: "监控", target: "health" },
      { status: "idle", text: "查看运行日志，排查异常与任务", hint: "监控", target: "logs" },
      { status: "idle", text: "查看群用量，导出使用报表", hint: "统计", target: "stats" },
      { status: "idle", text: "启动、重启、升级与部署修复", hint: "系统", target: "maintain" },
    ];
  }

  /** 需要关注的条数，不含常用入口——分隔线右端报的就是这个数。 */
  private attention(snapshot: Snapshot): number {
    return this.todos(snapshot).filter(todo => todo.status !== "idle").length;
  }

  /** Occupancy is independent of whether an offline plan can reclaim any of it. */
  private tmpBytes(snapshot: Snapshot): { total: number } {
    return { total: (snapshot.tmp ?? []).reduce((sum, user) => sum + user.bytes, 0) };
  }

  onKey(key: { name: string }, app: AppApi): boolean {
    if (this.state.kind !== "ready") return false;
    const todos = this.todos(this.state.value);
    const moved = moveSelection(key.name, this.selected, todos.length);
    if (moved !== null) { this.selected = moved; return true; }
    const todo = todos[this.selected];
    if (key.name === "enter" && todo) { app.go(todo.target, todo.focus); return true; }
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
    const { asks, people, tokens } = snapshot.today ?? { asks: 0, people: 0, tokens: 0 };
    const trend = snapshot.trend;
    const yesterday = trend.at(-2);
    const { total: tmp } = this.tmpBytes(snapshot);
    const placeholder = (id: string) => this.errors.has(id) ? "读取失败" : "读取中";

    const change = (now: number, before: number | undefined): { text: string } | undefined => {
      if (before === undefined || (before === 0 && now === 0)) return undefined;
      const diff = now - before;
      if (diff === 0) return { text: "持平" };
      return { text: `${diff > 0 ? "↑" : "↓"}${fmt.count(Math.abs(diff))}` };
    };

    const specs = [
      // 峰值不在这里标：下面趋势图的标题里已经有一个，同一个数字在一屏上出现两次没有意义。
      { label: "今日提问", value: snapshot.today ? `${fmt.count(asks)} 次` : placeholder("stats"), delta: change(asks, yesterday?.asks),
        trend: trend.map(point => point.asks) },
      { label: "活跃成员", value: snapshot.today ? `${fmt.count(people)} 人` : placeholder("stats"), delta: change(people, yesterday?.people),
        trend: trend.map(point => point.people) },
      { label: "今日 token", value: snapshot.today ? fmt.count(tokens) : placeholder("stats"), delta: change(tokens, yesterday?.tokens),
        trend: trend.map(point => point.tokens) },
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
    const attention = this.attention(snapshot);
    const listRows = Math.max(3, Math.min(todos.length + (attention ? 1 : 0), 8));
    const bottom = Math.max(listRows, wide ? 6 : 0) + 1;
    const chartRoom = height - out.length - bottom - 2;

    if (snapshot.today && chartRoom >= MIN_CHART_ROWS + 2) {
      const peak = Math.max(0, ...snapshot.trend.map(point => point.asks));
      out.push(rule(theme, total, `近 ${TREND_DAYS} 天提问`,
        `峰值 ${peak} · 今日 ${snapshot.today.groups} 群`));
      out.push(...columnChart(theme, {
        width: total, height: Math.min(6, chartRoom - 2), values: snapshot.trend.map(point => point.asks),
        labels: snapshot.trend.map(point => point.day.slice(5)),
      }));
      out.push(gap(total));
    }

    const mainWidth = wide ? Math.floor(total * 0.64) : total;
    const sideWidth = total - mainWidth - COLUMN_GAP;
    // 有告警时最后一行留给入口提示；只剩一行时先保证告警本身。
    const space = Math.max(1, height - out.length - 1);
    const footer = attention > 0 && space >= 2;
    const room = space - (footer ? 1 : 0);
    const start = windowStart(this.selected, todos.length, room);

    const tasks = [
      rule(theme, mainWidth, attention ? "待处理" : "常用入口", attention ? `${attention} 项待关注` : "日常管理",
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
      ...(footer ? [pad(` ${theme.c("muted", ENTRY_HINT)}`, mainWidth)] : []),
    ];

    const rows = snapshot.version ? versionRows(snapshot.version) : undefined;
    const version = rows ? rows[0]![1] : this.loading.has("version") ? "版本读取中" : "版本读取失败";
    if (!wide) {
      out.push(...tasks);
      out.push(pad(` ${theme.c("muted", describeDeployment(version, snapshot))}`, total));
      return out;
    }

    // 运行方式和端口已在页眉右上角；版本与构建并成一行，侧栏在 24 行高时也放得下。
    const build = rows?.find(([name]) => name === "构建")?.[1];
    const info = [
      rule(theme, sideWidth, "部署"),
      ...fields(theme, [
        ["消息接收", describeIntake(snapshot, this.loading.has("service"))],
        ["运行版本", build && build !== "—" ? `${version} · ${build}` : version],
        ...(rows ?? []).filter(([name]) => name !== "应用机器人" && name !== "构建"),
        ["本地代码", snapshot.git ? `${snapshot.git.branch}@${fmt.shortSha(snapshot.git.sha)}`
          : this.loading.has("git") ? "读取中" : this.errors.has("git") ? "读取失败" : "非 git 部署"],
        ["共享资料", ctx.deployment.workspaceRoot || "data/workspace"],
      ], sideWidth, 11),
    ];
    out.push(...sideBySide([tasks, info], [mainWidth, sideWidth], COLUMN_GAP));
    return out;
  }
}

/** 消息从事件 Stream 进来；服务没应答时连接状态无从得知。 */
function describeIntake(snapshot: Snapshot, loading: boolean): string {
  const service = snapshot.service;
  if (!service) return loading ? "读取中" : "未知";
  if (service.state === "verifying") return "验证实例";
  if (service.state !== "ready") return "服务未应答";
  if (!service.stream) return "未知";
  return service.stream.connected ? "Stream 已连接" : "Stream 未连接";
}

/** 窄窗口下部署信息压成一行，只留需要核对的几项；运行方式和端口已在页眉。 */
function describeDeployment(version: string, snapshot: Snapshot): string {
  return [describeIntake(snapshot, false), version].join(" · ");
}
