// 总览。回答三个问题：它活着吗、今天被用了多少、有什么该我处理的。
//
// 「待办」是这一页的核心，也是整个界面存在的理由：原来这些结论散在 doctor、stat、tmp-ls
// 和 git 四条命令里，得分别跑一遍再自己拼。这里把它们合成一张按严重度排序的清单。

import { box, columns as sideBySide, fields, mark, sparkline, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import type { StatusName } from "../render/theme.ts";
import * as fmt from "../render/format.ts";
import {
  loadRecentStats,
  loadDiskUsage,
  loadGit,
  loadTmp,
  type GitState,
  type RecentStats,
  type UserTmp,
} from "../data.ts";
import { PROJECT_DIR } from "../platform.ts";
import type { AppApi, Loading, View, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";
import { join } from "node:path";

const TREND_DAYS = 14;
/** 超过这些天没动过的 tmp 条目算「可以清了」，与 tmp-purge --days 的默认建议一致。 */
const STALE_DAYS = 30;

interface Snapshot {
  today: RecentStats["today"];
  trend: { day: string; asks: number }[];
  tmp: UserTmp[];
  disk: number;
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

  hints(): [string, string][] {
    return [["↑↓", "选择待办"], ["Enter", "前往"]];
  }

  async refresh(app: AppApi): Promise<void> {
    this.state = { kind: "loading" };
    app.redraw();
    const root = app.deployment.groupDataRoot;
    try {
      const [{ today, trend }, tmp, disk, git] = await Promise.all([
        loadRecentStats(root, TREND_DAYS),
        loadTmp(root),
        loadDiskUsage([join(PROJECT_DIR, "data"), root]),
        loadGit(),
      ]);
      this.state = { kind: "ready", value: { today, trend, tmp, disk, git } };
      this.selected = Math.min(this.selected, this.todos(this.state.value).length - 1);
    } catch (error) {
      this.state = { kind: "error", message: `读取失败：${String(error)}` };
    }
    app.redraw();
  }

  /** 待办按严重度排序；没有文件侧待办也保留逐项体检入口。 */
  private todos(snapshot: Snapshot): Todo[] {
    const list: Todo[] = [];
    const { git, tmp } = snapshot;

    if (git?.dirty) {
      list.push({
        status: "danger",
        text: "已跟踪文件有未提交改动，升级会被拒绝",
        hint: "维护",
        target: "maintain",
      });
    }
    if (git && git.behind > 0) {
      list.push({
        status: "warn",
        text: `origin/main 领先 ${git.behind} 个提交`,
        hint: "维护",
        target: "maintain",
      });
    }
    if (git && git.ahead > 0 && git.branch === "main") {
      list.push({
        status: "serious",
        text: `本地有 ${git.ahead} 个未推送的提交，无法快进升级`,
        hint: "维护",
        target: "maintain",
      });
    }

    const stale = tmp.flatMap((user) =>
      user.entries.filter((entry) => Date.now() - entry.newest > STALE_DAYS * 86_400_000)
    );
    const staleBytes = stale.reduce((sum, entry) => sum + entry.bytes, 0);
    const tmpBytes = tmp.reduce((sum, user) => sum + user.bytes, 0);
    if (staleBytes > 0) {
      list.push({
        status: "warn",
        text: `tmp 占用 ${fmt.bytes(tmpBytes)}，其中 ${fmt.bytes(staleBytes)} 超过 ${STALE_DAYS} 天未改动`,
        hint: "存储",
        target: "storage",
      });
    }

    list.push({ status: "idle", text: "查看服务、隧道与配置的逐项体检", hint: "健康", target: "health" });
    const severity: Record<string, number> = { danger: 0, serious: 1, warn: 2, idle: 3 };
    return list.sort((a, b) => severity[a.status]! - severity[b.status]!);
  }

  onKey(key: { name: string }, app: AppApi): boolean {
    if (this.state.kind !== "ready") return false;
    const todos = this.todos(this.state.value);
    const moved = moveSelection(key.name, this.selected, todos.length);
    if (moved !== null) { this.selected = moved; return true; }
    if (key.name === "enter") { app.go(todos[this.selected]!.target); return true; }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total } = ctx;
    const waiting = pending(theme, total, this.state, "暂无数据");
    if (waiting) return waiting;
    const snapshot = (this.state as { value: Snapshot }).value;

    const { asks, people, files, images, groups } = snapshot.today;

    const half = Math.floor((total - 1) / 2);
    const rest = total - 1 - half;

    const left = box(theme, {
      width: half,
      title: "部署",
      accent: "accent",
      body: fields(
        theme,
        [
          ["群数据根", ctx.deployment.groupDataRootIsCustom ? ctx.deployment.groupDataRoot : "data/groups（默认）"],
          ["占用", fmt.bytes(snapshot.disk)],
          ["域名", ctx.deployment.domain || "未设置"],
          [
            "版本",
            snapshot.git
              ? `${fmt.shortSha(snapshot.git.sha)} · ${snapshot.git.branch}`
              : "非 git 部署",
          ],
        ],
        half - 4,
        10
      ),
    });

    const right = box(theme, {
      width: rest,
      title: "今日",
      accent: "accent",
      body: fields(
        theme,
        [
          ["提问", `${asks} 次`],
          ["活跃成员", `${people} 人次`],
          ["已送附件", images > 0 ? `${files} 份 · ${images} 图` : `${files} 份`],
          ["活跃群", `${groups} 个`],
        ],
        rest - 4,
        10
      ),
    });

    const out: string[] = [];
    out.push(...sideBySide([left, right], [half, rest]));
    out.push(gap(total));

    // 趋势线：只表达形状，精确数字在统计页。峰值标出来，否则一条没有刻度的曲线无法判断量级。
    const values = snapshot.trend.map((point) => point.asks);
    const peak = Math.max(0, ...values);
    const spark = sparkline(theme, values);
    const label = `${theme.c("muted", `近 ${TREND_DAYS} 天提问`)}  ${spark}  ${theme.c("muted", `峰值 ${peak}`)}`;
    out.push(pad(` ${label}`, total));
    out.push(gap(total));

    const todos = this.todos(snapshot);
    const room = Math.max(1, ctx.height - out.length - 2);
    const start = windowStart(this.selected, todos.length, room);
    out.push(
      ...box(theme, {
        width: total,
        title: "待办",
        note: `${this.selected + 1} / ${todos.length} · Enter 前往`,
        body: table(theme, {
          width: total - 4,
          rows: todos.slice(start, start + room),
          selected: this.selected - start,
          gap: 2,
          columns: [
            { header: "", size: 2, render: (todo) => mark(theme, todo.status) },
            { header: "", flex: 1, render: (todo) => todo.text },
            {
              header: "",
              size: 8,
              align: "right",
              render: (todo) => (todo.hint ? theme.c("muted", `→ ${todo.hint}`) : ""),
            },
          ],
        }).slice(1), // 这张表不需要表头行
      })
    );
    return out;
  }
}
