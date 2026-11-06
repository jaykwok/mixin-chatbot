/** @jsxImportSource preact */
// Building blocks shared by the pages: cards, banners, segmented controls, dialogs and empty states.
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon, type IconName } from "./icons.tsx";

export type Tone = "ok" | "warn" | "danger" | "neutral" | "info";

export function Card({ title, icon, children, span = 4, aside, class: className, flush }: {
  title: ComponentChildren; icon: IconName; children: ComponentChildren; span?: number; aside?: ComponentChildren; class?: string;
  /** The body has no padding (tables and lists that run edge to edge). */
  flush?: boolean;
}) {
  return (
    <section class={`card span-${span}${className ? ` ${className}` : ""}`}>
      <header class="card-header"><Icon name={icon} /><h2>{title}</h2>{aside && <div class="card-aside">{aside}</div>}</header>
      <div class={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Rows({ rows }: { rows: [string, ComponentChildren][] }) {
  return <dl class="kv">{rows.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{value}</dd></Fragment>)}</dl>;
}

export function Banner({ tone, icon, title, children, action }: {
  tone: Tone; icon: IconName; title: ComponentChildren; children?: ComponentChildren; action?: ComponentChildren;
}) {
  return (
    <div class={`banner ${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon} size={18} />
      <div class="banner-text"><strong>{title}</strong>{children && <div class="banner-body">{children}</div>}</div>
      {action && <div class="banner-action">{action}</div>}
    </div>
  );
}

export interface SegmentOption<T extends string> { value: T; label: ComponentChildren; title?: string; icon?: IconName }

/** A row of mutually exclusive buttons (radio semantics); arrow keys move the choice. */
export function Segmented<T extends string>({ label, options, value, onChange, disabled, size }: {
  label: string; options: SegmentOption<T>[]; value: T; onChange: (value: T) => void; disabled?: boolean; size?: "small";
}) {
  const move = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex(option => option.value === value);
    const next = options[(index + step + options.length) % options.length]!;
    onChange(next.value);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div class={`segmented${size ? ` ${size}` : ""}`} role="radiogroup" aria-label={label} onKeyDown={move}>
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} data-value={option.value}
          tabIndex={option.value === value ? 0 : -1} title={option.title} disabled={disabled}
          onClick={() => { if (option.value !== value) onChange(option.value); }}>
          {option.icon && <Icon name={option.icon} size={14} />}{option.label}
        </button>
      ))}
    </div>
  );
}

/** A modal dialog: Escape and the backdrop close it, focus moves in and returns to where it was. */
export function Dialog({ title, icon, onClose, children, footer, size }: {
  title: string; icon?: IconName; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; size?: "wide";
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button:not(.dialog-close)")?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab" || !box.current) return;
    // Keep Tab inside the dialog.
    const focusable = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex='0']")];
    if (!focusable.length) return;
    const first = focusable[0]!, last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div class="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={box} class={`dialog${size ? ` ${size}` : ""}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <header class="dialog-header">
          {icon && <span class="dialog-icon"><Icon name={icon} size={18} /></span>}
          <h2>{title}</h2>
          <button type="button" class="btn ghost icon-btn dialog-close" aria-label="关闭" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div class="dialog-body">{children}</div>
        {footer && <footer class="dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action, tone }: {
  icon: IconName; title: ComponentChildren; children?: ComponentChildren; action?: ComponentChildren; tone?: Tone;
}) {
  return (
    <div class={`empty-state${tone ? ` tone-${tone}` : ""}`}>
      <div class="empty-icon"><Icon name={icon} size={22} class={icon === "loader" ? "spin" : undefined} /></div>
      <div class="empty-title">{title}</div>
      {children && <div class="empty-body">{children}</div>}
      {action && <div class="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ label = "正在加载" }: { label?: string }) {
  return <span class="spinner" role="status"><Icon name="loader" size={14} class="spin" />{label}</span>;
}

/** A small labelled count or state, e.g. a delivery part. */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ComponentChildren; title?: string }) {
  return <span class={`chip ${tone}`} title={title}>{children}</span>;
}
