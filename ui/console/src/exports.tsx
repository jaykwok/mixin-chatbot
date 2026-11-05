/** @jsxImportSource preact */
// Exports from the page: a dialog chooses what to export, the console hands out a one-time link, and the browser
// downloads it as an ordinary file (the page never holds the content). A tray follows each export until the console
// reports it sent, interrupted or failed; "sent" means the console finished sending, not that the file was saved.
import { useEffect, useState } from "preact/hooks";
import { api, ApiFailure } from "./api.ts";
import type { ExportRequest, ExportState, ExportStatus, ExportTicket, IdentityMode, StatsPeriodKey } from "./contract.ts";
import { bytes, count } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { ModeChoice, SCOPE_NOTE } from "./identity.tsx";
import { Banner, Dialog, Segmented, type Tone } from "./ui.tsx";

const POLL_MS = 1_000;
const MAX_SHOWN = 4;

type JobState = ExportState | "unknown";
interface Job { id: string; filename: string; state: JobState; rows: number; bytes: number; error?: string }

let jobs: Job[] = [];
// Bumped by resetExports: an answer to a request sent before the reset (the page of an earlier login) changes nothing.
let epoch = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const emit = () => { for (const listener of listeners) listener(); };
const update = (id: string, patch: Partial<Job>) => { jobs = jobs.map(job => job.id === id ? { ...job, ...patch } : job); emit(); };

/** Starts the browser download of a one-time link. A same-origin `download` link keeps the page where it is. */
function download(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

function poll(id: string) {
  const sentIn = epoch;
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    try {
      const status = await api<ExportStatus>("/api/exports/status", { method: "POST", body: { id } });
      if (sentIn !== epoch) return;
      update(id, { state: status.state, rows: status.rows, bytes: status.bytes, error: status.error });
      if (status.state === "ready" || status.state === "running") poll(id);
    } catch (error) {
      // A lost session or console takes the whole page away; anything else ends the tracking, not the download.
      if (sentIn !== epoch || error instanceof ApiFailure && (error.status === 401 || error.code === "offline")) return;
      update(id, { state: "unknown", error: (error as Error).message });
    }
  }, POLL_MS));
}

/** Asks for a link, starts the download and follows it. Failures (busy, bad range, audit) are thrown to the dialog. */
export async function startExport(request: ExportRequest): Promise<void> {
  const sentIn = epoch;
  const ticket = await api<ExportTicket>("/api/exports", { method: "POST", body: request, intent: true });
  // The page that asked is gone (logout, expiry, another login): no download, no tray entry; the link expires unused.
  if (sentIn !== epoch) return;
  jobs = [{ id: ticket.id, filename: ticket.filename, state: "ready" as JobState, rows: 0, bytes: 0 }, ...jobs].slice(0, 8);
  emit();
  download(ticket.url);
  poll(ticket.id);
}

/** Forgets every export (the session ended): stops polling; downloads already running are the console's to end. */
export function resetExports(): void {
  epoch++;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  jobs = [];
  emit();
}

const STATE: Record<JobState, { tone: Tone; icon: IconName; text: (job: Job) => string }> = {
  ready: { tone: "info", icon: "loader", text: () => "等待浏览器开始下载…" },
  running: { tone: "info", icon: "loader", text: job => `正在下载 · ${count(job.rows)} 行 · ${bytes(job.bytes)}` },
  sent: { tone: "ok", icon: "check", text: job => `已发送完毕 · ${count(job.rows)} 行 · ${bytes(job.bytes)}；是否保存成功以浏览器下载记录为准` },
  interrupted: { tone: "warn", icon: "alert", text: job => `下载中断：${job.error ?? "原因未知"}` },
  failed: { tone: "danger", icon: "alert", text: job => `导出失败：${job.error ?? "原因未知"}` },
  expired: { tone: "warn", icon: "clock", text: () => "下载链接已过期未使用（浏览器可能拦截了下载），请重新导出" },
  unknown: { tone: "warn", icon: "alert", text: job => `无法读取导出状态：${job.error ?? "原因未知"}` },
};

