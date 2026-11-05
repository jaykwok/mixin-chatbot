/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "./api.ts";
import type { Overview } from "./contract.ts";
import { TaskAction } from "./tasks.tsx";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function StorageActions() {
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<{ key: string; label: string }[]>([]), [scope, setScope] = useState(""), [error, setError] = useState("");
  const load = async () => {
    setError("");
    try { const result = await api<{ scopes: typeof scopes; truncated: boolean }>("/api/storage/scopes", { intent: true, timeoutMs: 120_000 });
      setScopes(result.scopes); setScope(""); if (result.truncated) setError("成员超过 10000 位，列表只显示前 10000 位。"); }
    catch (error) { setError(message(error)); }
  };
  return <section class="card write-form"><h2>临时文件维护</h2><p>归档可恢复；物理回收和删除归档不可撤销。先生成清单，再核对确认。</p>
    <label>未改动天数（0 表示不限时间）<input type="number" min="0" max="36500" value={days} onInput={event => setDays(event.currentTarget.value)} /></label>
    <button class="btn" onClick={() => void load()}>读取可归档成员</button>{error && <p role="alert">{error}</p>}
    <label>归档范围<select value={scope} onChange={event => setScope(event.currentTarget.value)}><option value="">全部空间与成员</option>{scopes.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
    <div class="action-row"><TaskAction operation="tmp-purge" params={{ days: Number(days), ...(scope ? { scope } : {}) }} disabled={!days}>预览归档</TaskAction>
      <TaskAction operation="tmp-reclaim" params={{ days: Number(days) }} disabled={!days} danger>预览物理回收</TaskAction>
      <TaskAction operation="tmp-discard" params={{}} danger>预览删除归档</TaskAction></div><p>物理回收和归档删除检查全部空间，使用各自的独立清单。</p></section>;
}

export function RelayActions() {
  const [all, setAll] = useState(false), [keyword, setKeyword] = useState("");
  return <section class="card write-form"><h2>外链维护</h2><TaskAction operation="relay-test" params={{}}>测试外链存储</TaskAction>
    <p>清理会删除对象，相关下载链接随即失效。</p><label>名称或链接关键字<input value={keyword} disabled={all} onInput={event => setKeyword(event.currentTarget.value)} /></label>
    <label class="check-label"><input type="checkbox" checked={all} onChange={event => setAll(event.currentTarget.checked)} />清理全部在册外链</label>
    <TaskAction operation="relay-purge" params={all ? { all: true } : { keyword }} disabled={!all && !keyword.trim()} danger>预览清理</TaskAction></section>;
}

export function StatsImportForm() {
  const [path, setPath] = useState("");
  return <details class="card write-form"><summary>导入统计</summary><p>填写运行控制台的宿主机上的统计文件路径。使用停止写入的一致快照；WAL 尚未合并时须保留同目录的 -wal 文件。</p>
    <p>支持旧版 schema 2，以及当前 schema 3 的空账本恢复。同一份文件重复导入不会增加统计。</p>
    <label>统计文件的绝对路径<input value={path} onInput={event => setPath(event.currentTarget.value)} placeholder="stats.sqlite 的完整路径" /></label>
    <TaskAction operation="stat-import" params={{ path }} disabled={!path.trim()}>校验并预览导入</TaskAction><StatsUpload /></details>;
}

function StatsUpload() {
  const [database, setDatabase] = useState<File | null>(null), [wal, setWal] = useState<File | null>(null), [id, setId] = useState<string | null>(null),
    [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [walMerged, setWalMerged] = useState(false);
  const upload = async () => {
    if (!database || busy) return; setBusy(true); setStatus("正在上传统计文件…"); let created: string | undefined;
    try {
      const result = await api<{ id: string }>("/api/uploads", { method: "POST", body: { databaseBytes: database.size, walBytes: wal?.size ?? 0, walMerged: !wal && walMerged }, intent: true });
      created = result.id;
      for (const [part, file] of [["database", database], ["wal", wal]] as const) {
        if (!file) continue;
        const response = await fetch(`/api/uploads/${result.id}/${part}`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", body: file,
          headers: { "Content-Type": "application/octet-stream", "X-Console-Request": "1", "X-Console-Intent": "user" }, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error ?? "文件上传失败"); }
      }
      await api(`/api/uploads/${result.id}/seal`, { method: "POST", body: {}, intent: true });
      setId(result.id); setStatus("文件已上传。核对预览后确认导入；任务结束会删除上传副本。");
    } catch (error) {
      setStatus(error instanceof TypeError || (error as Error)?.name === "TimeoutError" ? "上传连接中断或超时，请重试" : message(error));
      if (created) await api(`/api/uploads/${created}/cancel`, { method: "POST", body: {}, quiet: true }).catch(() => {});
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!id || busy) return; setBusy(true);
    try { await api(`/api/uploads/${id}/cancel`, { method: "POST", body: {}, intent: true }); setId(null); setStatus("上传副本已删除。"); }
    catch (error) { setStatus(message(error)); } finally { setBusy(false); }
  };
  return <fieldset><legend>或从这台电脑上传</legend><p>数据库和 WAL 合计最多 512 MB。WAL 模式的数据库如果同目录还有 -wal 文件，须一并选择，否则会缺少其中尚未合并的改动；正常关闭后通常没有 -wal。未提交的上传一小时后清理。</p>
    <label>统计数据库<input type="file" accept=".sqlite,.sqlite3,.db" disabled={busy || !!id} onChange={event => setDatabase(event.currentTarget.files?.[0] ?? null)} /></label>
    <label>对应的 WAL（可选）<input type="file" disabled={busy || !!id} onChange={event => setWal(event.currentTarget.files?.[0] ?? null)} /></label>
    {!wal && <label class="check-label"><input type="checkbox" checked={walMerged} disabled={busy || !!id} onChange={event => setWalMerged(event.currentTarget.checked)} />同目录没有 -wal 文件（WAL 模式的数据库已正常关闭）</label>}
    {status && <p role="status">{status}</p>}{id ? <div class="action-row"><TaskAction operation="stat-import" params={{ upload: id }} onStarted={() => setId(null)}>校验上传并预览</TaskAction><button class="btn" disabled={busy} onClick={() => void cancel()}>删除上传副本</button></div>
      : <button class="btn" disabled={busy || !database} onClick={() => void upload()}>{busy ? "上传中…" : "上传文件"}</button>}
  </fieldset>;
}

interface RuntimeOption { key: string; label: string; description: string; unit?: string; default: string; empty?: string; range?: number[]; choices?: { value: string; label: string }[] }
interface RuntimeForm { hash: string | null; values: Record<string, string>; groups: { label: string; description: string; options: RuntimeOption[] }[] }
export function RuntimeForm() {
  const [data, setData] = useState<RuntimeForm | null>(null), [changes, setChanges] = useState<Record<string, string | null>>({}), [error, setError] = useState(""), [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setChanges({});
    void api<RuntimeForm>("/api/forms/runtime", { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setData(value); setError(""); } }, error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [version]);
  const change = (key: string, value: string) => setChanges(previous => ({ ...previous, [key]: value || null }));
  return <details class="card write-form"><summary>高级运行参数</summary><p>保存前校验；执行时短暂停机，结束后恢复原来的运行状态。留空表示恢复默认值。</p>
    {error && <p role="alert">{error}</p>}<button class="btn" onClick={() => setVersion(value => value + 1)}>重新读取</button>
    {data && <>{data.groups.map(group => <fieldset key={group.label}><legend>{group.label}</legend><p>{group.description}</p>{group.options.map(option => {
      const current = Object.hasOwn(changes, option.key) ? changes[option.key] ?? "" : data.values[option.key] ?? "";
      return <label key={option.key}>{option.label}{option.unit ? `（${option.unit}）` : ""}
        {option.choices ? <select value={current} onChange={event => change(option.key, event.currentTarget.value)}><option value="">默认：{option.choices.find(item => item.value === option.default)?.label ?? option.default}</option>{option.choices.map(item => <option value={item.value}>{item.label}</option>)}</select>
          : option.range ? <input value={current} type="number" min={option.range[0]} max={option.range[1]} placeholder={option.default} onInput={event => change(option.key, event.currentTarget.value)} />
            : <input value={current} type="text" placeholder={option.default || option.empty || "默认"} onInput={event => change(option.key, event.currentTarget.value)} />}
        <small>{option.description}</small></label>;
    })}</fieldset>)}<TaskAction operation="runtime-configure" params={{ hash: data.hash, changes }} disabled={!Object.keys(changes).length}>校验并预览</TaskAction></>}
  </details>;
}

interface Department { key: string; name: string }
/** The service's limit (MAX_SCOPE_DEPARTMENTS, which this bundle cannot import); the service refuses more anyway. */
export const MAX_DEPARTMENTS = 200;
/** How often, and how long, the form follows a saved scope being applied; after that the status above tells. */
const APPLY_POLL_MS = 2_000, APPLY_FOLLOW_MS = 10 * 60_000;
interface Selection { view: string; mode: string; state: string; selected: Department[]; unavailable: number; children: Department[] }
const keysOf = (items: Department[]) => items.map(item => item.key).toSorted().join(" ");
/** `onSettled`: a save has ended (applied, failed, or nothing to apply), so the status shown elsewhere is out of date. */
export function DirectoryForm({ onSettled }: { onSettled?: () => void }) {
  const [data, setData] = useState<Selection | null>(null), [mode, setMode] = useState("departments"), [selected, setSelected] = useState<Department[]>([]),
    [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [tree, setTree] = useState<Record<string, Department[]>>({});
  // The mode and departments as last read from the service (ticks that differ are not saved yet), and when a save started applying.
  const [loaded, setLoaded] = useState({ mode: "", keys: "" }), [applying, setApplying] = useState(0);
  const open = async () => { setBusy(true); setError(""); try {
    const value = await api<Selection>("/api/directory/selection", { intent: true, timeoutMs: 180_000 });
    const fresh = { mode: value.mode === "all" ? "all" : "departments", keys: keysOf(value.selected) };
    // Reading the tree again keeps ticks not saved yet: the keys of a login stay the same, so they still name the same departments.
    const edited = data !== null && (mode !== loaded.mode || keysOf(selected) !== loaded.keys);
    setData(value); setLoaded(fresh); setTree({}); setNotice("");
    if (!edited) { setSelected(value.selected); setMode(fresh.mode); }
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const expand = async (parent: string) => { if (!data || busy) return; setBusy(true); setError(""); try {
    const result = await api<{ children: Department[] }>("/api/directory/children", { method: "POST", body: { view: data.view, parent }, intent: true, timeoutMs: 90_000 });
    setTree(previous => ({ ...previous, [parent]: result.children }));
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const save = async () => { if (!data || busy) return; setBusy(true); setError(""); try {
    const result = await api<{ status: string }>("/api/directory/apply", { method: "POST", body: { view: data.view, mode, selected: mode === "all" ? [] : selected.map(item => item.key) }, intent: true, timeoutMs: 90_000 });
    setNotice(result.status === "started" ? "已保存，正在应用新范围。应用期间原名单继续生效。" : result.status === "unchanged" ? "这个范围已经生效。" : "已恢复当前生效范围。"); setData(null);
    if (result.status === "started") setApplying(Date.now()); else onSettled?.();
  } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  // Follows the scope being applied (the console's status reads, which do not keep the login alive) and says how it ended.
  useEffect(() => {
    if (!applying) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (text: string) => { setNotice(text); setApplying(0); onSettled?.(); };
    const poll = async () => {
      try {
        const directory = (await api<Overview>("/api/overview")).service.directory;
        if (stopped) return;
        if (directory?.state === "effective") return settle(`新范围已生效：在册成员 ${directory.mappings} 名。`);
        if (directory?.state === "failed") return settle(`新范围没有应用成功：${directory.stateText}`);
        if (directory?.running) setNotice(`已保存，正在应用新范围（${directory.running}）。应用期间原名单继续生效。`);
      } catch { if (stopped) return; }
      if (Date.now() - applying < APPLY_FOLLOW_MS) timer = setTimeout(() => void poll(), APPLY_POLL_MS);
      else settle("新范围仍在应用，完成前原名单继续生效；可在上方刷新查看进度。");
    };
    timer = setTimeout(() => void poll(), APPLY_POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [applying]);
  // A department includes all of its subdepartments: below a selected one the boxes show it, and selecting a department
  // drops its subdepartments chosen one by one (as far as the tree has been opened).
  const below = (key: string, seen = new Set<string>()): Set<string> => {
    for (const child of tree[key] ?? []) if (!seen.has(child.key)) { seen.add(child.key); below(child.key, seen); }
    return seen;
  };
  const nodes = (items: Department[], ancestors: Department[] = []): JSX.Element => <ul class="department-tree">{items.filter(item => !ancestors.some(value => value.key === item.key)).map(item => {
    const covering = ancestors.find(ancestor => selected.some(value => value.key === ancestor.key));
    return <li key={item.key}>
      <label class="check-label"><input type="checkbox" disabled={busy || mode === "all" || !!covering} checked={!!covering || selected.some(value => value.key === item.key)}
        onChange={event => { const checked = event.currentTarget.checked, inner = below(item.key);
          setSelected(previous => checked ? [...previous.filter(value => value.key !== item.key && !inner.has(value.key)), item] : previous.filter(value => value.key !== item.key)); }} />
        {item.name}{covering && <small>（已包含在「{covering.name}」中）</small>}</label>
      <button class="btn ghost" disabled={busy} onClick={() => void expand(item.key)}>下级部门</button>
      {tree[item.key] && (tree[item.key]!.length ? nodes(tree[item.key]!, [...ancestors, item]) : <small>无下级部门</small>)}
    </li>;
  })}</ul>;
  return <section class="card write-form"><h2>通讯录同步范围</h2><p>选择范围后保存即开始应用，无需再次确认撤销。机器人必须正在运行。重新读取部门树时，尚未保存的勾选会保留。</p>
    <button class="btn" disabled={busy} onClick={() => void open()}>{busy ? "正在读取…" : data ? "重新读取部门树" : "选择同步范围"}</button>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && <><label>同步范围<select value={mode} disabled={busy} onChange={event => setMode(event.currentTarget.value)}><option value="all">整个通讯录</option><option value="departments">选定部门</option></select></label>
      {data.unavailable > 0 && <p role="alert">有 {data.unavailable} 个原选部门已不可查询，保存时将移除。</p>}
      {mode === "departments" && <><p>已选择：{selected.map(item => item.name).join("、") || "无"}</p><div class="action-row">{selected.map(item => <button class="btn" disabled={busy} onClick={() => setSelected(previous => previous.filter(value => value.key !== item.key))}>移除 {item.name}</button>)}</div>{nodes(data.children)}</>}
      {mode === "departments" && selected.length > MAX_DEPARTMENTS && <p role="alert">最多选 {MAX_DEPARTMENTS} 个部门；可以改选它们的上级部门。</p>}
      <button class="btn primary" disabled={busy || mode === "departments" && (!selected.length || selected.length > MAX_DEPARTMENTS)} onClick={() => void save()}>保存并立即应用</button></>}
  </section>;
}
