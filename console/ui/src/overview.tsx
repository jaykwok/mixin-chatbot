/** @jsxImportSource preact */
// Home page: what is deployed here, whether the bot answers, and what needs attention.
import type { Overview, ServiceView } from "./contract.ts";
import { ago, clock, dateTime, duration, platformName } from "./format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Banner, Card, Rows, type Tone } from "./ui.tsx";

export function serviceSummary(service: ServiceView): { tone: Tone; label: string; icon: IconName } {
  switch (service.state) {
    case "ready": return service.stream?.connected === false ? { tone: "warn", label: "运行中 · Stream 已断开", icon: "alert" } : { tone: "ok", label: "运行中", icon: "check" };
    case "verifying": return { tone: "warn", label: "验证实例", icon: "shield" };
    case "stopping": return { tone: "warn", label: "正在停止", icon: "power" };
    case "unreachable": return { tone: "danger", label: "未运行", icon: "power" };
  }
}

/** The directory card's pill for the saved scope's state (a sync in progress shows its own). */
const SCOPE_STATES: Record<NonNullable<ServiceView["directory"]>["state"], [Tone, string]> = {
  effective: ["ok", "已生效"], applying: ["warn", "应用中"], failed: ["danger", "应用失败"], unset: ["danger", "未设置"],
};

export function StatusPill({ service, loading }: { service: ServiceView | undefined; loading: boolean }) {
  if (!service) return <span class="pill neutral"><span class="dot" />{loading ? "正在检查" : "状态未知"}</span>;
  const summary = serviceSummary(service);
  return <span class={`pill ${summary.tone}`} title="机器人状态"><span class={`dot${service.state === "ready" ? " pulse" : ""}`} />机器人{summary.label}</span>;
}

