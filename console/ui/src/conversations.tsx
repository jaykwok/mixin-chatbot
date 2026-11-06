/** @jsxImportSource preact */
// Conversations: pick a space, then a member, then read the history with its tool calls, run records and deliveries.
// Everything goes through a view the console opened for this login: members are opaque keys, the identity mode is fixed
// per view (switching it opens a new one and keeps the member), and entry numbers are the only cursors. The bot must be
// running; when it is not, the page says so instead of reading the databases behind its back.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiFailure } from "./api.ts";
import type {
  Boundary, EntryPage, EntryPart, EntryView, GlobalSearchCursor, GlobalSearchHit, GlobalSearchResponse, GlobalSearchViewResponse, Identity, IdentityMode,
  MemberRow, MembersResponse, RequestsResponse, RequestView, SearchFilters, SearchHitView, SearchKind, SearchResponse, SpacesResponse, SpaceSummary,
  SpaceViewResponse,
} from "./contract.ts";
import { ConversationExportDialog } from "./exports.tsx";
import { ago, bytes, clock, count, dateTime, seconds, stamp } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Avatar, IdentityText, ModeBadge, ModeSwitch, NamesNotice, NamesObserved, SCOPE_NOTE } from "./identity.tsx";
import { Markdown } from "./markdown.tsx";
import { TaskAction } from "./tasks.tsx";

/** The entry kind of a push note (src/push/note.ts). */
const PUSH_NOTE_KIND = "mixin.push-note";
import { Banner, Chip, Dialog, EmptyState, Segmented, Spinner, type Tone } from "./ui.tsx";

const MEMBER_BATCH = 200;
/** Search blocks one click may read in a row while it finds little (each block scans at most 500 entries). */
const SEARCH_BLOCKS = 8;
/** The same for the search over every space, where a block may be a small space. */
const GLOBAL_BLOCKS = 16;
const LONG_TOOL_OUTPUT = 1_200;

const failureOf = (error: unknown) => error instanceof ApiFailure ? error : new ApiFailure(String(error), 0);
/** Failures that concern the whole view, not one request. */
const VIEW_PROBLEMS = new Set(["bot-offline", "view-gone", "space-changed", "space-absent"]);

type Problem = (error: unknown) => boolean;

function closeView(id: string) {
  api("/api/views/close", { method: "POST", body: { view: id }, quiet: true }).catch(() => {});
}

// ─── Page ──────────────────────────────────────────────────────────────────

