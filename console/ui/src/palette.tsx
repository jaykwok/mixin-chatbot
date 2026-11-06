/** @jsxImportSource preact */
// Ctrl+K / ⌘K command palette: jump to a section or run a console action.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.tsx";

export interface Command { id: string; label: string; hint?: string; icon: IconName; keywords?: string; run: () => void }

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter(command => {
      const text = `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase();
      return words.every(word => text.includes(word));
    });
  }, [commands, query]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setIndex(value => Math.min(value + 1, matches.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setIndex(value => Math.max(value - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(matches[index]); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };

  return (
    <div class="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="palette-search">
          <Icon name="search" size={18} />
          <input ref={input} value={query} placeholder="搜索页面或操作…" aria-label="搜索页面或操作"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={matches[index] ? `palette-${matches[index]!.id}` : undefined}
            onInput={event => setQuery((event.target as HTMLInputElement).value)} onKeyDown={onKeyDown} />
          <kbd>Esc</kbd>
        </div>
        <div class="palette-list" id="palette-list" role="listbox" ref={list}>
          {matches.length === 0 && <div class="palette-empty">没有匹配的页面或操作</div>}
          {matches.map((command, position) => (
            <div key={command.id} id={`palette-${command.id}`} data-index={position} role="option" aria-selected={position === index}
              class="palette-item" onMouseMove={() => setIndex(position)} onClick={() => choose(command)}>
              <Icon name={command.icon} />
              <span class="palette-label">{command.label}</span>
              {command.hint && <span class="palette-hint">{command.hint}</span>}
              {position === index && <Icon name="enter" size={14} class="palette-enter" />}
            </div>
          ))}
        </div>
        <div class="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
