// 替换缓冲区、原始输入和差量重绘。按键序列由 Node readline 处理，支持分块到达的方向键。
import { emitKeypressEvents, type Key as ReadlineKey } from "node:readline";
import { truncate } from "./width.ts";
import { drainMaintenance } from "../exec.ts";

const CSI = "\u001b[";
const ALT_ON = CSI + "?1049h";
const ALT_OFF = CSI + "?1049l";
const CURSOR_HIDE = CSI + "?25l";
const CURSOR_SHOW = CSI + "?25h";
const CLEAR_ALL = CSI + "2J" + CSI + "H";

export interface Key {
  name: string;
  ctrl: boolean;
  shift: boolean;
  raw: string;
  /** 可输入的文字；功能键为空。 */
  text?: string;
}

export const MIN_COLUMNS = 72;
export const MIN_ROWS = 20;

/** 保留输入大小写和 Unicode；过滤未识别的控制序列。 */
export function listenKeys(input: NodeJS.ReadableStream, onKey: (key: Key) => void): () => void {
  emitKeypressEvents(input);
  const handle = (text: string | undefined, key: ReadlineKey = {}): void => {
    // readline 把独立 Esc 也标为 meta；它仍是界面里的取消键。
    if (key.meta && key.name !== "escape") return;
    const printable = text && !/[\u0000-\u001f\u007f-\u009f]/.test(text) ? text : "";
    const name = key.name === "return" ? "enter" : printable === " " ? "space" : printable || key.name;
    if (!name) return;
    onKey({ name, ctrl: !!key.ctrl, shift: !!key.shift, raw: key.sequence ?? text ?? "", text: key.ctrl ? "" : printable });
  };
  input.on("keypress", handle);
  return () => { input.off("keypress", handle); };
}

export interface Size { columns: number; rows: number; }

export class Screen {
  private previous: string[] = [];
  private active = false;
  private restore: (() => void) | null = null;
  private detachKeys: (() => void) | null = null;
  private attachKeys: (() => void) | null = null;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly input: NodeJS.ReadStream = process.stdin
  ) {}

  get size(): Size { return { columns: this.out.columns ?? 80, rows: this.out.rows ?? 24 }; }
  get isActive(): boolean { return this.active; }

  start(onKey: (key: Key) => void, onResize: () => void): void {
    if (this.restore) return;
    const input = this.input;
    let exiting = false;
    if (!input.isTTY) throw new Error("需要交互式终端（stdin 不是 TTY）");

    this.attachKeys = () => { this.detachKeys = listenKeys(input, onKey); };
    const handleResize = (): void => { this.previous = []; onResize(); };
    const restore = (): void => {
      if (!this.restore) return;
      this.restore = null;
      this.active = false;
      this.detachKeys?.();
      this.detachKeys = null;
      this.out.off("resize", handleResize);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      this.out.write(CSI + "0m" + CURSOR_SHOW + ALT_OFF);
      process.off("exit", restore);
      if (!exiting) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.off("SIGHUP", onSignal);
        process.off("uncaughtException", onFatal);
      }
    };
    const onSignal = (): void => { if (exiting) return; exiting = true; restore(); void drainMaintenance().then(() => process.exit(130)); };
    const onFatal = (error: unknown): void => { if (exiting) return; exiting = true; restore(); console.error(error); void drainMaintenance().then(() => process.exit(1)); };
    this.restore = restore;
    process.on("exit", restore);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    process.on("uncaughtException", onFatal);
    this.out.on("resize", handleResize);
    try {
      this.out.write(ALT_ON + CURSOR_HIDE + CLEAR_ALL);
      input.setRawMode(true);
      this.attachKeys();
      this.active = true;
      input.resume();
    } catch (error) { restore(); throw error; }
  }

  stop(): void { this.restore?.(); }

  /** 交接期间停止读键和绘制，成功或异常退出都恢复同一套输入监听。 */
  async suspend<T>(run: () => Promise<T>): Promise<T> {
    const wasActive = this.active;
    if (wasActive) {
      this.active = false;
      this.detachKeys?.();
      this.detachKeys = null;
      this.input.pause();
      this.input.setRawMode(false);
      this.out.write(CSI + "0m" + CURSOR_SHOW + ALT_OFF);
    }
    try { return await run(); }
    finally {
      if (wasActive && this.restore) {
        this.out.write(ALT_ON + CURSOR_HIDE + CLEAR_ALL);
        this.input.setRawMode(true);
        this.attachKeys?.();
        this.active = true;
        this.previous = [];
        this.input.resume();
      }
    }
  }

  render(lines: string[]): void {
    if (!this.active) return;
    const { rows, columns } = this.size;
    const frame = lines.slice(0, rows).map(line => truncate(line, columns, ""));
    const chunks: string[] = [];
    for (let row = 0; row < Math.max(frame.length, this.previous.length); row++) {
      const next = frame[row] ?? "";
      if (next !== this.previous[row]) chunks.push(CSI + (row + 1) + ";1H" + CSI + "2K" + next + CSI + "0m");
    }
    if (chunks.length) this.out.write(chunks.join(""));
    this.previous = frame;
  }
}
