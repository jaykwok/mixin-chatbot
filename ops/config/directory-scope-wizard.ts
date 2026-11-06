// 通讯录同步范围的终端向导：先选「选择部门」或「整个通讯录」；部门从一级部门逐层进入、任意层级多选，每个部门含其全部子部门
// （部门 ID 是一长串数字，没人记得住，不接受手填）。部署时（directory-scope.ts choose，直接向平台查询）和部署后
// （directory-admin.ts scope，经运行中服务的本机控制接口查询和保存）共用这一份。
//
// 不导入平台客户端：部署后的修改只是对运行中服务的请求，这边只需要轻量的范围模块。
import { cancel, confirm, intro, isCancel, log, multiselect, outro, select, spinner } from "@clack/prompts";
import type { DepartmentDescription, DepartmentInfo } from "../../src/integrations/open-platform/directory.ts";
import { MAX_SCOPE_DEPARTMENTS, ROOT_DEPARTMENT as ROOT, sameScope, WHOLE_DIRECTORY, type DirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { departmentPath, departmentRow, describeScope, describeScopeChange, SCOPE_APPLY_NOTE, SCOPE_PROGRESS_HINT, scopeChangeSummary,
  type DepartmentSource, type SavedScope, type ScopeChange } from "../tools/directory-admin.ts";


/**
 * 向导的部门查询：直属子部门，以及完成选择时的核对（任何一个部门不存在、无权读取或没核对成都抛错，说明原因）。
 * 各自限时；signal 中止表示用户在查询中按了 Ctrl+C。
 */
export interface WizardDepartments {
  childDepartments(parent: string, signal: AbortSignal): Promise<DepartmentInfo[]>;
  verify(ids: readonly string[], signal: AbortSignal): Promise<DepartmentInfo[]>;
}

export interface WizardOptions {
  /** 当前保存的范围：整个通讯录时先停在「整个通讯录」；部门时预先勾选。 */
  readonly current?: DirectoryScope;
  /** 预先勾选的部门的显示路径（ID → 路径）；没有的显示 ID。 */
  readonly labels?: ReadonlyMap<string, string>;
  /** 最后确认之前的说明（保存后何时、对谁生效）。 */
  readonly note?: string;
  /** 取消时的说明。 */
  readonly cancelled?: string;
}

const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);
const cancelledError = () => new DOMException("选择已取消", "AbortError");
const departmentLabel = (department: DepartmentInfo) => department.name || department.id;
const countHint = (department: DepartmentInfo) => `${department.count === undefined ? "" : `${department.count} 人 · `}ID ${department.id}`;

/** 提示被取消（Ctrl+C 或 Esc）时说明并抛 AbortError。 */
function bailer(message: string) {
  return <T>(value: T | symbol): T => {
    if (isCancel(value)) {
      cancel(message);
      throw cancelledError();
    }
    return value as T;
  };
}

/**
 * 转圈等一次查询。查询中按 Ctrl+C 即取消：中止查询，说明后抛 AbortError。失败时显示原因，返回 undefined。
 */
async function query<T>(start: string, run: (signal: AbortSignal) => Promise<T>, done: (value: T) => string,
  failed: (error: unknown) => string, cancelled: string): Promise<T | undefined> {
  const controller = new AbortController();
  const progress = spinner({ cancelMessage: cancelled, onCancel: () => controller.abort() });
  progress.start(start);
  try {
    const value = await run(controller.signal);
    if (controller.signal.aborted) throw cancelledError();
    progress.stop(done(value));
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw cancelledError();
    progress.error(failed(error));
    return undefined;
  }
}

/** 先选「选择部门」或「整个通讯录」；整个通讯录要再确认一次（默认否）。取消时抛 AbortError。 */
export async function chooseInteractively(departments: WizardDepartments, options: WizardOptions = {}): Promise<DirectoryScope> {
  const cancelled = options.cancelled ?? "已取消，没有选择通讯录同步范围";
  const bail = bailer(cancelled);
  log.info("机器人按开放平台通讯录确认成员身份，只有同步范围内的成员能使用机器人。必须明确选择：整个通讯录，或选定的部门及其全部子部门。");
  for (;;) {
    const mode = bail(await select({
      message: "通讯录同步范围",
      options: [
        { value: "departments", label: "选择部门", hint: "只同步选中的部门及其全部子部门" },
        { value: "all", label: "整个通讯录", hint: "通讯录里的所有成员都能使用机器人" },
      ],
      ...options.current ? { initialValue: options.current.kind === "all" ? "all" : "departments" } : {},
    }));
    if (mode === "all") {
      if (options.note) log.info(options.note);
      if (bail(await confirm({ message: "确认同步整个通讯录？通讯录里的所有成员都能使用机器人", initialValue: false }))) return WHOLE_DIRECTORY;
      continue;
    }
    const picked = await pickDepartments(departments, options, cancelled);
    if (picked) return picked;
  }
}

