/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiFailure } from "./api.ts";
import { Dialog } from "./ui.tsx";
import { dateTime } from "./format.ts";
import { DeploymentDirectoryPicker, type DeploymentSelection } from "./deployment-directory.tsx";

export interface TaskView { id: string; operation: string; state: string; needsRecovery: boolean; createdAt: number;
  reason?: string; result?: { message: string; finalState: string; outcome: string; exitCode: number } }
interface Plan { id: string; operation: string; summary: string[]; expiresAt: number }
interface Event { seq: number; at: number; kind: string; text: string }
const names: Record<string, string> = { queued: "等待接单", "not-accepted": "未接单", running: "执行中", interrupted: "执行中断", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
const labels: Record<string, string> = { start: "启动", stop: "停止", restart: "重启", "maintenance-recover": "恢复中断的维护", update: "升级", deploy: "重新部署", repair: "修复部署", resume: "继续上次操作", rollback: "回滚上次操作", "history-clear": "清空会话", "history-compact": "会话压缩",
  "tmp-purge": "归档临时文件", "tmp-reclaim": "物理回收", "tmp-discard": "删除归档", "stat-import": "导入统计", "runtime-configure": "运行参数",
  "relay-test": "测试外链", "relay-purge": "清理外链", "backup-clean": "清理备份", "configuration-apply": "应用配置", "configuration-restore": "恢复配置" };
let recent: string | null = null;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function resetTasks() { recent = null; }

export function TaskAction({ operation, params, children, disabled, danger = false, onStarted }: {
  operation: string; params: Record<string, unknown>; children: ComponentChildren; disabled?: boolean; danger?: boolean; onStarted?: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  // The console refused this preview (facts changed, plan used or expired, executor unavailable): only a new preview can go on.
  const [refused, setRefused] = useState(false);
  const key = useRef(""), lock = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (!plan) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [plan]);
  const preview = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setRefused(false);
    try {
      const result = await api<Plan>("/api/plans", { method: "POST", body: { operation, params }, intent: true, timeoutMs: 120_000 });
      if (live.current) { key.current = crypto.randomUUID(); setPlan(result); setNow(Date.now()); }
    } catch (error) { if (live.current) setError(message(error)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const submit = async () => {
    if (!plan || refused || lock.current || Date.now() >= plan.expiresAt) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const task = await api<TaskView>("/api/tasks", { method: "POST", body: { plan: plan.id, key: key.current }, intent: true, timeoutMs: 90_000 });
      if (live.current) {
        recent = task.id; setPlan(null); onStarted?.(); location.hash = "#/maintain";
        window.dispatchEvent(new CustomEvent("console-task", { detail: task.id }));
      }
    } catch (error) {
      if (!live.current) return;
      // Only a lost or timed-out answer may have been accepted after all: the same preview and key cannot run twice.
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) {
        // Most refusals already end with "请重新预览"; say it once.
        setRefused(true); setError(message(error).replace(/[，；,;]?\s*请重新预览[。.]?$/, "") + "。这份预览不能再执行，请重新预览。");
      }
      else setError(message(error) + "。可以用同一预览重试，已接单的任务不会重复执行。");
    }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return <>
    <button type="button" class={`btn${danger ? " danger" : ""}`} disabled={disabled || busy} onClick={() => void preview()}>{busy && !plan ? "正在预览…" : children}</button>
    {!plan && error && <p role="alert" class="form-error">{error}</p>}
    {plan && <Dialog title="确认操作" onClose={() => { if (!busy) { setPlan(null); setError(""); } }} footer={<>
      <button class="btn" disabled={busy} onClick={() => setPlan(null)}>返回</button>
      {now >= plan.expiresAt || refused ? <button class="btn" disabled={busy} onClick={() => { setPlan(null); void preview(); }}>重新预览</button>
        : <button class={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={() => void submit()}>{busy ? "正在交接任务…" : "确认执行"}</button>}
    </>}>
      <ul>{plan.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <p>{now >= plan.expiresAt ? "预览已过期，请重新核对。" : `预览有效至 ${dateTime(plan.expiresAt)}。`}</p>
      <p>确认后任务独立运行，关掉网页或控制台不会取消。重新打开后可在维护页查看结果。</p>
      {error && <p role="alert">{error}</p>}
    </Dialog>}
  </>;
}

/**
 * Fetch SSE so Origin and X-Console-Request apply to every connection; EventSource cannot set this header. The server sends a
 * keepalive every second, so a connection silent for `idleMs` has stalled (a half-open SSH tunnel never ends it): it fails
 * and the caller reconnects. `onOpen` reports each connection the console accepted.
 */
export async function readTaskEvents(id: string, after: number, signal: AbortSignal, onEvent: (event: Event) => void,
  { idleMs = 15_000, onOpen }: { idleMs?: number; onOpen?: () => void } = {}): Promise<void> {
  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), idleMs);
  const heard = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), idleMs); };
  try {
    const response = await fetch(`/api/tasks/${id}/events`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, idle.signal]),
      headers: { "X-Console-Request": "1", "Last-Event-ID": String(after) } });
    if (!response.ok || !response.body) throw new Error(`事件连接未完成（HTTP ${response.status}）`);
    onOpen?.(); heard();
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    // The aborted fetch errors the body too; cancelling here ends the read even where it does not.
    idle.signal.addEventListener("abort", () => { void reader.cancel().catch(() => {}); }, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        heard();
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (frame.includes("event: error\n")) {
            let text = "事件记录无法读取";
            try { const value = JSON.parse(data?.slice(6) ?? "") as { message?: unknown }; if (typeof value.message === "string" && value.message) text = value.message; } catch {}
            throw new Error(text);
          }
          if (!frame.includes("event: task\n") || !data) continue;
          const event = JSON.parse(data.slice(6)) as Event;
          if (!Number.isSafeInteger(event.seq) || typeof event.text !== "string") throw new Error("事件记录不完整");
          if (event.seq > after) { after = event.seq; onEvent(event); }
        }
        if (buffer.length > 256 * 1024) throw new Error("事件数据过大");
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    if (!idle.signal.aborted || signal.aborted) throw error;
  } finally { clearTimeout(timer); }
  if (idle.signal.aborted && !signal.aborted) throw new Error("事件连接没有响应");
}

