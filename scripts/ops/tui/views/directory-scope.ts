// 通讯录同步范围的部门选择器：从一级部门逐层展开，任意层级、跨分支多选；选中的部门含其全部子部门。
//
// 当前范围、子部门和部门名称都经运行中服务的本机控制接口查询，与「列出部门」走同一条路。选择器不连平台、不改任何东西，
// 只交回选中的部门 ID；保存仍走确认框和 directory-scope 命令，由服务向平台核对每个部门。查询只在选择器打开期间进行：
// 交回结果、取消或管理台退出时，在途的请求随即取消，服务那边对应的平台查询也停下。

import { join } from "node:path";
import type { DepartmentDescription, DepartmentInfo } from "../../../../src/integrations/open-platform/directory.ts";
import { MAX_SCOPE_DEPARTMENTS, sameScope } from "../../../../src/integrations/open-platform/directory-scope.ts";
import { describeDepartments, listDepartments, readServiceStatus } from "../../directory-admin.ts";
import { consoleRequests } from "../exec.ts";
import { PROJECT_DIR } from "../platform.ts";
import type { Key } from "../render/screen.ts";
import type { StatusName, Theme } from "../render/theme.ts";
import { hints, spinner, status, table, wrap } from "../render/widgets.ts";
import { pad, truncate, width } from "../render/width.ts";
import type { AppApi, ConfirmSpec, Dialog, Loading } from "../view.ts";
import { moveSelection, windowStart } from "./common.ts";

/** 根部门 ID（ROOT_DEPARTMENT）。不从 directory.ts 取值：它会把服务的日志和配置一起加载进管理台。 */
const ROOT = "1";
/** 选择器最多占的行数；更高的终端不必铺满。 */
const MAX_HEIGHT = 28;
const MOVES = ["up", "down", "pageup", "pagedown", "home", "end"];

/** 选择器的数据来源：当前范围、直属子部门和部门详情。默认经服务的本机控制接口查询，测试换成假的。signal 中止时取消查询。 */
export interface DepartmentSource {
  /** 当前同步范围；undefined 为整个通讯录。 */
  scope(signal?: AbortSignal): Promise<readonly string[] | undefined>;
  children(parent: string, signal?: AbortSignal): Promise<DepartmentInfo[]>;
  describe(ids: readonly string[], signal?: AbortSignal): Promise<DepartmentDescription>;
}

export function serviceDepartments(file = join(PROJECT_DIR, "data", "state", "instance.json")): DepartmentSource {
  return {
    async scope(signal) {
      const service = await readServiceStatus(undefined, file, signal);
      if (service.verificationOnly) throw new Error("这是不连接平台的验证实例，不能读取部门");
      if (!service.directory) throw new Error("服务没有报告通讯录状态；请等服务启动完成后再试");
      return service.directory.scope;
    },
    children: (parent, signal) => listDepartments(parent, undefined, file, signal),
    describe: (ids, signal) => describeDepartments(ids, undefined, file, undefined, signal),
  };
}

/** 设置同步范围的确认说明；菜单里手动填写部门 ID 与选择器共用。change 是选择器给出的范围变化。 */
export function scopeConfirmation(subject: string, departments: boolean, change?: string): Omit<ConfirmSpec, "title"> {
  return {
    subject,
    steps: [
      ...(change ? [change] : []),
      ...(departments ? ["服务先向平台核对每个部门，任何一个不存在、无权读取或没核对成都不改"] : []),
      "与现有范围相同则不改、不重新同步；否则保存范围，正在进行的同步中止，按新范围立即重新同步",
      "范围外成员的映射在这一轮完整同步后撤销；超过撤销阈值时暂停，等你确认",
    ],
    untouched: ["统计账本和会话历史", "范围内成员已有的映射"],
    recovery: "重新设置范围（留空或不勾选部门即整个通讯录）后，下一轮同步恢复被撤销成员的映射",
  };
}

/**
 * 打开部门选择器设置同步范围。选好后照常确认，再交给 directory-scope 命令；在确认框里取消会回到选择器，勾选保留。
 * 选择器的查询在交回结果或取消时取消（确认框打开期间照常进行），管理台退出时也取消。
 */
