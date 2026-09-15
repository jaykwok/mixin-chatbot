import { basename, join } from "node:path";
import {
  ADVANCED_RUNTIME_KEYS, RUNTIME_DEFAULTS, RUNTIME_RANGES, validateRuntimeConfig, type AdvancedRuntimeKey,
} from "../../../../src/core/runtime-schema.ts";
import { discardRuntimeDraft, writeRuntimeDraft, type RuntimeChanges } from "../../../config/runtime-settings.ts";
import { loadRuntimeSettings } from "../data.ts";
import { PROJECT_DIR } from "../platform.ts";
import { spinner } from "../render/widgets.ts";
import type { AppApi, Choice, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";
import { LazySetting } from "./settings-state.ts";

interface RuntimeOption {
  key: AdvancedRuntimeKey;
  label: string;
  description: string;
  unit?: string;
  choices?: Choice[];
}
const groups: { label: string; description: string; options: RuntimeOption[] }[] = [
  { label: "并发与附件", description: "请求数量与附件上传并发", options: [
    { key: "BOT_MAX_ACTIVE_REQUESTS", label: "请求并发上限", description: "已接收但尚未完成清理的普通请求总数；超限时提示稍后重试。" },
    { key: "BOT_ATTACHMENT_CONCURRENCY", label: "附件并发", description: "同时读取、上传小附件的数量，用于控制内存峰值。" },
  ] },
  { label: "超时与退出", description: "整轮、模型、工具、交付及关机时限", options: [
    { key: "BOT_RUN_TIMEOUT_SECONDS", label: "整轮处理时限", unit: "秒", description: "覆盖准备、模型、工具与最终交付；其他时限仍受整轮剩余时间约束。" },
    { key: "BOT_MODEL_IDLE_TIMEOUT_SECONDS", label: "模型无进展时限", unit: "秒", description: "模型等待或输出期间，连续没有有效进展的上限。" },
    { key: "BOT_MODEL_RESPONSE_TIMEOUT_SECONDS", label: "单次模型响应时限", unit: "秒", description: "包含首字等待；持续输出也不会延长此时限。" },
    { key: "BOT_BASH_TIMEOUT", label: "命令默认时限", unit: "秒", description: "模型未指定时使用；工具可声明其他时限，最高 3600 秒。" },
    { key: "BOT_DELIVERY_TIMEOUT_SECONDS", label: "消息交付时限", unit: "秒", description: "包含出站发送的排队和重试。" },
    { key: "BOT_SHUTDOWN_TIMEOUT_SECONDS", label: "关机收尾时限", unit: "秒", description: "覆盖 HTTP、任务、子进程与租约收尾。" },
  ] },
  { label: "缓存与索引", description: "资料索引容量、刷新与模型缓存策略", options: [
    { key: "BOT_INDEX_TTL_MINUTES", label: "索引刷新间隔", unit: "分钟", description: "活跃会话每轮检查；首次等待构建，过期后后台刷新。" },
    { key: "BOT_INDEX_MAX_FILES", label: "索引文件上限", description: "单次扫描收录的文件数，防止过大的目录树占满资源。" },
    { key: "BOT_INDEX_MAX_DEPTH", label: "索引目录深度", description: "超过此深度的目录会跳过，索引标记为不完整。" },
    { key: "BOT_MODEL_CACHE_RETENTION", label: "模型缓存策略", description: "自动沿用模型 SDK；其他选项显式指定缓存保留策略，仍取决于服务商支持。", choices: [
      { value: "auto", label: "自动", description: "沿用 SDK 默认值" },
      { value: "short", label: "短期" }, { value: "long", label: "长期" }, { value: "none", label: "关闭" },
    ] },
  ] },
  { label: "文档与诊断", description: "文档解析环境与机器人详细日志", options: [
    { key: "BOT_DOCUMENT_ENV", label: "文档解析环境", description: "指定已配置的虚拟环境目录；默认自动选择就绪的项目 .venv 或本群环境。Linux 填容器内路径。" },
    { key: "BOT_DEBUG", label: "机器人详细日志", description: "开启后机器人日志会记录用户消息正文，分享前请脱敏。与 Cloudflared 日志分别控制。", choices: [
      { value: "0", label: "关闭" }, { value: "1", label: "开启" },
    ] },
  ] },
];

function display(option: RuntimeOption, saved?: string | null): string {
  const value = saved ?? RUNTIME_DEFAULTS[option.key];
  const choice = option.choices?.find(item => item.value === value);
  return choice?.label ?? (value ? value + (option.unit ? " " + option.unit : "") : "自动选择");
}

export class RuntimeSettingsEditor {
  readonly data = new LazySetting(signal => loadRuntimeSettings(undefined, signal));
  private group = -1;
  private selectedGroup = 0;
  private selected = 0;
  private changes: RuntimeChanges = {};
  private saving = false;

  get dirty(): boolean { return Object.keys(this.changes).length > 0; }
  get summary(): string {
    if (this.dirty) return Object.keys(this.changes).length + " 项待保存";
    const state = this.data.state;
    if (state.kind === "ready") return ADVANCED_RUNTIME_KEYS.filter(key => state.value.values[key] !== undefined).length + " 项自定义";
    return state.kind === "error" ? "读取失败" : state.kind === "loading" ? "读取中" : "按需读取";
  }
  activity(): string | null {
    return this.saving ? "正在保存运行参数…" : this.data.state.kind === "loading" ? "正在读取运行参数…" : null;
  }
  load(app: AppApi, force = false): Promise<void> {
    // 保留编辑基线；即使其他维护操作使页面失效，保存时仍按原 hash 检查并发修改。
    return this.dirty || this.saving ? Promise.resolve() : this.data.load(app, force);
  }
  invalidate(): void { if (!this.dirty && !this.saving) this.data.invalidate(); }
  onLeave(): boolean { return this.data.onLeave(); }
  hints(): [string, string][] { return [["↑↓", "选择"], ["Enter", this.group < 0 ? "进入" : "修改"], ["s", "保存"], ["Esc", "返回"]]; }
  actions(): ViewAction[] {
    return [
      { value: "enter", label: this.group < 0 ? "进入分类" : "修改选中参数", disabled: this.group >= 0 && this.data.state.kind !== "ready" },
      ...(this.group < 0 ? [] : [{ value: "d", label: "选中参数恢复默认", description: "加入待保存修改，按 s 确认后应用", disabled: this.data.state.kind !== "ready" }]),
      { value: "s", label: "预览并保存运行参数", disabled: !this.dirty },
      { value: "x", label: "放弃未保存的修改", disabled: !this.dirty },
      { value: "escape", label: "返回上一层", description: "在当前 TUI 中保留未保存的修改" },
    ];
  }

  private set(option: RuntimeOption, value: string | null, app: AppApi): void {
    if (this.data.state.kind !== "ready") return;
    const original = this.data.state.value.values[option.key] ?? null;
    if (original === value) delete this.changes[option.key];
    else this.changes[option.key] = value;
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (key.name === "escape") {
      if (this.group < 0) return false;
      this.selectedGroup = this.group; this.group = -1;
      return true;
    }
    const options = this.group < 0 ? groups : groups[this.group]!.options;
    const selected = moveSelection(key.name, this.group < 0 ? this.selectedGroup : this.selected, options.length);
    if (selected !== null) {
      if (this.group < 0) this.selectedGroup = selected; else this.selected = selected;
      return true;
    }
    if (key.name === "x") {
      if (this.dirty && await app.confirm({
        title: "放弃未保存的修改", subject: "高级运行参数", steps: ["丢弃当前草稿并重新读取已保存的配置"],
      })) {
        this.changes = {}; this.data.invalidate(); void this.load(app);
      }
      return true;
    }
    if (key.name === "s") { await this.save(app); return true; }
    if (this.group < 0) {
      if (key.name !== "enter") return false;
      this.group = this.selectedGroup; this.selected = 0;
      void this.load(app);
      return true;
    }
    if (!["enter", "d"].includes(key.name)) return false;
    if (this.data.state.kind !== "ready") {
      app.toast("warn", "请等待参数读取完成；读取失败可按 r 重试");
      return true;
    }
    const option = groups[this.group]!.options[this.selected]!;
    if (key.name === "d") { this.set(option, null, app); return true; }
    const current = option.key in this.changes ? this.changes[option.key] : this.data.state.value.values[option.key];
    const choice = await app.choose({
      title: option.label, description: option.description,
      choices: [
        { value: "edit", label: "修改", description: "当前：" + display(option, current) },
        { value: "default", label: "使用默认值", description: display(option) },
      ],
    });
    if (choice === null) return true;
    if (choice === "default") { this.set(option, null, app); return true; }
    let value: string | null;
    if (option.choices) value = await app.choose({
      title: option.label, description: option.description, choices: option.choices,
      initial: current ?? RUNTIME_DEFAULTS[option.key],
    });
    else {
      const range = RUNTIME_RANGES[option.key as keyof typeof RUNTIME_RANGES];
      const rule = range ? "（" + range.join("–") + (option.unit ?? "") + "，整数）" : "（留空恢复自动选择）";
      value = await app.ask(option.label + rule, current ?? RUNTIME_DEFAULTS[option.key]);
    }
    if (value === null) return true;
    if (!value.trim() && option.key === "BOT_DOCUMENT_ENV") { this.set(option, null, app); return true; }
    try { this.set(option, validateRuntimeConfig({ [option.key]: value })[option.key]!, app); }
    catch (error) { app.toast("warn", error instanceof Error ? error.message : String(error)); }
    return true;
  }

  private async save(app: AppApi): Promise<void> {
    if (!this.dirty || this.data.state.kind !== "ready") { app.toast("idle", "没有待保存的运行参数"); return; }
    const snapshot = this.data.state.value;
    const steps = groups.flatMap(group => group.options.filter(option => option.key in this.changes).map(option =>
      option.label + "：" + display(option, snapshot.values[option.key]) + " → " + display(option, this.changes[option.key]) +
      (this.changes[option.key] === null ? "（恢复默认）" : "")));
    if (!await app.confirm({
      title: "保存高级运行参数", subject: Object.keys(this.changes).length + " 项修改",
      steps: [...steps, "保存后重启原本运行中的机器人；已停止时保持停止，下次启动生效",
        "显式环境变量优先；应用前检查冲突，冲突时不写入"],
      recovery: "应用或健康检查失败时尝试恢复原配置及运行状态",
    })) return;
    this.saving = true; app.redraw();
    let draft: string | undefined;
    try {
      draft = await writeRuntimeDraft(snapshot, this.changes, join(PROJECT_DIR, "data/config/runtime.json"));
      if (await app.run("应用高级运行参数", ["runtime-configure", basename(draft)]) === 0) {
        this.changes = {}; this.data.invalidate();
      }
    } finally {
      try { if (draft) await discardRuntimeDraft(draft); }
      finally { this.saving = false; void this.load(app); app.redraw(); }
    }
  }

  render(ctx: ViewContext): string[] {
    const state = this.data.state;
    const loading = state.kind === "loading" ? [spinner(ctx.theme) + " 正在读取运行参数…"]
      : state.kind === "error" ? ["读取失败：" + state.message, "按 r 重试；配置无效时请先修正 runtime.json。"] : [];
    const note = this.dirty ? this.summary + " · s 预览并保存 · Esc 返回保留草稿 · 空格可放弃修改"
      : "显示已保存值与默认值；显式环境变量优先 · 端口、地址和数据目录在服务部署中设置";
    if (this.group < 0) {
      const group = groups[this.selectedGroup]!;
      return actionWorkbench(ctx, {
        title: "高级运行参数", selected: this.selectedGroup,
        items: groups.map(item => ({
          label: item.label, summary: item.options.length + " 项",
          status: item.options.some(option => option.key in this.changes) ? "warn" : "idle",
        })),
        details: [...loading, group.description, "", ...group.options.map(option => option.label), "",
          "Enter 进入分类；修改会先留在草稿中，按 s 预览并保存。"],
        note,
      });
    }
    const group = groups[this.group]!, option = group.options[this.selected]!;
    const values = state.kind === "ready" ? state.value.values : {};
    const current = option.key in this.changes ? this.changes[option.key] : values[option.key];
    const range = RUNTIME_RANGES[option.key as keyof typeof RUNTIME_RANGES];
    return actionWorkbench(ctx, {
      title: group.label, selected: this.selected,
      items: group.options.map(item => ({
        label: item.label,
        summary: state.kind === "ready" ? display(item, item.key in this.changes ? this.changes[item.key] : values[item.key]) : "待读取",
        status: item.key in this.changes ? "warn" : "idle",
      })),
      details: [
        ...loading,
        ...(state.kind === "ready" ? [
          "当前：" + display(option, current) + (option.key in this.changes ? "（待保存）" : values[option.key] === undefined ? "（默认）" : "（已保存）"),
          "默认：" + display(option) + (range ? "；范围：" + range.join("–") + (option.unit ?? "") : ""),
        ] : []),
        option.description, "", "Enter 修改 · d 恢复默认 · s 保存",
        "配置项：" + option.key,
      ],
      note,
    });
  }
}
