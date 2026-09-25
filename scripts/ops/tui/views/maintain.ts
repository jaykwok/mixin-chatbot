// 部署、升级、启停、修复和卸载入口；执行前展示各自的范围与恢复方式。
// 选中升级后联网检查，预览使用本次同步的目标提交。

import type { StatusName } from "../render/theme.ts";
import * as fmt from "../render/format.ts";
import { loadGit, loadUpgrade, type GitState, type UpgradeState } from "../data.ts";
import type { AppApi, ConfirmSpec, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";
import { LazySetting } from "./settings-state.ts";

interface Action {
  key: string;
  label: string;
  summary: string;
  /** 只在这些平台上出现；不给表示两个平台都有。 */
  only?: "windows" | "linux";
  status: StatusName;
  /** 该命令会向用户提问，必须拿到真正的 TTY（update 转调的 deploy.sh 全程交互）。 */
  interactive?: boolean | ((app: AppApi) => boolean);
  confirm(app: Pick<AppApi, "deployment">, git: GitState | null, targetSha?: string): ConfirmSpec | null;
  args(app: AppApi): string[];
}

const ACTIONS: Action[] = [
  {
    key: "deploy",
    label: "部署 / 重部署",
    summary: "配置并部署当前代码，失败恢复原部署",
    status: "busy",
    interactive: true,
    confirm: (app) => ({
      title: "部署 / 重部署",
      subject: "运行当前版本的部署向导",
      steps: ["确认模型、端口、群数据目录和访问方式，默认沿用已有配置",
        app.deployment.runtime === "docker" ? "构建镜像并切换容器" : "安装依赖并注册计划任务",
        "检查新实例就绪状态，失败时恢复部署前的配置和服务"],
      untouched: ["会话历史", "群共享资料"],
      recovery: "替换期间服务会短暂中断；尚未安装 Bun 和项目依赖的机器需先完成环境安装",
    }),
    args: () => ["deploy"],
  },
  {
    key: "update",
    label: "升级",
    summary: "停机后同步 origin/main，按需迁移并验证新实例",
    status: "busy",
    interactive: true,
    confirm: (app, git, targetSha) => {
      if (!git) {
        return {
          title: "升级",
          subject: "这份部署不是 git 仓库，无法自动升级",
          steps: ["先通过 Git 获取项目，再进入「系统 → 服务部署 → 部署 / 重部署」；之后即可在此升级"],
        };
      }
      if (git.dirty) {
        return {
          title: "升级",
          subject: "已跟踪文件有未提交改动，升级会被拒绝",
          steps: ["先提交、撤销或备份本地代码改动，再进入「系统 → 服务部署 → 升级」"],
        };
      }
      const steps =
        git.behind > 0
          ? [
              "停止旧实例，确认退出后才切换代码和更新依赖",
              `快进到 origin/main ${targetSha ? fmt.shortSha(targetSha) : ""}（${git.behind} 个提交）`,
              app.deployment.runtime === "docker"
                ? "保持停机，通过部署向导重建镜像"
                : "保持停机，按需安装依赖",
              "按需预览并迁移；同版本且标记配对时跳过数据迁移和数据库备份",
              "以只验证模式检查新实例，提交数据版本后恢复原运行状态",
            ]
          : ["重新核对远端版本", "停止旧实例，检查数据版本并续做中断事务", "同版本且标记配对时跳过迁移和数据库备份；需要迁移时先预览再备份执行", "以只验证模式检查新实例，通过后提交并恢复原运行状态"];
      return {
        title: "升级",
        subject:
          git.behind > 0
            ? `${fmt.shortSha(git.sha)} → ${targetSha ? fmt.shortSha(targetSha) : "origin/main"}，共 ${git.behind} 个提交`
            : `当前 ${fmt.shortSha(git.sha)}；origin/main ${targetSha ? fmt.shortSha(targetSha) : "待检查"}`,
        steps,
        untouched: ["会话历史", "群共享资料"],
        recovery: "提交前失败会恢复数据、代码和原服务；恢复失败保持停机。提交后保留新版本并报告启动问题",
      };
    },
    args: () => ["update"],
  },
  {
    key: "restart",
    label: "重启",
    summary: "停止并重新启动，等待健康检查通过",
    status: "busy",
    confirm: () => ({
      title: "重启",
      subject: "停止并重新启动机器人",
      steps: ["停止当前实例（正在处理的任务会被中断）", "重新启动并核对新实例的身份和就绪状态"],
      untouched: ["配置", "会话历史", "群数据"],
      recovery: "无需恢复；重启不改任何数据",
    }),
    args: () => ["restart"],
  },
  {
    key: "repair",
    label: "修复部署",
    summary: "Windows 修复任务与规则；Linux 通过部署向导重建",
    status: "warn",
    interactive: app => app.deployment.platform === "linux",
    confirm: app => ({
      title: "修复部署",
      subject: app.deployment.platform === "windows" ? "修复可确定的部署问题" : "按当前代码重建部署",
      steps: app.deployment.platform === "windows"
        ? ["检查并修复计划任务、防火墙和隧道", "完成后重新体检"]
        : ["进入部署向导，回车沿用当前配置", "重新构建镜像并切换容器，核对实例健康", "失败时恢复原部署"],
      untouched: ["会话历史", "群共享资料"],
      recovery: "可能短暂中断服务；无法自动判断的配置问题会显示具体原因",
    }),
    args: app => app.deployment.platform === "windows" ? ["doctor", "-Repair"] : ["deploy"],
  },
  {
    key: "stop",
    label: "停止",
    summary: "停止机器人，群里将不再有响应",
    status: "warn",
    confirm: () => ({
      title: "停止",
      subject: "停止机器人",
      steps: ["停止当前实例", "停止期间群成员发来的消息不会被处理"],
      untouched: ["配置", "会话历史", "群数据"],
      recovery: "用「启动」重新拉起",
      danger: true,
    }),
    args: () => ["stop"],
  },
  {
    key: "start",
    label: "启动",
    summary: "启动机器人并等待健康检查",
    status: "ok",
    confirm: () => null,
    args: () => ["start"],
  },
  {
    key: "repair-tunnel",
    label: "修复隧道",
    summary: "按当前 token 来源强制重装 Cloudflared 服务",
    only: "windows",
    status: "warn",
    confirm: () => ({
      title: "修复隧道",
      subject: "强制重装 Cloudflared 服务",
      steps: ["停止并卸载现有 Cloudflared 服务", "按当前 token 来源重新安装", "完成后跑一次体检确认公网连通"],
      untouched: ["机器人本身", "配置与数据"],
      recovery: "重装期间公网访问会中断",
      danger: true,
    }),
    args: () => ["repair-tunnel"],
  },
  {
    key: "uninstall",
    label: "卸载",
    summary: "删除容器/任务，可选删除镜像、隧道与数据",
    status: "danger",
    interactive: true,
    confirm: (app) => ({
      title: "卸载",
      subject: "卸载 mixin-chatbot",
      steps: [
        app.deployment.runtime === "docker" ? "停止并删除容器" : "停止并注销计划任务、清理防火墙规则",
        "随后逐项询问：是否删除镜像、是否停止 cloudflared、是否删除 data/ 与 logs/",
        "每一项都要单独确认，不会一次全删",
      ],
      untouched: ["自定义群数据根（若指向项目外，不会被删除）"],
      recovery: "选择删除 data/ 时文件会移入 backup/rm，不是直接删除",
      typeToConfirm: "卸载",
      danger: true,
    }),
    args: () => ["uninstall"],
  },
];

const ACTION_ORDER = ["start", "restart", "stop", "update", "deploy", "repair", "repair-tunnel", "uninstall"];

export class MaintainView implements View {
  readonly id = "maintain";
  readonly label = "服务部署";
  private state: Loading<GitState | null> = { kind: "idle" };
  private refreshing = false;
  private revision = 0;
  private readonly upgrade = new LazySetting<UpgradeState | null>(signal => loadUpgrade(signal));
  private selected = 0;
  private platform: "windows" | "linux" = "linux";

  private get waitingForVersion(): boolean { return this.refreshing || this.state.kind !== "ready"; }
  private get selectingUpgrade(): boolean { return this.availableActions[this.selected]?.key === "update"; }

  activity(): string | null { return this.upgrade.state.kind === "loading" ? "正在检查 origin/main 最新提交…" : null; }

  invalidate(): void {
    this.revision++;
    this.state = { kind: "idle" };
    this.refreshing = false;
    this.upgrade.invalidate();
  }

  onLeave(): boolean { this.invalidate(); return true; }

  private get availableActions(): Action[] {
    return ACTIONS.filter((action) => !action.only || action.only === this.platform)
      .sort((a, b) => ACTION_ORDER.indexOf(a.key) - ACTION_ORDER.indexOf(b.key))
      .map(action => action.key === "repair" ? { ...action, summary: this.platform === "windows"
        ? "检查并修复计划任务、防火墙与隧道" : "通过部署向导重建当前版本" } : action);
  }

  hints(): [string, string][] {
    return [
      ["↑↓", "选择"],
      ["Enter", "执行所选操作"],
    ];
  }

  actions(): ViewAction[] {
    return this.availableActions.map(action => ({
      value: action.key, label: action.label, description: action.summary,
      danger: action.status === "danger" || action.key === "stop" || action.key === "repair-tunnel",
      disabled: action.key === "update" && (this.selectingUpgrade ? this.upgrade.state.kind !== "ready" : this.waitingForVersion),
    }));
  }

  async refresh(app: AppApi): Promise<void> {
    this.platform = app.deployment.platform;
    if (this.selectingUpgrade) {
      await this.checkUpgrade(app, true);
      return;
    }
    const revision = ++this.revision;
    this.refreshing = true;
    if (this.state.kind !== "ready") this.state = { kind: "loading" };
    app.redraw();
    try {
      const value = await loadGit();
      if (revision === this.revision) this.state = { kind: "ready", value };
    } catch (error) {
      if (revision === this.revision) this.state = { kind: "error", message: `版本读取失败，请刷新重试：${String(error)}` };
    } finally {
      if (revision === this.revision) this.refreshing = false;
      app.redraw();
    }
  }

  private async checkUpgrade(app: AppApi, force = false): Promise<void> {
    await this.upgrade.load(app, force);
    if (this.upgrade.state.kind === "ready") {
      // The remote check also read HEAD. Reuse that result when leaving Upgrade,
      // and prevent an older local-only query from overwriting it.
      this.revision++;
      this.refreshing = false;
      this.state = { kind: "ready", value: this.upgrade.state.value?.git ?? null };
      app.redraw();
    }
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    const actions = this.availableActions;
    const moved = moveSelection(key.name, this.selected, actions.length);
    if (moved !== null) {
      const previous = this.selected;
      this.selected = moved;
      if (this.selectingUpgrade) {
        if (previous !== moved) this.upgrade.invalidate();
        void this.checkUpgrade(app);
      } else {
        this.upgrade.onLeave();
        if (this.state.kind === "idle") void this.refresh(app);
      }
      return true;
    }
    if (key.name === "enter" || actions.some(action => action.key === key.name)) {
      const action = key.name === "enter" ? actions[this.selected] : actions.find(action => action.key === key.name);
      if (!action) return true;
      if (action.key === "update" && !this.selectingUpgrade && this.waitingForVersion) {
        app.toast("warn", this.state.kind === "error" ? this.state.message : "版本读取中，请稍后再升级");
        return true;
      }
      if (action.key === "update" && (!this.selectingUpgrade || this.upgrade.state.kind === "idle")) {
        this.selected = actions.indexOf(action);
        this.upgrade.invalidate();
        void this.checkUpgrade(app);
        return true;
      }
      const upgrade = this.upgrade.state;
      if (action.key === "update" && upgrade.kind !== "ready") {
        app.toast("warn", upgrade.kind === "error" ? `${upgrade.message}；按 r 重试` : "正在检查远端，请稍后确认升级");
        return true;
      }
      const preview = action.key === "update" && upgrade.kind === "ready" ? upgrade.value : null;
      const git = action.key === "update" ? preview?.git ?? null : this.state.kind === "ready" ? this.state.value : null;
      const spec = action.confirm(app, git, preview?.targetSha);
      if (spec) {
        // 没有可执行步骤的 spec（升级被工作区拦下这类）只是用来解释为什么不能做，
        // 让它走同一个确认框，但确认后什么也不执行。
        const blocked = spec.steps.length === 1 && spec.untouched === undefined;
        const ok = await app.confirm(spec);
        if (!ok || blocked) {
          if (!ok) app.toast("idle", "已取消");
          return true;
        }
      }
      const interactive = typeof action.interactive === "function" ? action.interactive(app) : action.interactive;
      const code = interactive
        ? await app.runInteractive(action.label, action.args(app))
        : await app.run(action.label, action.args(app));
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? `${action.label}完成` : `${action.label}未成功（退出码 ${code}）`);
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme } = ctx;
    const upgrade = this.upgrade.state;
    const preview = this.selectingUpgrade && upgrade.kind === "ready" ? upgrade.value : null;
    const git = this.selectingUpgrade ? preview?.git ?? null : this.state.kind === "ready" ? this.state.value : null;
    const actions = this.availableActions;
    const action = actions[this.selected]!;
    const spec = action.confirm(ctx, git, preview?.targetSha);
    const blocked = action.key === "update" && (!git || git.dirty);
    const versionNotice = this.state.kind === "error" ? this.state.message : "版本读取中…（升级暂不可用）";
    const details = action.key === "update" && upgrade.kind !== "ready" ? [
      theme.bold(upgrade.kind === "error" ? `远端检查失败：${upgrade.message}` : "正在检查 origin/main 最新提交…"),
      upgrade.kind === "error" ? "按 r 重新检查；检查成功后才可升级。" : "检查完成后按 Enter 确认升级；其他服务操作和页面切换仍可使用。",
    ] : [
      theme.bold(blocked ? spec!.subject : action.summary),
      theme.c(spec?.danger || blocked ? "warn" : "accent", spec ? "影响：" + spec.steps[0] : "启动完成后检查服务是否就绪"),
      "",
      ...(spec ? [theme.bold("执行步骤"), ...spec.steps.map((step, i) => `${i + 1}. ${step}`),
        ...(spec.recovery ? ["", "恢复说明：" + spec.recovery] : [])] : ["启动机器人，等待健康检查通过。"]),
      ...(action.key === "update" && git && git.behind > 0 ? [
        "", theme.bold(`待应用的提交（${git.behind}，本次检查）`),
        ...git.incoming.map(commit => `${commit.sha}  ${commit.subject}`),
      ] : []),
    ];
    const version = this.selectingUpgrade ? (preview
      ? `当前 ${fmt.shortSha(preview.git.sha)} → origin/main ${fmt.shortSha(preview.targetSha)}`
      : upgrade.kind === "ready" ? "非 git 部署，升级不可用" : upgrade.kind === "error" ? "远端检查失败，请按 r 重试" : "正在检查远端版本…")
      : this.state.kind !== "ready" ? versionNotice : git?.dirty ? "工作区有改动，升级会被拒绝"
      : git ? `${fmt.shortSha(git.sha)} · ${git.behind > 0 ? `待更新 ${git.behind} 个提交（上次同步）` : git.ahead > 0 ? "本地有领先提交" : git.behind < 0 ? "尚无远端对照" : "与上次同步一致"}`
        : "非 git 部署，升级不可用";
    const note = !this.selectingUpgrade && this.refreshing && this.state.kind === "ready" ? `${version} · ${versionNotice}` : version;
    return actionWorkbench(ctx, { title: "服务与部署", items: actions, selected: this.selected, details, note });
  }
}