export async function pickDirectoryScope(app: AppApi, source: DepartmentSource = serviceDepartments()): Promise<void> {
  const session = new AbortController();
  const picker = new ScopePicker(source, () => app.redraw(), AbortSignal.any([session.signal, consoleRequests()]));
  let scope: string[] | undefined;
  try {
    for (;;) {
      const picked = await app.dialog(picker);
      if (picked === null) { app.toast("idle", "已取消，同步范围未改"); return; }
      if (!picker.changed) { app.toast("idle", "同步范围没有变化，未重新同步"); return; }
      if (await app.confirm({ title: "设置同步范围", danger: true, ...picker.confirmation() })) { scope = picked; break; }
    }
  } finally { session.abort(new Error("选择器已关闭")); }
  const code = await app.run("设置同步范围", scope ? ["directory-scope", scope.join(",")] : ["directory-scope"]);
  app.toast(code === 0 ? "ok" : "danger", code === 0 ? "设置同步范围完成" : `设置同步范围退出码 ${code}`);
}

interface Known {
  name: string;
  count?: number;
  fullName?: string;
  /** 上级部门 ID，根部门在前；还不知道时没有。 */
  path?: string[];
  /** 上级部门名称，一级部门在前、不含根部门；与 path 同时有。 */
  trail?: string[];
}

interface Level {
  /** 列出哪个部门的子部门。 */
  readonly id: string;
  /** 这个部门的上级 ID（根部门在前）；根部门为空。 */
  readonly path: string[];
  /** 这个部门及其上级的名称（不含根部门）：子部门的上级名称。 */
  readonly trail: string[];
  cursor: number;
  filter: string;
}

/** 交回 undefined 为整个通讯录，null 为取消。 */
export class ScopePicker implements Dialog<string[] | undefined | null> {
  private scope: Loading<readonly string[] | undefined> = { kind: "loading" };
  private names: Loading<true> = { kind: "idle" };
  private readonly children = new Map<string, Loading<DepartmentInfo[]>>();
  private readonly known = new Map<string, Known>();
  private readonly refused = new Map<string, string>();
  private readonly stack: Level[] = [{ id: ROOT, path: [], trail: [], cursor: 0, filter: "" }];
  private selected: string[] = [];
  private view: "browse" | "picked" = "browse";
  private pickedCursor = 0;
  private message: { status: StatusName; text: string } | null = null;
  private leaving = false;

  /** signal（缺省为管理台退出）中止后不再发起查询，迟到的结果也不再改动选择器。 */
  constructor(private readonly source: DepartmentSource, private readonly redraw: () => void,
    private readonly signal: AbortSignal = consoleRequests()) {
    void this.loadScope();
    this.load(this.stack[0]!);
  }

  private get closed(): boolean { return this.signal.aborted; }

  /** 勾选与打开时的范围不同（打开时的范围还没读到时为 false）。 */
  get changed(): boolean { return this.scope.kind === "ready" && !sameScope(this.result, this.scope.value); }

  private get result(): string[] | undefined { return this.selected.length ? [...this.selected] : undefined; }
  private get level(): Level { return this.stack.at(-1)!; }

  /** 确认框的说明：所选部门的路径，以及与打开时范围的差别。 */
  confirmation(): Omit<ConfirmSpec, "title"> {
    const before = this.scope.kind === "ready" ? this.scope.value : undefined, after = this.result;
    const list = (ids: string[]) => ids.map(id => this.label(id)).join("；");
    const change = [before ? `当前范围 ${before.length} 个部门` : "当前同步整个通讯录"];
    if (before && after) {
      const added = after.filter(id => !before.includes(id)), removed = before.filter(id => !after.includes(id));
      if (added.length) change.push(`新增 ${list(added)}`);
      if (removed.length) change.push(`移出 ${list(removed)}`);
    }
    return scopeConfirmation(after ? `只同步 ${after.length} 个部门及其子部门：${list(after)}` : "同步整个通讯录", !!after, change.join("；"));
  }

  /** 部门的显示路径（一级部门到本部门）；名称还没读到时为 ID。 */
  label(id: string): string {
    const known = this.known.get(id);
    if (!known) return id;
    const name = known.name || id;
    return known.trail ? [...known.trail, name].join(" / ") : known.fullName ?? name;
  }