export function ConversationsPage() {
  const [spaces, setSpaces] = useState<SpacesResponse | null>(null);
  const [spacesError, setSpacesError] = useState<ApiFailure | null>(null);
  const [open, setOpen] = useState<SpaceViewResponse | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<ApiFailure | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [jump, setJump] = useState<{ member: string; id: number; nonce: number } | null>(null);
  const [problem, setProblem] = useState<ApiFailure | null>(null);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<ApiFailure | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  const viewId = useRef<string | null>(null);
  const sequence = useRef(0);
  const refreshing = useRef(false);

  const loadSpaces = async (): Promise<SpacesResponse | null> => {
    setSpacesError(null);
    try {
      const result = await api<SpacesResponse>("/api/spaces", { intent: true });
      setSpaces(result);
      return result;
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === "bot-offline") setProblem(failure);
      else setSpacesError(failure);
      return null;
    }
  };

  useEffect(() => {
    void loadSpaces();
    return () => { if (viewId.current) closeView(viewId.current); };
  }, []);

  const openSpace = async (space: SpaceSummary, mode: IdentityMode = "default", confirm = false,
    keep?: { view: string; member: string }): Promise<SpaceViewResponse | null> => {
    if (space.state !== "ready" || !space.generation) return null;
    const id = ++sequence.current;
    setOpening(space.space);
    setOpenError(null);
    try {
      const result = await api<SpaceViewResponse>("/api/views/space", {
        method: "POST", intent: true, body: { space: space.space, generation: space.generation, mode, confirm: confirm || undefined, keep },
      });
      if (id !== sequence.current) { closeView(result.view.id); return null; }
      if (viewId.current && viewId.current !== result.view.id) closeView(viewId.current);
      viewId.current = result.view.id;
      setOpen(result);
      setMember(result.kept ?? null);
      setProblem(null);
      setNotice(keep && !result.kept ? "原来选中的成员不在新视图中，请重新选择。" : null);
      return result;
    } catch (error) {
      if (id !== sequence.current) return null;
      const failure = failureOf(error);
      if (failure.code === "bot-offline") setProblem(failure);
      else setOpenError(failure);
      return null;
    } finally {
      if (id === sequence.current) setOpening(null);
    }
  };

  const leave = () => {
    sequence.current++;
    if (viewId.current) closeView(viewId.current);
    viewId.current = null;
    setOpen(null);
    setMember(null);
    setSearching(false);
    setOpening(null);
    setRefreshError(null);
  };

  const backToList = () => { leave(); setProblem(null); setNotice(null); void loadSpaces(); };

  /** Opens the same space again (a new database generation, or the view went), in the mode it had unless that was full. */
  const reopen = async () => {
    if (!open) return backToList();
    const name = open.space.space, mode = open.view.mode === "full" ? "default" : open.view.mode;
    leave();
    setProblem(null);
    const list = await loadSpaces();
    const summary = list?.spaces.find(item => item.space === name);
    if (summary?.state === "ready") await openSpace(summary, mode);
    else if (list) setNotice("这个会话空间已不存在或暂时不可读。");
  };

  const onProblem: Problem = error => {
    const failure = failureOf(error);
    if (!failure.code || !VIEW_PROBLEMS.has(failure.code)) return false;
    setProblem(failure);
    return true;
  };

  /** Reads the member list again: newest activity per member, and members who joined since the view opened. */
  const refreshMembers = async () => {
    const id = viewId.current;
    if (!id || refreshing.current) return;
    refreshing.current = true;
    setMembersBusy(true);
    setRefreshError(null);
    try {
      const result = await api<MembersResponse>("/api/conversation/activity", { method: "POST", intent: true, body: { view: id } });
      setOpen(value => value?.view.id === id
        ? { ...value, members: result.members, truncated: result.truncated, observedAt: result.observedAt } : value);
    } catch (error) {
      if (viewId.current === id && !onProblem(error)) setRefreshError(failureOf(error));
    } finally {
      refreshing.current = false;
      setMembersBusy(false);
    }
  };

  const switchMode = (mode: IdentityMode, confirm: boolean) => {
    if (!open) return;
    // The view's own generation: a member can be kept only within the same database.
    void openSpace(open.space, mode, confirm, member ? { view: open.view.id, member } : undefined);
  };

  const rows = open?.members ?? [];
  const byKey = useMemo(() => new Map(rows.map(row => [row.identity.key, row])), [open]);
  const selected = member ? byKey.get(member) ?? null : null;

  /** Opens the space of a hit of the search over every space, in the search's mode, at the hit's entry. */
  const openGlobalHit = async (hit: GlobalSearchHit, search: { view: string; mode: IdentityMode }) => {
    const summary = spaces?.spaces.find(item => item.space === hit.space);
    if (!summary || !hit.member) return;
    const result = await openSpace(summary, search.mode, false, { view: search.view, member: hit.member.key });
    if (result?.kept) setJump({ member: result.kept, id: hit.id, nonce: Date.now() });
  };
  // Kept mounted (hidden while a space is open), so going back to the list finds the results where they were.
  const globalSearch = <GlobalSearch key="global-search" hidden={!!open} onOpen={(hit, search) => void openGlobalHit(hit, search)} />;

  if (problem?.code === "bot-offline") {
    return (
      <>
        <PageHead />
        <EmptyState icon="power" tone="danger" title="机器人未运行，实时会话不可用"
          action={<button type="button" class="btn primary" onClick={backToList}><Icon name="refresh" />重试</button>}>
          会话只能经机器人只读读取；控制台不会在机器人停止时直接打开会话库。已下载的导出文件可离线查看，统计页不受影响。
        </EmptyState>
      </>
    );
  }

  if (!open) {
    return (
      <>
        <PageHead />
        {spaces && spaces.spaces.length > 0 && globalSearch}
        {notice && <Banner tone="warn" icon="info" title={notice} />}
        {openError && <Banner tone="danger" icon="alert" title="无法打开会话空间">{openError.message}</Banner>}
        {spacesError && (
          <Banner tone="danger" icon="alert" title="读取会话空间失败" action={<button type="button" class="btn" onClick={() => void loadSpaces()}>重试</button>}>
            {spacesError.message}
          </Banner>
        )}
        {!spaces && !spacesError && <EmptyState icon="loader" title="正在读取会话空间…" />}
        {spaces && <SpaceGrid spaces={spaces} opening={opening} onOpen={space => void openSpace(space)} />}
      </>
    );
  }

  const viewProblem = problem && (
    <Banner tone="warn" icon="alert" title={problem.code === "view-gone" ? "这个视图已过期" : problem.code === "space-absent" ? "会话空间已不存在" : "会话库已更换"}
      action={problem.code === "space-absent"
        ? <button type="button" class="btn" onClick={backToList}>返回空间列表</button>
        : <button type="button" class="btn primary" onClick={() => void reopen()}>重新打开</button>}>
      {problem.message}
    </Banner>
  );

  const openHit = (key: string, id: number) => {
    setMember(key);
    setJump({ member: key, id, nonce: Date.now() });
  };

  return (
    <>
      <div class="page-header compact">
        <div class="space-head">
          <button type="button" class="btn ghost" onClick={backToList}><Icon name="arrow" class="flip" />全部空间</button>
          <select class="select space-select" aria-label="切换会话空间" value={open.space.space} disabled={opening !== null}
            onChange={event => {
              const next = spaces?.spaces.find(item => item.space === (event.target as HTMLSelectElement).value);
              if (next) { setSearching(false); void openSpace(next); }
            }}>
            {(spaces?.spaces ?? [open.space]).map(space => (
              <option key={space.space} value={space.space} disabled={space.state !== "ready"}>
                {space.title}{space.members !== undefined ? ` · ${count(space.members)} 位` : ""}{space.state === "empty" ? "（无会话）" : space.state === "unreadable" ? "（不可读）" : ""}
              </option>
            ))}
          </select>
          {opening && <Spinner label="正在打开…" />}
        </div>
        <div class="page-actions">
          <ModeBadge mode={open.view.mode} />
          <ModeSwitch mode={open.view.mode} disabled={opening !== null} what="这个空间的查看" onChange={switchMode} />
          <button type="button" class={`btn${searching ? " active" : ""}`} aria-pressed={searching} onClick={() => setSearching(value => !value)}>
            <Icon name="search" />搜索
          </button>
          <button type="button" class="btn" onClick={() => setExporting(true)}><Icon name="download" />导出</button>
          <TaskAction operation="history-clear" params={{ space: open.space.space }} danger>清空此空间</TaskAction>
          {member && <TaskAction operation="history-compact" params={{ view: open.view.id, member }}>压缩当前成员</TaskAction>}
        </div>
      </div>

      {viewProblem}
      {openError && <Banner tone="danger" icon="alert" title="切换失败">{openError.message}</Banner>}
      {notice && <Banner tone="warn" icon="info" title={notice} />}
      {refreshError && (
        <Banner tone="danger" icon="alert" title="刷新成员列表失败" action={<button type="button" class="btn" onClick={() => void refreshMembers()}>重试</button>}>
          {refreshError.message}（列表仍是上一次读取的结果）
        </Banner>
      )}
      <NamesNotice names={open.names} />
      {open.truncated && <Banner tone="warn" icon="users" title={`成员超过 ${count(open.members.length)} 位，只载入了前面这些`}>导出整个空间时同样只包括已载入的成员。</Banner>}

      <div class={`conv${searching ? " with-search" : ""}${member ? " has-member" : ""}`}>
        <MemberPane key={open.view.id} rows={rows} selected={member} onSelect={key => { setMember(key); setJump(null); }} names={open}
          busy={membersBusy} onRefresh={() => void refreshMembers()} />
        <section class="pane reader-pane" aria-label="会话内容">
          {selected ? (
            <MemberReader key={`${open.view.id}:${selected.identity.key}`} view={open.view.id} row={selected} onProblem={onProblem}
              jump={jump?.member === selected.identity.key ? jump : null} onBack={() => setMember(null)} onRefresh={() => void refreshMembers()} />
          ) : (
            <EmptyState icon="messages" title="选择一位成员查看会话">
              {open.space.space === "direct" ? "单聊里每位成员一段会话。" : "群聊里每位成员有自己的一段会话。"}成员按最近活动排序。
            </EmptyState>
          )}
        </section>
        {searching && (
          <SearchPanel key={open.view.id} view={open.view.id} member={selected} byKey={byKey} onOpen={openHit} onProblem={onProblem} onClose={() => setSearching(false)} />
        )}
      </div>
      <p class="footnote">{SCOPE_NOTE}</p>

      {exporting && (
        <ConversationExportDialog view={open.view.id} viewMode={open.view.mode} spaceTitle={open.space.title} members={open.members.length}
          member={selected && { key: selected.identity.key, label: selected.identity.label }} onClose={() => setExporting(false)} />
      )}
      {globalSearch}
    </>
  );
}

function PageHead() {
  return (
    <div class="page-header">
      <div>
        <h1 class="page-title">会话</h1>
        <p class="page-desc">单聊与群聊记录、工具调用和交付状态。经运行中的机器人只读读取，不修改会话库。</p>
      </div>
    </div>
  );
}

