// 维护。升级、起停、修隧道、卸载。
//
// 每一项都先把「会发生什么」摆出来再执行——这些命令的后果差异很大，从「重启一下」到
// 「删掉容器和数据」都有，而它们在菜单里只差两行。确认框里写的是这一条实际会做的事，
// 不是一句通用的「确定吗」。
//
// 升级那条尤其如此：它会把代码快进到 origin/main 再交给 deploy 重建镜像换容器，失败还会
// 自动回滚。这些在命令行里是跑起来才知道的，这里在按下去之前就列出来，并且把待应用的提交
// 一条条显示出来。

import { box, mark, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import type { StatusName } from "../render/theme.ts";
import * as fmt from "../render/format.ts";
import { loadGit, type GitState } from "../data.ts";
import type { AppApi, ConfirmSpec, Loading, View, ViewContext } from "../view.ts";
import { gap, moveSelection, pending } from "./common.ts";

interface Action {
  key: string;
  label: string;
  summary: string;
  /** 只在这些平台上出现；不给表示两个平台都有。 */
  only?: "windows" | "linux";
  status: StatusName;
  /** 该命令会向用户提问，必须拿到真正的 TTY（update 转调的 deploy.sh 全程交互）。 */
  interactive?: boolean;
  confirm(app: AppApi, git: GitState | null): ConfirmSpec | null;
  args(app: AppApi): string[];
}

const ACTIONS: Action[] = [
  {
    key: "update",
    label: "升级",
    summary: "同步 origin/main，重建并切换，失败自动回滚",
    status: "busy",
    interactive: true,
    confirm: (app, git) => {
      if (!git) {
        return {
          title: "升级",
          subject: "这份部署不是 git 仓库，无法自动升级",
          steps: ["请改用 git clone 重新部署后再使用升级"],
        };
      }
      if (git.dirty) {
        return {
          title: "升级",
          subject: "已跟踪文件有未提交改动，升级会被拒绝",
          steps: ["先提交、撤销（git restore <文件>）或备份这些改动，再回来升级"],
        };
      }
      const steps =
        git.behind > 0
          ? [
              `快进到 origin/main（${git.behind} 个提交）`,
              app.deployment.runtime === "docker"
                ? "交给 deploy.sh 重建镜像并切换容器"
                : "重装依赖并重启计划任务",
              "失败时自动回滚代码，并恢复升级前的容器/服务",
              "完成后自动跑一次体检",
            ]
          : ["代码已是最新；会询问是否仍然重启", "完成后自动跑一次体检"];
      return {
        title: "升级",
        subject:
          git.behind > 0
            ? `${fmt.shortSha(git.sha)} → origin/main，共 ${git.behind} 个提交`
            : `已经是最新（${fmt.shortSha(git.sha)}）`,
        steps,
        untouched: ["data/ 下的配置与群数据", "会话历史"],
        recovery: "失败时自动回滚代码并恢复原容器；部署过程中服务会短暂中断",
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
      steps: ["停止当前实例（正在处理的任务会被中断）", "重新启动并等待本地健康检查返回 200"],
      untouched: ["配置", "会话历史", "群数据"],
      recovery: "无需恢复；重启不改任何数据",
    }),
    args: () => ["restart"],
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

export class MaintainView implements View {
  readonly id = "maintain";
  readonly label = "维护";
  private state: Loading<GitState | null> = { kind: "idle" };
  private selected = 0;
  private platform: "windows" | "linux" = "linux";

  private get actions(): Action[] {
    return ACTIONS.filter((action) => !action.only || action.only === this.platform);
  }

  hints(): [string, string][] {
    return [
      ["↑↓", "选择"],
      ["⏎", "执行"],
    ];
  }

  async refresh(app: AppApi): Promise<void> {
    this.platform = app.deployment.platform;
    this.state = { kind: "loading" };
    app.redraw();
    this.state = { kind: "ready", value: await loadGit() };
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    const actions = this.actions;
    const moved = moveSelection(key.name, this.selected, actions.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }
    if (key.name === "enter") {
      const action = actions[this.selected];
      if (!action) return true;
      const git = this.state.kind === "ready" ? this.state.value : null;
      const spec = action.confirm(app, git);
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
      const code = action.interactive
        ? await app.runInteractive(action.label, action.args(app))
        : await app.run(action.label, action.args(app));
      app.toast(code === 0 ? "ok" : "danger", code === 0 ? `${action.label}完成` : `${action.label}未成功（退出码 ${code}）`);
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total } = ctx;
    const waiting = pending(theme, total, this.state, "");
    if (waiting && this.state.kind === "loading") return waiting;
    const git = this.state.kind === "ready" ? this.state.value : null;
    const actions = this.actions;

    const out = box(theme, {
      width: total,
      title: "维护",
      note: ctx.deployment.runtime === "docker" ? "Docker 部署" : "计划任务部署",
      accent: "accent",
      body: table(theme, {
        width: total - 4,
        rows: actions,
        selected: this.selected,
        columns: [
          { header: "", size: 2, render: (action) => mark(theme, action.status) },
          { header: "", size: Math.max(10, Math.floor(total * 0.16)), render: (action) => action.label },
          { header: "", flex: 1, render: (action) => theme.c("muted", action.summary) },
        ],
      }).slice(1),
    });

    // 待应用的提交：升级前最该看清楚的东西，不该等到执行日志里才滚过去。
    if (git && git.behind > 0) {
      const room = Math.max(1, ctx.height - out.length - 3);
      out.push(gap(total));
      out.push(
        ...box(theme, {
          width: total,
          title: `待应用的提交（${git.behind}）`,
          note: git.incoming.length > room ? `显示前 ${room} 条` : undefined,
          accent: "warn",
          body: git.incoming
            .slice(0, room)
            .map((commit) => `${theme.c("muted", commit.sha)}  ${commit.subject}`),
        })
      );
    } else if (git) {
      out.push(gap(total));
      out.push(
        pad(
          ` ${mark(theme, "ok")} ${theme.c("muted", `已是 origin/main 最新版本（${fmt.shortSha(git.sha)}）`)}`,
          total
        )
      );
    }
    return out;
  }
}
