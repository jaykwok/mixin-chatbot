// 部署、升级、启停、修复和卸载入口；执行前展示各自的范围与恢复方式。
// 选中升级后联网检查，预览使用本次同步的目标提交。
// 有未完成的部署或升级时，顶部提供继续和回滚，新的部署、升级和修复暂不可用。

import type { StatusName } from "../render/theme.ts";
import * as fmt from "../render/format.ts";
import { loadGit, loadUpgrade, tuiCodeChanged, type GitState, type UpgradeState } from "../data.ts";
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
  /** 该命令会向用户提问，必须拿到真正的 TTY（例如 update 确认切换到 main）。 */
  interactive?: boolean | ((app: AppApi) => boolean);
  confirm(app: Pick<AppApi, "deployment">, git: GitState | null, targetSha?: string): ConfirmSpec | null;
  args(app: AppApi, targetSha?: string): string[];
}

const ACTIONS: Action[] = [
  {
    key: "deploy",
    label: "重新部署",
    summary: "重新确认端口、共享资料目录、应用凭据和模型并部署当前代码，失败恢复原部署",
    status: "busy",
    interactive: true,
    confirm: (app) => ({
      title: "重新部署",
      subject: "运行当前版本的部署向导",
      steps: ["确认本机端口、共享资料目录和模型，默认沿用已有配置；缺少应用机器人凭据时先填写",
        app.deployment.runtime === "docker" ? "构建镜像并切换容器" : "安装依赖并注册计划任务",
        "检查新实例就绪状态，失败时恢复部署前的配置和服务"],
      untouched: ["会话历史", "使用统计", "共享资料"],
      recovery: "替换期间服务会短暂中断；尚未安装 Bun 和项目依赖的机器需先完成环境安装",
    }),
    args: () => ["deploy"],
  },
  {
    key: "update",
    label: "升级",
    summary: "同步 origin/main，由目标升级器检查数据版本并执行升级",
    status: "busy",
    interactive: true,
    confirm: (app, git, targetSha) => {
      if (!git) {
        return {
          title: "升级",
          subject: "这份部署不是 git 仓库，无法自动升级",
          blocked: true,
          steps: ["先通过 Git 获取项目，再进入「系统 → 服务部署 → 重新部署」；之后即可在此升级"],
        };
      }
      if (git.dirty) {
        return {
          title: "升级",
          subject: "已跟踪文件有未提交改动，升级会被拒绝",
          blocked: true,
          steps: ["先提交、撤销或备份本地代码改动，再进入「系统 → 服务部署 → 升级」"],
        };
      }
      const steps = [
        "交给与 ops update 相同的目标升级器；停机前核对部署记录和数据格式",
        "数据格式一致时升级，保留设置、会话、资料和使用统计",
        "目标的数据格式不同或目录没有有效部署记录时拒绝升级并保留现场，需在新目录全新部署",
        git.behind > 0 ? `快进到 origin/main ${targetSha ? fmt.shortSha(targetSha) : ""}（${git.behind} 个提交）` : "核对本次确认的目标提交",
        app.deployment.runtime === "docker" ? "准备目标镜像，按已保存计划切换数据" : "安装目标依赖，按已保存计划切换数据",
        "验证新实例，提交后恢复原运行状态",
      ];
      return {
        title: "升级",
        subject:
          git.behind > 0
            ? `${fmt.shortSha(git.sha)} → ${targetSha ? fmt.shortSha(targetSha) : "origin/main"}，共 ${git.behind} 个提交`
            : `当前 ${fmt.shortSha(git.sha)}；origin/main ${targetSha ? fmt.shortSha(targetSha) : "待检查"}`,
        steps,
        untouched: ["已入账统计（含提问次数、人数）", "会话、资料和全部设置"],
        recovery: "提交前失败恢复数据、代码和原服务；提交后启动失败，使用「继续上次操作」收尾",
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
      untouched: ["配置", "会话历史", "使用统计", "共享资料"],
      recovery: "无需恢复；重启不改任何数据",
    }),
    args: () => ["restart"],
  },
  {
    key: "repair",
    label: "修复部署",
    summary: "Windows 修复计划任务；Linux 通过部署向导重建",
    status: "warn",
    interactive: app => app.deployment.platform === "linux",
    confirm: app => ({
      title: "修复部署",
      subject: app.deployment.platform === "windows" ? "修复可确定的部署问题" : "按当前代码重建部署",
      steps: app.deployment.platform === "windows"
        ? ["检查并修复计划任务", "完成后重新体检"]
        : ["进入部署向导，回车沿用当前配置", "重新构建镜像并切换容器，核对实例健康", "失败时恢复原部署"],
      untouched: ["会话历史", "使用统计", "共享资料"],
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
      untouched: ["配置", "会话历史", "使用统计", "共享资料"],
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
    key: "uninstall",
    label: "卸载",
    summary: "删除容器/任务，可选删除镜像与数据",
    status: "danger",
    interactive: true,
    confirm: (app) => ({
      title: "卸载",
      subject: "卸载 mixin-chatbot",
      steps: [
        app.deployment.runtime === "docker" ? "停止并删除容器" : "停止并注销计划任务",
        app.deployment.runtime === "docker" ? "随后逐项询问：是否删除镜像、是否删除 data/ 与 logs/" : "随后询问：是否删除 data/ 与 logs/",
        "每一项都要单独确认，不会一次全删",
      ],
      untouched: ["外部共享资料目录（若配置在项目外，不会被删除）"],
      recovery: "选择删除 data/ 时文件会移入 backup/rm，不是直接删除",
      typeToConfirm: "卸载",
      danger: true,
    }),
    args: () => ["uninstall"],
  },
];

const ACTION_ORDER = ["resume", "rollback", "start", "restart", "stop", "update", "deploy", "repair", "uninstall"];
/** 有未完成的事务时，这些入口会开始新的部署或升级，必须先继续或回滚。 */
const BLOCKED_BY_PENDING = new Set(["deploy", "update", "repair"]);
/** 标记的含义：服务部署页的菜单栏底部显示。 */
const LEGEND = ["✓ 不中断", "● 短暂中断", "! 停止服务", "✗ 不可逆", "○ 当前不需要"];

/** 按页眉的服务探测调整启动、停止、重启的显示；探测只用于提示，执行仍交给运维脚本核对。 */
function withServiceState(action: Action, service: ViewContext["service"]): Action {
  if (!service) return action;
  const running = service.state === "ready";
  if (action.key === "start" && running) return { ...action, status: "idle", summary: "机器人已在运行，无需启动；需要时用「重启」" };
  if ((action.key === "stop" || action.key === "restart") && service.state === "unreachable") {
    return { ...action, status: "idle", summary: action.key === "stop" ? "机器人当前未运行，无需停止" : "机器人当前未运行；用「启动」拉起" };
  }
  return action;
}
const RESTART_NOTICE = "代码已更新：当前仍是启动时的旧版界面，按 q 退出后重新运行 bun run tui";
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
          pending.committed ? "数据已经提交：完成新实例启动" : "按已确认计划准备数据、验证并提交，再恢复原运行状态"],
        untouched: ["已入账统计"],
        recovery: pending.committed ? "数据已提交，不能再回滚；启动失败时保留事务，可再次继续" : "失败时恢复到操作前；也可改用「回滚上次操作」",
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
        steps: ["请使用「继续上次操作」完成新实例启动和清理"],
      } : pending.codeRestorePending ? {
        title: "完成回滚",
        subject,
        steps: ["把代码恢复到升级前的提交", "数据、配置、容器和原运行状态已经恢复，不再重复", ...record],
        recovery: "代码恢复失败时保留事务，处理 git 问题后可重试回滚",
        danger: true,
      } : {
        title: "回滚上次操作",
        subject,
        steps: ["停止当前实例，恢复操作前的数据", "恢复操作前的代码、配置和依赖", ...record, "按原运行状态恢复服务"],
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
  /** 升级、继续或回滚改动了界面代码：提示退出后重新运行，直到本次界面结束。 */
  private restartNotice = false;

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
        ? "检查并修复计划任务" : "通过部署向导重建当前版本" } : action);
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
      danger: action.status === "danger" || action.key === "stop" || action.key === "rollback",
      disabled: this.pending ? BLOCKED_BY_PENDING.has(action.key) || (action.key === "rollback" && this.pending.committed)
        || (action.key === "resume" && this.pending.codeRestorePending)
        : action.key === "update" && (this.selectingUpgrade ? this.upgrade.state.kind !== "ready" : this.waitingForVersion),
    }));
  }

  /** 从总览跳来时选中指定操作（服务未运行时为「启动」）。 */
  focus(key: string): void {
    const index = this.availableActions.findIndex(action => action.key === key);
    if (index >= 0) this.selected = index;
  }

  async refresh(app: AppApi): Promise<void> {
    const selected = this.availableActions[this.selected]?.key;
    this.platform = app.deployment.platform;
    // 部署形态变化会增减操作：按操作标识保留选择，被隐藏的操作退到范围内的相邻项。
    const actions = this.availableActions, index = actions.findIndex(action => action.key === selected);
    this.selected = index >= 0 ? index : Math.min(this.selected, actions.length - 1);
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
      if (["update", "resume", "rollback"].includes(action.key)) void this.checkTuiCode(app);
      return true;
    }
    return false;
  }

  private async checkTuiCode(app: AppApi): Promise<void> {
    try {
      if (this.restartNotice || !await tuiCodeChanged()) return;
      this.restartNotice = true;
      app.toast("warn", RESTART_NOTICE);
    } catch { /* 只是提示；读取失败不影响已完成的操作 */ }
  }

  render(ctx: ViewContext): string[] {
    const { theme } = ctx;
    const upgrade = this.upgrade.state;
    const preview = this.selectingUpgrade && upgrade.kind === "ready" ? upgrade.value : null;
    const git = this.selectingUpgrade ? preview?.git ?? null : this.state.kind === "ready" ? this.state.value : null;
    const actions = this.availableActions.map(item => withServiceState(item, ctx.service));
    const action = actions[this.selected]!;
    const spec = action.confirm(ctx, git, preview?.targetSha);
    const blocked = spec?.blocked === true;
    const versionNotice = this.state.kind === "error" ? this.state.message : "版本读取中…（升级暂不可用）";
    const details = [...(this.restartNotice ? [theme.c("warn", RESTART_NOTICE), ""] : []), ...(this.pending && BLOCKED_BY_PENDING.has(action.key) ? [
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
    ])];
    const version = this.selectingUpgrade ? (preview
      ? `当前 ${fmt.shortSha(preview.git.sha)} → origin/main ${fmt.shortSha(preview.targetSha)}`
      : upgrade.kind === "ready" ? "非 git 部署，升级不可用" : upgrade.kind === "error" ? "远端检查失败，请按 r 重试" : "正在检查远端版本…")
      : this.state.kind !== "ready" ? versionNotice : git?.dirty ? "工作区有改动，升级会被拒绝"
      : git ? `${fmt.shortSha(git.sha)} · ${git.behind > 0 ? `待更新 ${git.behind} 个提交（上次同步）` : git.ahead > 0 ? "本地有领先提交" : git.behind < 0 ? "尚无远端对照" : "与上次同步一致"}`
        : "非 git 部署，升级不可用";
    const note = !this.selectingUpgrade && this.refreshing && this.state.kind === "ready" ? `${version} · ${versionNotice}` : version;
    return actionWorkbench(ctx, { title: "服务与部署", items: actions, selected: this.selected, details, note, legend: LEGEND });
  }
}
