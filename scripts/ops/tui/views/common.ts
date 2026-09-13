// 视图共用的小零件。放在这里而不是 app.ts，页面就不必为了拿两个排版函数去依赖整个壳层。

import { pad } from "../render/width.ts";
import { columns as sideBySide, mark, rule, status, table, wrap } from "../render/widgets.ts";
import type { StatusName, Theme } from "../render/theme.ts";
import type { AppApi, Loading, ViewContext } from "../view.ts";

/** 空行，宽度对齐。 */
export function gap(columns: number): string {
  return pad("", columns);
}

/**
 * 三种未就绪状态的统一呈现。
 *
 * 「正在读」和「读到了但是空的」必须分开显示：把加载中画成空列表，会让人以为真的没数据，
 * 然后去查一个根本不存在的问题。
 */
export function pending<T>(
  theme: Theme,
  columns: number,
  state: Loading<T>,
  emptyText: string
): string[] | null {
  if (state.kind === "ready") return null;
  if (state.kind === "loading") {
    return [gap(columns), pad(`  ${theme.c("accent", "⠹")} ${theme.c("muted", "正在读取…")}`, columns)];
  }
  if (state.kind === "error") {
    return [
      gap(columns),
      pad(`  ${status(theme, "danger", state.message)}`, columns),
    ];
  }
  return [gap(columns), pad(`  ${theme.c("muted", emptyText)}`, columns)];
}

/** 列表视图共用的上下移动，返回新的选中下标。 */
export function moveSelection(key: string, current: number, total: number): number | null {
  if (total === 0) return null;
  if (key === "up" || key === "k") return (current - 1 + total) % total;
  if (key === "down" || key === "j") return (current + 1) % total;
  if (key === "home") return 0;
  if (key === "end") return total - 1;
  if (key === "pageup") return Math.max(0, current - 10);
  if (key === "pagedown") return Math.min(total - 1, current + 10);
  return null;
}

/**
 * 把选中项保持在可视窗口内。
 *
 * 返回要显示的切片起点。选中项滚出视野是列表类界面最常见的低级错误，集中处理一次。
 */
export function windowStart(selected: number, total: number, room: number): number {
  if (total <= room) return 0;
  return Math.min(Math.max(0, selected - Math.floor(room / 2)), total - room);
}

/** 列表筛选不改底层数据；取消输入保留原条件，Esc 清除条件。 */
export class ListFilter {
  value = "";

  matches(...values: string[]): boolean {
    const query = this.value.toLocaleLowerCase();
    return !query || values.some(value => value.toLocaleLowerCase().includes(query));
  }

  async edit(app: AppApi, label: string): Promise<boolean> {
    const value = await app.ask(label + "（留空显示全部）", this.value);
    if (value === null) return false;
    this.value = value.trim();
    return true;
  }

  clear(): boolean {
    if (!this.value) return false;
    this.value = "";
    return true;
  }

  describe(shown: number, total: number): string {
    return this.value ? `筛选「${this.value}」 · ${shown} / ${total} · Esc 清除` : `共 ${total} 项 · / 筛选`;
  }
}

/**
 * 操作页共用：宽窗口左选右看，窄窗口把影响预览放在菜单下面。
 *
 * 两栏都用分隔线而不是框。原来一边是七行菜单、一边是四行说明，两个高度不等的框并排放着，
 * 右边那个为了对齐留出十几行空边框——看起来像渲染坏了。去掉框以后两栏自然等高，
 * 省下的四列宽度也回到了说明文字上。
 */
export function actionWorkbench(
  ctx: ViewContext,
  options: {
    title: string;
    items: { label: string; summary: string; status: StatusName }[];
    selected: number;
    details: string[];
    note: string;
  }
): string[] {
  const { theme, width: total, height } = ctx;
  const { items, selected } = options;
  const wide = total >= 96;
  const menuWidth = wide ? Math.max(26, Math.floor(total * 0.3)) : total;
  const body = Math.max(1, height - 1);
  const room = Math.max(1, wide ? body - 1 : Math.min(items.length, body - 6));
  const start = windowStart(selected, items.length, room);
  const current = items[selected];

  const menu = [
    rule(theme, menuWidth, options.title, `${selected + 1} / ${items.length}`, "accent"),
    ...table(theme, {
      width: menuWidth, rows: items.slice(start, start + room), selected: selected - start,
      columns: [
        { header: "", size: 2, render: item => mark(theme, item.status) },
        { header: "", ...(wide ? { flex: 1 } : { size: 18 }), render: item => item.label },
        ...(!wide ? [{ header: "", flex: 1, render: (item: typeof items[number]) => theme.c("muted", item.summary) }] : []),
      ],
    }),
  ];

  const detailWidth = wide ? total - menuWidth - 2 : total;
  const detailRoom = Math.max(1, (wide ? body : body - menu.length - 1) - 1);
  const details = options.details.flatMap(line => wrap(line, detailWidth - 1));
  const visible = details.slice(0, detailRoom);
  if (details.length > detailRoom) visible[detailRoom - 1] = theme.c("muted", "… Enter 查看完整步骤");
  const preview = [
    rule(theme, detailWidth, current?.label ?? "操作预览", undefined,
      current?.status === "danger" ? "danger" : "accent"),
    ...visible.map(line => pad(" " + line, detailWidth)),
  ];

  const out = wide
    ? sideBySide([menu, preview], [menuWidth, detailWidth], 2)
    : [...menu, gap(total), ...preview];
  // 版本/范围那行钉在正文最后一行。它是执行前最后要核对的一句话，位置不该随菜单长短上下浮动。
  while (out.length < height - 1) out.push(gap(total));
  out.push(pad(" " + theme.c("muted", options.note), total));
  return out;
}