export function ExportTray() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick(value => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  if (!jobs.length) return null;
  const dismiss = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id); jobs = jobs.filter(job => job.id !== id); emit(); };
  return (
    <div class="export-tray" aria-label="导出" role="region">
      {jobs.slice(0, MAX_SHOWN).map(job => {
        const state = STATE[job.state];
        const active = job.state === "ready" || job.state === "running";
        return (
          <div key={job.id} class={`export-item tone-${state.tone}`} role="status">
            <span class="export-icon"><Icon name={active ? "download" : state.icon} size={16} /></span>
            <div class="export-text">
              <div class="export-name" title={job.filename}>{job.filename}</div>
              <div class="export-state">{active && <Icon name="loader" size={12} class="spin" />}{state.text(job)}</div>
            </div>
            {!active && <button type="button" class="btn ghost icon-btn" aria-label="关闭这条导出提示" onClick={() => dismiss(job.id)}><Icon name="x" size={14} /></button>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Dialogs ───────────────────────────────────────────────────────────────

const BUSY_HINT = "同时最多 2 个导出（包括等待浏览器开始的），请等其中一个结束后再试。";

function useSubmit(build: () => ExportRequest | string, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const request = build();
    if (typeof request === "string") { setError(request); return; }
    setBusy(true);
    setError(null);
    try {
      await startExport(request);
      onDone();
    } catch (failure) {
      setError(failure instanceof ApiFailure && failure.code === "busy" ? `${failure.message}。${BUSY_HINT}` : (failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

const defaultMode = (mode: IdentityMode): IdentityMode => mode === "full" ? "default" : mode;

function Footer({ busy, disabled, onCancel, onSubmit }: { busy: boolean; disabled: boolean; onCancel: () => void; onSubmit: () => void }) {
  return (
    <>
      <button type="button" class="btn" onClick={onCancel}>取消</button>
      <button type="button" class="btn primary" disabled={busy || disabled} onClick={onSubmit}>
        <Icon name={busy ? "loader" : "download"} class={busy ? "spin" : undefined} />{busy ? "正在准备…" : "开始导出"}
      </button>
    </>
  );
}

const NO_COPY = "文件由浏览器直接下载；控制台不保存导出内容，只在审计中记录导出范围、行数和结果。";

export function ConversationExportDialog({ view, viewMode, spaceTitle, members, member, onClose }: {
  view: string; viewMode: IdentityMode; spaceTitle: string; members: number; member: { key: string; label: string } | null; onClose: () => void;
}) {
  const [scope, setScope] = useState<"member" | "space">(member ? "member" : "space");
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [mode, setMode] = useState<IdentityMode>(defaultMode(viewMode));
  const [confirmed, setConfirmed] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const { busy, error, submit } = useSubmit(() => {
    if (since && until && since > until) return "起始日期晚于结束日期";
    return { type: "conversation", view, member: scope === "member" ? member!.key : null, format, mode, confirm: mode === "full" ? confirmed : undefined,
      since: since || undefined, until: until || undefined };
  }, onClose);
  return (
    <Dialog title="导出会话" icon="download" onClose={onClose}
      footer={<Footer busy={busy} disabled={mode === "full" && !confirmed} onCancel={onClose} onSubmit={() => void submit()} />}>
      <div class="form">
        <div class="field">
          <span class="field-label">范围</span>
          <Segmented label="导出范围" value={scope} onChange={setScope}
            options={[
              ...(member ? [{ value: "member" as const, label: <>当前成员 <span class="muted">{member.label}</span></> }] : []),
              { value: "space" as const, label: `${spaceTitle}全部 ${count(members)} 位成员` },
            ]} />
        </div>
        <div class="field">
          <span class="field-label">格式</span>
          <Segmented label="导出格式" value={format} onChange={setFormat}
            options={[{ value: "markdown", label: "Markdown", title: "便于阅读" }, { value: "json", label: "JSON", title: "结构化，便于程序处理" }]} />
        </div>
        <div class="field">
          <span class="field-label">时间</span>
          <div class="date-range">
            <input type="date" aria-label="起始日期" value={since} max={until || undefined} onInput={event => setSince((event.target as HTMLInputElement).value)} />
            <span class="muted">至</span>
            <input type="date" aria-label="结束日期" value={until} min={since || undefined} onInput={event => setUntil((event.target as HTMLInputElement).value)} />
          </div>
          <span class="field-hint">按条目时间筛选，留空表示不限；历史截止到开始导出时各会话的最后一条。</span>
        </div>
        <ModeChoice mode={mode} confirmed={confirmed} onChange={(next, ok) => { setMode(next); setConfirmed(ok); }} />
        {error && <Banner tone="danger" icon="alert" title="无法开始导出">{error}</Banner>}
        <p class="field-hint">{SCOPE_NOTE}</p>
        <p class="field-hint">{NO_COPY}</p>
      </div>
    </Dialog>
  );
}

export function StatsExportDialog({ viewMode, period, since, until, group, view, member, windowLabel, groupLabel, onClose }: {
  viewMode: IdentityMode; period: StatsPeriodKey; since: string; until: string; group: string | null; windowLabel: string; groupLabel: string;
  view: string; member: string | null;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"html" | "csv">("html");
  const [mode, setMode] = useState<IdentityMode>(defaultMode(viewMode));
  const [confirmed, setConfirmed] = useState(false);
  const { busy, error, submit } = useSubmit(() => ({
    type: "stats", format, mode, confirm: mode === "full" ? confirmed : undefined, period, group,
    ...(member ? { view, member } : {}),
    ...(period === "custom" ? { since: since || undefined, until: until || undefined } : {}),
  }), onClose);
  return (
    <Dialog title="导出统计" icon="download" onClose={onClose}
      footer={<Footer busy={busy} disabled={mode === "full" && !confirmed} onCancel={onClose} onSubmit={() => void submit()} />}>
      <div class="form">
        <div class="field">
          <span class="field-label">范围</span>
          <div class="field-value">{windowLabel} · {groupLabel}</div>
          <span class="field-hint">与页面当前的筛选一致。</span>
        </div>
        <div class="field">
          <span class="field-label">格式</span>
          <Segmented label="导出格式" value={format} onChange={setFormat}
            options={[{ value: "html", label: "HTML 报表", title: "单文件，可离线打开" }, { value: "csv", label: "CSV 表格", title: "每行一个群 × 成员" }]} />
        </div>
        <ModeChoice mode={mode} confirmed={confirmed} onChange={(next, ok) => { setMode(next); setConfirmed(ok); }} />
        {error && <Banner tone="danger" icon="alert" title="无法开始导出">{error}</Banner>}
        <p class="field-hint">{NO_COPY}</p>
      </div>
    </Dialog>
  );
}
