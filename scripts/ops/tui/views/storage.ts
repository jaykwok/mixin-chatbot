// 存储。各用户临时目录的占用与清理。
//
// 这一页比命令行多出来的那点东西，全在「按天数先看会删掉多少，再决定要不要删」：
// tmp 里混着可重建的缓存和用户真正生成的交付物，一条不看时间的 purge 太容易把某个正在跑
// 的任务的中间产物一起端掉。所以确认框里给的是这次实际会命中的条目数和字节数，不是泛泛的
// 「确定吗」。

import { box, meter, rule, table, wrap } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import * as fmt from "../render/format.ts";
import { loadTmp, type UserTmp } from "../data.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, ListFilter, moveSelection, pending, windowStart } from "./common.ts";

const DAY = 86_400_000;
/** 清理天数通过 d 的方向键菜单选择，左右键始终用于切页。 */
const PRESETS = [90, 60, 30, 14, 7, 3, 0] as const;

export class StorageView implements View {
  readonly id = "storage";
  readonly label = "临时文件";
  private state: Loading<UserTmp[]> = { kind: "idle" };
  private selected = 0;
  private presetIndex = 2; // 默认 30 天
  private filter = new ListFilter();
  private expanded = false;
  private scroll = new Viewport();

  private get days(): number {
    return PRESETS[this.presetIndex]!;
  }

  hints(): [string, string][] {
    return [
      ...(this.expanded ? [["Esc", "返回"], ["↑↓", "滚动"]] : [["↑↓", "选择"], ["Enter", "文件"], ["/", "筛选"]]) as [string, string][],
      ["d", this.days === 0 ? "不限时间" : `${this.days} 天`],
      ["p", "清当前"],
    ];
  }

  actions(): ViewAction[] {
    return [
      ...(this.expanded ? [{ value: "escape", label: "返回成员列表" }]
        : [{ value: "enter", label: "查看选中成员的文件", disabled: !this.users.length },
          { value: "/", label: "筛选群或成员", description: "按群名、成员号码或打码后的号码查找" }]),
      { value: "d", label: "选择清理天数", description: `当前：${this.days === 0 ? "不限时间" : `${this.days} 天未改动`}；选择后重新预览` },
      { value: "p", label: "清理当前群的选中成员", description: "先预览命中条目与大小，再确认归档", danger: true, disabled: !this.users.length },
      { value: "a", label: "清理所有群的所有成员", description: "按当前天数处理全部成员，不受列表筛选影响", danger: true,
        disabled: this.state.kind !== "ready" || !this.state.value.length },
    ];
  }

  private get users(): UserTmp[] {
    return this.state.kind === "ready" ? this.state.value.filter(user =>
      this.filter.matches(user.group, user.user, fmt.maskUser(user.user))
    ) : [];
  }

  async refresh(app: AppApi): Promise<void> {
    this.state = { kind: "loading" };
    app.redraw();
    try {
      const users = await loadTmp(app.deployment.groupDataRoot);
      this.state = { kind: "ready", value: users };
      this.selected = Math.min(this.selected, Math.max(0, this.users.length - 1));
      if (!this.users.length) this.expanded = false;
    } catch (error) {
      this.state = { kind: "error", message: `读取失败：${String(error)}` };
    }
    app.redraw();
  }

