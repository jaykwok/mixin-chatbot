// 存储。各用户临时目录的占用与清理。
//
// 这一页比命令行多出来的那点东西，全在「按天数先看会删掉多少，再决定要不要删」：
// tmp 里混着可重建的缓存和用户真正生成的交付物，一条不看时间的 purge 太容易把某个正在跑
// 的任务的中间产物一起端掉。所以确认框里给的是这次实际会命中的条目数和字节数，不是泛泛的
// 「确定吗」。

import { box, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import * as fmt from "../render/format.ts";
import { loadTmp, type UserTmp } from "../data.ts";
import type { AppApi, Loading, View, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";

const DAY = 86_400_000;
/** 清理天数的候选值。按 ← → 在其中切换，省得每次手输。 */
const PRESETS = [90, 60, 30, 14, 7, 3, 0] as const;

export class StorageView implements View {
  readonly id = "storage";
  readonly label = "存储";
  private state: Loading<UserTmp[]> = { kind: "idle" };
  private selected = 0;
  private presetIndex = 2; // 默认 30 天

  private get days(): number {
    return PRESETS[this.presetIndex]!;
  }

  hints(): [string, string][] {
    return [
      ["↑↓", "选择"],
      ["←→", `天数 ${this.days}`],
      ["p", "清当前"],
      ["a", "清所有"],
    ];
  }

  async refresh(app: AppApi): Promise<void> {
    this.state = { kind: "loading" };
    app.redraw();
    try {
      const users = await loadTmp(app.deployment.groupDataRoot);
      this.state = { kind: "ready", value: users };
      if (this.selected >= users.length) this.selected = Math.max(0, users.length - 1);
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
    if (this.state.kind !== "ready") return false;
    const users = this.state.value;

    if (key.name === "left") {
      this.presetIndex = Math.max(0, this.presetIndex - 1);
      return true;
    }
    if (key.name === "right") {
      this.presetIndex = Math.min(PRESETS.length - 1, this.presetIndex + 1);
      return true;
    }
    const moved = moveSelection(key.name, this.selected, users.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }

    if (key.name === "p" || key.name === "a") {
      const current = users[this.selected];
      if (!current) return true;
      const all = key.name === "a";
      const scope = all ? "所有群的所有成员" : `群 ${current.group} · 成员 ${fmt.maskUser(current.user)}`;
      const hit = this.matched(all ? users : [current]);
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
      const args = this.days === 0 ? ["tmp-purge", "--all"] : ["tmp-purge", "--days", String(this.days)];
      if (!all) args.push("--group", current.group, "--user", current.user, "--storage-segment");
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
    const users = (this.state as { value: UserTmp[] }).value;
    if (users.length === 0) {
      return [gap(total), pad(`  ${theme.c("muted", "还没有任何用户临时目录")}`, total)];
    }

    const totalBytes = users.reduce((sum, user) => sum + user.bytes, 0);
    const hit = this.matched(users);
    const current = users[this.selected]!;
    const currentHit = this.matched([current]);
    const room = Math.max(1, Math.floor((height - 8) * 0.65));
    const start = windowStart(this.selected, users.length, room);
    const visible = users.slice(start, start + room);

    const out = box(theme, {
      width: total,
      title: "用户临时目录",
      note: `合计 ${fmt.bytes(totalBytes)}`,
      accent: "accent",
      body: table(theme, {
        width: total - 4,
        rows: visible,
        selected: this.selected - start,
        columns: [
          { header: "成员", flex: 1, render: (user) => fmt.maskUser(user.user) },
          { header: "群", size: Math.max(10, Math.floor(total * 0.16)), render: (user) => user.group },
          { header: "占用", size: 10, align: "right", render: (user) => fmt.bytes(user.bytes) },
          { header: "文件", size: 7, align: "right", render: (user) => String(user.files) },
          { header: "最后改动", size: 10, align: "right", render: (user) => fmt.since(user.newest) },
        ],
      }),
    });

    // 清理预览：这一行是这一页存在的理由，不是装饰。
    out.push(gap(total));
    out.push(
      pad(` ${theme.c("muted", "清理阈值")} ${theme.bold(this.days === 0 ? "不限时间" : `${this.days} 天未改动`)} · 显示 ${start + 1}–${start + visible.length} / ${users.length}`, total),
      pad(` ${theme.bold("p 当前")} ${theme.c(currentHit.entries ? "warn" : "muted", `${currentHit.entries} 个 · ${fmt.bytes(currentHit.bytes)}`)}` +
        `   ${theme.c("muted", `保留 ${currentHit.keptEntries} 个`)} · ${current.group} / ${fmt.maskUser(current.user)}`, total),
      pad(` ${theme.bold("a 所有群与成员")} ${theme.c(hit.entries ? "warn" : "muted", `${hit.entries} 个 · ${fmt.bytes(hit.bytes)}`)}   ${theme.c("muted", `保留 ${hit.keptEntries} 个`)}`, total)
    );

    const left = height - out.length - 1;
    if (current && left >= 4) {
      const shown = current.entries.slice(0, left - 3);
      out.push(gap(total));
      out.push(
        ...box(theme, {
          width: total,
          title: `${fmt.maskUser(current.user)} 的条目`,
          body: [
            ...shown.map((entry) =>
              [
                pad(entry.name, Math.max(18, Math.floor(total * 0.4))),
                pad(fmt.bytes(entry.bytes), 10, "right"),
                pad(fmt.since(entry.newest), 12, "right"),
              ].join("  ")
            ),
            ...(current.entries.length > shown.length
              ? [theme.c("muted", `…… 另有 ${current.entries.length - shown.length} 个条目`)]
              : []),
          ],
        })
      );
    }
    return out;
  }
}
