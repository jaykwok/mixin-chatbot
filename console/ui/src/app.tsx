/** @jsxImportSource preact */
// Login gate and the console shell (sidebar, top bar, command palette). When the session ends or the console goes
// away, the shell unmounts so no page content stays on screen.
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiFailure, newLoginGeneration, onConnectionLost } from "./api.ts";
import type { Overview, SessionResponse, SessionView } from "./contract.ts";
import { duration, platformName } from "./format.ts";
import { BrandMark, Icon, type IconName } from "./icons.tsx";
import { available, NAV, routeFromHash, type NavItem } from "./nav.ts";
import { ConversationsPage } from "./conversations.tsx";
import { ExportTray, resetExports } from "./exports.tsx";
import { OverviewPage, StatusPill } from "./overview.tsx";
import { CommandPalette, type Command } from "./palette.tsx";
import { takeLoginToken } from "./login.ts";
import { StatsPage } from "./stats.tsx";
import { PushSettingsForm } from "./push.tsx";
import { PushGroups } from "./push-groups.tsx";
import { PushRecords } from "./push-records.tsx";
import { ReadOnlyPage } from "./read-pages.tsx";
import { TasksPage, resetTasks } from "./tasks.tsx";
import { DirectoryForm, RelayActions, RuntimeForm, StatsImportForm, StorageActions } from "./write-forms.tsx";
import { ConfigurationSettings, ConfigurationRecovery } from "./configuration.tsx";
import { applyTheme, nextTheme, storedTheme, themeLabel, type Theme } from "./theme.ts";

const OVERVIEW_POLL_MS = 15_000;
const SESSION_POLL_MS = 60_000;
/** User activity renews the idle timer at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

/** A logout that gets no answer within this time is reported as unconfirmed (a half-open SSH tunnel may never answer). */
const LOGOUT_TIMEOUT_MS = 10_000;

type Gate = "checking" | "exchanging" | "ready" | "login" | "exchange-failed" | "expired" | "offline"
  | "logging-out" | "logged-out" | "logout-unconfirmed" | "error";

const failureOf = (error: unknown) => error instanceof ApiFailure ? error : new ApiFailure(String(error), 0);