function TaskDetail({ id, recoveryAllowed }: { id: string; recoveryAllowed: boolean }) {
  const [task, setTask] = useState<TaskView | null>(null), [events, setEvents] = useState<Event[]>([]);
  // Each source clears its own alert once it works again; the export error stays until the next export.
  const [loadError, setLoadError] = useState(""), [streamError, setStreamError] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let cursor = 0, reconnect: ReturnType<typeof setTimeout> | undefined, busy = false;
    setTask(null); setEvents([]); setLoadError(""); setStreamError(""); setError("");
    const load = async () => { if (busy) return; busy = true; try { const value = await api<TaskView>(`/api/tasks/${id}`, { signal: controller.signal }); if (!controller.signal.aborted) { setTask(value); setLoadError(""); } }
      catch (error) { if (!controller.signal.aborted) setLoadError(message(error)); } finally { busy = false; } };
    const connect = async () => {
      try { await readTaskEvents(id, cursor, controller.signal, event => { cursor = event.seq; setEvents(previous => [...previous, event].slice(-2000)); }, { onOpen: () => setStreamError("") }); }
      // fetch() itself fails with the browser's own text ("Failed to fetch"): say what happened instead.
      catch (error) { if (!controller.signal.aborted) { setStreamError((error instanceof TypeError ? "事件连接中断" : message(error)) + "，正在重连…"); void load(); } }
      if (!controller.signal.aborted) reconnect = setTimeout(() => void connect(), 3000);
    };
    void load(); void connect(); const timer = setInterval(() => void load(), 3000);
    return () => { controller.abort(); clearInterval(timer); clearTimeout(reconnect); };
  }, [id]);
  const download = async () => {
    setError("");
    try {
      const result = await api<{ filename: string; content: string }>(`/api/tasks/${id}/log`, { method: "POST", body: {}, intent: true });
      const url = URL.createObjectURL(new Blob([result.content], { type: "text/plain;charset=utf-8" })), link = document.createElement("a");
      link.href = url; link.download = result.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setError(message(error)); }
  };
  return <section class="card task-detail"><h2>{labels[task?.operation ?? ""] ?? "任务详情"}</h2><small>{id}</small>
    <div><button class="btn" onClick={() => void download()}>导出任务日志</button></div>
    <p>{task ? names[task.state] ?? task.state : "正在读取…"}{task?.needsRecovery ? " · 需要恢复处理" : ""}</p>
    {task?.result && <p role="status">{task.result.message || (task.result.outcome === "success" ? "执行完成" : "执行失败，请查看下方记录")}</p>}
    {task?.needsRecovery && <><p role="alert">维护记录仍需处理。请查看体检和运维日志，按恢复指引继续或回滚。</p>
      {recoveryAllowed && ["history-clear", "history-compact", "stat-import", "tmp-purge", "tmp-reclaim", "tmp-discard", "configuration-apply", "configuration-restore", "runtime-configure", "backup-clean", "relay-test", "relay-purge", "maintenance-recover"].includes(task.operation) &&
        <TaskAction operation="maintenance-recover" params={{}}>预览恢复中断的维护</TaskAction>}</>}
    {task?.reason && <p role="alert">{task.reason}</p>}
    {[...new Set([loadError, streamError, error])].filter(Boolean).map(text => <p key={text} role="alert">{text}</p>)}
    <pre class="task-events" aria-label="任务输出">{events.map(event => <div key={event.seq} class={event.kind === "error" ? "event-error" : ""}>{event.text}</div>)}</pre>
    <p class="muted">最多显示最近 2000 行。关闭详情只断开订阅，不会取消任务。</p>
  </section>;
}

