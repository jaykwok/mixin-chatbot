// 会话历史。列出各群的占用（群库和升级前的旧会话文件），并提供清空单个群或所有群。
//
// 清空这件事本身不在这里做：转交 ops 的 history-clear，它会自动停机、在群库里登记清空、归档旧会话文件，
// 再恢复到操作前的运行状态。那套顺序是有原因的（运行中的机器人独占群库），不该有第二份实现。

import { rule, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import * as fmt from "../render/format.ts";
import { lastActivity, loadHistory, type GroupHistory } from "../data.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { gap, ListFilter, moveSelection, pending, windowStart } from "./common.ts";

/** 清空只开启新上下文：统计账本独立保存，已有用量在清空时照常入账。 */
const STATS_STEP = "使用统计不受影响：已计入的数字保留，清空时的用量照常入账";

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
    // 清空放在最前：这是本页最常用的写操作。
    return this.expanded ? [["c", "清空当前群"], ["a", "清空全部群"], ["Esc", "返回"], ["↑↓", "滚动"], ["p", "压缩成员"]]
      : [["c", "清空当前群"], ["a", "清空全部群"], ["↑↓", "选择"], ["Enter", "全部成员"], ["/", "筛选"], ["p", "压缩成员"]];
  }

  actions(): ViewAction[] {
    return [
      { value: "c", label: "清空当前群的会话历史", description: "相当于该群全员发送 /clear；输入群名确认，不影响使用统计", danger: true, disabled: !this.groups.length },
      { value: "a", label: "清空所有群的会话历史", description: "相当于所有群全员发送 /clear，一次停机完成；不受筛选影响，不影响使用统计", danger: true,
        disabled: this.state.kind !== "ready" || !this.state.value.length },
      ...(this.expanded ? [{ value: "escape", label: "返回群列表" }]
        : [{ value: "enter", label: "查看选中群的全部成员", disabled: !this.groups.length },
          { value: "/", label: "筛选群或成员", description: "按群名、成员号码或打码后的号码查找" }]),
      { value: "p", label: "压缩一位成员的上下文", description: "登记后由机器人生成摘要，产生模型用量", disabled: !this.groups[this.selected]?.database },
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
        title: "清空当前群的会话历史",
        subject: `群 ${target.group} · ${fmt.bytes(target.bytes)}`,
        steps: [
          "停止机器人（运行中的机器人独占群库）",
          ...(target.database ? ["在群库里为每位成员登记清空：机器人启动时先执行，排队中的消息一并取消"] : []),
          ...(target.users.length ? [`${target.users.length} 个升级前的 session.jsonl 先计入使用统计，再移入 backup/rm`] : []),
          STATS_STEP,
          "恢复到操作前的运行状态",
        ],
        untouched: ["workspace", "tmp", "资料索引", "未交付消息", "使用统计"],
        recovery: "旧上下文仍留在群库里，但清空后不再进入对话；旧会话文件在 backup/rm 下，可按原路径还原",
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
    if (key.name === "a") {
      // 范围取全部群而不是筛选结果；执行时按当时的全部群处理，这里的数字只用于确认。
      const all = this.state.value;
      if (!all.length) return true;
      const databases = all.filter(group => group.database).length;
      const legacy = all.reduce((sum, group) => sum + group.users.length, 0);
      const ok = await app.confirm({
        title: "清空所有群的会话历史",
        subject: `${all.length} 个群 · ${fmt.bytes(all.reduce((sum, group) => sum + group.bytes, 0))}（不受列表筛选影响）`,
        steps: [
          "停止机器人（运行中的机器人独占群库）",
          ...(databases ? [`在 ${databases} 个群库里为每位成员登记清空：机器人启动时先执行，排队中的消息一并取消`] : []),
          ...(legacy ? [`${legacy} 个升级前的 session.jsonl 先计入使用统计，再移入 backup/rm`] : []),
          STATS_STEP,
          "恢复到操作前的运行状态；某个群失败时其余群照常清空",
        ],
        untouched: ["workspace", "tmp", "资料索引", "未交付消息", "使用统计"],
        recovery: "旧上下文仍留在群库里，但清空后不再进入对话；旧会话文件在 backup/rm 下，可按原路径还原",
        typeToConfirm: "全部清空",
        danger: true,
      });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
      const code = await app.run("清空所有群的会话历史", ["history-clear", "--all"]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "所有群已清空并恢复运行状态" : "清空未全部完成，请看输出");
      return true;
    }
    if (key.name === "p") {
      const target = groups[this.selected];
      if (!target?.database) { app.toast("idle", "该群尚无 Durable 群库"); return true; }
      const phone = (await app.ask("要压缩的成员号码（摘要会产生模型用量）"))?.trim();
      if (!phone) { app.toast("idle", "已取消"); return true; }
      if (!await app.confirm({
        title: "压缩成员上下文", subject: `群 ${target.group} · 成员 ${fmt.maskUser(phone)}`,
        steps: ["停止机器人并登记压缩任务", "恢复原运行状态；机器人启动后生成摘要，产生模型用量"],
        untouched: ["历史记录", "资料与结果文件", "待补发回复", "已累计费用"],
        recovery: "压缩失败保留原上下文；成功后模型使用摘要继续对话",
      })) { app.toast("idle", "已取消"); return true; }
      const code = await app.run(`登记 ${target.group} 的成员压缩`, ["history-compact", target.group, phone, "--storage-segment"]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "已登记压缩任务；机器人运行后执行" : "登记未完成，请看输出");
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
          `${fmt.bytes(selected.bytes)} · ${this.scroll.label}`, "accent"),
        members[0]!,
        ...visible,
        pad(" " + theme.c("muted", selected.database
          ? `群库 ${fmt.bytes(selected.database.bytes)} 保存全体成员的对话，上表只列升级前的旧会话文件；清空作用于整个群`
          : "清空操作作用于整个群"), total),
      ];
    }

    const totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);
    // 清空入口固定占最后三行：位置不随列表长短和选中的群漂移，每次来都在同一个地方。
    const current = groups[this.selected];
    const clear = [
      rule(theme, total, "清空会话 · 相当于全员发送 /clear", "不影响使用统计", "warn"),
      pad(` ${theme.bold(theme.c("warn", "c 当前群"))}  ${current ? `${current.group} · ${fmt.bytes(current.bytes)}` : "未选择群"}`, total),
      pad(` ${theme.bold(theme.c("warn", "a 全部群"))}  ${all.length} 个群 · ${fmt.bytes(all.reduce((sum, group) => sum + group.bytes, 0))}` +
        theme.c("muted", this.filter.value ? " · 忽略筛选" : ""), total),
    ];
    // 有旧会话文件时上下分屏：群列表至多半屏，其余给选中群的旧文件明细；没有旧文件时列表占满。
    // 按全部群是否有旧文件决定，选中不同的群时布局不跳动。
    const legacy = groups.some(group => group.users.length);
    const space = height - clear.length - 2;
    const room = Math.max(1, Math.min(groups.length, legacy ? Math.floor((space - 2) * 0.5) : space - 1));
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
          { header: "旧文件", size: 6, align: "right", render: (group) => group.users.length ? `${group.users.length} 份` : "—" },
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

    const left = height - clear.length - out.length - 2;
    if (legacy && current && left >= 2) {
      const shown = current.users.slice(0, left - 1);
      out.push(gap(total));
      out.push(rule(theme, total, `群 ${current.group} 的旧会话文件`, current.database ? `群库 ${fmt.bytes(current.database.bytes)} · Enter 看全部 · 已打码` : "Enter 看全部 · 已打码"));
      out.push(...shown.map((user) => pad(
        " " + pad(fmt.maskUser(user.user), Math.max(14, Math.floor(total * 0.3))) +
        pad(fmt.bytes(user.bytes), 10, "right") + pad(fmt.since(user.modified), 12, "right"), total)));
      if (current.users.length > shown.length) {
        out.push(pad(` ${theme.c("muted", `…… 另有 ${current.users.length - shown.length} 位成员`)}`, total));
      }
    }
    while (out.length < height - clear.length) out.push(gap(total));
    out.push(...clear);
    return out;
  }
}