function SpaceGrid({ spaces, opening, onOpen }: { spaces: SpacesResponse; opening: string | null; onOpen: (space: SpaceSummary) => void }) {
  if (!spaces.spaces.length) return <EmptyState icon="messages" title="还没有会话空间">有人和机器人单聊或在群里提问后，这里会出现对应的空间。</EmptyState>;
  return (
    <div class="space-grid">
      {spaces.spaces.map(space => {
        const ready = space.state === "ready";
        return (
          <button key={space.space} type="button" class="space-card" disabled={!ready || opening !== null} onClick={() => onOpen(space)}
            aria-busy={opening === space.space}>
            <span class="space-icon"><Icon name={space.space === "direct" ? "user" : "users"} size={18} /></span>
            <span class="space-text">
              <span class="space-title">{space.title}</span>
              <span class="space-sub">
                {space.state === "empty" ? "还没有会话" : space.state === "unreadable" ? `暂不可读：${space.error ?? "原因未知"}`
                  : <>{count(space.members ?? 0)} 位成员{space.lastAt ? ` · 最近 ${ago(space.lastAt, spaces.observedAt)}` : ""}</>}
              </span>
            </span>
            {opening === space.space ? <Icon name="loader" class="spin" /> : ready && <Icon name="arrow" size={14} class="space-go" />}
          </button>
        );
      })}
    </div>
  );
}

// ─── Members ───────────────────────────────────────────────────────────────

