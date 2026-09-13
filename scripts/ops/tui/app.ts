// 应用壳层：导航、确认框、输入框、子进程执行面板、重绘调度。
//
// 九个页面共用这里的确认与执行通道，是为了让「危险操作必须先说清后果」成为结构上做不到
// 绕过的事，而不是每个页面自己记得去做。

import { Screen, type Key, MIN_COLUMNS, MIN_ROWS } from "./render/screen.ts";
import { createTheme, STATUS, type StatusName, type Theme } from "./render/theme.ts";
import { box, wrap } from "./render/widgets.ts";
import { pad, width } from "./render/width.ts";
import { Viewport } from "./render/viewport.ts";
import { createInterface } from "node:readline";
import * as fmt from "./render/format.ts";
import { footer, header, navbar } from "./frame.ts";
import { loadGit, probeService, type GitState, type Service } from "./data.ts";
import { PROJECT_DIR, loadDeployment, opsCommand, type Deployment } from "./platform.ts";
import { openLocalFile, stream, trackMaintenance } from "./exec.ts";
import type { AppApi, ConfirmSpec, View, ViewContext } from "./view.ts";

/** 转圈动画，只在操作进行时显示。 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const TOAST_MS = 6000;

interface Modal {
  kind: "confirm" | "ask" | "help";
  spec?: ConfirmSpec;
  label?: string;
  /** typeToConfirm 或 ask 的当前输入。 */
  input: string;
  /** confirm 时选中的按钮：0 取消，1 确认。 */
  choice: number;
  scroll: Viewport;
  resolve: (value: unknown) => void;
}

interface ActionPane {
  title: string;
  lines: string[];
  frame: number;
  done: boolean;
  code: number | null;
  cancel: () => void;
  startedAt: number;
  scroll: Viewport;
}

export class App implements AppApi {
  readonly theme: Theme;
  deployment: Deployment;
  private readonly screen: Screen;
  private readonly readDeployment: () => Deployment;
  private readonly views: View[];
  private active: string;
  private toastState: { status: StatusName; text: string; at: number } | null = null;
  private modal: Modal | null = null;
  private action: ActionPane | null = null;
  private service: Service | null = null;
  private git: GitState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private quit = false;
  private dirty = true;
  private paintQueued = false;
  private viewBusy = false;

  constructor(views: View[], options: { screen?: Screen; deployment?: Deployment; theme?: Theme } = {}) {
    this.readDeployment = options.deployment ? () => options.deployment! : loadDeployment;
    this.deployment = this.readDeployment();
    this.theme = options.theme ?? createTheme();
    this.screen = options.screen ?? new Screen();
    this.views = views;
    this.active = views[0]!.id;
  }

  // ===== 生命周期 =====

  async start(): Promise<void> {
    this.screen.start(
      (key) => void this.handleKey(key).catch(error => this.toast("danger", String(error))),
      () => this.redraw()
    );
    // 每秒一拍：转圈动画、运行时长、提示条过期都靠它，不需要各自计时器。
    this.timer = setInterval(() => {
      if (this.action && !this.action.done) this.action.frame++;
      if (this.toastState && Date.now() - this.toastState.at > TOAST_MS) this.toastState = null;
      if (this.action || this.toastState || this.service?.startedAt) this.redraw();
      this.paint();
    }, 1000);

    this.paint();
    try {
      await Promise.all([this.refreshChrome(), this.current.refresh?.(this)]);
      this.redraw();
      while (!this.quit) await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      this.current.onLeave?.();
      if (this.timer) clearInterval(this.timer);
      this.screen.stop();
    }
  }

  private get current(): View {
    return this.views.find((view) => view.id === this.active) ?? this.views[0]!;
  }

  /** 页眉要的那几样：服务是否在应答、代码版本。两者都可能慢，所以并行。 */
  private async refreshChrome(): Promise<void> {
    this.deployment = this.readDeployment();
    const [service, git] = await Promise.all([probeService(this.deployment.port), loadGit()]);
    this.service = service;
    this.git = git;
    this.redraw();
  }

  // ===== AppApi =====

  toast(status: StatusName, text: string): void {
    this.toastState = { status, text, at: Date.now() };
    this.redraw();
    this.paint();
  }

  redraw(): void {
    this.dirty = true;
    if (!this.paintQueued) {
      this.paintQueued = true;
      setImmediate(() => { this.paintQueued = false; this.paint(); });
    }
  }

  go(view: string): void {
    if (!this.views.some((entry) => entry.id === view)) return;
    if (view !== this.active) this.current.onLeave?.();
    this.active = view;
    this.redraw();
    void this.current.refresh?.(this).catch(error => this.toast("danger", String(error)));
  }