function Hero({ data }: { data: Overview }) {
  const { service } = data;
  const summary = serviceSummary(service);
  const now = data.checkedAt;
  const title = { ready: "机器人运行中", verifying: "验证实例运行中", stopping: "机器人正在停止", unreachable: "机器人未运行" }[service.state];
  // Ready only means the process answers: messages arrive over the event Stream.
  const offline = service.state === "ready" && service.stream?.connected === false;
  const detail = offline ? "进程有应答，但事件 Stream 已断开，暂时收不到群聊和单聊消息；断开原因见下方“事件 Stream”。"
    : service.state === "ready" ? "正在接收并处理群聊和单聊消息。"
    : service.state === "verifying" ? "这是不连接平台的验证实例，不处理群消息。"
    : service.state === "stopping" ? "停止后不再处理消息。"
    : data.deployment ? "没有应答，群里的消息不会被处理。可在“维护”页启动或重启。"
    : "尚未读取到部署信息。";
  const attention = service.attention.filter(event => event.recent).length;
  return (
    <section class={`card span-12 hero tone-${summary.tone}`}>
      <div class="hero-main">
        <div class="hero-icon"><Icon name={summary.icon} size={24} /></div>
        <div class="hero-text">
          <h2 class="hero-title">{title}</h2>
          <p class="hero-detail">{detail}</p>
          {service.state !== "unreachable" && (
            <div class="hero-meta">
              {service.startedAt !== undefined && <span><Icon name="clock" size={14} />已运行 {duration(now - service.startedAt)}</span>}
              {service.pid !== undefined && <span class="mono">PID {service.pid}</span>}
              {service.latency !== undefined && <span>响应 {service.latency} ms</span>}
            </div>
          )}
        </div>
      </div>
      <div class="hero-stats">
        <Stat label="事件 Stream" value={service.stream ? (service.stream.connected ? "已连接" : "已断开") : "—"}
          tone={service.stream ? (service.stream.connected ? "ok" : "danger") : "neutral"} />
        <Stat label="通讯录映射" value={service.directory ? service.directory.mappings.toLocaleString("zh-CN") : "—"} />
        <Stat label="待留意" value={service.state === "ready" ? String(attention) : "—"} tone={attention > 0 ? "warn" : "neutral"} />
      </div>
    </section>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return <div class={`stat tone-${tone}`}><div class="stat-value">{value}</div><div class="stat-label">{label}</div></div>;
}

export function OverviewPage({ data, error, refreshing, onRefresh, sessionLeft }: {
  data: Overview | null; error: string | null; refreshing: boolean; onRefresh: () => void; sessionLeft: number;
}) {
  return (
    <>
      <div class="page-header">
        <div>
          <h1 class="page-title">总览</h1>
          <p class="page-desc">{data ? <>主机 <strong>{data.console.hostname}</strong> 上的部署状态，每 15 秒自动刷新</> : "正在读取部署状态…"}</p>
        </div>
        <button class="btn" onClick={onRefresh} disabled={refreshing}>
          <Icon name="refresh" class={refreshing ? "spin" : undefined} />刷新
        </button>
      </div>

      {error && <Banner tone="danger" icon="alert" title="刷新失败">{error}{data && "（下面是上一次读取的结果）"}</Banner>}
      {!data && !error && <Skeleton />}
      {data && <OverviewBody data={data} sessionLeft={sessionLeft} />}
    </>
  );
}

function OverviewBody({ data, sessionLeft }: { data: Overview; sessionLeft: number }) {
  const { deployment, service } = data;
  const attention = service.attention;
  const stream = service.stream, directory = service.directory;
  return (
    <>
      {data.recovery && (
        <Banner tone="danger" icon="alert" title="需要先处理部署">
          {data.recovery}。到“维护”页的“部署恢复”继续或回滚上次操作，或重新部署；记录无法读取时，在终端运行 <code>ops doctor</code>（scripts 下的 ops.ps1 或 ops.sh）按提示处理。
        </Banner>
      )}
      {!data.recovery && data.pending && (
        <Banner tone="warn" icon="alert" title={data.pending.subject}>
          <ul class="plain-list">{data.pending.record.map(line => <li key={line}>{line}</li>)}</ul>
        </Banner>
      )}
      {data.deploymentError && <Banner tone="danger" icon="alert" title="无法读取部署设置">{data.deploymentError}</Banner>}

      <div class="grid">
        <Hero data={data} />

        <Card title="部署" icon="server" span={6}>
          {deployment ? (
            <Rows rows={[
              ["运行方式", `${platformName(deployment.platform)} · ${deployment.mode}`],
              ["主机", data.console.hostname],
              ["管理端口", <span class="mono">127.0.0.1:{deployment.port}</span>],
              ["数据目录", <span class="mono path">{deployment.dataRoot}</span>],
              ["共享资料", <span class="mono path">{deployment.workspaceRoot || "data/workspace（默认）"}</span>],
            ]} />
          ) : <p class="muted">没有可用的部署设置。</p>}
        </Card>

        <Card title="版本" icon="tag" span={6}>
          <Rows rows={[
            ...data.versions.map(([key, value]): [string, string] => [key, value]),
            ["控制台", `v${data.console.version}${data.console.build ? ` · ${data.console.build.slice(0, 7)}${data.console.build.endsWith("-dirty") ? "-dirty" : ""}` : ""}`],
          ]} />
        </Card>

        <Card title="事件 Stream" icon="radio" aside={stream && <span class={`pill small ${stream.connected ? "ok" : "danger"}`}><span class="dot" />{stream.connected ? "已连接" : "已断开"}</span>}>
          {stream ? (
            <Rows rows={[
              ["重连次数", String(stream.reconnects)],
              ...(stream.disconnectedSince !== undefined ? [["断开于", ago(stream.disconnectedSince, data.checkedAt)] as [string, string]] : []),
              ...(stream.lastDisconnectReason ? [["最近断开", stream.lastDisconnectReason] as [string, string]] : []),
            ]} />
          ) : <p class="muted">{service.state === "ready" ? "此实例没有事件 Stream。" : "机器人运行时显示。"}</p>}
        </Card>

        <Card title="通讯录" icon="users" aside={directory && (directory.running
          ? <span class="pill small warn"><Icon name="loader" size={12} class="spin" />同步中</span>
          : <span class={`pill small ${SCOPE_STATES[directory.state][0]}`}><span class="dot" />{SCOPE_STATES[directory.state][1]}</span>)}>
          {directory ? (
            <Rows rows={[
              ["映射", `${directory.mappings.toLocaleString("zh-CN")} 名成员`],
              ["同步范围", directory.scope],
              ["范围状态", directory.stateText],
              ["完整同步", directory.lastCompleteAt !== undefined ? ago(directory.lastCompleteAt, data.checkedAt) : "还没有"],
              ...(directory.running ? [["当前阶段", directory.running] as [string, string]] : []),
              ...(directory.failure ? [["上一轮没有完成", directory.failure] as [string, string]] : []),
              ...(directory.recheck ? [["大批缺席", directory.recheck] as [string, string]] : []),
            ]} />
          ) : <p class="muted">机器人运行时显示。</p>}
        </Card>

        <Card title="控制台" icon="terminal">
          <Rows rows={[
            ["地址", <span class="mono">127.0.0.1:{data.console.port}</span>],
            ["启动于", dateTime(data.console.startedAt)],
            ["进程", <span class="mono">PID {data.console.pid}</span>],
            ["登录", sessionLeft > 0 ? `闲置 ${duration(sessionLeft)}后失效` : "已失效"],
          ]} />
          <p class="card-note">在运行控制台的终端按 Ctrl+C 退出，端口随即关闭。</p>
        </Card>

        <Card title="待留意事件" icon="alert" span={12} aside={<span class="muted small">自机器人本次启动以来</span>}>
          {attention.length === 0 ? (
            <div class="empty-inline"><Icon name="check" />{service.state === "ready" ? "没有需要留意的事件。" : "机器人运行时显示。"}</div>
          ) : (
            <ul class="event-list">
              {attention.map(event => (
                <li key={event.kind} class={event.recent ? (event.kind === "interrupted" || event.kind === "faulted" ? "danger" : "warn") : "old"}>
                  <span class="dot" />{event.text}{!event.recent && <span class="muted small">（一天以前）</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p class="footnote">数据读取于 {clock(data.checkedAt)}</p>
    </>
  );
}

function Skeleton() {
  return (
    <div class="grid" aria-busy="true" aria-label="正在加载">
      <section class="card span-12 skeleton-card"><div class="skeleton w40" /><div class="skeleton w70" /></section>
      {[6, 6, 4, 4, 4].map((span, index) => (
        <section key={index} class={`card span-${span} skeleton-card`}><div class="skeleton w30" /><div class="skeleton w80" /><div class="skeleton w60" /></section>
      ))}
    </div>
  );
}
