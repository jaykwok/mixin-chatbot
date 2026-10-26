// 存储。各用户临时目录的占用与清理。
//
// 年龄只生成候选；停机预览读取全群持久引用，确认后按固定清单归档。

import { box, meter, rule, table, wrap } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import * as fmt from "../render/format.ts";
import { loadTmp, spaceName, type UserTmp } from "../data.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, ListFilter, moveSelection, pending, windowStart } from "./common.ts";
import { randomUUID } from "node:crypto";
import { readReclaimPlan, readReclaimProgress, readRemovalPlan, readRemovalProgress, readTmpPlan, readTmpProgress } from "../../../lib/tmp-plan.ts";

const DAY = 86_400_000;
/** 清理天数通过 d 的方向键菜单选择，左右键始终用于切页。 */
const PRESETS = [90, 60, 30, 14, 7, 3, 0] as const;

export class StorageView implements View {
  readonly id = "storage";
  readonly label = "临时文件";
  private state: Loading<UserTmp[]> = { kind: "idle" };
  private root: string | undefined;
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
          { value: "/", label: "筛选空间或成员", description: "按群名、「单聊」、成员号码或打码后的号码查找" }]),
      { value: "d", label: "选择清理天数", description: `当前：${this.days === 0 ? "不限时间" : `${this.days} 天未改动`}；选择后重新预览` },
      { value: "p", label: "清理选中成员（当前空间）", description: "先预览命中条目与大小，再确认归档", danger: true, disabled: !this.users.length },
      { value: "a", label: "清理所有空间的所有成员", description: "按当前天数处理全部成员，不受列表筛选影响", danger: true,
        disabled: this.state.kind !== "ready" || !this.state.value.length },
      { value: "x", label: "物理回收已登记的产物", description: "按当前天数预览所有空间，确认后永久删除，释放磁盘空间", danger: true },
      { value: "r", label: "永久删除归档", description: "预览 data/state/reclamation/backup/rm 中内容未变的归档，确认后释放磁盘空间", danger: true },
    ];
  }

  private get users(): UserTmp[] {
    return this.state.kind === "ready" ? this.state.value.filter(user =>
      this.filter.matches(user.space, spaceName(user.space), user.user, fmt.maskUser(user.user))
    ) : [];
  }

  async refresh(app: AppApi): Promise<void> {
    const rootChanged = this.root !== undefined && this.root !== app.deployment.dataRoot;
    if (rootChanged) {
      this.filter.clear();
      this.expanded = false;
      this.selected = 0;
      this.scroll.reset();
    }
    this.root = app.deployment.dataRoot;
    if (rootChanged || this.state.kind !== "ready") this.state = { kind: "loading" };
    app.redraw();
    try {
      const users = await loadTmp(app.deployment.dataRoot);
      this.state = { kind: "ready", value: users };
      this.selected = Math.min(this.selected, Math.max(0, this.users.length - 1));
      if (!this.users.length) this.expanded = false;
    } catch (error) {
      this.state = { kind: "error", message: `读取失败：${String(error)}` };
    }
    app.redraw();
  }

  /** Age-only candidates. Actual eligibility is obtained from the maintenance command before confirmation. */
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
        description: "按最后改动时间筛选候选；执行预览还会核对持久引用与运行状态。",
        choices: PRESETS.map(days => ({
          value: String(days), label: days ? `${days} 天未改动` : "不限时间 · 包含近期文件",
          description: days ? `保留最近 ${days} 天内改动过的文件` : "包括近期候选；仍保留有引用或可恢复任务的内容",
          danger: days === 0,
        })),
      });
      const index = PRESETS.findIndex(days => String(days) === value);
      if (index >= 0) this.presetIndex = index;
      return true;
    }
    if (key.name === "x" || key.name === "r") return this.permanent(key.name === "x" ? "reclaim" : "discard", app);
    if (this.state.kind !== "ready") return false;
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
      const scope = all ? "所有空间的所有成员（不受列表筛选影响）" : `${spaceName(current!.space)} · 成员 ${fmt.maskUser(current!.user)}`;
      const id = randomUUID(), root = app.deployment.dataRoot;
      const args = days === 0 ? ["tmp-preview", "--all"] : ["tmp-preview", "--days", String(days)];
      args.push("--plan", id);
      if (!all) args.push("--user", current!.user, ...(current!.space === "direct" ? ["--group", "direct"]
        : ["--group", current!.space.slice("groups/".length), "--storage-segment"]));
      if (await app.run(`核对归档范围 · ${scope}`, args) !== 0) { app.toast("danger", "预览失败，未执行归档，请看输出"); return true; }
      let plan;
      try { plan = await readTmpPlan(root, id); }
      catch (error) { app.toast("danger", `无法读取本次归档清单：${String(error)}`); return true; }
      if (!plan.ready) {
        app.toast(plan.deferred ? "warn" : "idle", `可归档 0 项；保留 ${plan.kept} 项，待处置 ${plan.deferred} 项。原因见预览输出`);
        return true;
      }
      const ok = await app.confirm({
        title: all ? "清理所有成员临时目录" : "清理当前成员临时目录",
        subject: `${scope}：${this.days === 0 ? "不限时间" : `${this.days} 天未改动`}，可归档 ${plan.ready} 个条目、${fmt.bytes(plan.bytes)}`,
        steps: [
          "短暂停机，取得维护租约后重验清单；完成后恢复原运行状态",
          `将清单中仍符合条件的条目移入 data/state/reclamation/backup/rm（最多 ${fmt.bytes(plan.bytes)}）`,
          `已确认保留 ${plan.kept} 项，待处置 ${plan.deferred} 项；新增引用或内容变化的条目仍会保留`,
        ],
        untouched: ["tmp 目录本身", "共享资料", "会话历史"],
        recovery: "按清单中的源路径和目标路径恢复；归档尚未释放磁盘空间，r 永久删除归档",
        typeToConfirm: this.days === 0 ? (all ? "全部清理" : "清理当前") : undefined,
        danger: this.days === 0,
      });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
      const code = await app.run(`归档 · ${scope}`, ["tmp-purge", "--plan", id, "--digest", plan.digest]);
      try {
        const done = await readTmpProgress(root, id, plan.digest);
        app.toast(code === 0 ? (done.done ? "ok" : "idle") : "warn",
          `已归档 ${done.done} 项，保留 ${done.kept} 项，待处置 ${done.deferred} 项，失败 ${done.failed} 项${code ? "；操作未完成，请看输出" : ""}`);
      } catch { app.toast("warn", "未取得完整归档结果，请看命令输出并保留原清单"); }
      return true;
    }
    return false;
  }

  /** Permanent deletion: physical reclamation of registered outputs, or of entries archived earlier. Same shape as
   * archival — a read-only preview beside the running service, then one maintenance window for the confirmed list. */
  private async permanent(kind: "reclaim" | "discard", app: AppApi): Promise<boolean> {
    const reclaim = kind === "reclaim", days = this.days, id = randomUUID(), root = app.deployment.dataRoot;
    const range = days === 0 ? "不限时间" : `${days} 天前登记`;
    const args = reclaim ? ["tmp-reclaim", ...(days === 0 ? ["--all"] : ["--days", String(days)]), "--plan", id] : ["tmp-discard", "--plan", id];
    if (await app.run(reclaim ? `核对物理回收范围 · 所有空间 · ${range}` : "核对可删除的归档", args) !== 0) {
      app.toast("danger", "预览失败，未删除任何内容，请看输出"); return true;
    }
    let plan;
    try { plan = reclaim ? await readReclaimPlan(root, id) : await readRemovalPlan(root, id); }
    catch (error) { app.toast("danger", `无法读取本次清单：${String(error)}`); return true; }
    if (!plan.ready) {
      app.toast(plan.deferred ? "warn" : "idle", `可删除 0 项；保留 ${plan.kept} 项，待处置 ${plan.deferred} 项。原因见预览输出`);
      return true;
    }
    const ok = await app.confirm({
      title: reclaim ? "物理回收已登记的临时产物" : "永久删除临时文件归档",
      subject: reclaim ? `所有空间：${range}，可回收 ${plan.ready} 项、${fmt.bytes(plan.bytes)}` : `可删除 ${plan.ready} 项归档、${fmt.bytes(plan.bytes)}`,
      steps: [
        "短暂停机，取得维护租约后逐项重验清单；完成后恢复原运行状态",
        reclaim ? "删除清单中仍无引用、内容未变的产物，并结算回收账本" : "删除清单中内容与归档时一致的条目，释放磁盘空间",
        `保留 ${plan.kept} 项，待处置 ${plan.deferred} 项；预览后有变化的条目不会删除`,
      ],
      untouched: reclaim ? ["归档", "共享资料", "会话历史"] : ["成员临时目录", "归档清单", "会话历史"],
      recovery: "不可恢复：删除后不能从归档或 Git 找回",
      typeToConfirm: "永久删除",
      danger: true,
    });
    if (!ok) { app.toast("idle", "已取消"); return true; }
    const code = await app.run(reclaim ? "物理回收" : "永久删除归档", [args[0]!, "--plan", id, "--digest", plan.digest]);
    try {
      const done = reclaim ? await readReclaimProgress(root, id, plan.digest) : await readRemovalProgress(root, id, plan.digest);
      app.toast(code === 0 ? (done.done ? "ok" : "idle") : "warn",
        `本清单累计已删除 ${done.done} 项、${fmt.bytes(done.bytes)}${done.finishing ? `，收尾 ${done.finishing} 项（此前已删除，不计入）` : ""}，保留 ${done.kept} 项，待处置 ${done.deferred} 项，失败 ${done.failed} 项${code ? "；操作未完成，请看输出" : ""}`);
    } catch { app.toast("warn", "未取得完整结果，请看命令输出并保留原清单"); }
    return true;
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
        width: total, title: `${spaceName(current.space)} › ${fmt.maskUser(current.user)}`, note: condition, accent: "accent",
        body: [`年龄候选 ${currentHit.entries} 个 · ${fmt.bytes(currentHit.bytes)}；近期 ${currentHit.keptEntries} 个；执行前核对引用`],
      });
      const cutoff = Date.now() - this.days * DAY;
      const content = current.entries.flatMap(entry => [
        theme.c(entry.newest <= cutoff ? "muted" : "ok", entry.newest <= cutoff ? "候选    " : "近期    ") + entry.name,
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
      rule(theme, total, `年龄候选 · ${condition}`, "按 p/a 核对可归档范围", "faint"),
      this.previewRow(theme, total, "p 当前", currentHit,
        current ? `${spaceName(current.space)} / ${fmt.maskUser(current.user)}` : "未选择成员"),
      this.previewRow(theme, total, "a 全部", hit, "所有空间与成员，忽略筛选"),
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
          { header: "空间", size: Math.max(10, Math.floor(total * 0.16)), render: (user) => spaceName(user.space) },
          { header: "占用", size: 10, align: "right", render: (user) => fmt.bytes(user.bytes) },
          { header: "文件", size: 7, align: "right", render: (user) => String(user.files) },
          { header: "最后改动", size: 10, align: "right", render: (user) => fmt.since(user.newest) },
        ],
      }) : [pad(`  ${theme.c("muted", "没有匹配的空间或成员；/ 修改筛选，Esc 清除")}`, total)]),
    ];
    while (out.length < height - preview.length) out.push(gap(total));
    out.push(...preview);
    return out;
  }

  /**
   * 一行清理预览：快捷键、比例条、数字、范围。
   *
   * 比例条只表示按年龄筛选的候选占比。固定清单里的引用检查才决定可归档项。
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
      `${theme.c("muted", `近期 ${hit.keptEntries} 个 · ${scope}`)}`,
      total
    );
  }
}
