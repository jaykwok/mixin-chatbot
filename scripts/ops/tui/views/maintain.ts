// 部署、升级、启停、修复和卸载入口；执行前展示各自的范围与恢复方式。
// 选中升级后联网检查，预览使用本次同步的目标提交。
// 有未完成的部署或升级时，顶部提供继续和回滚，新的部署、升级和修复暂不可用。

import type { StatusName } from "../render/theme.ts";
import * as fmt from "../render/format.ts";
import { loadGit, loadUpgrade, type GitState, type UpgradeState } from "../data.ts";
import { describePendingTransaction, loadPendingTransaction } from "../transaction.ts";
import { confirmTransaction } from "../../../lib/confirmed-transaction.ts";
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
  /** 该命令会向用户提问，必须拿到真正的 TTY（update 的升级器在停机前确认隧道和迁移决策）。 */
  interactive?: boolean | ((app: AppApi) => boolean);
  confirm(app: Pick<AppApi, "deployment">, git: GitState | null, targetSha?: string): ConfirmSpec | null;
  args(app: AppApi, targetSha?: string): string[];
}

const ACTIONS: Action[] = [
  {
    key: "deploy",
    label: "部署 / 修改设置",
    summary: "配置并部署当前代码，失败恢复原部署",
    status: "busy",
    interactive: true,
    confirm: (app) => ({
      title: "部署 / 修改设置",
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
    label: "升级（保留设置）",
    summary: "同步 origin/main，停机前预览迁移，停机后切换代码并验证新实例",
    status: "busy",
    interactive: true,
    confirm: (app, git, targetSha) => {
      if (!git) {
        return {
          title: "升级（保留设置）",
          subject: "这份部署不是 git 仓库，无法自动升级",
          blocked: true,
          steps: ["先通过 Git 获取项目，再进入「系统 → 服务部署 → 部署 / 修改设置」；之后即可在此升级"],
        };
      }
      if (git.dirty) {
        return {
          title: "升级（保留设置）",
          subject: "已跟踪文件有未提交改动，升级会被拒绝",
          blocked: true,
          steps: ["先提交、撤销或备份本地代码改动，再进入「系统 → 服务部署 → 升级（保留设置）」"],
        };
      }
      const steps =
        git.behind > 0
          ? [
              "停机前由目标版本预览迁移并确认所需选择，写入事务记录",
              "停止旧实例，确认退出后才切换代码和更新依赖",
              `快进到 origin/main ${targetSha ? fmt.shortSha(targetSha) : ""}（${git.behind} 个提交）`,
              app.deployment.runtime === "docker"
                ? "保持停机，沿用现有配置重建镜像（改配置请用服务部署）"
                : "保持停机，按需安装依赖",
              "按停机前确认的计划迁移；同版本且标记配对时跳过数据迁移和数据库备份",
              "以只验证模式检查新实例，提交数据版本后恢复原运行状态",
            ]
          : ["核对本次确认的目标提交", "停机前检查数据版本并预览迁移", "停止旧实例；同版本且标记配对时跳过迁移和数据库备份，需要迁移时先备份再执行", "以只验证模式检查新实例，通过后提交并恢复原运行状态"];
      return {
        title: "升级（保留设置）",
        subject:
          git.behind > 0
            ? `${fmt.shortSha(git.sha)} → ${targetSha ? fmt.shortSha(targetSha) : "origin/main"}，共 ${git.behind} 个提交`
            : `当前 ${fmt.shortSha(git.sha)}；origin/main ${targetSha ? fmt.shortSha(targetSha) : "待检查"}`,
        steps,
        untouched: ["会话历史", "群共享资料"],
        recovery: "提交前失败会恢复数据、代码和原服务；恢复失败保持停机。提交后保留新版本并报告启动问题",
      };
    },
    args: (_app, targetSha) => {
      if (!targetSha) throw new Error("升级缺少已确认的目标提交，请重新检查版本");
      return ["update", targetSha];
    },
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
    key: "tunnel-update",
    label: "更新 cloudflared",
    summary: "更新本项目隧道连接器到官方稳定版，校验后切换，失败恢复旧版本",
    status: "warn",
    confirm: () => ({
      title: "更新 cloudflared",
      subject: "检查并更新本项目隧道连接器",
      steps: ["查询官方稳定版，下载并校验 SHA-256；无更新时直接结束", "核对连接器归属和启动参数，替换项目中的程序",
        "原来运行的隧道按原参数重启；原来停止的隧道保持停止"],
      recovery: "正在运行的隧道会短暂中断公网访问；替换或启动失败时恢复旧程序及运行状态。Windows 服务更新需管理员权限",
    }),
    args: () => ["tunnel-update"],
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

const ACTION_ORDER = ["resume", "rollback", "start", "restart", "stop", "update", "deploy", "repair", "tunnel-update", "repair-tunnel", "uninstall"];
/** 有未完成的事务时，这些入口会开始新的部署或升级，必须先继续或回滚。 */
const BLOCKED_BY_PENDING = new Set(["deploy", "update", "repair", "tunnel-update"]);
const PENDING_NOTICE = "有未完成的部署或升级：请先「继续上次操作」或「回滚上次操作」";

interface Pending { subject: string; record: string[]; committed: boolean; codeRestorePending: boolean; confirmation?: import("../../../lib/confirmed-transaction.ts").TransactionReadSet }

/** 继续和回滚都只使用事务记录；确认页列出记录内容。 */
function transactionActions(pending: Pending): Action[] {
  const { subject, record } = pending;
  return [
    {
      key: "resume",
      label: "继续上次操作",
      summary: pending.codeRestorePending ? "数据已经回滚，不能继续" : "沿用事务记录完成中断的部署或升级",
      status: "busy",
      interactive: true,
      confirm: () => !pending.confirmation ? { title: "继续上次操作", subject: "事务记录无法读取，请刷新后重试", blocked: true, steps: record } : pending.codeRestorePending ? {
        title: "继续上次操作",
        subject: "数据、配置和容器已经回滚，不能继续",
        blocked: true,
        steps: ["请使用「回滚上次操作」恢复升级前的代码"],
      } : ({
        title: "继续上次操作",
        subject,
        steps: ["沿用事务记录继续：不拉取新的 origin/main，不重新提问", ...record,
          pending.committed ? "数据已经提交：只启动新实例" : "完成迁移、验证和提交，再按原运行状态恢复服务"],
        untouched: ["会话历史", "群共享资料"],
        recovery: pending.committed ? "数据已提交，不能再回滚；启动失败时保留新版本并报告原因" : "失败时恢复到操作前；也可改用「回滚上次操作」",
      }),
      args: () => ["resume", "--confirmed-transaction", confirmTransaction(pending.confirmation!, "continue")],
    },
    {
      key: "rollback",
      label: "回滚上次操作",
      summary: pending.committed ? "数据已经提交，不能回滚"
        : pending.codeRestorePending ? "只恢复升级前的代码（数据、配置和容器已经回滚）" : "恢复到操作前的代码、数据和运行状态",
      status: "warn",
      interactive: true,
      confirm: () => !pending.confirmation ? { title: "回滚上次操作", subject: "事务记录无法读取，请刷新后重试", blocked: true, steps: record } : pending.committed ? {
        title: "回滚上次操作",
        subject: "数据已经提交，不能回滚",
        blocked: true,
        steps: ["请使用「继续上次操作」完成新实例启动"],
      } : pending.codeRestorePending ? {
        title: "完成回滚",
        subject,
        steps: ["把代码恢复到升级前的提交", "数据、配置、容器和原运行状态已经恢复，不再重复", ...record],
        recovery: "代码恢复失败时保留事务，处理 git 问题后可重试回滚",
        danger: true,
      } : {
        title: "回滚上次操作",
        subject,
        steps: ["停止当前实例，恢复迁移前的数据", "恢复操作前的代码、配置、依赖和网络入口", ...record, "按原运行状态恢复服务"],
        recovery: "回滚失败时保持停机并保留快照，处理后可重试回滚或改为继续",
        danger: true,
      },
      args: () => ["rollback", "--confirmed-transaction", confirmTransaction(pending.confirmation!, "rollback")],
    },
  ];
}

export class MaintainView implements View {
  readonly id = "maintain";
  readonly label = "服务部署";
  private state: Loading<GitState | null> = { kind: "idle" };
  private refreshing = false;
  private revision = 0;
  private readonly upgrade = new LazySetting<UpgradeState | null>(signal => loadUpgrade(signal));
  private selected = 0;
  private platform: "windows" | "linux" = "linux";
  private pending: Pending | null = null;

  private get waitingForVersion(): boolean { return this.refreshing || this.state.kind !== "ready"; }
  private get selectingUpgrade(): boolean { return !this.pending && this.availableActions[this.selected]?.key === "update"; }

  /** 同步读取事务指针；出现或消失时把焦点移回第一项。 */
  private loadPending(): void {
    let pending: Pending | null;
    try {
      const value = loadPendingTransaction();
      pending = value && { ...describePendingTransaction(value), committed: value.committed, codeRestorePending: value.codeRestorePending, confirmation: value.confirmation };
    } catch (error) {
      // 记录无法读取时仍提供两个入口，由脚本报告具体原因。
      pending = { subject: "未完成的部署或升级", record: [`事务记录无法读取：${(error as Error).message}`], committed: false, codeRestorePending: false };
    }
    if (!!pending !== !!this.pending) this.selected = 0;
    this.pending = pending;
  }

  activity(): string | null { return this.upgrade.state.kind === "loading" ? "正在检查 origin/main 最新提交…" : null; }

  invalidate(): void {
    this.revision++;
    this.state = { kind: "idle" };
    this.refreshing = false;
    this.upgrade.invalidate();
  }

  onLeave(): boolean { this.invalidate(); return true; }

  private get availableActions(): Action[] {
    return [...(this.pending ? transactionActions(this.pending) : []), ...ACTIONS]
      .filter((action) => !action.only || action.only === this.platform)
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
      danger: action.status === "danger" || action.key === "stop" || action.key === "repair-tunnel" || action.key === "rollback",
      disabled: this.pending ? BLOCKED_BY_PENDING.has(action.key) || (action.key === "rollback" && this.pending.committed)
        || (action.key === "resume" && this.pending.codeRestorePending)
        : action.key === "update" && (this.selectingUpgrade ? this.upgrade.state.kind !== "ready" : this.waitingForVersion),
    }));
  }

  async refresh(app: AppApi): Promise<void> {
    this.platform = app.deployment.platform;
    this.loadPending();
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
      if (this.pending && BLOCKED_BY_PENDING.has(action.key)) {
        app.toast("warn", PENDING_NOTICE);
        return true;
      }
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
        const ok = await app.confirm(spec);
        if (!ok || spec.blocked) {
          if (!ok) app.toast("idle", "已取消");
          return true;
        }
      }
      const interactive = typeof action.interactive === "function" ? action.interactive(app) : action.interactive;
      const code = interactive
        ? await app.runInteractive(action.label, action.args(app, preview?.targetSha))
        : await app.run(action.label, action.args(app, preview?.targetSha));
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? `${action.label}完成` : `${action.label}未成功（退出码 ${code}）`);
      this.loadPending();
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
    const blocked = spec?.blocked === true;
    const versionNotice = this.state.kind === "error" ? this.state.message : "版本读取中…（升级暂不可用）";
    const details = this.pending && BLOCKED_BY_PENDING.has(action.key) ? [
      theme.bold(action.summary),
      theme.c("warn", PENDING_NOTICE),
      "",
      this.pending.subject,
      ...this.pending.record,
    ] : action.key === "update" && upgrade.kind !== "ready" ? [
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
