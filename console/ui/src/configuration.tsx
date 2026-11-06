/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { TaskAction } from "./tasks.tsx";

type Kind = "models" | "app" | "relay";
type Secret = { mode: "keep" | "set" | "clear"; value?: string };
type Model = { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: string[]; reasoning?: boolean;
  cost?: Record<string, number>; thinking?: string[] };
type Provider = { id: string; custom?: boolean; api?: string; baseUrl?: string; hasKey?: boolean; models: Model[] };
interface Form { kind: Kind; provider?: string; model?: string; thinking?: string; providers?: Provider[]; appId?: string; environment?: string; bound?: boolean;
  catalogModels?: (Model & { provider: string })[];
  hasSecret?: boolean; hasAccessKey?: boolean; hasToken?: boolean; enabled?: boolean; endpoint?: string; region?: string; bucket?: string; prefix?: string;
  forcePathStyle?: boolean; maxBytes?: number; expireHours?: number; cleanupGraceMinutes?: number }
interface Draft { id: string; revision: number; expiresAt: number; validated: boolean; summary: string[]; form: Form }
interface Catalog { providers: { id: string; name: string }[]; apis: string[]; models: (Model & { provider: string })[] }
type Patch = Record<string, unknown>;
const titles = { models: "模型配置", app: "应用机器人凭据", relay: "外链配置" };
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const retained = (has?: boolean, optional = false): Secret => ({ mode: has ? "keep" : optional ? "clear" : "set" });

function modelPatch(form: Form, providerId: string, catalog?: Catalog): Patch {
  const provider = form.providers?.find(value => value.id === providerId), model = provider?.models.find(value => value.id === form.model) ?? provider?.models[0];
  return { provider: providerId, mode: provider?.custom ? "custom" : "builtin", api: provider?.api ?? "openai-completions", baseUrl: provider?.baseUrl ?? "",
    key: retained(provider?.hasKey), model: provider?.custom ? model ?? { id: "", contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false }
      : (form.provider === providerId ? form.model : undefined) ?? catalog?.models.find(value => value.provider === providerId)?.id ?? "",
    thinking: form.thinking ?? "off" };
}
function initial(form: Form, catalog?: Catalog): Patch {
  if (form.kind === "models") return modelPatch(form, form.provider ?? form.providers?.[0]?.id ?? "", catalog);
  if (form.kind === "app") return { appId: form.appId ?? "", environment: form.environment ?? "production", secret: retained(form.hasSecret) };
  return { enabled: form.enabled ?? false, endpoint: form.endpoint ?? "", region: form.region ?? "", bucket: form.bucket ?? "", prefix: form.prefix ?? "",
    forcePathStyle: form.forcePathStyle ?? false, maxBytes: form.maxBytes, expireHours: form.expireHours, cleanupGraceMinutes: form.cleanupGraceMinutes,
    accessKey: retained(form.hasAccessKey), secret: retained(form.hasSecret), token: retained(form.hasToken, true) };
}
function SecretField({ label, value, optional, change }: { label: string; value: Secret; optional?: boolean; change: (value: Secret) => void }) {
  return <fieldset><legend>{label}</legend><select aria-label={`${label}处理方式`} value={value.mode} onChange={event => change({ mode: event.currentTarget.value as Secret["mode"] })}>
    <option value="keep">保留已设置的值</option><option value="set">填写新值</option>{optional && <option value="clear">清除（可选）</option>}</select>
    {value.mode === "set" && <input aria-label={label} type="password" autoComplete="new-password" value={value.value ?? ""} onInput={event => change({ mode: "set", value: event.currentTarget.value })} />}
    <small>原值不回显。改端点或账户时需要重新填写凭据。</small></fieldset>;
}

