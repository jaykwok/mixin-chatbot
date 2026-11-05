/** @jsxImportSource preact */
// 推送页的「设置」：推送人、管理员、频次上限与授权。名单默认为空，即推送功能关闭；机器人必须正在运行（名单存在服务的状态库里，
// 保存时服务核对每个人都在同步的通讯录里）。默认只能推送给个人；按部门（含下级）、全员和到群各需单独授权。
import { useState } from "preact/hooks";
import { api } from "./api.ts";
import type { PushDepartmentView, PushRoleView, PushSettingsResponse } from "./contract.ts";
import { dateTime } from "./format.ts";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A row being edited: an existing person by key, or a new one by the number typed in. */
type Row = {
  key?: string; phone: string; name: string | null; admin: boolean; pusher: boolean; dailyLimit: string; updatedAt?: number;
  all: boolean; group: boolean; department: "none" | "any" | "some"; departments: string[];
};

const rowOf = (role: PushRoleView): Row => ({ key: role.key, phone: role.phone, name: role.name, admin: role.admin, pusher: role.pusher,
  dailyLimit: role.dailyLimit === null ? "" : String(role.dailyLimit), updatedAt: role.updatedAt, all: role.grants.all, group: role.grants.group,
  department: Array.isArray(role.grants.department) ? "some" : role.grants.department,
  departments: Array.isArray(role.grants.department) ? role.grants.department : [] });

/** Department grants of one row: none, any, or the chosen departments (picked by path). */
function DepartmentGrant(props: { row: Row; departments: PushDepartmentView[]; disabled: boolean; change: (patch: Partial<Row>) => void }) {
  const { row, departments, disabled, change } = props;
  const [typed, setTyped] = useState("");
  const pathOf = new Map(departments.map(department => [department.key, department]));
  const pick = (value: string) => {
    const found = departments.find(department => !department.gone && department.path === value.trim());
    if (!found) { setTyped(value); return; }
    setTyped("");
    if (!row.departments.includes(found.key)) change({ departments: [...row.departments, found.key] });
  };
  return <div class="push-grant">
    <select aria-label="部门授权" value={row.department} disabled={disabled} onChange={event => change({ department: event.currentTarget.value as Row["department"] })}>
      <option value="none">不能按部门</option><option value="any">任意部门</option><option value="some">指定部门</option>
    </select>
    {row.department === "some" && <>
      {row.departments.map(key => <span class={`chip ${pathOf.get(key)?.gone ? "warn" : "neutral"}`} key={key}>{pathOf.get(key)?.path ?? "未知部门"}
        <button class="btn ghost" aria-label="移除部门" disabled={disabled} onClick={() => change({ departments: row.departments.filter(each => each !== key) })}>×</button></span>)}
      <input list="push-departments" placeholder={departments.length ? "输入部门路径选择" : "还没有同步到部门"} aria-label="添加部门" value={typed}
        disabled={disabled || !departments.length} onInput={event => pick(event.currentTarget.value)} />
    </>}
  </div>;
}