  /**
   * 把终端整个交给子进程。
   *
   * 退出替换缓冲区、恢复回显，子进程继承 stdio，于是它自己的提示、颜色和读键盘都照常工作。
   * 结束后停一下等一次回车，否则最后几行输出会被回到全屏的那一刻擦掉——跑完升级却没看清
   * 它说了什么，比多按一次回车糟糕得多。
   */
  async runInteractive(title: string, args: string[]): Promise<number> {
    const { command, args: full } = opsCommand(this.deployment.platform, args);
    let code = 1;
    await this.screen.suspend(async () => {
      process.stdout.write(`\n== ${title} ==\n\n`);
      const child = Bun.spawn([command, ...full], {
        cwd: PROJECT_DIR,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      code = await trackMaintenance(child.exited);
      process.stdout.write(`\n== ${title} 结束（退出码 ${code}）==\n按回车回到运维界面…`);
      const input = createInterface({ input: process.stdin, terminal: false });
      try {
        await new Promise<void>(resolve => { input.once("line", () => resolve()); input.once("close", () => resolve()); });
      } finally { input.close(); process.stdin.pause(); }
    });
    await this.refreshChrome();
    await this.current.refresh?.(this);
    this.redraw();
    this.paint();
    return code;
  }

  async openFile(path: string): Promise<void> {
    try {
      await openLocalFile(path, this.deployment.platform);
      this.toast("ok", "已请求打开报表");
    } catch (error) { this.toast("warn", String(error instanceof Error ? error.message : error)); }
  }

  confirm(spec: ConfirmSpec): Promise<boolean> {
    return new Promise((resolve) => {
      this.modal = {
        kind: "confirm",
        spec,
        input: "",
        choice: spec.danger ? 0 : 1,
        scroll: new Viewport(),
        resolve: resolve as (value: unknown) => void,
      };
      this.redraw();
      this.paint();
    });
  }

  ask(label: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      this.modal = {
        kind: "ask",
        label,
        input: initial,
        choice: 1,
        scroll: new Viewport(),
        resolve: resolve as (value: unknown) => void,
      };
      this.redraw();
      this.paint();
    });
  }

  /**
   * 跑一条运维命令并实时显示输出。
   *
   * 完整输出保留到面板关闭，可滚动检查；升级构建仍直接使用终端。
   */
  async run(title: string, args: string[]): Promise<number> {
    const { command, args: full } = opsCommand(this.deployment.platform, args);
    const pane: ActionPane = {
      title,
      lines: [],
      frame: 0,
      done: false,
      code: null,
      cancel: () => {},
      startedAt: Date.now(),
      scroll: new Viewport(true),
    };
    this.action = pane;
    this.redraw();
    this.paint();

    let code = 1;
    try {
      const handle = stream(command, full, (line) => {
        pane.lines.push(line);
        this.redraw();
      }, { cancelMode: ["logs", "relay-ls", "history-ls", "tmp-ls", "stat", "doctor", "status"].includes(args[0] ?? "") &&
        !args.includes("-Repair") && !args.includes("-RestartTunnel") ? "terminate" : "finish" });
      pane.cancel = handle.cancel;
      code = await handle.done;
    } catch (error) {
      pane.lines.push(`执行失败：${String(error instanceof Error ? error.message : error)}`);
    }
    pane.done = true;
    pane.code = code;
    this.redraw();
    this.paint();

    // 命令跑完后状态多半变了：重新探一次服务和版本，页眉不要停留在旧结论上。
    await this.refreshChrome();
    await this.current.refresh?.(this);
    this.paint();
    return code;
  }

  // ===== 按键 =====

  private async handleKey(key: Key): Promise<void> {
    if (!this.screen.isActive) return;
    if (this.action) return this.handleActionKey(key);
    if (this.modal) return this.handleModalKey(key);

    if (key.ctrl && key.name === "c") {
      this.quit = true;
      return;
    }
    switch (key.name) {
      case "q":
        this.quit = true;
        return;
      case "?":
        this.modal = { kind: "help", input: "", choice: 0, scroll: new Viewport(), resolve: () => {} };
        this.redraw();
        this.paint();
        return;
      case "r":
        this.toast("busy", "正在刷新…");
        await this.refreshChrome();
        await this.current.refresh?.(this);
        this.toast("ok", "已刷新");
        this.paint();
        return;
      case "tab": {
        const index = this.views.findIndex((view) => view.id === this.active);
        const next = key.shift
          ? (index - 1 + this.views.length) % this.views.length
          : (index + 1) % this.views.length;
        this.go(this.views[next]!.id);
        this.paint();
        return;
      }
    }
    if (/^[1-9]$/.test(key.name)) {
      const target = this.views[Number(key.name) - 1];
      if (target) {
        this.go(target.id);
        this.paint();
      }
      return;
    }

    if (this.viewBusy) return;
    this.viewBusy = true;
    try {
      const consumed = await this.current.onKey?.(key, this);
      if (consumed !== false) this.redraw();
    } finally { this.viewBusy = false; }
  }