  private async loadScope(): Promise<void> {
    let scope: readonly string[] | undefined;
    try { scope = await this.source.scope(this.signal); }
    catch (error) {
      if (this.closed) return;
      this.scope = { kind: "error", message: describeError(error) };
      this.redraw();
      return;
    }
    if (this.closed) return;
    this.scope = { kind: "ready", value: scope };
    this.selected = [...scope ?? []];
    this.redraw();
    if (scope?.length) await this.loadNames(scope);
  }

  /** 范围里各部门的名称和上级链；读不到不影响勾选和保存，可以在已选列表里按 r 重读。 */
  private async loadNames(ids: readonly string[]): Promise<void> {
    if (this.closed || this.names.kind === "loading") return;
    this.names = { kind: "loading" };
    this.redraw();
    let described: DepartmentDescription;
    try { described = await this.source.describe(ids, this.signal); }
    catch (error) {
      if (this.closed) return;
      this.names = { kind: "error", message: describeError(error) };
      this.redraw();
      return;
    }
    if (this.closed) return;
    for (const department of described.departments) {
      const seen = this.known.get(department.id), ancestors = department.ancestors;
      // 浏览时看到的位置与列表一致，已经知道的不用详情里的上级链覆盖。
      const place = seen?.path ? { path: seen.path, trail: seen.trail }
        : ancestors ? { path: [ROOT, ...ancestors.map(item => item.id)], trail: ancestors.map(item => item.name || item.id) } : {};
      this.known.set(department.id, { name: department.name, ...place,
        ...(department.count !== undefined ? { count: department.count } : {}), ...(department.fullName ? { fullName: department.fullName } : {}) });
    }
    for (const item of described.unavailable) this.refused.set(item.id, item.message);
    this.names = { kind: "ready", value: true };
    this.redraw();
  }

  /** 读取一层的子部门；读到的和正在读的不再重复读，失败的可以重试。 */
  private load(level: Level): void {
    const state = this.children.get(level.id);
    if (this.closed || state?.kind === "loading" || state?.kind === "ready") return;
    this.children.set(level.id, { kind: "loading" });
    const path = [...level.path, level.id];
    void this.source.children(level.id, this.signal).then(list => {
      if (this.closed) return;
      for (const item of list) {
        this.known.set(item.id, { ...this.known.get(item.id), name: item.name, ...(item.count !== undefined ? { count: item.count } : {}),
          path, trail: level.trail });
      }
      this.children.set(level.id, { kind: "ready", value: list });
      this.redraw();
    }, error => {
      if (this.closed) return;
      this.children.set(level.id, { kind: "error", message: describeError(error) });
      this.redraw();
    });
  }

  /** 本层符合筛选的子部门。 */
  private rows(level: Level): DepartmentInfo[] {
    const state = this.children.get(level.id);
    if (state?.kind !== "ready") return [];
    const query = level.filter.trim().toLocaleLowerCase();
    return query ? state.value.filter(item => item.name.toLocaleLowerCase().includes(query) || item.id.toLocaleLowerCase().includes(query)) : state.value;
  }

  /** path 上已勾选的部门（离根最近的那个）；没有时为 undefined。 */
  private covering(path: readonly string[] | undefined): string | undefined {
    return path?.find(id => this.selected.includes(id));
  }

  /** 已勾选、且已知在 id 之下的部门。 */
  private below(id: string): string[] {
    return this.selected.filter(other => other !== id && this.known.get(other)?.path?.includes(id));
  }