export function PushSettingsForm() {
  const [view, setView] = useState<string | null>(null), [rows, setRows] = useState<Row[]>([]), [adding, setAdding] = useState("");
  const [departments, setDepartments] = useState<PushDepartmentView[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const load = (result: PushSettingsResponse) => { setView(result.view); setDepartments(result.departments); setRows(result.roles.map(rowOf)); };
  const open = async () => { setBusy(true); setError(""); setNotice(""); try { load(await api<PushSettingsResponse>("/api/push/settings", { intent: true, timeoutMs: 30_000 })); }
    catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const change = (index: number, patch: Partial<Row>) => setRows(previous => previous.map((row, at) => at === index ? { ...row, ...patch } : row));
  const add = () => {
    const phone = adding.replace(/[\s-]/g, "");
    if (!/^\+?\d{5,20}$/.test(phone)) { setError("请输入完整手机号"); return; }
    if (rows.some(row => !row.key && row.phone === phone)) { setError("这个手机号已在名单里"); return; }
    setError(""); setAdding("");
    setRows(previous => [...previous, { phone, name: null, admin: false, pusher: true, dailyLimit: "", all: false, group: false, department: "none", departments: [] }]);
  };
  const invalidLimit = rows.some(row => row.dailyLimit !== "" && !/^[1-9]\d{0,3}$/.test(row.dailyLimit) || Number(row.dailyLimit) > 1000);
  const missingDepartments = rows.some(row => row.pusher && row.department === "some" && !row.departments.length);
  const save = async () => { if (!view || busy) return; setBusy(true); setError(""); try {
    const roles = rows.map(row => ({ ...(row.key ? { key: row.key } : { phone: row.phone }), admin: row.admin, pusher: row.pusher,
      dailyLimit: row.dailyLimit === "" ? null : Number(row.dailyLimit),
      // Only pushers push: the grants of anyone else are dropped.
      grants: row.pusher ? { all: row.all, group: row.group, department: row.department === "some" ? row.departments : row.department }
        : { all: false, group: false, department: "none" } }));
    load(await api<PushSettingsResponse>("/api/push/settings", { method: "POST", body: { view, roles }, intent: true, timeoutMs: 30_000 }));
    setNotice("已保存，立即生效：推送人下一次在单聊里提问时就能发起推送。");
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  return <section class="card write-form"><h2>推送设置</h2>
    <p>推送人可以在单聊里让机器人准备推送，确认后发给通讯录同步范围内的人；管理员负责群登记。名单为空时推送功能关闭。机器人必须正在运行。</p>
    <button class="btn" disabled={busy} onClick={() => void open()}>{busy ? "正在读取…" : view ? "重新读取" : "读取名单"}</button>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {view && <>
      <datalist id="push-departments">{departments.filter(department => !department.gone).map(department => <option key={department.key} value={department.path} />)}</datalist>
      {!rows.length ? <p>名单为空，推送功能关闭。</p> : <div class="table-wrap"><table class="data-table push-roles"><thead><tr>
        <th>姓名</th><th>手机号</th><th>推送人</th><th>管理员</th><th>24 小时内最多</th><th>全员</th><th>到群</th><th>按部门</th><th>更新时间</th><th /></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.key ?? `new-${row.phone}`}>
          <td>{row.name ?? (row.key ? <span class="muted">不在通讯录里</span> : <span class="muted">保存时核对</span>)}</td>
          <td class="mono">{row.phone}</td>
          <td><input type="checkbox" aria-label="推送人" checked={row.pusher} disabled={busy} onChange={event => change(index, { pusher: event.currentTarget.checked })} /></td>
          <td><input type="checkbox" aria-label="管理员" checked={row.admin} disabled={busy} onChange={event => change(index, { admin: event.currentTarget.checked })} /></td>
          <td><input class="limit-input" inputMode="numeric" placeholder="不限" aria-label="频次上限" value={row.dailyLimit} disabled={busy || !row.pusher}
            onInput={event => change(index, { dailyLimit: event.currentTarget.value.trim() })} /> 条</td>
          <td><input type="checkbox" aria-label="全员授权" checked={row.pusher && row.all} disabled={busy || !row.pusher} onChange={event => change(index, { all: event.currentTarget.checked })} /></td>
          <td><input type="checkbox" aria-label="群授权" checked={row.pusher && row.group} disabled={busy || !row.pusher} onChange={event => change(index, { group: event.currentTarget.checked })} /></td>
          <td><DepartmentGrant row={row} departments={departments} disabled={busy || !row.pusher} change={patch => change(index, patch)} /></td>
          <td class="muted">{row.updatedAt ? dateTime(row.updatedAt) : "未保存"}</td>
          <td><button class="btn ghost" disabled={busy} onClick={() => setRows(previous => previous.filter((_, at) => at !== index))}>移除</button></td>
        </tr>)}</tbody></table></div>}
      <label>添加成员（完整手机号）<input inputMode="tel" value={adding} disabled={busy} onInput={event => setAdding(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === "Enter") add(); }} /></label>
      <div class="action-row"><button class="btn" disabled={busy || !adding.trim()} onClick={add}>加入名单</button>
        <button class="btn primary" disabled={busy || invalidLimit || missingDepartments} onClick={() => void save()}>保存</button></div>
      {invalidLimit && <p role="alert">频次上限是 1 到 1000 的整数，留空为不限。</p>}
      {missingDepartments && <p role="alert">选了「指定部门」的推送人至少要选一个部门。</p>}
      <p><small>频次上限按点「确认推送」的时间计算，留空为不限。默认只能推送给个人；按部门推送（含下级部门）、推送给全员和推送到已登记的群
        要在这里授权，部门和全员的名单不含推送人自己。管理员在群里登记群（见下方群名单）。既不是推送人也不是管理员的人保存时移出名单。</small></p>
    </>}
  </section>;
}