export function TasksPage({ resultsOnly = false }: { resultsOnly?: boolean }) {
  const [tasks, setTasks] = useState<TaskView[]>([]), [selected, setSelected] = useState<string | null>(recent), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    const load = async () => { if (busy) return; busy = true; try { const value = await api<{ tasks: TaskView[] }>("/api/tasks", { signal: controller.signal }); if (!controller.signal.aborted) { setTasks(value.tasks); setError(""); } }
      catch (error) { if (!controller.signal.aborted) setError(message(error)); } finally { busy = false; } };
    const choose = (event: globalThis.Event) => { setSelected((event as CustomEvent<string>).detail); void load(); };
    void load(); const timer = setInterval(() => void load(), 5000); window.addEventListener("console-task", choose);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("console-task", choose); };
  }, []);
  return <div class="page"><header class="page-header"><div><h1>维护</h1><p>{resultsOnly ? "查看后台任务及断线前的进度。" : "控制机器人运行，查看后台任务及断线前的进度。"}</p></div></header>
    {!resultsOnly && <>
    <RecoveryActions />
    <UpgradeForm />
    <DeployForm />
    <section class="card plain"><h2>机器人运行</h2><div class="action-row"><TaskAction operation="start" params={{}}>启动</TaskAction><TaskAction operation="stop" params={{}}>停止</TaskAction><TaskAction operation="restart" params={{}}>重启</TaskAction></div></section>
    <BackupCleanup />
    <section class="card plain"><h2>清空全部会话</h2><p>包含单聊和所有群组；统计保留。此操作不可撤销。</p><TaskAction operation="history-clear" params={{ space: "all" }} danger>预览清空全部会话</TaskAction></section></>}
    <section class="card plain"><h2>后台任务</h2>{error && <p role="alert">{error}</p>}{!tasks.length && <p>暂无任务记录。</p>}
      <ul class="task-list">{tasks.map(task => <li key={task.id}><button class="btn ghost" onClick={() => setSelected(task.id)} aria-pressed={selected === task.id}>
        {labels[task.operation] ?? task.operation} · {names[task.state] ?? task.state}{task.needsRecovery ? " · 需要恢复" : ""} · {dateTime(task.createdAt)}</button></li>)}</ul></section>
    {selected && <TaskDetail key={selected} id={selected} recoveryAllowed={!resultsOnly} />}
  </div>;
}