  /** 按当前天数阈值，统计这次 purge 会命中什么。确认框要说的是这个，不是「确定吗」。 */
  private matched(users: UserTmp[]): { entries: number; bytes: number; keptEntries: number; keptBytes: number } {
    const cutoff = Date.now() - this.days * DAY;
    let entries = 0;
    let bytes = 0;
    let keptEntries = 0;
    let keptBytes = 0;
    for (const user of users) {
      for (const entry of user.entries) {
        if (entry.newest > cutoff) {
          keptEntries++;
          keptBytes += entry.bytes;
        } else {
          entries++;
          bytes += entry.bytes;
        }
      }
    }
    return { entries, bytes, keptEntries, keptBytes };
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (key.name === "escape" && this.expanded) { this.expanded = false; return true; }
    if (key.name === "escape" && this.filter.clear()) { this.selected = 0; return true; }
    if (key.name === "/" && !this.expanded) {
      if (await this.filter.edit(app, "筛选群名或成员")) this.selected = 0;
      return true;
    }
    if (key.name === "d") {
      const value = await app.choose({
        title: "选择清理天数", initial: String(this.days),
        description: "按最后改动时间预览可归档条目；选择条件本身不会清理文件。",
        choices: PRESETS.map(days => ({
          value: String(days), label: days ? `${days} 天未改动` : "不限时间 · 包含近期文件",
          description: days ? `保留最近 ${days} 天内改动过的文件` : "包括正在使用的近期文件；执行前须输入确认词",
          danger: days === 0,
        })),
      });
      const index = PRESETS.findIndex(days => String(days) === value);
      if (index >= 0) this.presetIndex = index;
      return true;
    }
    if (this.state.kind !== "ready") return false;
    const users = this.state.value;

    if (key.name === "[") {
      this.presetIndex = Math.max(0, this.presetIndex - 1);
      return true;
    }
    if (key.name === "]") {
      this.presetIndex = Math.min(PRESETS.length - 1, this.presetIndex + 1);
      return true;
    }
    if (this.expanded && this.scroll.onKey(key.name)) return true;
    const visible = this.users;
    if (key.name === "enter" && visible[this.selected]) {
      this.expanded = true;
      this.scroll.reset();
      return true;
    }
    const moved = this.expanded ? null : moveSelection(key.name, this.selected, visible.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }

    if (key.name === "p" || key.name === "a") {
      const current = visible[this.selected];
      const all = key.name === "a";
      if (!all && !current) return true;
      const days = this.days;
      const scope = all ? "所有群的所有成员（不受列表筛选影响）" : `群 ${current!.group} · 成员 ${fmt.maskUser(current!.user)}`;
      const hit = this.matched(all ? users : [current!]);
      if (hit.entries === 0) {
        app.toast("idle", `${scope}：没有符合条件的条目`);
        return true;
      }
      const ok = await app.confirm({
        title: all ? "清理所有成员临时目录" : "清理当前成员临时目录",
        subject: `${scope}：${this.days === 0 ? "不限时间" : `${this.days} 天未改动`}，${hit.entries} 个条目、${fmt.bytes(hit.bytes)}`,
        steps: [
          "要求维护租约，运行中的机器人会阻止本操作",
          `命中的条目移入 backup/rm（${fmt.bytes(hit.bytes)}）`,
          hit.keptEntries > 0
            ? `保留 ${hit.keptEntries} 个近期改动过的条目（${fmt.bytes(hit.keptBytes)}）`
            : "没有条目会被保留",
        ],
        untouched: ["tmp 目录本身", "workspace", "session.jsonl"],
        recovery: "可以，文件在 backup/rm 下，按原路径还原即可（磁盘空间此时还没释放）",
        typeToConfirm: this.days === 0 ? (all ? "全部清理" : "清理当前") : undefined,
        danger: this.days === 0,
      });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
      const args = days === 0 ? ["tmp-purge", "--all"] : ["tmp-purge", "--days", String(days)];
      if (!all) args.push("--group", current!.group, "--user", current!.user, "--storage-segment");
      const code = await app.run(`清理 · ${scope}`, args);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "清理完成" : "清理未完成，请看输出");
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "还没有任何用户临时目录");
    if (waiting) return waiting;
    const all = (this.state as { value: UserTmp[] }).value;
    if (all.length === 0) {
      return [gap(total), pad(`  ${theme.c("muted", "还没有任何用户临时目录")}`, total)];
    }