export function Root({ loginToken }: { loginToken: string | null }) {
  const [gate, setGate] = useState<Gate>(loginToken ? "exchanging" : "checking");
  const [session, setSession] = useState<{ view: SessionView; offset: number } | null>(null);
  const [message, setMessage] = useState("");
  // Every login check, exchange and logout takes a new number; an answer that arrives after a newer one started is
  // dropped, so a slow old exchange cannot overwrite the result of a link opened later. The shown page's requests are
  // tied to it the same way (newLoginGeneration): a late failure of an earlier page cannot end a newer login.
  const attempt = useRef(0);
  const shown = useRef(gate);
  shown.current = gate;

  const begin = (next: Gate) => {
    newLoginGeneration();
    setSession(null);
    setMessage("");
    setGate(next);
    return ++attempt.current;
  };
  const settle = (id: number, next: Gate, text = "") => {
    if (id !== attempt.current) return;
    setMessage(text);
    setGate(next);
  };

  const enter = async (token: string | null) => {
    const id = begin(token === null ? "checking" : "exchanging");
    try {
      const result = token === null
        ? await api<SessionResponse>("/api/session", { quiet: true })
        : await api<SessionResponse>("/api/session/exchange", { method: "POST", body: { token }, quiet: true });
      if (id !== attempt.current) return;
      setSession({ view: result.session, offset: result.now - Date.now() });
      setGate("ready");
    } catch (error) {
      const failure = failureOf(error);
      settle(id, failure.status === 401 ? (token === null ? "login" : "exchange-failed") : failure.code === "offline" ? "offline" : "error",
        failure.message);
    }
  };

  // The content leaves the screen at once, but "logged out" is claimed only when the console confirms the session is
  // gone: otherwise the cookie may still be valid and a reload would walk straight back in.
  const logout = async () => {
    const id = begin("logging-out");
    try {
      await api("/api/session/logout", { method: "POST", intent: true, quiet: true, timeoutMs: LOGOUT_TIMEOUT_MS });
      settle(id, "logged-out");
    } catch (error) {
      const failure = failureOf(error);
      // 401: the console no longer knows this session (expired, already revoked, or a restarted console).
      settle(id, failure.status === 401 ? "logged-out" : "logout-unconfirmed", failure.message);
    }
  };

  useEffect(() => {
    // Only a visible shell can lose its session. Requests of an earlier shell no longer report here at all (api.ts).
    onConnectionLost(reason => { if (shown.current === "ready") begin(reason === "session" ? "expired" : "offline"); });
    // A login link opened in this tab after it loaded is a same-document navigation: only hashchange reports it.
    const onHash = () => {
      const token = takeLoginToken();
      if (token !== null) void enter(token);
    };
    window.addEventListener("hashchange", onHash);
    void enter(loginToken);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (gate === "ready" && session) return <Shell initial={session} onEnd={next => void begin(next)} onLogout={() => void logout()} />;
  return <GateScreen gate={gate} message={message} onRetryLogout={() => void logout()} onReconnect={() => void enter(null)} />;
}

function GateScreen({ gate, message, onRetryLogout, onReconnect }: { gate: Gate; message: string; onRetryLogout: () => void; onReconnect: () => void }) {
  const screens: Record<Exclude<Gate, "ready">, { icon: IconName; title: string; body: ComponentChildren; tone?: string }> = {
    checking: { icon: "loader", title: "正在连接控制台", body: "请稍候…" },
    exchanging: { icon: "loader", title: "正在登录", body: "正在验证一次性登录链接…" },
    login: { icon: "lock", title: "需要登录", body: <>在运行 <code>bun run console</code> 的终端复制登录链接打开。链接 5 分钟内有效，只能使用一次；在终端按 <kbd>Enter</kbd> 可生成新链接。</> },
    "exchange-failed": { icon: "lock", title: "登录链接不可用", tone: "warn", body: <>{message || "登录链接无效、已使用或已过期。"}<br />在运行控制台的终端按 <kbd>Enter</kbd> 获取新链接。</> },
    expired: { icon: "clock", title: "登录已失效", tone: "warn", body: <>为保护会话内容，闲置 30 分钟或登录满 8 小时后需要重新登录。在运行控制台的终端按 <kbd>Enter</kbd> 获取新链接。</> },
    offline: { icon: "wifiOff", title: "无法连接控制台", tone: "danger", body: <>网络中断、SSH 端口转发断开，或控制台已经退出。恢复后点“重新连接”，登录仍有效时直接回到页面；控制台已退出时，重新运行 <code>bun run console</code> 并使用新的登录链接。</> },
    "logging-out": { icon: "loader", title: "正在退出", body: "正在请控制台撤销这次登录…" },
    "logged-out": { icon: "logout", title: "已退出登录", body: <>要再次进入，在运行控制台的终端按 <kbd>Enter</kbd> 获取新链接。</> },
    "logout-unconfirmed": { icon: "alert", title: "无法确认已退出", tone: "warn", body: <>{message ? `${message}。` : ""}控制台没有确认撤销这次登录，它可能仍然有效。恢复连接后点"重试退出"；也可以在运行控制台的终端按 <kbd>Ctrl+C</kbd> 关闭控制台，所有登录随即失效。</> },
    error: { icon: "alert", title: "控制台出错", tone: "danger", body: message || "请查看运行控制台的终端。" },
  };
  const screen = screens[gate as Exclude<Gate, "ready">];
  const busy = gate === "checking" || gate === "exchanging" || gate === "logging-out";
  return (
    <div class="gate">
      <div class="gate-card" role={busy ? "status" : "alert"}>
        <div class="gate-brand"><BrandMark size={32} /><span>量子密信应用机器人控制台</span></div>
        <div class={`gate-icon ${screen.tone ?? ""}`}><Icon name={screen.icon} size={22} class={busy ? "spin" : undefined} /></div>
        <h1>{screen.title}</h1>
        <p>{screen.body}</p>
        {gate === "logout-unconfirmed" && <div class="gate-actions"><button class="btn primary" onClick={onRetryLogout}>重试退出</button></div>}
        {gate === "offline" && <div class="gate-actions"><button class="btn primary" onClick={onReconnect}>重新连接</button></div>}
      </div>
      <p class="gate-foot"><Icon name="shield" size={14} />仅监听 127.0.0.1 · 登录链接一次有效 · 不保存聊天内容</p>
    </div>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Shell({ initial, onEnd, onLogout }: { initial: { view: SessionView; offset: number }; onEnd: (gate: Gate) => void; onLogout: () => void }) {
  const [session, setSession] = useState(initial);
  const [route, setRoute] = useState(() => routeFromHash(location.hash));
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resultsOnly, setResultsOnly] = useState(false);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  /** Bumped when a directory scope save has ended, so the directory page reads its status again. */
  const [directorySettled, setDirectorySettled] = useState(0);
  const replaced = useRef(false);
  const lastTouch = useRef(Date.now());
  const now = useNow(1_000);

  const serverNow = now + session.offset;
  const idleLeft = session.view.idleExpiresAt - serverNow;
  const absoluteLeft = session.view.expiresAt - serverNow;

  const adopt = useCallback((response: SessionResponse) => setSession({ view: response.session, offset: response.now - Date.now() }), []);

  const loadOverview = useCallback(async (intent: boolean) => {
    if (intent) setRefreshing(true);
    try {
      if (replaced.current) return;
      const runtime = await api<{ current: boolean }>("/api/runtime");
      if (runtime.current === false) {
        replaced.current = true; setResultsOnly(true); setOverview(null); resetExports(); return;
      }
      setRuntimeChecked(true);
      setOverview(await api<Overview>("/api/overview", { intent }));
      setOverviewError(null);
      if (intent) lastTouch.current = Date.now();
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 401 || error.code === "offline")) return;
      if (error instanceof ApiFailure && error.code === "version-changed") {
        replaced.current = true; setResultsOnly(true); setOverview(null); resetExports(); return;
      }
      setOverviewError((error as Error).message);
    } finally {
      if (intent) setRefreshing(false);
    }
  }, []);

  // Background polls: overview and session state; neither renews the idle timer.
  useEffect(() => {
    void loadOverview(false);
    const overviewTimer = setInterval(() => void loadOverview(false), OVERVIEW_POLL_MS);
    const sessionTimer = setInterval(() => { api<SessionResponse>("/api/session").then(adopt, () => {}); }, SESSION_POLL_MS);
    // Leaving the shell (logout, expiry, a lost console) forgets the exports it was following.
    return () => { clearInterval(overviewTimer); clearInterval(sessionTimer); resetExports(); resetTasks(); };
  }, []);

  // The session ends on the client clock too, so content disappears even if a poll never comes back.
  useEffect(() => { if (idleLeft <= 0 || absoluteLeft <= 0) onEnd("expired"); }, [idleLeft <= 0, absoluteLeft <= 0]);

  // Real user activity (keys, clicks, scrolling) renews the idle timer, throttled.
  useEffect(() => {
    const touch = () => {
      if (Date.now() - lastTouch.current < TOUCH_INTERVAL_MS) return;
      lastTouch.current = Date.now();
      api<SessionResponse>("/api/session/touch", { method: "POST", intent: true }).then(adopt, () => {});
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    return () => { for (const name of events) window.removeEventListener(name, touch); };
  }, []);

  useEffect(() => {
    const onHash = () => { setRoute(routeFromHash(location.hash)); setDrawer(false); };
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(open => !open); }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, []);

  const changeTheme = (value: Theme) => { applyTheme(value); setTheme(value); };

  const commands = useMemo<Command[]>(() => [
    ...NAV.filter(item => available(item) && (!resultsOnly || item.id === "maintain")).map(item => ({ id: `go-${item.id}`, label: `前往${item.label}`, hint: item.description, icon: item.icon,
      keywords: item.id, run: () => { location.hash = `#/${item.id}`; } })),
    { id: "refresh", label: "刷新数据", icon: "refresh", keywords: "reload refresh", run: () => void loadOverview(true) },
    ...(["system", "light", "dark"] as const).filter(value => value !== theme).map(value => ({
      id: `theme-${value}`, label: `外观：${themeLabel[value]}`, icon: (value === "dark" ? "moon" : value === "light" ? "sun" : "monitor") as IconName,
      keywords: "theme dark light 主题 深色 浅色", run: () => changeTheme(value) })),
    { id: "logout", label: "退出登录", icon: "logout", keywords: "logout sign out", run: onLogout },
  ], [theme, resultsOnly]);

  const current = NAV.find(item => item.id === route)!;
  const themeIcon: IconName = theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor";

  return (
    <div class={`layout${drawer ? " drawer-open" : ""}`}>
      <Sidebar route={resultsOnly ? "maintain" : route} overview={overview} resultsOnly={resultsOnly} onSearch={() => setPalette(true)} onClose={() => setDrawer(false)} />
      <div class="scrim" onClick={() => setDrawer(false)} />
      <div class="main">
        <header class="topbar">
          <button class="btn ghost icon-btn menu-btn" aria-label="打开导航" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          <nav class="crumbs" aria-label="位置">
            <span class="crumb-host">{overview?.console.hostname ?? "控制台"}</span>
            <Icon name="arrow" size={12} />
            <span class="crumb-page">{resultsOnly ? "任务结果" : current.label}</span>
          </nav>
          <div class="topbar-right">
            {resultsOnly ? <span class="pill neutral" title="代码已变化，控制台不再读取部署"><span class="dot" />只看任务结果</span>
              : <StatusPill service={overview?.service} loading={!overview} />}
            <span class={`session-chip${idleLeft < 5 * 60_000 ? " warn" : ""}`} title={`闲置 ${duration(idleLeft)}后失效；登录 ${duration(absoluteLeft)}后到期`}>
              <Icon name="clock" size={14} />{duration(Math.min(idleLeft, absoluteLeft))}
            </span>
            <button class="btn ghost icon-btn" aria-label={`外观：${themeLabel[theme]}，点击切换`} title={`外观：${themeLabel[theme]}`}
              onClick={() => changeTheme(nextTheme(theme))}><Icon name={themeIcon} /></button>
            <button class="btn ghost icon-btn" aria-label="退出登录" title="退出登录" onClick={onLogout}><Icon name="logout" /></button>
          </div>
        </header>
        <main class={`content${route === "conversations" ? " wide" : ""}`} id="content">
          {resultsOnly ? <><section class="card plain" role="status"><h1>代码已变化</h1><p>当前控制台只能查看任务结果。请退出当前控制台并重新运行 <code>bun run console</code>，再使用终端里的新链接登录。</p></section><TasksPage resultsOnly /></> : !runtimeChecked ? <section class="card plain" role="status"><p>{overviewError ?? "正在检查控制台版本…"}</p>{overviewError && <button class="btn" onClick={() => void loadOverview(true)}>重试</button>}</section> : <>
          {route === "overview" && <OverviewPage data={overview} error={overviewError} refreshing={refreshing}
            onRefresh={() => void loadOverview(true)} sessionLeft={Math.min(idleLeft, absoluteLeft)} />}
          {route === "conversations" && <ConversationsPage />}
          {route === "stats" && <StatsPage />}
          {route === "stats" && <StatsImportForm />}
          {route === "maintain" && <TasksPage />}
          {["health", "logs", "storage", "relay", "directory", "settings"].includes(route) && <ReadOnlyPage key={route} page={route}
            refresh={route === "directory" ? directorySettled : 0} />}
          {route === "storage" && <StorageActions />}
          {route === "relay" && <RelayActions />}
          {route === "directory" && <DirectoryForm onSettled={() => { setDirectorySettled(count => count + 1); void loadOverview(false); }} />}
          {route === "push" && <><PushRecords /><PushSettingsForm /><PushGroups /></>}
          {route === "settings" && <><ConfigurationRecovery /><ConfigurationSettings /><RuntimeForm /></>}
          </>}
        </main>
      </div>
      {!resultsOnly && <ExportTray />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}

function Sidebar({ route, overview, resultsOnly = false, onSearch, onClose }: { route: string; overview: Overview | null; resultsOnly?: boolean; onSearch: () => void; onClose: () => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, NavItem[]>();
    for (const item of NAV) map.set(item.group, [...map.get(item.group) ?? [], item]);
    return [...map];
  }, []);
  const deployment = overview?.deployment;
  return (
    <aside class="sidebar" aria-label="导航">
      <div class="brand">
        <BrandMark />
        <div class="brand-text"><div class="brand-name">量子密信应用机器人</div><div class="brand-sub">管理控制台</div></div>
        <button class="btn ghost icon-btn drawer-close" aria-label="关闭导航" onClick={onClose}><Icon name="arrow" /></button>
      </div>
      <button class="search-trigger" onClick={onSearch}>
        <Icon name="search" /><span>搜索或跳转…</span><kbd>Ctrl K</kbd>
      </button>
      <nav class="nav">
        {groups.map(([group, items]) => (
          <div class="nav-group" key={group || "top"}>
            {group && <div class="nav-group-label">{group}</div>}
            {items.filter(item => !resultsOnly || item.id === "maintain").map(item => available(item) ? (
              <a key={item.id} class="nav-item" href={`#/${item.id}`} aria-current={route === item.id ? "page" : undefined}>
                <Icon name={item.icon} /><span>{item.label}</span>
              </a>
            ) : (
              <span key={item.id} class="nav-item disabled" aria-disabled="true" title={`${item.description}（计划在 ${item.stage} 阶段提供）`}>
                <Icon name={item.icon} /><span>{item.label}</span><span class="nav-badge">规划中</span>
              </span>
            ))}
          </div>
        ))}
      </nav>
      <div class="sidebar-footer">
        <div class="host-card">
          <Icon name="server" />
          <div>
            <div class="host-name">{overview?.console.hostname ?? "—"}</div>
            <div class="host-sub">{resultsOnly ? "代码已变化，不再读取部署" : deployment ? `${platformName(deployment.platform)} · ${deployment.mode}` : "读取部署中…"}</div>
          </div>
        </div>
        {!resultsOnly && <div class="version-line">控制台 v{overview?.console.version ?? "—"}</div>}
      </div>
    </aside>
  );
}