  private toggle(id: string, path: readonly string[] | undefined): void {
    if (this.scope.kind !== "ready") {
      this.message = { status: "warn", text: this.scope.kind === "error" ? "当前范围读取失败，不能修改；按 Esc 关闭" : "正在读取当前范围，稍后再勾选" };
      return;
    }
    const covering = this.covering(path);
    if (this.selected.includes(id)) {
      this.selected = this.selected.filter(other => other !== id);
      this.message = { status: "idle", text: covering ? `已取消「${this.label(id)}」；它仍包含在已选的「${this.label(covering)}」中` : `已取消「${this.label(id)}」` };
      return;
    }
    if (covering) {
      this.message = { status: "warn", text: `已包含在已选的「${this.label(covering)}」中；要单独选它，先取消上级` };
      return;
    }
    const below = this.below(id), next = [...this.selected.filter(other => !below.includes(other)), id];
    if (next.length > MAX_SCOPE_DEPARTMENTS) {
      this.message = { status: "warn", text: `最多选 ${MAX_SCOPE_DEPARTMENTS} 个部门；可以改选它们的上级部门` };
      return;
    }
    this.selected = next;
    this.message = { status: "ok", text: below.length ? `已勾选「${this.label(id)}」（含全部子部门），原先单独勾选的 ${below.length} 个下级部门并入其中`
      : `已勾选「${this.label(id)}」（含全部子部门）` };
  }

  // ===== Dialog =====

  title(): string { return "选择同步范围"; }

  note(): string {
    if (this.scope.kind !== "ready") return "";
    return this.selected.length ? `已选 ${this.selected.length} 个部门` : "整个通讯录";
  }

  busy(): boolean {
    return this.scope.kind === "loading" || this.names.kind === "loading" || [...this.children.values()].some(state => state.kind === "loading");
  }

  onKey(key: Key): { done: string[] | undefined | null } | void {
    if (key.ctrl && key.name === "c") return { done: null };
    const level = this.level;
    if (key.name === "escape") {
      if (this.view === "browse" && level.filter) { level.filter = ""; level.cursor = 0; return; }
      if (this.changed && !this.leaving) {
        this.leaving = true;
        this.message = { status: "warn", text: "勾选有改动：再按 Esc 放弃，按 Enter 保存" };
        return;
      }
      return { done: null };
    }
    this.leaving = false;
    if (key.name === "enter") {
      if (this.scope.kind === "ready") return { done: this.result };
      this.message = { status: "warn", text: this.scope.kind === "error" ? "当前范围读取失败，不能保存；按 Esc 关闭" : "正在读取当前范围，请稍候" };
      return;
    }
    if (key.name === "tab") {
      this.view = this.view === "browse" ? "picked" : "browse";
      this.message = null;
      return;
    }
    if (this.view === "picked") this.pickedKey(key);
    else this.browseKey(key, level);
  }

  private browseKey(key: Key, level: Level): void {
    const rows = this.rows(level), row = rows[level.cursor];
    if (MOVES.includes(key.name)) {
      level.cursor = moveSelection(key.name, level.cursor, rows.length) ?? level.cursor;
    } else if (key.name === "right") {
      if (this.children.get(level.id)?.kind === "error") { this.children.delete(level.id); this.load(level); return; }
      if (!row) return;
      const next: Level = { id: row.id, path: [...level.path, level.id], trail: [...level.trail, row.name || row.id], cursor: 0, filter: "" };
      this.stack.push(next);
      this.load(next);
      this.message = null;
    } else if (key.name === "left") {
      if (this.stack.length > 1) { this.stack.pop(); this.message = null; }
    } else if (key.name === "space") {
      if (row) this.toggle(row.id, [...level.path, level.id]);
    } else {
      const before = level.filter;
      if (key.name === "backspace") level.filter = [...level.filter].slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") level.filter = "";
      else if (!key.ctrl && key.text) level.filter += key.text;
      if (level.filter !== before) level.cursor = 0;
    }
  }

  private pickedKey(key: Key): void {
    // 浏览视图里取消勾选会让已选列表变短，光标可能停在末尾之外。
    this.pickedCursor = Math.max(0, Math.min(this.pickedCursor, this.selected.length - 1));
    if (MOVES.includes(key.name)) {
      this.pickedCursor = moveSelection(key.name, this.pickedCursor, this.selected.length) ?? this.pickedCursor;
    } else if (key.name === "space" || key.name === "delete") {
      const id = this.selected[this.pickedCursor];
      if (!id) return;
      this.toggle(id, this.known.get(id)?.path);
      this.pickedCursor = Math.max(0, Math.min(this.pickedCursor, this.selected.length - 1));
    } else if (key.name === "r" && !key.ctrl && this.names.kind === "error" && this.scope.kind === "ready" && this.scope.value) {
      this.message = null;
      void this.loadNames(this.scope.value);
    }
  }