export function ConfigurationForm({ kind }: { kind: Kind }) {
  const [draft, setDraft] = useState<Draft | null>(null), [patch, setPatch] = useState<Patch>({}), [catalog, setCatalog] = useState<Catalog>(),
    [busy, setBusy] = useState(false), [error, setError] = useState(""), [valid, setValid] = useState(false), [network, setNetwork] = useState(false), [refresh, setRefresh] = useState(false);
  const current = useRef<string | null>(null), generation = useRef(0);
  const discard = (id: string) => api("/api/configuration/discard", { method: "POST", body: { id }, quiet: true }).catch(() => {});
  useEffect(() => () => { generation.current++; if (current.current) void discard(current.current); current.current = null; }, []);
  const change = (key: string, value: unknown) => { setPatch(previous => ({ ...previous, [key]: value })); setValid(false); };
  const open = async () => {
    const request = ++generation.current; setBusy(true); setError(""); setValid(false);
    try {
      if (current.current) { await discard(current.current); current.current = null; }
      const next = await api<Draft>("/api/configuration/open", { method: "POST", body: { kind }, intent: true });
      if (request !== generation.current) { void discard(next.id); return; }
      current.current = next.id; setDraft(next); setPatch(initial(next.form)); setNetwork(false); setRefresh(false);
      if (kind === "models") {
        const data = await api<Catalog>("/api/configuration/catalog", { intent: true, timeoutMs: 90_000 });
        if (request === generation.current) setCatalog(data);
      }
    } catch (error) { if (request === generation.current) setError(errorText(error)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const check = async () => {
    if (!draft || busy) return; const request = generation.current; setBusy(true); setError(""); setValid(false);
    try {
      const edited = await api<Draft>("/api/configuration/edit", { method: "POST", body: { id: draft.id, revision: draft.revision, patch }, intent: true });
      if (request !== generation.current) return;
      setDraft(edited); setPatch(initial(edited.form, catalog)); // clear new secret inputs after the private host draft took them
      const checked = await api<Draft>("/api/configuration/check", { method: "POST", body: { id: edited.id, revision: edited.revision, network, refresh }, intent: true, timeoutMs: 120_000 });
      if (request === generation.current) { setDraft(checked); setValid(checked.validated); }
    } catch (error) { if (request === generation.current) setError(errorText(error)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const close = () => { generation.current++; if (current.current) void discard(current.current); current.current = null; setDraft(null); setPatch({}); setBusy(false); setError(""); setValid(false); };
  const text = (key: string, label: string, number = false) => <label>{label}{number
    ? <input type="number" value={String(patch[key] ?? "")} onInput={event => change(key, Number(event.currentTarget.value))} />
    : <input type="text" value={String(patch[key] ?? "")} onInput={event => change(key, event.currentTarget.value)} />}</label>;
  const secret = (key: string, label: string, optional = false) => <SecretField label={label} optional={optional} value={(patch[key] as Secret) ?? retained(false, optional)} change={value => change(key, value)} />;
  const custom = patch.mode === "custom", model = typeof patch.model === "object" ? patch.model as Model : { id: String(patch.model ?? "") };
  const changeModel = (key: keyof Model, value: unknown) => change("model", { ...model, [key]: value });
  const models = [...new Map([...(catalog?.models ?? []), ...(draft?.form.catalogModels ?? [])].filter(value => value.provider === patch.provider).map(value => [value.id, value])).values()];
  const thinking = models.find(value => value.id === model.id)?.thinking ?? ["off", "minimal", "low", "medium", "high", "xhigh"];
  return <section class="card write-form"><h2>{titles[kind]}</h2><p>先编辑草稿并校验，再预览应用。取消或关闭页面不会修改正式配置。</p>
    <button class="btn" disabled={busy} onClick={() => void open()}>{draft ? "放弃并重新读取" : "编辑配置"}</button>
    {error && <p role="alert">{error}</p>}
    {draft && <><fieldset disabled={busy}><legend>配置草稿</legend>
      {kind === "app" && <>{text("appId", "应用 AppID")}<label>环境<select value={String(patch.environment)} onChange={event => change("environment", event.currentTarget.value)}><option value="production">生产环境</option><option value="staging">预发布环境</option></select></label>{secret("secret", "应用密钥")}
        {draft.form.bound && <p>现有数据已绑定应用；这里只能修改同一应用的凭据。切换应用请全新部署。</p>}</>}
      {kind === "relay" && <><label class="check-label"><input type="checkbox" checked={!!patch.enabled} onChange={event => change("enabled", event.currentTarget.checked)} />启用外链</label>
        {!!patch.enabled && <>{text("endpoint", "S3 端点")}{text("region", "区域")}{text("bucket", "存储桶")}{text("prefix", "路径前缀（可为空）")}
          <label class="check-label"><input type="checkbox" checked={!!patch.forcePathStyle} onChange={event => change("forcePathStyle", event.currentTarget.checked)} />使用路径式寻址</label>
          {text("maxBytes", "文件上限（字节）", true)}{text("expireHours", "链接有效期（小时）", true)}{text("cleanupGraceMinutes", "清理宽限（分钟）", true)}
          {secret("accessKey", "访问密钥 ID")}{secret("secret", "访问密钥")}{secret("token", "临时会话令牌", true)}</>}</>}
      {kind === "models" && <><label>服务商 ID<input list={`providers-${draft.id}`} value={String(patch.provider ?? "")} onInput={event => { setPatch(modelPatch(draft.form, event.currentTarget.value, catalog)); setValid(false); }} /></label>
        <datalist id={`providers-${draft.id}`}>{[...new Set([...(draft.form.providers ?? []).map(value => value.id), ...(catalog?.providers ?? []).map(value => value.id)])].map(id => <option value={id} />)}</datalist>
        <label>模型来源<select value={String(patch.mode)} onChange={event => { change("mode", event.currentTarget.value); change("model", event.currentTarget.value === "custom" ? { id: model.id, contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: false } : model.id); }}><option value="builtin">内置服务商目录</option><option value="custom">自定义模型</option></select></label>
        {custom && <><p>更改已有服务商的端点或协议，请使用新的服务商 ID。</p>{text("baseUrl", "API 端点")}<label>协议<select value={String(patch.api)} onChange={event => change("api", event.currentTarget.value)}>{(catalog?.apis ?? ["openai-completions"]).map(api => <option value={api}>{api}</option>)}</select></label></>}
        {secret("key", "模型 API 密钥")}
        {custom ? <><label>模型 ID<input value={model.id} onInput={event => changeModel("id", event.currentTarget.value)} /></label>
          <label>显示名称<input value={model.name ?? ""} onInput={event => changeModel("name", event.currentTarget.value)} /></label>
          <label>上下文上限<input type="number" min="1" value={model.contextWindow} onInput={event => changeModel("contextWindow", Number(event.currentTarget.value))} /></label>
          <label>输出上限<input type="number" min="1" value={model.maxTokens} onInput={event => changeModel("maxTokens", Number(event.currentTarget.value))} /></label>
          <label class="check-label"><input type="checkbox" checked={model.reasoning ?? false} onChange={event => changeModel("reasoning", event.currentTarget.checked)} />支持推理</label>
          <label class="check-label"><input type="checkbox" checked={model.input?.includes("image") ?? false} onChange={event => changeModel("input", event.currentTarget.checked ? ["text", "image"] : ["text"])} />支持图片输入</label>
          <fieldset><legend>每百万 token 单价</legend>{[["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"]].map(([key, label]) => <label>{label}<input type="number" min="0" step="any" value={model.cost?.[key!] ?? 0} onInput={event => changeModel("cost", { ...model.cost, [key!]: Number(event.currentTarget.value) })} /></label>)}</fieldset></>
          : <label>模型<select value={model.id} onChange={event => change("model", event.currentTarget.value)}><option value="">请选择模型</option>{model.id && !models.some(value => value.id === model.id) && <option value={model.id}>{model.id}</option>}{models.map(value => <option value={value.id}>{value.name ?? value.id}（{value.contextWindow} / {value.maxTokens}）</option>)}</select></label>}
        <label>推理级别<select value={String(patch.thinking)} onChange={event => change("thinking", event.currentTarget.value)}>{[...new Set([String(patch.thinking), ...thinking])].map(value => <option value={value}>{value}</option>)}</select></label></>}
      {kind !== "relay" && <label class="check-label"><input type="checkbox" checked={network} onChange={event => { setNetwork(event.currentTarget.checked); if (!event.currentTarget.checked) setRefresh(false); setValid(false); }} />{kind === "app" ? "联网验证应用凭据（仅获取 token）" : "允许刷新所选服务商的模型目录（不发起推理）"}</label>}
      {kind === "models" && network && <label class="check-label"><input type="checkbox" checked={refresh} onChange={event => { setRefresh(event.currentTarget.checked); setValid(false); }} />本次刷新模型目录</label>}
      <button class="btn" onClick={() => void check()}>{busy ? "正在校验…" : "保存草稿并校验"}</button>
    </fieldset><button class="btn" onClick={close}>取消草稿</button>
      {valid && <><ul>{draft.summary.map(line => <li>{line}</li>)}</ul><TaskAction key={`${draft.id}-${draft.revision}`} operation="configuration-apply" params={{ draft: draft.id }} onStarted={() => { current.current = null; setDraft(null); setPatch({}); }}>预览应用配置</TaskAction></>}
    </>}
  </section>;
}

export function ConfigurationSettings() { return <>{(["models", "app", "relay"] as const).map(kind => <ConfigurationForm key={kind} kind={kind} />)}</>; }

export function ConfigurationRecovery() {
  type RecoveryState = { transaction: { id: string; phase: string; kind: Kind | "runtime" } | null; maintenancePending: boolean };
  const [state, setState] = useState<RecoveryState | null>(null), [error, setError] = useState(""), [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<RecoveryState>("/api/configuration/state", { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setState(value); setError(""); }
    }, error => { if (!controller.signal.aborted) { setState(null); setError(errorText(error)); } });
    return () => controller.abort();
  }, [version]);
  const transaction = state?.transaction;
  return <section class="card plain"><h2>配置恢复</h2><button class="btn" onClick={() => setVersion(value => value + 1)}>检查配置事务</button>
    {error && <p role="alert">{error}</p>}{!error && state && <>
      {transaction && <p>{transaction.kind === "runtime" ? "高级运行参数" : titles[transaction.kind]}留下了待处理记录。</p>}
      {state.maintenancePending ? <><p>上次维护尚未收尾。如任务仍在运行，请等待完成；中断后从这里恢复。</p>
        <TaskAction operation="maintenance-recover" params={{}} onStarted={() => setState(null)}>预览恢复中断的维护</TaskAction></>
        : transaction ? <TaskAction operation="configuration-restore" params={{ draft: transaction.id }} onStarted={() => setState(null)}>
          {["committed", "rolled-back"].includes(transaction.phase) ? "预览完成配置收尾" : "预览恢复原配置"}</TaskAction>
          : <p>没有未结束的配置事务。</p>}
    </>}</section>;
}