type Level = { id: string; ids: string[]; trail: string[] };

/**
 * 从一级部门逐层进入，任意层级多选；完成时核对并列出完整路径，再确认一次。返回 undefined 为改选整个通讯录。
 * 当前范围是部门时预先勾选它们。
 */
async function pickDepartments(departments: WizardDepartments, options: WizardOptions, cancelled: string): Promise<DirectoryScope | undefined> {
  const bail = bailer(cancelled);
  /** 已选部门 ID → 显示路径。 */
  const selected = new Map<string, string>();
  if (options.current?.kind === "departments") for (const id of options.current.departments) selected.set(id, options.labels?.get(id) ?? id);
  const stack: Level[] = [{ id: ROOT, ids: [], trail: [] }];
  const loaded = new Map<string, DepartmentInfo[]>();
  for (;;) {
    const level = stack.at(-1)!;
    const where = level.trail.length ? level.trail.join(" / ") : "一级部门";
    let children = loaded.get(level.id);
    if (!children) {
      children = await query(`读取「${where}」…`, signal => departments.childDepartments(level.id, signal),
        list => `「${where}」有 ${list.length} 个子部门`, error => `读取「${where}」失败：${describeError(error)}`, cancelled);
      if (children) loaded.set(level.id, children);
    }
    const covering = level.ids.find(id => selected.has(id));
    const action = bail(await select({
      message: `位置：${where}${covering ? `（已包含在已选的「${selected.get(covering)}」中）` : ""}`,
      options: [
        ...children?.length && !covering ? [{ value: "check", label: "勾选本层部门", hint: "每个部门含其全部子部门" }] : [],
        ...children?.length ? [{ value: "open", label: "进入子部门" }] : [],
        ...children ? [] : [{ value: "reload", label: "重新读取" }],
        ...stack.length > 1 ? [{ value: "up", label: "返回上一级" }] : [],
        ...selected.size ? [{ value: "review", label: `查看或移出已选部门（${selected.size} 个）` }] : [],
        { value: "done", label: "完成选择", hint: selected.size ? `已选 ${selected.size} 个部门` : "还没有勾选部门" },
        { value: "back", label: "返回，改选整个通讯录" },
      ],
    }));
    if (action === "back") return undefined;
    if (action === "reload") continue;
    if (action === "up") { stack.pop(); continue; }
    if (action === "check") {
      const picked = bail(await multiselect({
        message: `勾选「${where}」下的部门（空格勾选，回车确认）`,
        options: children!.map(department => ({ value: department.id, label: departmentLabel(department), hint: countHint(department) })),
        initialValues: children!.filter(department => selected.has(department.id)).map(department => department.id),
        required: false,
      }));
      const next = new Map(selected);
      for (const department of children!) {
        if (picked.includes(department.id)) next.set(department.id, [...level.trail, departmentLabel(department)].join(" / "));
        else next.delete(department.id);
      }
      if (next.size > MAX_SCOPE_DEPARTMENTS) { log.warn(`最多选 ${MAX_SCOPE_DEPARTMENTS} 个部门；可以改选它们的上级部门`); continue; }
      selected.clear();
      for (const [id, label] of next) selected.set(id, label);
      continue;
    }
    if (action === "open") {
      const id = bail(await select({
        message: "进入哪个部门？",
        options: children!.map(department => ({ value: department.id, label: departmentLabel(department), hint: countHint(department) })),
      }));
      const department = children!.find(item => item.id === id)!;
      stack.push({ id, ids: [...level.ids, id], trail: [...level.trail, departmentLabel(department)] });
      continue;
    }
    if (action === "review") {
      const kept = bail(await multiselect({
        message: "已选部门（取消勾选即移出）",
        options: [...selected].map(([id, label]) => ({ value: id, label, hint: `ID ${id}` })),
        initialValues: [...selected.keys()],
        required: false,
      }));
      for (const id of [...selected.keys()]) if (!kept.includes(id)) selected.delete(id);
      continue;
    }
    // done
    if (!selected.size) { log.warn("还没有勾选部门：勾选部门，或返回改选整个通讯录"); continue; }
    const ids = [...selected.keys()];
    const checked = await query(`向平台核对 ${ids.length} 个部门…`, signal => departments.verify(ids, signal), () => "核对通过", describeError, cancelled);
    if (!checked) continue;
    log.message(["只同步以下部门及其全部子部门（ID、人数、路径）：", ...checked.map(departmentRow)].join("\n"));
    if (options.note) log.info(options.note);
    if (bail(await confirm({ message: `保存这 ${ids.length} 个部门为同步范围？`, initialValue: true }))) return { kind: "departments", departments: ids };
  }
}

