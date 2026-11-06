/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { ReadPage } from "./contract.ts";
import { clock } from "./format.ts";
import { Banner, Card } from "./ui.tsx";
import { NAV } from "./nav.ts";

/** `refresh`: read the page again whenever it changes (a write elsewhere on the page has ended). */
export function ReadOnlyPage({ page, refresh = 0 }: { page: string; refresh?: number }) {
  const [data, setData] = useState<ReadPage | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState(""), [level, setLevel] = useState("all"), [task, setTask] = useState("");
  const current = useRef<AbortController | null>(null);
  const item = NAV.find(item => item.id === page)!;
  /** `intent`: the user asked for it (renews the login's idle timer); an automatic read does not. */
  const load = async (download = false, intent = true) => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setBusy(true); setError("");
    try {
      const result = await api<ReadPage>(`/api/read/${page}`, { method: "POST", body: { keyword, level, task, export: download },
        signal: controller.signal, intent, timeoutMs: 95_000 });
      if (controller.signal.aborted) return;
      setData(result);
      if (download) {
        const url = URL.createObjectURL(new Blob([result.rows.map(row => row.join("\t")).join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = `logs-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => { setData(null); void load(); return () => current.current?.abort(); }, [page]);
  useEffect(() => { if (refresh) void load(false, false); }, [refresh]);
  return <div class="page-grid">
    <Card title={item.label} icon={item.icon} span={12} aside={<button class="btn" disabled={busy} onClick={() => void load()}>刷新</button>}>
      {page === "logs" && <form class="read-filters" onSubmit={event => { event.preventDefault(); void load(); }}>
        <label>关键词<input value={keyword} maxLength={128} onInput={event => setKeyword(event.currentTarget.value)} /></label>
        <label>任务编号<input value={task} maxLength={128} onInput={event => setTask(event.currentTarget.value)} /></label>
        <label>级别<select value={level} onChange={event => setLevel(event.currentTarget.value)}>
          <option value="all">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option>
        </select></label>
        <button class="btn" disabled={busy}>筛选</button><button class="btn" type="button" disabled={busy} onClick={() => void load(true)}>导出筛选结果</button>
      </form>}
      {error && <Banner tone="danger" icon="alert" title="读取失败" action={<button class="btn" onClick={() => void load()}>重试</button>}>{error}</Banner>}
      {busy && <p role="status">正在读取…</p>}
      {data && <>
        <p class="muted">读取于 {clock(data.checkedAt)} · {data.note}</p>
        {!data.rows.length ? <p>暂无记录</p> : <div class="read-table"><table><thead><tr>{data.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{data.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>}
      </>}
    </Card>
  </div>;
}