  private handleActionKey(key: Key): void {
    const pane = this.action!;
    if (!key.ctrl && pane.scroll.onKey(key.name)) { this.redraw(); return; }
    if (!pane.done) {
      // 除滚动外，运行中只接受显式中止；回车不会打断命令。
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        pane.cancel();
        this.toast("warn", "已请求中止；维护操作会完成恢复后退出，请查看输出");
      }
      return;
    }
    if (!["escape", "enter", "q"].includes(key.name) && !(key.ctrl && key.name === "c")) return;
    this.action = null;
    this.redraw();
    this.paint();
  }

  private handleModalKey(key: Key): void {
    const modal = this.modal!;
    if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name) && modal.scroll.onKey(key.name)) {
      this.redraw();
      return;
    }
    if (modal.kind === "help") {
      if (!["escape", "enter", "q", "?"].includes(key.name)) return;
      this.modal = null;
      this.redraw();
      this.paint();
      return;
    }

    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.modal = null;
      modal.resolve(modal.kind === "ask" ? null : false);
      this.redraw();
      this.paint();
      return;
    }

    if (modal.kind === "ask") {
      if (key.name === "enter") {
        const value = modal.input.trim();
        this.modal = null;
        modal.resolve(value);
      } else if (key.name === "backspace") {
        // 按码位删除，避免把 emoji 的 UTF-16 代理对拆开。
        modal.input = [...modal.input].slice(0, -1).join("");
      } else if (!key.ctrl) {
        modal.input += key.text ?? (key.name === "space" ? " " : [...key.name].length === 1 ? key.name : "");
      }
      this.redraw();
      this.paint();
      return;
    }

    const spec = modal.spec!;
    if (spec.typeToConfirm) {
      if (key.name === "enter") {
        if (modal.input.trim() === spec.typeToConfirm) {
          this.modal = null;
          modal.resolve(true);
        } else {
          this.toast("warn", `请原样输入「${spec.typeToConfirm}」`);
        }
      } else if (key.name === "backspace") {
        modal.input = [...modal.input].slice(0, -1).join("");
      } else if (!key.ctrl) {
        modal.input += key.text ?? (key.name === "space" ? " " : [...key.name].length === 1 ? key.name : "");
      }
      this.redraw();
      this.paint();
      return;
    }

    if (key.name === "left" || key.name === "right" || key.name === "tab") {
      modal.choice = modal.choice === 0 ? 1 : 0;
    } else if (key.name === "enter") {
      const accepted = modal.choice === 1;
      this.modal = null;
      modal.resolve(accepted);
    } else if (key.name === "y") {
      this.modal = null;
      modal.resolve(true);
    } else if (key.name === "n") {
      this.modal = null;
      modal.resolve(false);
    }
    this.redraw();
    this.paint();
  }

  // ===== 渲染 =====

  private paint(): void {
    if (!this.dirty || !this.screen.isActive) return;
    this.dirty = false;
    const { columns, rows } = this.screen.size;

    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      this.screen.render([
        "",
        ` 终端太小：当前 ${columns}×${rows}，至少需要 ${MIN_COLUMNS}×${MIN_ROWS}。`,
        " 请把窗口拉大，或改用 ops.sh / ops.ps1 的命令行子命令。",
      ]);
      return;
    }

    const chrome = [
      ...header({
        theme: this.theme,
        width: columns,
        deployment: this.deployment,
        service: this.service,
        git: this.git,
        uptime: this.service?.state === "ready" && this.service.startedAt ? Date.now() - this.service.startedAt : undefined,
      }),
      ...navbar(this.theme, columns, this.views, this.active, this.git),
    ];
    const keys: [string, string][] = [
      ...this.current.hints(),
      ["r", "刷新"],
      ["?", "帮助"],
      ["q", "退出"],
    ];
    const tail = footer(this.theme, columns, this.toastState, keys);
    const bodyHeight = Math.max(0, rows - chrome.length - tail.length);

    const ctx: ViewContext = {
      theme: this.theme,
      width: columns,
      height: bodyHeight,
      deployment: this.deployment,
    };
    let body = this.current.render(ctx).slice(0, bodyHeight);
    while (body.length < bodyHeight) body.push(pad("", columns));

    let frame = [...chrome, ...body, ...tail];
    if (this.action) frame = this.overlay(frame, this.renderAction(columns, rows), columns);
    else if (this.modal) frame = this.overlay(frame, this.renderModal(columns, rows), columns);
    this.screen.render(frame);
  }

  /** 把浮层居中盖在基础帧上。基础帧仍然完整算过，退出浮层时不需要重建布局。 */
  private overlay(base: string[], panel: string[], columns: number): string[] {
    const top = Math.max(0, Math.floor((base.length - panel.length) / 2));
    const left = Math.max(0, Math.floor((columns - width(panel[0] ?? "")) / 2));
    const out = [...base];
    panel.forEach((line, index) => {
      const row = top + index;
      if (row < out.length) out[row] = " ".repeat(left) + line;
    });
    return out;
  }

  private renderAction(columns: number, rows: number): string[] {
    const pane = this.action!;
    const size = Math.min(columns - 6, 100);
    const inner = size - 4;
    const room = Math.max(3, rows - 8);
    const status = pane.done
      ? pane.code === 0
        ? `${STATUS.ok.glyph} 完成`
        : `${STATUS.danger.glyph} 退出码 ${pane.code}`
      : `${SPINNER[pane.frame % SPINNER.length]} 进行中 ${fmt.duration(Date.now() - pane.startedAt)}`;
    const color = pane.done ? (pane.code === 0 ? "ok" : "danger") : "accent";

    const wrapped = pane.lines.flatMap(line => wrap(line, inner));
    const body = pane.scroll.slice(wrapped, room).map(line => this.theme.c("muted", line));
    while (body.length < room) body.push("");
    body.push(this.theme.c("muted", `${pane.scroll.label}  ↑↓ / PgUp PgDn 回看 · End 跟随`));
    body.push(
      this.theme.c(
        color,
        pane.done ? "Enter / Esc 返回" : "Esc 中止操作"
      )
    );

    return box(this.theme, {
      width: size,
      title: pane.title,
      note: status,
      accent: color,
      body: body.map((line) => pad(line, inner)),
    });
  }

  private renderModal(columns: number, height: number): string[] {
    const modal = this.modal!;
    const size = Math.min(columns - 6, 72);
    const inner = size - 4;
    const inputLine = () => {
      const tail = wrap(modal.input, inner - 5).at(-1) ?? "";
      return "  " + this.theme.c("accent", "▏") + tail + this.theme.c("accent", "▁");
    };

    if (modal.kind === "ask") {
      return box(this.theme, {
        width: size, title: "输入", accent: "accent",
        body: [...wrap(modal.label ?? "", inner), "", inputLine(), "", this.theme.c("muted", "Enter 确认 · Esc 取消")],
      });
    }

    let title = "帮助";
    const content: string[] = [];
    const controls: string[] = [];
    if (modal.kind === "help") {
      content.push(
        "1–9 / Tab / Shift+Tab  切换页面", "↑↓ / j k              选择或滚动",
        "PgUp / PgDn           翻页", "Home / End            首尾",
        "Enter                 进入或执行", "Esc                   返回上一层",
        "r                     刷新", "q / Ctrl+C            退出", "",
        "统计：e 导出，o 打开最近报表，m 临时显号。",
        "存储：p 清理当前成员，a 清理全部成员，←→ 选择天数。",
        "历史和临时目录清理会移入 backup/rm；外链对象删除不可恢复。"
      );
      controls.push(this.theme.c("muted", "Enter / Esc 关闭"));
    } else {
      const spec = modal.spec!;
      title = spec.title;
      content.push(this.theme.bold(spec.subject), "", this.theme.c("muted", "会发生什么"));
      spec.steps.forEach((step, index) => content.push(String(index + 1) + ". " + step));
      if (spec.untouched?.length) content.push("", "不受影响：" + spec.untouched.join(" · "));
      if (spec.recovery) content.push("恢复说明：" + spec.recovery);
      if (spec.typeToConfirm) {
        controls.push(...wrap("输入「" + spec.typeToConfirm + "」确认", inner), inputLine());
      } else {
        const cancel = modal.choice === 0 ? this.theme.invert(" 取消 ") : " 取消 ";
        const label = spec.danger ? "确认执行" : "继续";
        const accept = modal.choice === 1 ? this.theme.invert(" " + label + " ") : " " + label + " ";
        controls.push(cancel + "    " + accept);
      }
      controls.push(this.theme.c("muted", spec.typeToConfirm ? "Enter 确认 · Esc 取消" : "←→ 选择 · Enter 确认 · y/n · Esc 取消"));
    }

    const room = Math.max(1, height - 4 - controls.length - 1);
    const lines = content.flatMap(line => wrap(line, inner));
    const visible = modal.scroll.slice(lines, room);
    return box(this.theme, {
      width: size, title, accent: modal.spec?.danger ? "danger" : "accent",
      body: [...visible, this.theme.c("muted", modal.scroll.label ? modal.scroll.label + " · ↑↓ / PgUp PgDn" : ""), ...controls],
    });
  }
}