function MemberPane({ rows, selected, onSelect, names, busy, onRefresh }: {
  rows: MemberRow[]; selected: string | null; onSelect: (key: string) => void; names: SpaceViewResponse; busy: boolean; onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(MEMBER_BATCH);
  const matches = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? rows.filter(row => words.every(word => row.identity.label.toLowerCase().includes(word))) : rows;
  }, [rows, filter]);
  useEffect(() => setLimit(MEMBER_BATCH), [filter]);
  return (
    <aside class="pane member-pane" aria-label="成员">
      <div class="pane-head">
        <div class="pane-tools">
          <div class="input-icon">
            <Icon name="search" size={14} />
            <input type="search" placeholder={names.view.mode === "anonymous" ? "按成员编号筛选" : "按姓名或号码筛选"} aria-label="筛选成员" value={filter}
              onInput={event => setFilter((event.target as HTMLInputElement).value)} />
          </div>
          <button type="button" class="btn ghost icon-btn" aria-label="刷新成员列表" title="刷新成员列表（最近活动与新成员）" disabled={busy} onClick={onRefresh}>
            <Icon name="refresh" class={busy ? "spin" : undefined} />
          </button>
        </div>
        <div class="pane-sub"><span>{filter ? `${count(matches.length)} / ${count(rows.length)} 位` : `${count(rows.length)} 位成员`}</span><NamesObserved names={names.names} /></div>
      </div>
      <ul class="member-list">
        {matches.slice(0, limit).map(row => (
          <li key={row.identity.key}>
            <button type="button" class="member-row" aria-current={row.identity.key === selected ? "true" : undefined} onClick={() => onSelect(row.identity.key)}>
              <Avatar identity={row.identity} size={30} />
              <span class="member-text">
                <span class="member-name"><IdentityText identity={row.identity} compact /></span>
                <span class="member-sub">{row.lastAt ? stamp(row.lastAt, names.observedAt) : "还没有对话"}
                  {row.identity.nameState && row.identity.nameState !== "named" && <span title={row.identity.nameNote}> · {row.identity.nameNote}</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
        {!matches.length && <li class="member-empty">没有匹配的成员</li>}
      </ul>
      {matches.length > limit && (
        <button type="button" class="btn ghost more-btn" onClick={() => setLimit(value => value + MEMBER_BATCH)}>
          再显示 {count(Math.min(MEMBER_BATCH, matches.length - limit))} 位（还有 {count(matches.length - limit)} 位）
        </button>
      )}
    </aside>
  );
}

// ─── Reader ────────────────────────────────────────────────────────────────

function MemberReader({ view, row, onProblem, jump, onBack, onRefresh }: {
  view: string; row: MemberRow; onProblem: Problem; jump: { id: number; nonce: number } | null; onBack: () => void; onRefresh: () => void;
}) {
  const [tab, setTab] = useState<"chat" | "runs">("chat");
  const [target, setTarget] = useState<{ id: number; nonce: number } | null>(jump);
  const [reload, setReload] = useState(0);
  useEffect(() => { if (jump) { setTab("chat"); setTarget(jump); } }, [jump?.nonce]);
  const goTo = (id: number) => { setTab("chat"); setTarget({ id, nonce: Date.now() }); };
  return (
    <>
      <header class="reader-head">
        <button type="button" class="btn ghost icon-btn back-btn" aria-label="返回成员列表" onClick={onBack}><Icon name="arrow" class="flip" /></button>
        <Avatar identity={row.identity} size={36} />
        <div class="reader-title">
          <div class="reader-name"><IdentityText identity={row.identity} /></div>
          <div class="reader-sub">
            {row.createdAt ? `首次对话 ${dateTime(row.createdAt)}` : "首次对话时间未知"}
            {row.lastAt ? ` · 最近 ${dateTime(row.lastAt)}` : ""}
          </div>
        </div>
        <div class="reader-tools">
          <Segmented label="内容" size="small" value={tab} onChange={setTab}
            options={[{ value: "chat", label: "对话", icon: "messages" }, { value: "runs", label: "运行记录", icon: "activity" }]} />
          {tab === "chat" && <BoundaryMenu view={view} member={row.identity.key} onJump={goTo} onProblem={onProblem} />}
          <button type="button" class="btn ghost icon-btn" aria-label={tab === "chat" ? "回到最新" : "刷新运行记录"} title={tab === "chat" ? "回到最新" : "刷新"}
            onClick={() => { setTarget(null); setReload(value => value + 1); onRefresh(); }}><Icon name="refresh" /></button>
        </div>
      </header>
      {tab === "chat"
        ? <Transcript key={`${reload}:${target?.nonce ?? 0}`} view={view} identity={row.identity} target={target?.id ?? null} onProblem={onProblem} />
        : <Runs key={reload} view={view} member={row.identity.key} onJump={goTo} onProblem={onProblem} />}
    </>
  );
}

interface TranscriptState { items: EntryView[]; older: boolean; newer: boolean }

function Transcript({ view, identity, target, onProblem }: { view: string; identity: Identity; target: number | null; onProblem: Problem }) {
  const [state, setState] = useState<TranscriptState | null>(null);
  const [busy, setBusy] = useState<"older" | "newer" | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [full, setFull] = useState<EntryView | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const keepFrom = useRef<number | null>(null);
  const member = identity.key;

  const page = (older: boolean, cursor: number | null) =>
    api<EntryPage>("/api/conversation/entries", { method: "POST", intent: true, body: { view, member, older, cursor } });

  const fail = (failure: unknown) => { if (!onProblem(failure)) setError(failureOf(failure)); };

  // First page: the newest entries, or the entries from the jump target on.
  useEffect(() => {
    let live = true;
    (target === null ? page(true, null) : page(false, Math.max(0, target - 1))).then(result => {
      if (!live) return;
      setState(target === null
        ? { items: [...result.items].reverse(), older: result.next !== null, newer: false }
        : { items: result.items, older: target > 1, newer: result.next !== null });
    }, failure => { if (live) fail(failure); });
    return () => { live = false; };
  }, []);

  // Land at the bottom (newest) or on the target once the first page is in.
  const landed = useRef(false);
  useEffect(() => {
    const box = scroller.current;
    if (!state || !box) return;
    if (!landed.current) {
      landed.current = true;
      if (target === null) box.scrollTop = box.scrollHeight;
      else box.querySelector(`[data-entry="${target}"]`)?.scrollIntoView?.({ block: "center" });
    } else if (keepFrom.current !== null) {
      // Older entries went in above: keep what was on screen where it was.
      box.scrollTop += box.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    }
  }, [state]);

  const loadOlder = async () => {
    if (!state || busy) return;
    setBusy("older");
    setError(null);
    try {
      const result = await page(true, state.items[0]?.id ?? null);
      keepFrom.current = scroller.current?.scrollHeight ?? null;
      setState(current => current && { ...current, items: [...[...result.items].reverse(), ...current.items], older: result.next !== null });
    } catch (failure) { fail(failure); } finally { setBusy(null); }
  };

  const loadNewer = async () => {
    if (!state || busy) return;
    setBusy("newer");
    setError(null);
    try {
      const result = await page(false, state.items.at(-1)?.id ?? 0);
      setState(current => current && { ...current, items: [...current.items, ...result.items], newer: result.next !== null });
    } catch (failure) { fail(failure); } finally { setBusy(null); }
  };

  /** The whole entry (texts past the page limit, system prompts). */
  const loadFull = async (id: number, show: boolean) => {
    try {
      const result = await api<{ entry: EntryView }>("/api/conversation/entry", { method: "POST", intent: true, body: { view, member, id } });
      if (show) setFull(result.entry);
      else setState(current => current && { ...current, items: current.items.map(item => item.id === id ? result.entry : item) });
    } catch (failure) { fail(failure); }
  };

  if (!state) {
    return error
      ? <EmptyState icon="alert" tone="danger" title="读取会话失败">{error.message}</EmptyState>
      : <EmptyState icon="loader" title="正在读取会话…" />;
  }

  return (
    <div class="transcript" ref={scroller}>
      {state.older
        ? <div class="load-row"><button type="button" class="btn small-btn" disabled={busy !== null} onClick={() => void loadOlder()}>
            {busy === "older" ? <><Icon name="loader" size={14} class="spin" />正在读取…</> : "加载更早的记录"}</button></div>
        : state.items.length > 0 && <div class="load-row muted small">已到这段会话的开头</div>}
      {!state.items.length && <EmptyState icon="messages" title="这段会话还没有记录" />}
      {state.items.map(entry => <EntryRow key={entry.id} entry={entry} identity={identity} target={entry.id === target} onFull={loadFull} />)}
      {state.newer && (
        <div class="load-row"><button type="button" class="btn small-btn" disabled={busy !== null} onClick={() => void loadNewer()}>
          {busy === "newer" ? <><Icon name="loader" size={14} class="spin" />正在读取…</> : "加载之后的记录"}</button></div>
      )}
      {error && <Banner tone="danger" icon="alert" title="读取失败">{error.message}</Banner>}
      {full && (
        <Dialog title={`${full.role === "system" ? "系统提示" : "完整内容"} · #${full.id}`} icon="file" size="wide" onClose={() => setFull(null)}>
          <pre class="full-text">{full.parts.map(part => part.type === "text" || part.type === "thinking" ? part.text : part.type === "toolCall" ? part.arguments : "").join("\n\n")}</pre>
        </Dialog>
      )}
    </div>
  );
}

// ─── Entries ───────────────────────────────────────────────────────────────

function When({ entry }: { entry: EntryView }) {
  return (
    <span class="entry-when">
      {entry.at !== null && <time title={dateTime(entry.at)}>{stamp(entry.at)}</time>}
      <span class="entry-id">#{entry.id}</span>
    </span>
  );
}

function Truncated({ part, onLoad }: { part: { truncated?: number }; onLoad: () => void }) {
  if (!part.truncated) return null;
  return (
    <div class="truncated">
      <Icon name="scissors" size={13} />此段共 {count(part.truncated)} 字，这里只显示开头。
      <button type="button" class="link-btn" onClick={onLoad}>加载全文</button>
    </div>
  );
}

function ToolCall({ part, onLoad }: { part: Extract<EntryPart, { type: "toolCall" }>; onLoad: () => void }) {
  return (
    <details class="tool-call">
      <summary><Icon name="terminal" size={14} /><span class="tool-name">{part.name}</span><span class="muted">调用参数</span>
        {part.invalid && <Chip tone="danger" title={part.invalid}>参数无效</Chip>}</summary>
      <pre class="code-block">{part.arguments}</pre>
      <Truncated part={part} onLoad={onLoad} />
    </details>
  );
}

function PlainText({ text }: { text: string }) {
  return <div class="plain-text">{text}</div>;
}

function Parts({ entry, markdown, onFull }: { entry: EntryView; markdown: boolean; onFull: (id: number, show: boolean) => void }) {
  const [raw, setRaw] = useState(false);
  const hasText = entry.parts.some(part => part.type === "text" && part.text.trim());
  return (
    <>
      {markdown && hasText && (
        <button type="button" class="link-btn raw-toggle" onClick={() => setRaw(value => !value)}>{raw ? "按格式显示" : "显示原文"}</button>
      )}
      {entry.parts.map((part, index) => {
        switch (part.type) {
          case "text": return (
            <div key={index} class="part">
              {markdown && !raw ? <Markdown text={part.text} /> : <PlainText text={part.text} />}
              <Truncated part={part} onLoad={() => onFull(entry.id, false)} />
            </div>
          );
          case "thinking": return (
            <details key={index} class="thinking">
              <summary><Icon name="sparkles" size={14} />思考过程{part.redacted ? "（已隐去）" : ""}</summary>
              <PlainText text={part.text} />
              <Truncated part={part} onLoad={() => onFull(entry.id, false)} />
            </details>
          );
          case "image": return <div key={index} class="attachment"><Icon name="file" size={14} />图片 · {part.mimeType || "未知类型"} · {bytes(part.bytes)}（页面不显示图片内容）</div>;
          case "toolCall": return <ToolCall key={index} part={part} onLoad={() => onFull(entry.id, false)} />;
        }
      })}
    </>
  );
}

const STOP_NOTES: Record<string, string> = { length: "达到输出长度上限", error: "出错结束", aborted: "被中止" };

function Usage({ entry }: { entry: EntryView }) {
  const info = entry.assistant!;
  const usage = info.usage;
  return (
    <div class="entry-meta">
      <span class="mono">{info.provider}/{info.model}</span>
      {usage && <span title={`输入 ${count(usage.input)} · 输出 ${count(usage.output)} · 缓存读 ${count(usage.cacheRead)} · 缓存写 ${count(usage.cacheWrite)}`}>
        {count(usage.total)} token</span>}
      {info.durationMs !== undefined && <span>{seconds(info.durationMs)}</span>}
      {STOP_NOTES[info.stopReason] && <Chip tone={info.stopReason === "length" ? "warn" : "danger"}>{STOP_NOTES[info.stopReason]}</Chip>}
    </div>
  );
}

function EntryRow({ entry, identity, target, onFull }: { entry: EntryView; identity: Identity; target: boolean; onFull: (id: number, show: boolean) => void }) {
  const mark = target ? " target" : "";
  if (entry.kind === "pi.reset") {
    return (
      <div class={`divider reset${mark}`} data-entry={entry.id}>
        <span><Icon name="scissors" size={13} />/clear：此后开始新的上下文<When entry={entry} /></span>
      </div>
    );
  }
  if (entry.kind === "pi.compaction") {
    return (
      <div class={`divider compaction${mark}`} data-entry={entry.id}>
        <details>
          <summary><Icon name="layers" size={13} />压缩摘要：此后模型上下文从 #{entry.head} 起保留，更早的记录仍在下方历史中<When entry={entry} /></summary>
          <div class="compaction-body"><Parts entry={entry} markdown onFull={onFull} /></div>
        </details>
      </div>
    );
  }
  if (entry.system) {
    const info = entry.system;
    return (
      <div class={`system-row${mark}`} data-entry={entry.id}>
        <Icon name="file" size={14} />
        <span>系统提示 · {count(info.chars)} 字{info.sections.length > 0 && ` · 段：${info.sections.join("、")}`}
          {info.toolsAdded.length > 0 && ` · 新增工具：${info.toolsAdded.join("、")}`}{info.toolsRemoved.length > 0 && ` · 移除工具：${info.toolsRemoved.join("、")}`}</span>
        <button type="button" class="link-btn" onClick={() => onFull(entry.id, true)}>查看全文</button>
        <When entry={entry} />
      </div>
    );
  }
  if (entry.role === "toolResult" && entry.tool) {
    const tool = entry.tool;
    const text = entry.parts.map(part => part.type === "text" ? part.text : "").join("\n");
    return (
      <div class={`tool-result${tool.isError ? " failed" : ""}${mark}`} data-entry={entry.id}>
        <details open={text.length <= LONG_TOOL_OUTPUT && text.split("\n").length <= 12}>
          <summary>
            <Icon name={tool.isError ? "alert" : "check"} size={14} />
            <span class="tool-name">{tool.name || "工具"}</span>
            <span class="muted">{tool.isError ? "失败" : "结果"}</span>
            {tool.durationMs !== undefined && <span class="muted">{seconds(tool.durationMs)}</span>}
            {tool.nested !== undefined && <Chip>嵌套调用 {tool.nested}</Chip>}
            <span class="muted small">{count(text.length)} 字</span>
            <When entry={entry} />
          </summary>
          <Parts entry={entry} markdown={false} onFull={onFull} />
        </details>
      </div>
    );
  }
  if (entry.kind === PUSH_NOTE_KIND) {
    // Written by the push service, not by the member: the model reads it as background.
    return (
      <div class={`push-note${mark}`} data-entry={entry.id}>
        <Icon name="radio" size={14} />
        <div class="push-note-main">
          <div class="push-note-head"><span>推送备注</span><When entry={entry} /></div>
          <Parts entry={entry} markdown={false} onFull={onFull} />
        </div>
      </div>
    );
  }
  if (entry.role === "user" || entry.role === "assistant") {
    const user = entry.role === "user";
    return (
      <article class={`message ${entry.role}${mark}`} data-entry={entry.id}>
        <Avatar identity={user ? identity : null} size={30} />
        <div class="message-main">
          <header class="message-head">
            <span class="message-author">{user ? identity.label : "机器人"}</span>
            <When entry={entry} />
          </header>
          <div class="message-body"><Parts entry={entry} markdown={!user} onFull={onFull} /></div>
          {entry.assistant?.error && <Banner tone="danger" icon="alert" title="模型返回错误">{entry.assistant.error}</Banner>}
          {entry.assistant && <Usage entry={entry} />}
        </div>
      </article>
    );
  }
  // Other records (the agent's bookkeeping): named and collapsible, never hidden.
  return (
    <details class={`other-row${mark}`} data-entry={entry.id}>
      <summary><Icon name="database" size={13} /><span class="mono">{entry.kind}</span><When entry={entry} /></summary>
      {entry.parts.length > 0 && <Parts entry={entry} markdown={false} onFull={onFull} />}
      {entry.data !== undefined && <pre class="code-block">{JSON.stringify(entry.data, null, 2).slice(0, 20_000)}</pre>}
    </details>
  );
}

// ─── Context boundaries ────────────────────────────────────────────────────

function BoundaryMenu({ view, member, onJump, onProblem }: { view: string; member: string; onJump: (id: number) => void; onProblem: Problem }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Boundary[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = async (after: number) => {
    setError(null);
    try {
      const result = await api<{ items: Boundary[]; next: number | null }>("/api/conversation/boundaries", { method: "POST", intent: true, body: { view, member, after } });
      setItems(current => [...after ? current ?? [] : [], ...result.items]);
      setNext(result.next);
    } catch (failure) {
      if (!onProblem(failure)) setError(failureOf(failure).message);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (items === null) void load(0);
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);

  return (
    <div class="menu" ref={box}>
      <button type="button" class="btn ghost small-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(value => !value)}>
        <Icon name="layers" size={14} />上下文分段
      </button>
      {open && (
        <div class="menu-pop" role="menu">
          <div class="menu-note">/clear 开始新的上下文；压缩摘要替代了更早的模型上下文，原始记录仍保留。</div>
          {items === null && !error && <div class="menu-empty"><Spinner /></div>}
          {items?.length === 0 && <div class="menu-empty">这段会话没有 /clear 或压缩</div>}
          {items?.map(item => (
            <button key={item.id} type="button" role="menuitem" class="menu-item" onClick={() => { setOpen(false); onJump(item.id); }}>
              <Icon name={item.kind === "pi.reset" ? "scissors" : "layers"} size={14} />
              <span>{item.kind === "pi.reset" ? "/clear" : "压缩摘要"}</span>
              <span class="muted small">{item.at ? stamp(item.at) : "时间未知"} · #{item.id}</span>
            </button>
          ))}
          {next !== null && <button type="button" class="menu-item more" onClick={() => void load(next)}>加载更多</button>}
          {error && <div class="menu-empty danger-text">{error}</div>}
        </div>
      )}
    </div>
  );
}

// ─── Search ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = { "pi.user": "用户", "pi.assistant": "机器人", "pi.tool-result": "工具结果", "pi.compaction": "压缩摘要",
  [PUSH_NOTE_KIND]: "推送备注" };

/** The snippet with every occurrence of the search terms marked (the bot gives the terms lower-cased). */
function Snippet({ text, terms }: { text: string; terms: string[] }) {
  const lower = text.toLowerCase(), marks: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) marks.push([at, at + term.length]);
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: (string | preact.JSX.Element)[] = [];
  let last = 0;
  for (const [start, end] of marks) {
    if (start < last) continue;
    out.push(text.slice(last, start), <mark key={start}>{text.slice(start, end)}</mark>);
    last = end;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

const SEARCH_KINDS: [SearchKind, string][] = [["question", "提问"], ["answer", "回答"], ["thinking", "思考"], ["tool", "工具"], ["summary", "压缩摘要"], ["push", "推送备注"]];
type RangeKey = "all" | "today" | "7d" | "30d" | "custom";
const RANGES: [RangeKey, string][] = [["all", "不限时间"], ["today", "今天"], ["7d", "最近 7 天"], ["30d", "最近 30 天"], ["custom", "自定义日期"]];
interface FilterState { kinds: SearchKind[]; range: RangeKey; since: string; until: string }
const NO_FILTERS: FilterState = { kinds: [], range: "all", since: "", until: "" };
const SEARCH_NOTE = "多个词用空格分开，须同时出现；英文双引号括起的词组按整体查找。从最新的记录往前找，每次读取有限条数；系统提示不搜索。";

/** The request filters of the chosen ones, days in the browser's time zone; or why the range cannot be searched. */
function requestFilters(state: FilterState): { filters: SearchFilters; error: string | null } {
  const midnight = (date: Date) => { date.setHours(0, 0, 0, 0); return date; };
  const dayOf = (value: string) => { const [year, month, day] = value.split("-").map(Number); return new Date(year!, month! - 1, day!); };
  let from: number | null = null, to: number | null = null;
  if (state.range === "today") from = midnight(new Date()).getTime();
  else if (state.range === "7d" || state.range === "30d") {
    const start = midnight(new Date());
    start.setDate(start.getDate() - (state.range === "7d" ? 6 : 29));
    from = start.getTime();
  } else if (state.range === "custom") {
    if (state.since) from = dayOf(state.since).getTime();
    if (state.until) { const end = dayOf(state.until); end.setDate(end.getDate() + 1); to = end.getTime(); }
    if (from !== null && to !== null && from >= to) return { filters: {}, error: "起始日期晚于结束日期" };
  }
  return { filters: { kinds: state.kinds.length ? state.kinds : null, from, to }, error: null };
}

const timed = (filters: SearchFilters | undefined) => filters?.from != null || filters?.to != null;

function SearchFilterBar({ state, onChange, disabled }: {
  state: FilterState; onChange: (update: (state: FilterState) => FilterState) => void; disabled?: boolean;
}) {
  const toggle = (kind: SearchKind) =>
    onChange(state => ({ ...state, kinds: state.kinds.includes(kind) ? state.kinds.filter(item => item !== kind) : [...state.kinds, kind] }));
  const set = (patch: Partial<FilterState>) => onChange(state => ({ ...state, ...patch }));
  return (
    <div class="search-filters">
      <div class="kind-toggles" role="group" aria-label="只搜这些内容（不选即全部）" title="只搜选中的内容；都不选即全部">
        {SEARCH_KINDS.map(([kind, label]) => {
          const on = state.kinds.includes(kind);
          return <button key={kind} type="button" class={`btn small-btn${on ? " active" : ""}`} aria-pressed={on} disabled={disabled} onClick={() => toggle(kind)}>{label}</button>;
        })}
      </div>
      <div class="date-range">
        <select class="select" aria-label="时间范围" value={state.range} disabled={disabled}
          onChange={event => set({ range: (event.target as HTMLSelectElement).value as RangeKey })}>
          {RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {state.range === "custom" && (
          <>
            <input type="date" aria-label="起始日期" value={state.since} disabled={disabled}
              onChange={event => set({ since: (event.target as HTMLInputElement).value })} />
            <span class="muted">至</span>
            <input type="date" aria-label="结束日期" value={state.until} disabled={disabled}
              onChange={event => set({ until: (event.target as HTMLInputElement).value })} />
          </>
        )}
      </div>
    </div>
  );
}

function SearchPanel({ view, member, byKey, onOpen, onProblem, onClose }: {
  view: string; member: MemberRow | null; byKey: Map<string, MemberRow>; onOpen: (member: string, id: number) => void; onProblem: Problem; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"member" | "space">(member ? "member" : "space");
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [query, setQuery] = useState<{ text: string; member: string | null; filters: SearchFilters } | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const [hits, setHits] = useState<SearchHitView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (!member && scope === "member") setScope("space"); }, [member]);

  /** Reads blocks until some hits turn up, the history ends, or this click's block budget is spent. */
  const search = async (target: { text: string; member: string | null; filters: SearchFilters }, cursor: number | null, fresh: boolean) => {
    const id = ++run.current;
    setBusy(true);
    setError(null);
    if (fresh) { setHits([]); setScanned(0); setNext(null); setQuery(target); setTerms([]); }
    let found = 0;
    try {
      for (let block = 0; block < SEARCH_BLOCKS; block++) {
        const result = await api<SearchResponse>("/api/conversation/search", { method: "POST", intent: true,
          body: { view, text: target.text, member: target.member, ...target.filters, cursor } });
        if (id !== run.current) return;
        setTerms(result.terms);
        setHits(current => [...current, ...result.hits]);
        setScanned(value => value + result.scanned);
        setNext(result.next);
        found += result.hits.length;
        cursor = result.next;
        if (cursor === null || found >= 10) break;
      }
    } catch (failure) {
      if (id === run.current && !onProblem(failure)) setError(failureOf(failure).message);
    } finally {
      if (id === run.current) setBusy(false);
    }
  };

  const chosen = requestFilters(filters);
  const submit = (event: Event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || chosen.error) return;
    void search({ text: value, member: scope === "member" && member ? member.identity.key : null, filters: chosen.filters }, null, true);
  };
  // Results describe the search as it was run: changing the filters or where to search, once there are results, searches again.
  const filterKey = JSON.stringify(chosen.filters);
  useEffect(() => {
    const value = text.trim();
    if (query && value && !chosen.error) void search({ text: value, member: scope === "member" && member ? member.identity.key : null, filters: chosen.filters }, null, true);
  }, [filterKey, scope]);

  return (
    <aside class="pane search-pane" aria-label="搜索">
      <div class="pane-head">
        <div class="pane-title"><Icon name="search" size={15} /><span>搜索记录</span>
          <button type="button" class="btn ghost icon-btn" aria-label="关闭搜索" onClick={onClose}><Icon name="x" size={14} /></button></div>
        <form class="search-form" onSubmit={submit}>
          <input ref={input} type="search" maxLength={200} placeholder="输入要找的文字" aria-label="搜索内容" value={text}
            onInput={event => setText((event.target as HTMLInputElement).value)} />
          <button type="submit" class="btn primary" disabled={busy || !text.trim() || !!chosen.error}>搜索</button>
        </form>
        <Segmented label="搜索范围" size="small" value={scope} onChange={setScope}
          options={[...(member ? [{ value: "member" as const, label: "当前成员" }] : []), { value: "space" as const, label: "整个空间" }]} />
        <SearchFilterBar state={filters} onChange={setFilters} disabled={busy} />
        {chosen.error && <p class="pane-note warn-text">{chosen.error}</p>}
        <p class="pane-note">{SEARCH_NOTE}</p>
      </div>
      <div class="search-results">
        {query && (
          <div class="search-status">
            {busy ? <Spinner label="正在搜索…" />
              : <span>已检查 {count(scanned)} 条，找到 {count(hits.length)} 处{next === null ? timed(query.filters) ? "，已搜完所选时间" : "，已搜到最早的记录" : ""}</span>}
          </div>
        )}
        {hits.map(hit => {
          const row = hit.member ? byKey.get(hit.member) : undefined;
          return (
            <button key={hit.id} type="button" class="hit" disabled={!hit.member} onClick={() => hit.member && onOpen(hit.member, hit.id)}
              title={hit.member ? "在会话中打开" : "这位成员不在本视图载入的名单里"}>
              <span class="hit-head">
                <span class="hit-who">{row ? row.identity.label : "未载入的成员"}</span>
                <span class="muted small">{KIND_LABEL[hit.kind] ?? hit.kind}{hit.at ? ` · ${stamp(hit.at)}` : ""}</span>
              </span>
              <span class="hit-snippet"><Snippet text={hit.snippet} terms={terms} /></span>
            </button>
          );
        })}
        {query && !busy && next !== null && (
          <button type="button" class="btn small-btn more-btn" onClick={() => void search(query, next, false)}>继续搜索更早的记录</button>
        )}
        {error && <Banner tone="danger" icon="alert" title="搜索失败">{error}</Banner>}
      </div>
    </aside>
  );
}

/**
 * The search over every space, above the space list: its own view pins the spaces and names members in its mode (default
 * or anonymous). Each block reads one space; a click reads blocks until some hits turn up or its budget is spent.
 */
function GlobalSearch({ hidden, onOpen }: { hidden: boolean; onOpen: (hit: GlobalSearchHit, search: { view: string; mode: IdentityMode }) => void }) {
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [mode, setMode] = useState<"default" | "anonymous">("default");
  const [search, setSearch] = useState<{ view: string; mode: IdentityMode; spaces: number; text: string; filters: SearchFilters } | null>(null);
  const [hits, setHits] = useState<GlobalSearchHit[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [next, setNext] = useState<GlobalSearchCursor | null>(null);
  const [scanned, setScanned] = useState(0);
  const [skipped, setSkipped] = useState<{ title: string; reason: string }[]>([]);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const viewRef = useRef<string | null>(null);
  useEffect(() => () => { if (viewRef.current) closeView(viewRef.current); }, []);

  const read = async (target: NonNullable<typeof search>, cursor: GlobalSearchCursor | null, id: number) => {
    let found = 0;
    for (let block = 0; block < GLOBAL_BLOCKS; block++) {
      const result = await api<GlobalSearchResponse>("/api/search", { method: "POST", intent: true,
        body: { view: target.view, text: target.text, ...target.filters, cursor } });
      if (id !== run.current) return;
      setHits(list => [...list, ...result.hits]);
      setScanned(value => value + result.scanned);
      setNext(result.next);
      if (result.terms.length) setTerms(result.terms);
      if (result.skipped.length) setSkipped(list => [...list, ...result.skipped]);
      setCurrent(result.title);
      found += result.hits.length;
      cursor = result.next;
      if (cursor === null || found >= 10) break;
    }
  };

  const go = async (fresh: boolean) => {
    const id = ++run.current;
    setBusy(true);
    setError(null);
    try {
      if (fresh) {
        // A new search pins the spaces again; the previous one's member keys go with its view.
        if (viewRef.current) { closeView(viewRef.current); viewRef.current = null; }
        setHits([]); setScanned(0); setNext(null); setSkipped([]); setTerms([]); setCurrent("");
        const opened = await api<GlobalSearchViewResponse>("/api/views/search", { method: "POST", intent: true, body: { mode } });
        if (id !== run.current) { closeView(opened.view.id); return; }
        viewRef.current = opened.view.id;
        const target = { view: opened.view.id, mode: opened.view.mode, spaces: opened.spaces, text: text.trim(), filters: requestFilters(filters).filters };
        setSearch(target);
        await read(target, null, id);
      } else if (search) {
        await read(search, next, id);
      }
    } catch (failure) {
      if (id === run.current) setError(failureOf(failure).message);
    } finally {
      if (id === run.current) setBusy(false);
    }
  };

  const chosen = requestFilters(filters);
  const submit = (event: Event) => {
    event.preventDefault();
    if (text.trim() && !chosen.error) void go(true);
  };
  // Results describe the search as it was run: changing the filters or the identity mode, once there are results, searches again.
  const filterKey = JSON.stringify(chosen.filters);
  useEffect(() => { if (search && text.trim() && !chosen.error) void go(true); }, [filterKey, mode]);
  const clear = () => {
    run.current++;
    if (viewRef.current) { closeView(viewRef.current); viewRef.current = null; }
    setSearch(null); setHits([]); setNext(null); setSkipped([]); setBusy(false); setError(null);
  };

  return (
    <section class="global-search" hidden={hidden} aria-label="搜索全部会话">
      <form class="search-form" onSubmit={submit}>
        <div class="input-icon">
          <Icon name="search" size={14} />
          <input type="search" maxLength={200} placeholder="在全部单聊和群聊中搜索" aria-label="搜索全部会话" value={text}
            onInput={event => setText((event.target as HTMLInputElement).value)} />
        </div>
        <Segmented label="搜索结果的身份显示" size="small" value={mode} onChange={setMode} disabled={busy}
          options={[{ value: "default", label: "默认身份", title: "姓名和打码号码" }, { value: "anonymous", label: "匿名", title: "只显示本次编号" }]} />
        <button type="submit" class="btn primary" disabled={busy || !text.trim() || !!chosen.error}>搜索</button>
        {search && <button type="button" class="btn ghost" onClick={clear}>清除结果</button>}
      </form>
      <SearchFilterBar state={filters} onChange={setFilters} disabled={busy} />
      {chosen.error && <p class="pane-note warn-text">{chosen.error}</p>}
      <p class="pane-note">{SEARCH_NOTE}按空间依次查找：先单聊，再按最近活动排列的群。</p>
      {search && (
        <div class="search-results global">
          <div class="search-status">
            {busy ? <Spinner label={current ? `正在搜索 ${current}…` : "正在搜索…"} />
              : <span>已检查 {count(scanned)} 条，找到 {count(hits.length)} 处{next === null
                ? timed(search.filters) ? "，全部空间已搜完所选时间" : "，全部空间已搜到最早的记录"
                : `，${count(search.spaces)} 个空间中已搜到第 ${count(next.space + 1)} 个`}</span>}
          </div>
          {skipped.length > 0 && (
            <Banner tone="warn" icon="info" title={`跳过了 ${count(skipped.length)} 个空间`}>
              {skipped.map(item => `${item.title}（${item.reason}）`).join("、")}。需要时重新搜索。
            </Banner>
          )}
          {hits.map(hit => (
            <button key={`${hit.space}:${hit.id}`} type="button" class="hit" disabled={!hit.member} onClick={() => onOpen(hit, search)}
              title={hit.member ? "在会话中打开" : "这位成员不在本次搜索载入的成员中"}>
              <span class="hit-head">
                <span class="hit-who">{hit.member?.label ?? "未载入的成员"}<span class="muted"> · {hit.title}</span></span>
                <span class="muted small">{KIND_LABEL[hit.kind] ?? hit.kind}{hit.at ? ` · ${stamp(hit.at)}` : ""}</span>
              </span>
              <span class="hit-snippet"><Snippet text={hit.snippet} terms={terms} /></span>
            </button>
          ))}
          {!busy && next !== null && <button type="button" class="btn small-btn more-btn" onClick={() => void go(false)}>继续搜索</button>}
          {error && <Banner tone="danger" icon="alert" title="搜索失败">{error}</Banner>}
        </div>
      )}
    </section>
  );
}

// ─── Run records ───────────────────────────────────────────────────────────

const SUBMISSION: Record<string, [string, Tone]> = { queued: ["排队中", "info"], placed: ["处理中", "info"], done: ["已完成", "ok"], unanswered: ["未回答", "warn"] };
const PART_STATE: Record<string, [string, Tone]> = {
  pending: ["待发送", "neutral"], planned: ["待发送", "neutral"], sending: ["发送中", "info"], sent: ["平台已接收", "ok"],
  uncertain: ["结果不确定", "warn"], failed: ["失败", "danger"],
};
const PART_KIND: Record<string, string> = { markdown: "回复", links: "外链说明", file: "文件" };
const DELIVERABLE: Record<string, [string, Tone]> = { checked: ["已检查", "ok"], draft: ["草稿", "warn"], rejected: ["未通过检查", "danger"] };
const ABANDONED: Record<string, string> = { withdrawn: "被 /stop 或 /clear 撤回", expired: "超出发送时限" };

function StateChip({ table, state, title }: { table: Record<string, [string, Tone]>; state: string; title?: string }) {
  const [label, tone] = table[state] ?? [state || "未知", "neutral"];
  return <Chip tone={tone} title={title}>{label}</Chip>;
}

function RunCard({ item, onJump }: { item: RequestView; onJump: (id: number) => void }) {
  const delivery = item.delivery, received = item.receivedAt ?? item.createdAt;
  return (
    <article class="run-card">
      <header class="run-head">
        <span class="run-time">{received !== null ? dateTime(received) : "时间未知"}</span>
        {item.status && <StateChip table={SUBMISSION} state={item.status} />}
        {item.cancelled && <Chip tone="warn">已取消</Chip>}
        <span class="muted small">{item.closedAt ? `结束于 ${clock(item.closedAt)}` : "进行中"}</span>
        <span class="run-links">
          {item.entry !== null && <button type="button" class="link-btn" onClick={() => onJump(item.entry!)}>提问 #{item.entry}</button>}
          {item.answer !== null && <button type="button" class="link-btn" onClick={() => onJump(item.answer!)}>回答 #{item.answer}</button>}
        </span>
      </header>
      {item.summary && <p class="run-summary">{item.summary}</p>}
      <dl class="run-facts">
        <dt>交付</dt>
        <dd>
          {!delivery ? <span class="muted">没有交付记录</span> : (
            <>
              <span class="muted">{delivery.kind === "fallback" ? "兜底提示" : "回复"}</span>
              {delivery.abandoned && <Chip tone="warn">已放弃：{ABANDONED[delivery.abandonedReason ?? ""] ?? "原因未记录"}</Chip>}
              <ul class="parts">
                {delivery.parts.map(part => (
                  <li key={part.id}>
                    <span>{PART_KIND[part.kind] ?? part.kind}</span>
                    <StateChip table={PART_STATE} state={part.state} />
                    {part.attempts > 1 && <span class="muted small">尝试 {part.attempts} 次</span>}
                    {part.state === "failed" && <span class="muted small">{part.retryAt ? `将于 ${clock(part.retryAt)} 重试` : "不再重试"}</span>}
                    {part.at !== undefined && <span class="muted small">{clock(part.at)}</span>}
                    {part.error && <span class="part-error">{part.error}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </dd>
        {item.files.length > 0 && <>
          <dt>发送的文件</dt>
          <dd><ul class="parts">{item.files.map((file, index) => (
            <li key={index}><span class="mono">{file.name}</span><span class="muted small">{bytes(file.size)} · {file.mode === "relay" ? "外链" : "直接发送"}</span>
              <StateChip table={PART_STATE} state={file.state} />{file.error && <span class="part-error">{file.error}</span>}</li>
          ))}</ul></dd>
        </>}
        {item.deliverables.length > 0 && <>
          <dt>生成的文档</dt>
          <dd><ul class="parts">{item.deliverables.map((file, index) => (
            <li key={index}><span class="mono">{file.name}</span><span class="muted small">{bytes(file.size)}{file.complete ? "" : " · 未完成"}</span>
              <StateChip table={DELIVERABLE} state={file.status} /></li>
          ))}</ul></dd>
        </>}
      </dl>
    </article>
  );
}

function Runs({ view, member, onJump, onProblem }: { view: string; member: string; onJump: (id: number) => void; onProblem: Problem }) {
  const [data, setData] = useState<RequestsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<RequestsResponse>("/api/conversation/requests", { method: "POST", intent: true, body: { view, member } }).then(
      result => { if (live) setData(result); },
      failure => { if (live && !onProblem(failure)) setError(failureOf(failure).message); });
    return () => { live = false; };
  }, []);
  if (error) return <EmptyState icon="alert" tone="danger" title="读取运行记录失败">{error}</EmptyState>;
  if (!data) return <EmptyState icon="loader" title="正在读取运行记录…" />;
  return (
    <div class="runs">
      <Banner tone="info" icon="info" title={`保留中的运行记录 ${count(data.total)} 条 · 读取于 ${clock(data.observedAt)}`}>
        "平台已接收"表示平台收下了消息，没有已读证据，不代表对方已读；"结果不确定"的消息可能已到达，不会重发。已结束的记录 24 小时后清除。
      </Banner>
      {!data.items.length && <EmptyState icon="activity" title="没有保留中的运行记录" />}
      {data.items.map(item => <RunCard key={item.requestId} item={item} onJump={onJump} />)}
      {data.total > data.items.length && <p class="footnote">只显示最近 {count(data.items.length)} 条。</p>}
    </div>
  );
}

