// 会话历史。列出各群的占用，并提供清空。
//
// 清空这件事本身不在这里做：转交 ops 的 history-clear，它会自动停机、清理、再恢复到操作前
// 的运行状态。那套顺序是有原因的（内存里的会话会把历史写回去），不该有第二份实现。

import { rule, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import * as fmt from "../render/format.ts";
import { loadHistory, type GroupHistory } from "../data.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, ListFilter, moveSelection, pending, windowStart } from "./common.ts";

export class HistoryView implements View {
  readonly id = "history";
  readonly label = "会话";
  private state: Loading<GroupHistory[]> = { kind: "idle" };
  private root: string | undefined;
  private selected = 0;
  private filter = new ListFilter();
  private expanded = false;
  private scroll = new Viewport();

  hints(): [string, string][] {
    return this.expanded ? [["Esc", "返回"], ["↑↓", "滚动"], ["c", "清空该群"]]
      : [["↑↓", "选择"], ["Enter", "全部成员"], ["/", "筛选"], ["c", "清空该群"]];
  }

  actions(): ViewAction[] {
    return [
      ...(this.expanded ? [{ value: "escape", label: "返回群列表" }]
        : [{ value: "enter", label: "查看选中群的全部成员", disabled: !this.groups.length },
          { value: "/", label: "筛选群或成员", description: "按群名、成员号码或打码后的号码查找" }]),
      { value: "c", label: "清空选中群的会话历史", description: "确认群名后，归档该群所有成员的历史并恢复运行状态", danger: true, disabled: !this.groups.length },
    ];
  }

  private get groups(): GroupHistory[] {
    return this.state.kind === "ready" ? this.state.value.filter(group => this.filter.matches(
      group.group, ...group.users.flatMap(user => [user.user, fmt.maskUser(user.user)])
    )) : [];
  }

  async refresh(app: AppApi): Promise<void> {
    const rootChanged = this.root !== undefined && this.root !== app.deployment.groupDataRoot;
    if (rootChanged) {
      this.filter.clear();
      this.expanded = false;
      this.selected = 0;
      this.scroll.reset();
    }
    this.root = app.deployment.groupDataRoot;
    if (rootChanged || this.state.kind !== "ready") this.state = { kind: "loading" };
    app.redraw();
    try {
      const groups = await loadHistory(app.deployment.groupDataRoot);
      this.state = { kind: "ready", value: groups };
      this.selected = Math.min(this.selected, Math.max(0, this.groups.length - 1));
      if (!this.groups.length) this.expanded = false;
    } catch (error) {
      this.state = { kind: "error", message: `读取失败：${String(error)}` };
    }
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (key.name === "escape" && this.expanded) { this.expanded = false; return true; }
    if (key.name === "escape" && this.filter.clear()) { this.selected = 0; return true; }
    if (key.name === "/" && !this.expanded) {
      if (await this.filter.edit(app, "筛选群名或成员")) this.selected = 0;
      return true;
    }
    if (this.state.kind !== "ready") return false;
    const groups = this.groups;
    if (this.expanded && this.scroll.onKey(key.name)) return true;
    if (key.name === "enter" && groups[this.selected]) {
      this.expanded = true;
      this.scroll.reset();
      return true;
    }
    const moved = this.expanded ? null : moveSelection(key.name, this.selected, groups.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }
    if (key.name === "c") {
      const target = groups[this.selected];
      if (!target) return true;
      const ok = await app.confirm({
        title: "清空会话历史",
        subject: `群 ${target.group} · ${target.users.length} 位成员 · ${fmt.bytes(target.bytes)}`,
        steps: [
          "停止机器人（否则内存里的会话会把历史写回去）",
          `${target.users.length} 个 session.jsonl 移入 backup/rm`,
          "恢复到操作前的运行状态",
        ],
        untouched: ["workspace", "tmp", "资料索引", "未交付消息"],
        recovery: "可以，文件在 backup/rm 下，按原路径还原即可",
        typeToConfirm: target.group,
        danger: true,
      });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
      const code = await app.run(`清空 ${target.group} 的会话历史`, ["history-clear", target.group, "--storage-segment"]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "已清空并恢复运行状态" : "清空未完成，请看输出");
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "还没有任何会话历史");
    if (waiting) return waiting;
    const all = (this.state as { value: GroupHistory[] }).value;
    const groups = this.groups;
    if (groups.length === 0) {
      return [gap(total), pad(theme.c("muted", this.filter.value
        ? `  没有匹配「${this.filter.value}」的群或成员；/ 修改，Esc 清除` : "  还没有任何会话历史"), total)];
    }

    const selected = groups[this.selected]!;
    if (this.expanded) {
      const members = table(theme, {
        width: total, rows: selected.users, marker: 1,
        columns: [
          { header: "成员（已打码）", flex: 1, render: user => fmt.maskUser(user.user) },
          { header: "会话占用", size: 12, align: "right", render: user => fmt.bytes(user.bytes) },
          { header: "最后活动", size: 12, align: "right", render: user => fmt.since(user.modified) },
        ],
      });
      // 先切片再取 label：Viewport 的计数是在 slice 里算出来的，顺序反了会一直显示上一帧的数。
      // 三行留给分隔线、表头和底部说明，其余归成员列表。
      const visible = this.scroll.slice(members.slice(1), Math.max(1, height - 3));
      return [
        rule(theme, total, `会话 › ${selected.group}`,
          `${selected.users.length} 位成员 · ${fmt.bytes(selected.bytes)} · ${this.scroll.label}`, "accent"),
        members[0]!,
        ...visible,
        pad(" " + theme.c("muted", "清空操作作用于整个群"), total),
      ];
    }

    const totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);
    // 上下两块按内容分高度：群列表至少三行，剩下的给选中群的成员明细——占用大头通常
    // 集中在一两个人身上，不展开看不出来，所以明细值得占掉半屏。
    const room = Math.max(3, Math.min(groups.length, Math.floor((height - 4) * 0.5)));
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
          { header: "群", flex: 1, render: (group) => group.group },
          { header: "成员", size: 6, align: "right", render: (group) => `${group.users.length} 人` },
          { header: "占用", size: 10, align: "right", render: (group) => fmt.bytes(group.bytes) },
          {
            header: "最后活动",
            size: 10,
            align: "right",
            render: (group) => fmt.since(Math.max(...group.users.map((user) => user.modified))),
          },
        ],
      }),
    ];

    const current = groups[this.selected];
    const left = height - out.length - 2;
    if (current && left >= 2) {
      const shown = current.users.slice(0, left - 1);
      out.push(gap(total));
      out.push(rule(theme, total, `群 ${current.group} 的成员`, "Enter 看全部 · 已打码"));
      out.push(...shown.map((user) => pad(
        " " + pad(fmt.maskUser(user.user), Math.max(14, Math.floor(total * 0.3))) +
        pad(fmt.bytes(user.bytes), 10, "right") + pad(fmt.since(user.modified), 12, "right"), total)));
      if (current.users.length > shown.length) {
        out.push(pad(` ${theme.c("muted", `…… 另有 ${current.users.length - shown.length} 位成员`)}`, total));
      }
    }
    return out;
  }
}