export function DeployForm() {
  const [selected, setSelected] = useState<DeploymentSelection | null>(null);
  const [saved, setSaved] = useState<{ port: number; workspace: string; hasDirectory: boolean; platform: "windows" | "linux" } | null>(null);
  const [port, setPort] = useState(""), [workspace, setWorkspace] = useState(""), [cleanup, setCleanup] = useState(""), [directory, setDirectory] = useState("");
  const [operation, setOperation] = useState("deploy"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), controller = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  const load = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setSaved(null); setCleanup(""); setDirectory(""); setSelected(null); setOperation("deploy");
    controller.current?.abort(); controller.current = new AbortController();
    try { const value = await api<NonNullable<typeof saved>>("/api/lifecycle/deploy", { signal: controller.current.signal, intent: true });
      if (live.current) { setSaved(value); setPort(String(value.port)); setWorkspace(value.workspace); } }
    catch (error) { if (live.current) setError(message(error)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return <section class="card write-form"><h2>重新部署与修复</h2><p>重新部署使用当前代码和已保存的配置，完成后启动机器人。首次部署仍从命令行进行。</p>
    <button class="btn" disabled={busy} onClick={() => void load()}>{busy ? "正在读取部署设置…" : "读取部署设置"}</button>
    {error && <p role="alert">{error}</p>}
    {saved && <>
      {saved.platform === "linux" ? <label>操作<select aria-label="部署操作" value={operation} onChange={event => setOperation(event.currentTarget.value)}>
        <option value="deploy">重新部署</option><option value="repair">重建容器以修复部署</option></select></label>
        : <><p>Windows 本机未就绪时可先尝试重启修复；计划任务缺失或安装损坏时使用下面的重新部署。</p><TaskAction operation="repair" params={{}}>预览本机修复</TaskAction></>}
      <label>机器人端口<input aria-label="机器人端口" type="number" min="1" max="65535" value={port} onInput={event => setPort(event.currentTarget.value)} /></label>
      <label>共享资料目录<input aria-label="共享资料目录" value={workspace} onInput={event => setWorkspace(event.currentTarget.value)} /></label>
      <p>留空使用 data/workspace；外置目录必须已经存在。不会移动或删除共享资料。</p>
      <label>旧修订链<select aria-label="重部署修订链" value={cleanup} onChange={event => setCleanup(event.currentTarget.value)}>
        <option value="">请选择</option><option value="apply">先备份，再整理</option><option value="skip">跳过整理</option></select></label>
      <label>通讯录范围<select aria-label="重部署通讯录范围" value={directory} onChange={event => { setDirectory(event.currentTarget.value); setSelected(null); }}>
        <option value="">请选择</option>{saved.hasDirectory ? <option value="saved">沿用已保存的同步范围</option> : <><option value="all">整个通讯录</option><option value="departments">选择部分部门</option></>}</select></label>
      {directory === "departments" && <DeploymentDirectoryPicker onChange={setSelected} />}
      <TaskAction operation={operation} params={{ port: Number(port), workspace, cleanup, directory: directory === "departments" ? selected : directory }}
        disabled={!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !cleanup || !directory || directory === "departments" && !selected} onStarted={() => setSaved(null)}>
        {operation === "repair" ? "预览重建修复" : "预览重新部署"}</TaskAction>
    </>}
  </section>;
}

export function UpgradeForm() {
  const [selected, setSelected] = useState<DeploymentSelection | null>(null);
  const [version, setVersion] = useState<{ branch: string; hasDirectory: boolean; target: string } | null>(null);
  const [cleanup, setCleanup] = useState(""), [directory, setDirectory] = useState(""), [switchMain, setSwitchMain] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true), controller = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  const check = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setVersion(null); setCleanup(""); setDirectory(""); setSelected(null); setSwitchMain(false);
    controller.current?.abort(); controller.current = new AbortController();
    try { const value = await api<NonNullable<typeof version>>("/api/lifecycle/check-update", { method: "POST", body: {}, intent: true, signal: controller.current.signal, timeoutMs: 120_000 });
      if (live.current) setVersion(value); }
    catch (error) { if (live.current) setError(message(error)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return <section class="card write-form"><h2>升级</h2><p>检查 origin/main 后选择升级方式，再预览确认。升级沿用模型、机器人凭据和运行参数；完成后请重新运行 bun run console。</p>
    <button class="btn" disabled={busy} onClick={() => void check()}>{busy ? "正在检查版本…" : "检查可升级版本"}</button>
    {error && <p role="alert">{error}</p>}
    {version && <><p>目标提交：<code>{version.target}</code></p><p>当前分支：{version.branch}</p>
      <label>旧修订链<select aria-label="旧修订链" value={cleanup} onChange={event => setCleanup(event.currentTarget.value)}>
        <option value="">请选择</option><option value="apply">先备份，再整理</option><option value="skip">跳过整理</option>
      </select></label>
      <label>通讯录范围<select aria-label="升级通讯录范围" value={directory} onChange={event => { setDirectory(event.currentTarget.value); setSelected(null); }}>
        <option value="">请选择</option>{version.hasDirectory ? <option value="saved">沿用已保存的同步范围</option> : <><option value="all">整个通讯录</option><option value="departments">选择部分部门</option></>}
      </select></label>
      {directory === "departments" && <DeploymentDirectoryPicker onChange={setSelected} />}
      {version.branch !== "main" && <label class="check-label"><input type="checkbox" checked={switchMain} onChange={event => setSwitchMain(event.currentTarget.checked)} />允许切换到 main 分支</label>}
      <TaskAction operation="update" params={{ target: version.target, switchMain, cleanup, directory: directory === "departments" ? selected : directory }}
        disabled={!cleanup || !directory || directory === "departments" && !selected || (version.branch !== "main" && !switchMain)} onStarted={() => setVersion(null)}>预览升级</TaskAction>
    </>}
  </section>;
}

export function RecoveryActions() {
  const [pending, setPending] = useState<{ subject: string; record: string[]; committed: boolean; canResume: boolean; canRollback: boolean } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const refresh = async (signal?: AbortSignal) => {
    setBusy(true); setPending(null); setError("");
    try { const value = await api<{ pending: typeof pending }>("/api/lifecycle", { signal }); if (!signal?.aborted) setPending(value.pending); }
    catch (error) { if (!signal?.aborted) setError(message(error)); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, []);
  return <section class="card plain"><h2>部署恢复</h2><button class="btn" disabled={busy} onClick={() => void refresh()}>刷新恢复状态</button>
    {error && <p role="alert">{error}</p>}{busy && <p>正在读取事务记录…</p>}
    {!busy && !error && !pending && <p>没有未完成的部署或升级。</p>}
    {pending && <><p>{pending.subject}</p><ul>{pending.record.map(line => <li key={line}>{line}</li>)}</ul>
      <p>{pending.committed ? "数据已提交，只能继续完成启动和清理。" : !pending.canResume ? "上次操作已经开始回滚，只能完成回滚。" : "按原事务记录处理，不拉取新目标或改变已保存的选择。"}</p>
      <div class="action-row"><TaskAction operation="resume" params={{}} disabled={!pending.canResume} onStarted={() => setPending(null)}>预览继续上次操作</TaskAction>
        <TaskAction operation="rollback" params={{}} disabled={!pending.canRollback} danger onStarted={() => setPending(null)}>预览回滚上次操作</TaskAction></div></>}
  </section>;
}

function BackupCleanup() {
  const [data, setData] = useState<{ selection: string | null; entries: { index: number; name: string; basis: string[]; bytes: number; category: string; selected: boolean; selectable: boolean }[] } | null>(null),
    [indexes, setIndexes] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const scan = async () => {
    setBusy(true); setError(""); setData(null);
    try { const value = await api<NonNullable<typeof data>>("/api/backups/scan", { method: "POST", body: {}, intent: true, timeoutMs: 120_000 });
      setData(value); setIndexes(value.entries.filter(entry => entry.selected && entry.selectable).map(entry => entry.index)); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const categories: Record<string, string> = { "confirmed-test": "测试数据", business: "业务归档", "suspected-test": "疑似测试数据", unknown: "无法判断" };
  return <section class="card write-form"><h2>备份清理</h2><p>业务归档默认保留。勾选需要删除的条目，再预览确认；活动事务与当前发布依赖始终受保护。</p>
    <button class="btn" disabled={busy} onClick={() => void scan()}>{busy ? "正在扫描…" : "扫描备份"}</button>{error && <p role="alert">{error}</p>}
    {data && <>{!data.entries.length && <p>没有历史备份。</p>}<ul class="task-list">{data.entries.map(entry => <li key={entry.index}>
      <label class="check-label"><input type="checkbox" checked={indexes.includes(entry.index)} disabled={!entry.selectable}
        onChange={event => setIndexes(previous => event.currentTarget.checked ? [...previous, entry.index] : previous.filter(value => value !== entry.index))} />
        {entry.name} · {categories[entry.category]} · {(entry.bytes / 1024 / 1024).toFixed(2)} MB</label>
      {entry.basis.length > 0 && <p class="muted small">{entry.basis.join("；")}</p>}
    </li>)}</ul>{data.selection && <TaskAction operation="backup-clean" params={{ selection: data.selection, indexes }} disabled={!indexes.length} danger onStarted={() => setData(null)}>预览所选备份</TaskAction>}</>}
  </section>;
}