  render(theme: Theme, size: number, height: number): string[] {
    const total = Math.min(height, MAX_HEIGHT);
    const head = this.view === "browse" ? this.browseHead(theme, size) : this.pickedHead(theme, size);
    const tail = this.tail(theme, size);
    const room = Math.max(1, total - head.length - tail.length);
    const body = (this.view === "browse" ? this.browseRows(theme, size, room) : this.pickedRows(theme, size, room)).slice(0, room);
    while (body.length < room) body.push("");
    return [...head, ...body, ...tail].map(line => pad(line, size));
  }

  private browseHead(theme: Theme, size: number): string[] {
    const level = this.level, rows = this.rows(level).length;
    const filter = level.filter ? level.filter + "▁" : theme.c("muted", "输入名称或 ID 筛选本层");
    return [
      theme.c("muted", "位置 › ") + keepEnd(["全部部门", ...level.trail].join(" / "), size - 7),
      withPosition(theme, theme.c("accent", "筛选 › ") + filter, rows ? `${level.cursor + 1} / ${rows}` : "", size),
    ];
  }

  private pickedHead(theme: Theme, size: number): string[] {
    const before = this.scope.kind === "ready" ? this.scope.value : undefined;
    let change = "";
    if (this.scope.kind === "ready") {
      const added = this.selected.filter(id => !before?.includes(id)).length, removed = (before ?? []).filter(id => !this.selected.includes(id)).length;
      change = !this.changed ? "与当前范围相同" : before && this.selected.length ? `与当前范围相比：新增 ${added} 个，移出 ${removed} 个`
        : this.selected.length ? "当前同步整个通讯录，改为只同步所选部门" : "改为同步整个通讯录";
    }
    const count = this.scope.kind === "ready" ? this.selected.length : 0;
    return [theme.c("muted", "已选部门 · 每个都含其全部子部门"), withPosition(theme, theme.c(this.changed ? "warn" : "muted", change),
      count ? `${Math.min(this.pickedCursor, count - 1) + 1} / ${count}` : "", size)];
  }

  private browseRows(theme: Theme, size: number, room: number): string[] {
    const level = this.level, state = this.children.get(level.id);
    if (state?.kind !== "ready" && state?.kind !== "error") return [`  ${spinner(theme)} ${theme.c("muted", "正在读取部门…")}`];
    if (state.kind === "error") return [...wrap(`读取失败：${state.message}`, size - 2).map(line => "  " + theme.c("danger", line)), theme.c("muted", "  按 → 重试，← 返回上级")];
    const rows = this.rows(level);
    if (!rows.length) return [theme.c("muted", state.value.length ? "  没有匹配的部门；退格修改，Ctrl+U 清空" : "  没有子部门；按 ← 返回上级")];
    const covering = this.covering([...level.path, level.id]);
    const start = windowStart(level.cursor, rows.length, room);
    return table(theme, {
      width: size, rows: rows.slice(start, start + room), selected: level.cursor - start,
      columns: [
        { header: "", size: 3, render: item => covering ? theme.c("muted", "[x]") : this.selected.includes(item.id) ? theme.c("ok", "[x]") : "[ ]" },
        { header: "", flex: 1, render: item => covering ? theme.c("muted", item.name || item.id) : item.name || item.id },
        { header: "", size: 7, align: "right", render: item => item.count === undefined ? "" : theme.c("muted", `${item.count} 人`) },
        { header: "", size: 16, render: item => {
          if (covering) return theme.c("muted", "已包含在上级中");
          const below = this.below(item.id).length;
          return below ? theme.c("accent", `含 ${below} 个已选下级`) : "";
        } },
      ],
    });
  }

