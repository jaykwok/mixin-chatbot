// 会话历史。列出各群的占用，并提供清空。
//
// 清空这件事本身不在这里做：转交 ops 的 history-clear，它会自动停机、清理、再恢复到操作前
// 的运行状态。那套顺序是有原因的（内存里的会话会把历史写回去），不该有第二份实现。

import { box, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import * as fmt from "../render/format.ts";
import { loadHistory, type GroupHistory } from "../data.ts";
import type { AppApi, Loading, View, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";

export class HistoryView implements View {
  readonly id = "history";
  readonly label = "会话";
  private state: Loading<GroupHistory[]> = { kind: "idle" };
  private selected = 0;

  hints(): [string, string][] {
    return [
      ["↑↓", "选择"],
      ["c", "清空该群"],
    ];
  }

  async refresh(app: AppApi): Promise<void> {
    this.state = { kind: "loading" };
    app.redraw();
    try {
      const groups = await loadHistory(app.deployment.groupDataRoot);
      this.state = { kind: "ready", value: groups };
      if (this.selected >= groups.length) this.selected = Math.max(0, groups.length - 1);
    } catch (error) {
      this.state = { kind: "error", message: `读取失败：${String(error)}` };
    }
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (this.state.kind !== "ready") return false;
    const groups = this.state.value;
    const moved = moveSelection(key.name, this.selected, groups.length);
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
      const code = await app.run(`清空 ${target.group} 的会话历史`, ["history-clear", target.group]);
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? "已清空并恢复运行状态" : "清空未完成，请看输出");
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "还没有任何会话历史");
    if (waiting) return waiting;
    const groups = (this.state as { value: GroupHistory[] }).value;
    if (groups.length === 0) {
      return [gap(total), pad(`  ${theme.c("muted", "还没有任何会话历史")}`, total)];
    }

    const totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);
    const room = Math.max(3, Math.floor((height - 8) * 0.6));
    const start = windowStart(this.selected, groups.length, room);
    const visible = groups.slice(start, start + room);

    const out = box(theme, {
      width: total,
      title: "会话历史",
      note: `合计 ${fmt.bytes(totalBytes)}`,
      accent: "accent",
      body: table(theme, {
        width: total - 4,
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
    });

    // 选中群的成员明细：占用大头通常集中在一两个人身上，不展开看不出来。
    const current = groups[this.selected];
    const left = height - out.length - 3;
    if (current && left >= 4) {
      const shown = current.users.slice(0, left - 2);
      out.push(gap(total));
      out.push(
        ...box(theme, {
          width: total,
          title: `群 ${current.group} 的成员`,
          note: "已打码",
          body: [
            ...shown.map((user) =>
              [
                pad(fmt.maskUser(user.user), Math.max(14, Math.floor(total * 0.3))),
                pad(fmt.bytes(user.bytes), 10, "right"),
                pad(fmt.since(user.modified), 12, "right"),
              ].join("  ")
            ),
            ...(current.users.length > shown.length
              ? [theme.c("muted", `…… 另有 ${current.users.length - shown.length} 位成员`)]
              : []),
          ],
        })
      );
    }
    return out;
  }
}