    const users = this.users;
    const totalBytes = all.reduce((sum, user) => sum + user.bytes, 0);
    const hit = this.matched(all);
    const current = users[this.selected];
    const currentHit = this.matched(current ? [current] : []);
    const condition = this.days === 0 ? "不限时间" : `${this.days} 天未改动`;
    if (this.expanded && current) {
      const summary = box(theme, {
        width: total, title: `${current.group} › ${fmt.maskUser(current.user)}`, note: condition, accent: "accent",
        body: [`待归档 ${currentHit.entries} 个 · ${fmt.bytes(currentHit.bytes)}；保留 ${currentHit.keptEntries} 个`],
      });
      const cutoff = Date.now() - this.days * DAY;
      const content = current.entries.flatMap(entry => [
        theme.c(entry.newest <= cutoff ? "warn" : "ok", entry.newest <= cutoff ? "待归档  " : "保留    ") + entry.name,
        theme.c("muted", `        ${fmt.bytes(entry.bytes)} · ${fmt.since(entry.newest)}`),
      ]).flatMap(line => wrap(line, total - 4));
      const lines = this.scroll.slice(content, Math.max(1, height - summary.length - 3));
      return [...summary, gap(total), ...box(theme, {
        width: total, title: "文件与清理范围", note: this.scroll.label, body: lines,
      })];
    }
    // 清理预览固定占最后三行，列表拿走中间全部高度。预览是这一页存在的理由，不是装饰，
    // 所以它的位置不随列表长短漂移——每次来都在同一个地方。
    const preview = [
      rule(theme, total, `清理预览 · ${condition}`, "归档后空间尚未释放", hit.entries ? "warn" : "faint"),
      this.previewRow(theme, total, "p 当前", currentHit,
        current ? `${current.group} / ${fmt.maskUser(current.user)}` : "未选择成员"),
      this.previewRow(theme, total, "a 全部", hit, "所有群与成员，忽略筛选"),
    ];
    const room = Math.max(1, height - preview.length - 2);
    const start = windowStart(this.selected, users.length, room);
    const visible = users.slice(start, start + room);

    const out = [
      // 筛选生效时让位给筛选状态：此刻「匹配到几条、怎么清掉筛选」比总占用更需要看到。
      rule(theme, total, "用户临时目录", (this.filter.value
        ? this.filter.describe(users.length, all.length)
        : `${users.length ? `${start + 1}–${start + visible.length} / ${users.length}` : "无匹配"} · ${fmt.bytes(totalBytes)}`
      ) + " · d 改天数", "accent"),
      ...(users.length ? table(theme, {
        width: total,
        rows: visible,
        selected: this.selected - start,
        columns: [
          { header: "成员", flex: 1, render: (user) => fmt.maskUser(user.user) },
          { header: "群", size: Math.max(10, Math.floor(total * 0.16)), render: (user) => user.group },
          { header: "占用", size: 10, align: "right", render: (user) => fmt.bytes(user.bytes) },
          { header: "文件", size: 7, align: "right", render: (user) => String(user.files) },
          { header: "最后改动", size: 10, align: "right", render: (user) => fmt.since(user.newest) },
        ],
      }) : [pad(`  ${theme.c("muted", "没有匹配的群或成员；/ 修改筛选，Esc 清除")}`, total)]),
    ];
    while (out.length < height - preview.length) out.push(gap(total));
    out.push(...preview);
    return out;
  }

  /**
   * 一行清理预览：快捷键、比例条、数字、范围。
   *
   * 比例条画的是「这次会删掉的占这个范围的多大一块」——同样两个数字，读一条横条比读
   * 「3 个 · 5.60 GB，保留 2 个」快得多，而按下去之后就撤不回来了，值得让人看清楚。
   */
  private previewRow(
    theme: ViewContext["theme"], total: number, key: string,
    hit: { entries: number; bytes: number; keptEntries: number; keptBytes: number },
    scope: string
  ): string {
    const whole = hit.bytes + hit.keptBytes;
    const size = Math.max(6, Math.min(16, Math.floor(total * 0.14)));
    const gauge = meter(theme, [{ value: hit.bytes, color: hit.entries ? "warn" : "track" }], whole, size);
    const facts = `${hit.entries} 个 · ${fmt.bytes(hit.bytes)}`;
    return pad(
      ` ${theme.bold(key)}  ${gauge}  ${theme.c(hit.entries ? "warn" : "muted", pad(facts, 20))}` +
      `${theme.c("muted", `保留 ${hit.keptEntries} 个 · ${scope}`)}`,
      total
    );
  }
}
