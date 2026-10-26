import { rule, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import * as fmt from "../render/format.ts";
import { lastActivity, loadHistory, loadStatsOverview, spaceName, type SpaceHistory } from "../data.ts";
import type { UserStats } from "../../stats-admin.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, ListFilter, moveSelection, pending, windowStart } from "./common.ts";

/** `groups/<段>` 的目录段。 */
function spaceSegment(space: string): string {
  return space.slice("groups/".length);
}

/** ops 的空间选择参数：单聊空间用 --direct，群按扫描到的目录段。 */
function spaceArgs(space: string): string[] {
  return space === "direct" ? ["--direct"] : [spaceSegment(space), "--storage-segment"];
}

/** 统计账本的来源段：单聊为 direct，群为目录段（src/core/layout.ts statsSegment）。 */
function statsSource(space: string): string {
  return space === "direct" ? "direct" : spaceSegment(space);
}

/** 清空只开启新上下文：统计账本独立保存，已有用量在清空时照常入账。 */
const STATS_STEP = "使用统计不受影响：已计入的数字保留，清空时的用量照常入账";

export class HistoryView implements View {
  readonly id = "history";
  readonly label = "会话";
  private state: Loading<SpaceHistory[]> = { kind: "idle" };
  private root: string | undefined;
  private selected = 0;
  private filter = new ListFilter();
  private expanded = false;
  /**
   * 详情页的成员：取自使用统计账本（提问过的成员，按最后提问排序）。会话库由运行中的机器人独占，
   * 不为一份名单去读它；没提问过的成员在列表页按 p 输入号码。
   */
  private members: Loading<UserStats[]> = { kind: "idle" };
  private member = 0;
  private membersRevision = 0;

  hints(): [string, string][] {
    // 清空放在最前：这是本页最常用的写操作。
    return this.expanded ? [["c", "清空当前空间"], ["a", "清空全部"], ["↑↓", "选择成员"], ["p", "压缩选中成员"], ["Esc", "返回"]]
      : [["c", "清空当前空间"], ["a", "清空全部"], ["↑↓", "选择"], ["Enter", "成员与会话库"], ["/", "筛选"], ["p", "压缩成员"]];
  }

  private get selectedMember(): UserStats | undefined {
    return this.expanded && this.members.kind === "ready" ? this.members.value[this.member] : undefined;
  }

  private async loadMembers(app: AppApi, space: string): Promise<void> {
    const revision = ++this.membersRevision;
    if (this.members.kind !== "ready") this.members = { kind: "loading" };
    app.redraw();
    let next: Loading<UserStats[]>;
    try {
      const stats = (await loadStatsOverview(app.deployment.dataRoot)).find(group => group.group === statsSource(space));
      next = { kind: "ready", value: [...stats?.users ?? []].sort((a, b) => b.lastAt - a.lastAt || a.user.localeCompare(b.user)) };
    } catch (error) {
      next = { kind: "error", message: `成员读取失败：${String(error)}` };
    }
    if (revision !== this.membersRevision) return;
    const kept = this.members.kind === "ready" ? this.members.value[this.member]?.user : undefined;
    this.members = next;
    const index = next.kind === "ready" ? next.value.findIndex(user => user.user === kept) : -1;
    this.member = index >= 0 ? index : 0;
    app.redraw();
  }

  actions(): ViewAction[] {
    return [
      { value: "c", label: "清空当前空间的会话历史", description: "相当于该群（或单聊空间）全员发送 /clear；输入名称确认，不影响使用统计", danger: true, disabled: !this.groups.length },
      { value: "a", label: "清空所有会话空间的历史", description: "相当于单聊和所有群全员发送 /clear，一次停机完成；不受筛选影响，不影响使用统计", danger: true,
        disabled: this.state.kind !== "ready" || !this.state.value.length },
      ...(this.expanded ? [{ value: "escape", label: "返回列表" }]
        : [{ value: "enter", label: "查看选中空间的会话库详情", disabled: !this.groups.length },
          { value: "/", label: "筛选", description: "按群名或「单聊」查找" }]),
      { value: "p", label: this.selectedMember ? "压缩选中成员的上下文" : "压缩一位成员的上下文", description: "登记后由机器人生成摘要，产生模型用量",
        disabled: !this.groups[this.selected]?.database },
    ];
  }

  private get groups(): SpaceHistory[] {
    return this.state.kind === "ready" ? this.state.value.filter(space => this.filter.matches(
      space.space, spaceName(space.space)
    )) : [];
  }

  async refresh(app: AppApi): Promise<void> {
    const rootChanged = this.root !== undefined && this.root !== app.deployment.dataRoot;
    if (rootChanged) {
      this.filter.clear();
      this.expanded = false;
      this.selected = 0;
    }
    this.root = app.deployment.dataRoot;
    if (rootChanged || this.state.kind !== "ready") this.state = { kind: "loading" };
    app.redraw();
    try {
      const groups = await loadHistory(app.deployment.dataRoot);
      this.state = { kind: "ready", value: groups };
      this.selected = Math.min(this.selected, Math.max(0, this.groups.length - 1));
      if (!this.groups.length) this.expanded = false;
      if (this.expanded) void this.loadMembers(app, this.groups[this.selected]!.space);
    } catch (error) {
      this.state = { kind: "error", message: `读取失败：${String(error)}` };
    }
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (key.name === "escape" && this.expanded) { this.expanded = false; return true; }
    if (key.name === "escape" && this.filter.clear()) { this.selected = 0; return true; }
    if (key.name === "/" && !this.expanded) {
      if (await this.filter.edit(app, "筛选群名或单聊")) this.selected = 0;
      return true;
    }
    if (this.state.kind !== "ready") return false;
    const groups = this.groups;
    if (key.name === "enter" && groups[this.selected] && !this.expanded) {
      this.expanded = true;
      this.members = { kind: "idle" };
      this.member = 0;
      void this.loadMembers(app, groups[this.selected]!.space);
      return true;
    }
    if (this.expanded) {
      const moved = moveSelection(key.name, this.member, this.members.kind === "ready" ? this.members.value.length : 0);
      if (moved !== null) { this.member = moved; return true; }
    } else {
      const moved = moveSelection(key.name, this.selected, groups.length);
      if (moved !== null) { this.selected = moved; return true; }
    }
    if (key.name === "c") {
      const target = groups[this.selected];
      if (!target) return true;
      const name = spaceName(target.space);
      const ok = await app.confirm({
        title: "清空当前空间的会话历史",
        subject: `${name} · ${fmt.bytes(target.bytes)}`,
        steps: [
          "停止机器人（运行中的机器人独占会话库）",
          ...(target.database ? ["在会话库里为每位成员登记清空：机器人启动时先执行，排队中的消息一并取消"] : []),
          STATS_STEP,
          "恢复到操作前的运行状态",
        ],
        untouched: ["共享资料", "tmp", "资料索引", "未交付消息", "使用统计"],
        recovery: "清空后旧上下文不再进入模型请求；统计账本独立保存",
        typeToConfirm: target.space === "direct" ? "单聊" : spaceSegment(target.space),
        danger: true,
      });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
      const code = await app.run(`清空${name}的会话历史`, ["history-clear", ...spaceArgs(target.space)]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "已清空并恢复运行状态" : "清空未完成，请看输出");
      return true;
    }
    if (key.name === "a") {
      // 范围取全部空间而不是筛选结果；执行时按当时的全部空间处理，这里的数字只用于确认。
      const all = this.state.value;
      if (!all.length) return true;
      const databases = all.filter(group => group.database).length;
      const ok = await app.confirm({
        title: "清空所有会话空间的历史",
        subject: `${all.length} 个会话空间 · ${fmt.bytes(all.reduce((sum, group) => sum + group.bytes, 0))}（不受列表筛选影响）`,
        steps: [
          "停止机器人（运行中的机器人独占会话库）",
          ...(databases ? [`在 ${databases} 个会话库里为每位成员登记清空：机器人启动时先执行，排队中的消息一并取消`] : []),
          STATS_STEP,
          "恢复到操作前的运行状态；某个空间失败时其余照常清空",
        ],
        untouched: ["共享资料", "tmp", "资料索引", "未交付消息", "使用统计"],
        recovery: "清空后旧上下文不再进入模型请求；统计账本独立保存",
        typeToConfirm: "全部清空",
        danger: true,
      });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
      const code = await app.run("清空所有会话空间的历史", ["history-clear", "--all"]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "所有会话空间已清空并恢复运行状态" : "清空未全部完成，请看输出");
      return true;
    }
    if (key.name === "p") {
      const target = groups[this.selected];
      if (!target?.database) { app.toast("idle", "该空间尚无会话库"); return true; }
      // 账本记的是成员目录段：普通号码就是号码本身，摘要形式（sha256-user-…）认不出号码，仍要输入。
      const known = this.selectedMember?.user;
      const phone = known && !known.startsWith("sha256-user-") ? known : (await app.ask("要压缩的成员号码（摘要会产生模型用量）"))?.trim();
      if (!phone) { app.toast("idle", "已取消"); return true; }
      if (!await app.confirm({
        title: "压缩成员上下文", subject: `${spaceName(target.space)} · 成员 ${fmt.maskUser(phone)}`,
        steps: ["停止机器人并登记压缩任务", "恢复原运行状态；机器人启动后生成摘要，产生模型用量"],
        untouched: ["历史记录", "资料与结果文件", "统计数据"],
        recovery: "压缩失败保留原上下文；成功后模型使用摘要继续对话",
      })) { app.toast("idle", "已取消"); return true; }
      const code = await app.run(`登记${spaceName(target.space)}的成员压缩`, target.space === "direct"
        ? ["history-compact", "--direct", phone] : ["history-compact", spaceSegment(target.space), phone, "--storage-segment"]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "已登记压缩任务；机器人运行后执行" : "登记未完成，请看输出");
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "还没有任何会话历史");
    if (waiting) return waiting;
    const all = (this.state as { value: SpaceHistory[] }).value;
    const groups = this.groups;
    if (groups.length === 0) {
      return [gap(total), pad(theme.c("muted", this.filter.value
        ? `  没有匹配「${this.filter.value}」的会话空间；/ 修改，Esc 清除` : "  还没有任何会话历史"), total)];
    }

    const selected = groups[this.selected]!;
    if (this.expanded) return this.renderDetail(ctx, selected);

    const totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);
    // 清空入口固定占最后三行：位置不随列表长短和选中的群漂移，每次来都在同一个地方。
    const current = groups[this.selected];
    const clear = [
      rule(theme, total, "清空会话 · 相当于全员发送 /clear", "不影响使用统计", "warn"),
      pad(` ${theme.bold(theme.c("warn", "c 当前"))}  ${current ? `${spaceName(current.space)} · ${fmt.bytes(current.bytes)}` : "未选择"}`, total),
      pad(` ${theme.bold(theme.c("warn", "a 全部"))}  ${all.length} 个会话空间 · ${fmt.bytes(all.reduce((sum, group) => sum + group.bytes, 0))}` +
        theme.c("muted", this.filter.value ? " · 忽略筛选" : ""), total),
    ];
    const room = Math.max(1, Math.min(groups.length, height - clear.length - 3));
    const start = windowStart(this.selected, groups.length, room);
    const visible = groups.slice(start, start + room);

    const out = [
      rule(theme, total, "会话历史",
        `${this.filter.describe(groups.length, all.length)} · 合计 ${fmt.bytes(totalBytes)}`, "accent"),
      ...table(theme, {
        width: total,
        rows: visible,
        selected: this.selected - start,
        columns: [
          { header: "会话空间", flex: 1, render: (group) => spaceName(group.space) },
          { header: "占用", size: 10, align: "right", render: (group) => fmt.bytes(group.bytes) },
          {
            header: "最后活动",
            size: 10,
            align: "right",
            render: (group) => fmt.since(lastActivity(group)),
          },
        ],
      }),
    ];

    while (out.length < height - clear.length) out.push(gap(total));
    out.push(...clear);
    return out;
  }

  /** 详情：会话库占用与说明，下面是提问过的成员（打码），p 压缩选中的那位。 */
  private renderDetail(ctx: ViewContext, selected: SpaceHistory): string[] {
    const { theme, width: total, height } = ctx;
    const members = this.members;
    const out = [
      rule(theme, total, `会话 › ${spaceName(selected.space)}`,
        members.kind === "ready" ? `${members.value.length} 位提问过的成员` : "会话库", "accent"),
      pad(` 会话库占用 ${fmt.bytes(selected.bytes)} · 最后活动 ${fmt.since(lastActivity(selected))}`, total),
      pad(theme.c("muted", ` 全体成员的上下文保存在此会话库；清空作用于整个${selected.space === "direct" ? "单聊空间" : "群"}，使用统计独立保留。`), total),
      gap(total),
    ];
    if (members.kind !== "ready") {
      out.push(pad(theme.c(members.kind === "error" ? "danger" : "muted", `  ${members.kind === "error" ? members.message : "读取成员中…"}`), total));
      return out;
    }
    if (!members.value.length) {
      out.push(pad(theme.c("muted", "  使用统计里还没有这个空间的成员；可返回列表按 p 输入号码压缩"), total));
      return out;
    }
    const note = pad(theme.c("muted", " 成员取自使用统计，只列提问过的成员；其他成员返回列表按 p 输入号码。"), total);
    const room = Math.max(1, height - out.length - 2);
    const start = windowStart(this.member, members.value.length, room);
    out.push(...table(theme, {
      width: total,
      rows: members.value.slice(start, start + room),
      selected: this.member - start,
      columns: [
        { header: "成员", flex: 1, render: (user) => fmt.maskUser(user.user) },
        { header: "提问", size: 8, align: "right", render: (user) => fmt.count(user.asks) },
        { header: "最后提问", size: 10, align: "right", render: (user) => fmt.since(user.lastAt) },
      ],
    }));
    if (out.length < height) out.push(note);
    return out;
  }
}
