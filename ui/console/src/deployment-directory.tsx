/** @jsxImportSource preact */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";

type Department = { key: string; name: string };
export interface DeploymentSelection { view: string; selected: string[] }
export function DeploymentDirectoryPicker({ onChange }: { onChange(value: DeploymentSelection | null): void }) {
  const [data, setData] = useState<{ view: string; children: Department[] } | null>(null), [selected, setSelected] = useState<Department[]>([]);
  const [tree, setTree] = useState<Record<string, Department[]>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), locked = useRef(false);
  useEffect(() => () => { controller.current?.abort(); }, []);
  const read = async (parent?: string) => {
    if (locked.current) return; locked.current = true; setBusy(true); setError("");
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    if (!parent) { onChange(null); setData(null); setSelected([]); setTree({}); }
    try {
      if (parent && data) {
        const value = await api<{ children: Department[] }>("/api/lifecycle/directory/children", { method: "POST", body: { view: data.view, parent }, intent: true, signal: current.signal, timeoutMs: 90_000 });
        if (!current.signal.aborted) setTree(previous => ({ ...previous, [parent]: value.children }));
      } else {
        const value = await api<NonNullable<typeof data>>("/api/lifecycle/directory/open", { method: "POST", body: {}, intent: true, signal: current.signal, timeoutMs: 90_000 });
        if (!current.signal.aborted) setData(value);
      }
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "部门查询失败"); }
    finally { locked.current = false; if (!current.signal.aborted) setBusy(false); }
  };
  const select = (item: Department, checked: boolean) => {
    const next = checked ? [...selected.filter(value => value.key !== item.key), item] : selected.filter(value => value.key !== item.key);
    setSelected(next); onChange(data && next.length ? { view: data.view, selected: next.map(value => value.key) } : null);
  };
  const cancel = () => { controller.current?.abort(); setData(null); setSelected([]); setTree({}); setBusy(false); setError(""); onChange(null); };
  const nodes = (items: Department[], ancestors = new Set<string>()): JSX.Element => <ul class="department-tree">{items.filter(item => !ancestors.has(item.key)).map(item => <li key={item.key}>
    <label class="check-label"><input type="checkbox" checked={selected.some(value => value.key === item.key)} disabled={busy || selected.length >= 200 && !selected.some(value => value.key === item.key)}
      onChange={event => select(item, event.currentTarget.checked)} />{item.name}</label>
    <button class="btn ghost" disabled={busy} onClick={() => void read(item.key)}>下级部门</button>
    {tree[item.key] && (tree[item.key]!.length ? nodes(tree[item.key]!, new Set([...ancestors, item.key])) : <small>无下级部门</small>)}
  </li>)}</ul>;
  return <fieldset><legend>部署时的部门范围</legend><p>直接向平台查询，不要求机器人运行。这里只选择草稿；预览时重新核对，停机部署时才保存。最多选择 200 个部门，包含其全部子部门。</p>
    <button class="btn" disabled={busy} onClick={() => void read()}>{busy ? "正在查询部门…" : data ? "重新读取部署部门树" : "读取部署部门树"}</button>
    {(data || busy) && <button class="btn" onClick={cancel}>取消部门选择</button>}
    {error && <p role="alert">{error}</p>}
    {data && <><p>已选择：{selected.map(item => item.name).join("、") || "无"}</p>{nodes(data.children)}</>}
  </fieldset>;
}