  private pickedRows(theme: Theme, size: number, room: number): string[] {
    if (this.scope.kind === "loading") return [`  ${spinner(theme)} ${theme.c("muted", "正在读取当前范围…")}`];
    if (this.scope.kind === "error") return [theme.c("muted", "  当前范围读取失败")];
    if (!this.selected.length) return [theme.c("muted", "  没有勾选部门：保存后同步整个通讯录"), theme.c("muted", "  按 Tab 回到部门列表勾选")];
    const cursor = Math.min(this.pickedCursor, this.selected.length - 1);
    const start = windowStart(cursor, this.selected.length, room);
    return table(theme, {
      width: size, rows: this.selected.slice(start, start + room), selected: cursor - start,
      columns: [
        { header: "", size: 3, render: () => theme.c("ok", "[x]") },
        { header: "", flex: 1, render: id => this.label(id) },
        { header: "", size: 16, render: id => this.refused.has(id) ? theme.c("danger", "平台拒绝")
          : this.covering(this.known.get(id)?.path) ? theme.c("muted", "已包含在上级中")
          : this.known.has(id) ? "" : theme.c("muted", this.names.kind === "loading" ? "读取名称…" : "名称未知") },
      ],
    });
  }

  /** 当前行的详情、提示、已选摘要和键位。 */
  private tail(theme: Theme, size: number): string[] {
    return [
      theme.c("muted", truncate(this.detail(), size)),
      this.notice(theme, size),
      truncate(this.summary(theme), size),
      hints(theme, this.view === "browse"
        ? [["↑↓", "选择"], ["→", "展开"], ["←", "上级"], ["Space", "勾选"], ["Tab", "已选"], ["Enter", "保存"], ["Esc", "取消"]]
        : [["↑↓", "选择"], ["Space", "移出"], ...this.names.kind === "error" ? [["r", "重读名称"] as [string, string]] : [],
          ["Tab", "返回列表"], ["Enter", "保存"], ["Esc", "取消"]], size),
    ];
  }

  private detail(): string {
    if (this.view === "browse") {
      const level = this.level, row = this.rows(level)[level.cursor];
      if (!row) return "";
      const covering = this.covering([...level.path, level.id]);
      return `ID ${row.id} · ${covering ? `已包含在已选的「${this.label(covering)}」中` : "→ 查看子部门"}`;
    }
    const id = this.selected[Math.min(this.pickedCursor, this.selected.length - 1)];
    if (!id) return "";
    const known = this.known.get(id), covering = this.covering(known?.path), refused = this.refused.get(id);
    return [`ID ${id}`, refused ? `需先移出，否则保存被拒：${refused}` : covering ? `已包含在已选的「${this.label(covering)}」中` : ""]
      .filter(Boolean).join(" · ");
  }

  private notice(theme: Theme, size: number): string {
    const line = (name: StatusName, text: string) => status(theme, name, truncate(text, size - 2));
    if (this.message) return line(this.message.status, this.message.text);
    if (this.scope.kind === "loading") return line("busy", "正在读取当前范围…");
    if (this.scope.kind === "error") return line("danger", `当前范围读取失败：${this.scope.message}`);
    if (this.names.kind === "loading") return line("busy", "正在读取已选部门的名称…");
    if (this.names.kind === "error") {
      return line("warn", `部门名称没读到（不影响勾选和保存；${this.view === "picked" ? "按 r 重试" : "Tab 到已选列表按 r 重试"}）：${this.names.message}`);
    }
    return "";
  }

  private summary(theme: Theme): string {
    if (this.scope.kind !== "ready") return "";
    const text = this.selected.length ? `已选 ${this.selected.length} 个：${this.selected.map(id => this.label(id)).join("；")}` : "没有勾选部门：保存后同步整个通讯录";
    return (this.changed ? theme.c("warn", "有改动 · ") : "") + text;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 行尾右对齐列表位置（如 3 / 23）；放不下时让给左边的文字。 */
function withPosition(theme: Theme, text: string, position: string, size: number): string {
  const room = size - width(position) - 2;
  return position && width(text) <= room ? pad(text, size - width(position)) + theme.c("muted", position) : text;
}

/** 只保留末尾能放下的部分（面包屑里当前这一层更要紧）。 */
function keepEnd(text: string, size: number): string {
  if (width(text) <= size) return text;
  let out = "";
  for (const char of [...text].reverse()) {
    if (width("…" + char + out) > size) break;
    out = char + out;
  }
  return "…" + out;
}
