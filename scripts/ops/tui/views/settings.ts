import { loadTunnelLogging, loadTunnelProtocol, type TunnelLogging, type TunnelProtocol } from "../data.ts";
import { spinner } from "../render/widgets.ts";
import type { AppApi, View, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";
import { LazySetting } from "./settings-state.ts";
import { RuntimeSettingsEditor } from "./runtime-settings.ts";

const protocolLabels: Record<TunnelProtocol, string> = { auto: "自动（默认）", http2: "HTTP2（TCP）", quic: "QUIC（UDP）" };

export class SettingsView implements View {
  readonly id = "settings";
  readonly label = "设置";
  private readonly tunnel = new LazySetting<TunnelLogging>(signal => loadTunnelLogging(undefined, signal));
  private readonly protocol = new LazySetting<TunnelProtocol>(signal => loadTunnelProtocol(undefined, signal));
  private readonly runtime = new RuntimeSettingsEditor();
  private editingRuntime = false;
  private selected = 0;
  private get state() { return this.tunnel.state; }

  hints(): [string, string][] {
    return this.editingRuntime ? this.runtime.hints() : [["↑↓", "选择"], ["Enter", "设置"], ["v", "隧道日志"]];
  }
  hasUnsavedChanges(): boolean { return this.runtime.dirty; }
  activity(): string | null {
    if (this.editingRuntime || this.selected === 3) return this.runtime.activity();
    if (this.selected === 2 && this.protocol.state.kind === "loading") return "正在读取隧道连接模式…";
    return this.selected === 1 && this.state.kind === "loading" ? "正在读取隧道日志设置…" : null;
  }

  actions(): ViewAction[] {
    if (this.editingRuntime) return this.runtime.actions();
    return [
      { value: "e", label: "外链配置", description: "启用、修改或停用外链，填写 WebDAV 与公开下载地址" },
      { value: "l", label: "Cloudflared 日志", description: "关闭 / 开启，默认关闭" },
      { value: "p", label: "Cloudflared 连接模式", description: "自动 / HTTP2 / QUIC，默认自动" },
      { value: "a", label: "高级运行参数", description: "并发、超时、缓存索引、文档与诊断" },
      { value: "v", label: "查看隧道日志", description: "查看近期记录、搜索请求路径或 cfRay" },
    ];
  }

  invalidate(): void { this.tunnel.invalidate(); this.protocol.invalidate(); this.runtime.invalidate(); }
  onLeave(): boolean {
    const pending = this.tunnel.onLeave();
    const protocolPending = this.protocol.onLeave();
    const runtimePending = this.runtime.onLeave();
    return pending || protocolPending || runtimePending;
  }

  refresh(app: AppApi): Promise<void> {
    if (this.editingRuntime || this.selected === 3) return this.runtime.load(app, true);
    if (this.selected === 2) return this.protocol.load(app, true);
    if (this.selected === 1) return this.tunnel.load(app, true);
    return Promise.resolve();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (this.editingRuntime) {
      const consumed = await this.runtime.onKey(key, app);
      if (key.name === "escape" && !consumed) { this.editingRuntime = false; return true; }
      return consumed;
    }
    const selected = moveSelection(key.name, this.selected, 4);
    if (selected !== null) {
      this.selected = selected;
      if (selected === 1) void this.tunnel.load(app); else this.tunnel.onLeave();
      if (selected === 2) void this.protocol.load(app); else this.protocol.onLeave();
      if (selected === 3) void this.runtime.load(app); else this.runtime.onLeave();
      return true;
    }
    const action = key.name === "enter" ? ["e", "l", "p", "a"][this.selected] : key.name;
    if (action === "v") { app.go("tunnel-logs"); return true; }
    if (action === "a") {
      this.selected = 3; this.editingRuntime = true; this.tunnel.onLeave(); this.protocol.onLeave();
      void this.runtime.load(app);
      return true;
    }
    if (action === "e") {
      const code = await app.runInteractive("外链配置", ["relay-configure"]);
      if (code === 0) app.toast("ok", "外链配置向导已结束");
      return true;
    }
    if (action === "p") return this.configureProtocol(app);
    if (action !== "l") return false;
    this.selected = 1; this.runtime.onLeave(); this.protocol.onLeave();
    void this.tunnel.load(app);
    if (this.state.kind !== "ready") { app.toast("warn", "请等待设置读取完成，读取失败可按 r 重试"); return true; }
    const value = await app.choose({
      title: "Cloudflared 日志", initial: this.state.value,
      description: "记录隧道连接、请求及回源信息，写入 logs/cloudflared.log 并自动轮转。",
      choices: [{ value: "off", label: "关闭" }, { value: "on", label: "开启" }],
    });
    if ((value !== "off" && value !== "on") || value === this.state.value) return true;
    if (!await app.confirm({
      title: `${value === "on" ? "开启" : "关闭"} Cloudflared 日志`,
      subject: "本项目的 Cloudflared 隧道",
      steps: [
        value === "on" ? "记录请求、源站响应和连接错误，保存在 logs/cloudflared.log"
          : "停止写入隧道日志，保留已有日志文件",
        "正在运行的隧道会重启，公网访问短暂中断；已停止或未安装时，下次启动生效",
        ...(value === "on" ? ["日志包含完整 URL 和请求头，可能含访问凭据，分享前请脱敏"] : []),
      ],
      recovery: "应用失败会恢复原设置及运行状态；可随时在这里重新切换",
    })) return true;
    const previous = this.state;
    await app.run("设置 Cloudflared 日志", ["tunnel-logging", value]);
    // App 已在维护结束后失效并刷新当前项；独立调用时才补一次读取。
    if (this.state === previous) void this.tunnel.load(app, true);
    return true;
  }

  private async configureProtocol(app: AppApi): Promise<boolean> {
    this.selected = 2; this.tunnel.onLeave(); this.runtime.onLeave();
    void this.protocol.load(app);
    const state = this.protocol.state;
    if (state.kind !== "ready") { app.toast("warn", "请等待设置读取完成，读取失败可按 r 重试"); return true; }
    const value = await app.choose({
      title: "Cloudflared 连接模式", initial: state.value,
      description: "自动优先 QUIC，无法建立 UDP 连接时回退 HTTP2；UDP 不稳定时可尝试 HTTP2。",
      choices: [
        { value: "auto", label: protocolLabels.auto },
        { value: "http2", label: protocolLabels.http2 },
        { value: "quic", label: protocolLabels.quic },
      ],
    });
    if ((value !== "auto" && value !== "http2" && value !== "quic") || value === state.value) return true;
    if (!await app.confirm({
      title: `连接模式：${protocolLabels[value]}`, subject: "本项目的 Cloudflared 隧道",
      steps: [
        value === "auto" ? "优先 QUIC，无法建立 UDP 连接时回退 HTTP2"
          : value === "http2" ? "固定使用 TCP 7844，适合测试 UDP 路径不稳定的环境"
            : "固定使用 UDP 7844；UDP 不可用时无法通过 HTTP2 回退",
        "正在运行的隧道会重启，公网访问短暂中断；已停止或未安装时，下次启动生效",
      ],
      recovery: "启动失败会尝试恢复原设置及运行状态；网络可用性请结合隧道日志验证，可随时切回自动",
    })) return true;
    await app.run("设置 Cloudflared 连接模式", ["tunnel-protocol", value]);
    if (this.protocol.state === state) void this.protocol.load(app, true);
    return true;
  }

  render(ctx: ViewContext): string[] {
    if (this.editingRuntime) return this.runtime.render(ctx);
    const current = this.state.kind === "ready" ? (this.state.value === "on" ? "开启" : "关闭")
      : this.state.kind === "error" ? "读取失败" : this.state.kind === "loading" ? "读取中" : "选中后读取";
    const protocol = this.protocol.state;
    const connection = protocol.kind === "ready" ? protocolLabels[protocol.value]
      : protocol.kind === "error" ? "读取失败" : protocol.kind === "loading" ? "读取中" : "选中后读取";
    return actionWorkbench(ctx, {
      title: "设置", selected: this.selected,
      items: [
        { label: "外链配置", summary: "WebDAV 与公开下载地址", status: "idle" },
        { label: "Cloudflared 日志", summary: current, status: this.state.kind === "error" ? "warn" : "idle" },
        { label: "Cloudflared 连接模式", summary: connection, status: protocol.kind === "error" ? "warn" : "idle" },
        { label: "高级运行参数", summary: this.runtime.summary, status: this.runtime.dirty ? "warn" : "idle" },
      ],
      details: this.selected === 0 ? [
        "可选的大文件外链：启用、修改或停用。",
        "向导含 Alist 示例：上传填到挂载目录，下载可只填域名。",
        "文件上限、有效期和兼容签名放在高级设置。",
        "保存前预览并确认，取消不修改配置。",
        "确认后重启原本运行中的机器人，已停止时保持停止。",
      ] : this.selected === 1 ? [
        this.state.kind === "loading" ? spinner(ctx.theme) + " 正在读取隧道日志设置…" : `当前：${current}（默认关闭）`,
        "开启后记录隧道连接、HTTP 请求及源站响应，便于排查回调和文件下载。",
        "文件：logs/cloudflared.log，自动轮转。",
        "切换会重启正在运行的隧道；已停止时保持停止。",
        "日志可能含访问凭据，分享前请脱敏。",
        ...(this.state.kind === "error" ? [this.state.message] : []),
      ] : this.selected === 2 ? [
        protocol.kind === "loading" ? spinner(ctx.theme) + " 正在读取隧道连接模式…" : `当前：${connection}`,
        "自动：优先 QUIC，无法建立 UDP 连接时回退 HTTP2。",
        "HTTP2：TCP 7844，UDP 不稳定时可尝试。",
        "QUIC：UDP 7844，固定使用 QUIC。",
        "切换会重启正在运行的隧道；已停止时保持停止。",
        ...(protocol.kind === "error" ? [protocol.message] : []),
      ] : [
        ...(this.runtime.activity() ? [spinner(ctx.theme) + " " + this.runtime.activity()] : []),
        "并发与附件：请求数量、附件上传并发。",
        "超时与退出：整轮、模型、工具、交付与关机时限。",
        "缓存与索引：模型缓存、索引刷新和容量。",
        "文档与诊断：解析环境、机器人详细日志。",
        "Enter 进入；修改后按 s 预览并保存。",
        "当前：" + this.runtime.summary,
      ],
      note: this.selected === 0 ? "查看与清理已生成的外链：数据 → 外链"
        : this.selected === 1 ? "查看隧道日志：监控 → 隧道日志（v）；界面显示本机时间，原始文件使用 UTC"
          : this.selected === 2 ? "模式决定隧道传输协议；是否经过代理由系统及代理路由决定"
          : "设置按需读取；显式环境变量优先于保存值，保存时检查冲突",
    });
  }
}
