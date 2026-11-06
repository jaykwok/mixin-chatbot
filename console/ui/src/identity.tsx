/** @jsxImportSource preact */
// Identity modes in the page: the switch (complete numbers need a confirmation each time), how a member is shown, and
// how the name lookup went. The host decides what each mode reveals; the page only displays what it was sent.
import { useState } from "preact/hooks";
import type { Identity, IdentityMode, NamesStatus, NameState } from "./contract.ts";
import { clock } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Banner, Chip, Dialog, Segmented } from "./ui.tsx";

export const MODE_LABEL: Record<IdentityMode, string> = { default: "默认", full: "完整身份", anonymous: "匿名" };
const MODE_HINT: Record<IdentityMode, string> = {
  default: "通讯录姓名＋打码号码",
  full: "通讯录姓名＋完整号码；本次确认后生效，记入审计",
  anonymous: "不显示姓名和号码，成员只用本次编号",
};

/** Mirrors the host's IDENTITY_SCOPE_NOTE: what a mode does not touch. */
export const SCOPE_NOTE = "身份模式只作用于成员号码、姓名和成员编号等结构化字段；聊天正文、工具输出和附件文件名按原样显示，其中出现的姓名或号码不会被替换。";

const NAME_SHORT: Record<Exclude<NameState, "named">, string> = {
  missing: "通讯录未找到", summary: "摘要身份", offline: "机器人未运行", failed: "姓名查询失败",
};

/** Confirms complete numbers for one view or export. */
function FullConfirm({ what, onConfirm, onCancel }: { what: string; onConfirm: () => void; onCancel: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Dialog title="显示完整身份" icon="shield" onClose={onCancel}
      footer={<>
        <button type="button" class="btn" onClick={onCancel}>取消</button>
        <button type="button" class="btn primary" disabled={!checked} onClick={onConfirm}>确认并显示</button>
      </>}>
      <p>完整身份模式会在{what}中显示成员的<strong>完整手机号</strong>。这次开启会写入控制台审计记录（不记录号码本身）。</p>
      <p class="muted small dialog-gap">只对这一次{what}有效：切换空间、返回列表或重新登录后回到默认模式。</p>
      <label class="check dialog-gap">
        <input type="checkbox" checked={checked} onChange={event => setChecked((event.target as HTMLInputElement).checked)} />
        <span>我确认需要查看完整号码</span>
      </label>
    </Dialog>
  );
}

/** Default / full / anonymous. Choosing full asks first; `onChange` gets the confirmation with it. */
export function ModeSwitch({ mode, onChange, disabled, what = "查看" }: {
  mode: IdentityMode; onChange: (mode: IdentityMode, confirm: boolean) => void; disabled?: boolean; what?: string;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Segmented label="身份显示模式" size="small" value={mode} disabled={disabled}
        options={(["default", "full", "anonymous"] as const).map(value => ({ value, label: MODE_LABEL[value], title: MODE_HINT[value] }))}
        onChange={value => value === "full" ? setAsking(true) : onChange(value, false)} />
      {asking && <FullConfirm what={what} onCancel={() => setAsking(false)} onConfirm={() => { setAsking(false); onChange("full", true); }} />}
    </>
  );
}

/** The choice inside an export dialog: complete numbers need the checkbox in the same dialog. */
export function ModeChoice({ mode, confirmed, onChange }: {
  mode: IdentityMode; confirmed: boolean; onChange: (mode: IdentityMode, confirmed: boolean) => void;
}) {
  return (
    <div class="field">
      <span class="field-label">身份显示</span>
      <Segmented label="导出的身份显示模式" value={mode}
        options={(["default", "full", "anonymous"] as const).map(value => ({ value, label: MODE_LABEL[value], title: MODE_HINT[value] }))}
        onChange={value => onChange(value, false)} />
      <span class="field-hint">{MODE_HINT[mode]}</span>
      {mode === "full" && (
        <label class="check warn-box">
          <input type="checkbox" checked={confirmed} onChange={event => onChange("full", (event.target as HTMLInputElement).checked)} />
          <span>我确认导出完整号码；这次导出会写入控制台审计记录</span>
        </label>
      )}
      {mode === "anonymous" && <span class="field-hint">只替换身份字段，正文、工具输出和文件名里出现的姓名或号码不会被替换；文件不是匿名化数据。</span>}
    </div>
  );
}

export function ModeBadge({ mode }: { mode: IdentityMode }) {
  return <span class={`mode-badge ${mode}`} title={MODE_HINT[mode]}><Icon name={mode === "anonymous" ? "eye" : "shield"} size={12} />{MODE_LABEL[mode]}</span>;
}

/** Name and number as the mode sent them; a member without a name says why, without guessing. */
export function IdentityText({ identity, compact }: { identity: Identity; compact?: boolean }) {
  if (identity.phone === undefined) return <span class="id-code">{identity.label}</span>;
  return (
    <span class="identity">
      {identity.name !== undefined && <span class="id-name">{identity.name}</span>}
      <span class="id-phone">{identity.phone}</span>
      {identity.nameState && identity.nameState !== "named" && !compact && (
        <Chip title={identity.nameNote}>{NAME_SHORT[identity.nameState]}</Chip>
      )}
    </span>
  );
}

export function Avatar({ identity, size = 32 }: { identity: Identity | null; size?: number }) {
  const text = identity === null ? null : identity.name ? [...identity.name][0] : identity.phone === undefined ? identity.label.replace(/^成员\s*/, "").slice(0, 3) : null;
  return (
    <span class={`avatar${identity === null ? " bot" : ""}`} style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      {identity === null ? <Icon name="bot" size={size * 0.55} /> : text ?? <Icon name="user" size={size * 0.55} />}
    </span>
  );
}

/** How the batch name lookup went, when it did not fully succeed. */
export function NamesNotice({ names }: { names: NamesStatus }) {
  if (names.state === "ok" || names.state === "skipped") return null;
  const title = { partial: "部分姓名不可用", failed: "姓名查询失败", offline: "机器人未运行，姓名不可用" }[names.state];
  return (
    <Banner tone="warn" icon="users" title={title}>
      {names.state === "offline" ? "统计和成员列表照常显示，成员只显示号码。机器人运行后刷新即可查到姓名。"
        : "查不到姓名的成员只显示号码并注明状态，其余内容不受影响。"}
      {names.note && <> 原因：{names.note}</>}
    </Banner>
  );
}

/** "姓名读取于 …": names are the directory's at that time, not at the time of the conversation. */
export function NamesObserved({ names }: { names: NamesStatus }) {
  if (names.observedAt === undefined) return null;
  return <span class="muted small" title="姓名是读取时的通讯录姓名，不代表对话发生时的名字">姓名读取于 {clock(names.observedAt)}</span>;
}