/**
 * 经运行中服务的查询：子部门；核对用部门详情，平台拒绝的部门（不存在、无权读取）和服务没有返回的部门都不能保存。
 * 服务的接口自己限时（directory-admin.ts）。
 */
export function serviceWizard(source: DepartmentSource): WizardDepartments {
  return {
    childDepartments: (parent, signal) => source.children(parent, signal),
    async verify(ids, signal) {
      const described = await source.describe(ids, signal);
      const refused = described.unavailable[0];
      if (refused) throw new Error(`部门 ${refused.id}：${refused.message}；范围未改，请移出这个部门`);
      const found = new Map(described.departments.map(department => [department.id, department]));
      return ids.map(id => {
        const department = found.get(id);
        if (!department) throw new Error(`服务没有返回部门 ${id}；范围未改，请稍后重试`);
        return { ...department, fullName: departmentPath(department) };
      });
    },
  };
}

/** 已选部门的显示路径（ID → 路径）；平台拒绝的注明原因（保存前要移出），服务没有返回的不列（显示 ID）。 */
export function scopeLabels(described: DepartmentDescription): Map<string, string> {
  const labels = new Map(described.departments.map(department => [department.id, departmentPath(department)]));
  for (const item of described.unavailable) labels.set(item.id, `${item.id}（平台拒绝：${item.message}；保存前要移出）`);
  return labels;
}

/**
 * 部署后在终端里修改同步范围（directory-admin.ts scope 不带参数）：读取服务保存的范围并预先勾选，用上面的向导选择，经运行中
 * 服务保存，保存即开始应用（与控制台的选择器同一个接口、同样的结果）。勾选没变且保存的范围已生效时不发请求；
 * 没生效（正在应用或应用失败）时同一范围再保存一次，立即重新应用。
 * 返回退出码：0 已保存或不必保存；1 没有保存（读不到服务、服务或平台拒绝）；130 取消（什么都没改）。
 */
export async function changeScopeInTerminal(source: DepartmentSource): Promise<number> {
  const cancelled = "已取消，同步范围未改";
  intro("通讯录同步范围");
  try {
    const saved = await query<SavedScope>("读取服务保存的同步范围…", signal => source.scope(signal), state => `当前范围：${describeScope(state.scope)}`,
      error => `读不到当前范围：${describeError(error)}`, cancelled);
    if (!saved) { outro("同步范围未改"); return 1; }
    const current = saved.scope;
    let labels: Map<string, string> | undefined;
    if (current?.kind === "departments") {
      const described = await query(`读取已选 ${current.departments.length} 个部门的名称…`, signal => source.describe(current.departments, signal),
        () => "已读取部门名称", error => `部门名称没读到（不影响选择，已选部门按 ID 显示）：${describeError(error)}`, cancelled);
      if (described) labels = scopeLabels(described);
    }
    if (!current) log.warn("当前未设置同步范围，服务不同步通讯录");
    else if (!saved.settled) log.warn("保存的范围还没有生效（正在应用或应用失败），之前的名单仍然生效；按同一范围再保存一次可立即重新应用");
    const scope = await chooseInteractively(serviceWizard(source), {
      ...current ? { current } : {}, ...labels ? { labels } : {}, note: `保存即开始应用：${SCOPE_APPLY_NOTE}。`, cancelled,
    });
    if (current && saved.settled && sameScope(scope, current)) { outro("同步范围没有变化，已经生效"); return 0; }
    // 请求发出后不能撤回：Ctrl+C 只停下转圈，照样等服务答复并显示结果。
    const progress = spinner({ cancelMessage: "保存请求已发出，不能中途取消；正在等服务答复…" });
    progress.start(scope.kind === "all" ? "保存同步范围：整个通讯录…" : `保存同步范围：${scope.departments.length} 个部门；服务先向平台核对每个部门…`);
    let result: ScopeChange;
    try { result = await source.save(scope); progress.stop("服务已答复"); }
    catch (error) { progress.error(describeError(error)); outro("同步范围没有保存，原因见上"); return 1; }
    log.message(describeScopeChange(scope, result).join("\n"));
    if (result.status === "started") log.info(SCOPE_PROGRESS_HINT);
    outro(scopeChangeSummary(result, { unset: !current, changed: !current || !sameScope(scope, current) }));
    return 0;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return 130;
    throw error;
  }
}
