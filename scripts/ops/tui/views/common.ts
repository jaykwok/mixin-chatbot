// 视图共用的小零件。放在这里而不是 app.ts，页面就不必为了拿两个排版函数去依赖整个壳层。

import { pad } from "../render/width.ts";
import { status } from "../render/widgets.ts";
import type { Theme } from "../render/theme.ts";
import type { Loading } from "../view.ts";

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
