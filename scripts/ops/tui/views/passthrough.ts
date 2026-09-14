// 外链与回调路由。
//
// 这两页不自己解析数据，而是把现有命令的原文输出显示在执行面板里。理由是那两个脚本的输出
// 本来就是为人读的中文说明——外链那段会讲清「到期是删文件还是只让签名失效」，路由那段会
// 讲清指纹冲突意味着什么。把它们拆成表格，等于把这些说明丢掉，再自己编一套同样意思的话。
//
// 界面在这里提供的是「不用记参数」：每条命令要什么参数、危险在哪，列成菜单并在执行前问清楚。

import type { StatusName } from "../render/theme.ts";
import type { AppApi, View, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";

interface Command {
  label: string;
  summary: string;
  status: StatusName;
  /** 按顺序询问必填参数，群名中的空格不会被拆成多个参数。 */
  ask?: string[];
  /** 配置向导接管终端，自行显示保存预览并隐藏密码。 */
  interactive?: boolean;
  /** 需要确认时给出说明；返回 null 表示只读操作，直接执行。 */
  danger?: (values: string[]) => {
    subject: string;
    steps: string[];
    untouched?: string[];
    recovery?: string;
    typeToConfirm?: string;
  };
  args(values: string[]): string[];
}

class CommandMenu implements View {
  private selected = 0;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly title: string,
    private readonly intro: string,
    private readonly commands: Command[]
  ) {}

  hints(): [string, string][] {
    return [
      ["↑↓", "选择"],
      ["Enter", "执行所选操作"],
    ];
  }

  actions(): ViewAction[] {
    return this.commands.map((command, index) => ({
      value: `command:${index}`, label: command.label, description: command.summary, danger: !!command.danger,
    }));
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    const moved = moveSelection(key.name, this.selected, this.commands.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }
    const command = key.name === "enter" ? this.commands[this.selected]
      : this.commands.find((_, index) => key.name === `command:${index}`);
    if (!command) return false;

    const values: string[] = [];
    for (const label of command.ask ?? []) {
      const answer = await app.ask(label);
      if (answer === null) {
        app.toast("idle", "已取消");
        return true;
      }
      if (!answer.trim()) {
        app.toast("warn", "此项不能为空，操作未执行");
        return true;
      }
      values.push(answer.trim());
    }

    if (this.id === "relay" && command.ask && values[0] === "--all") {
      app.toast("warn", "清理全部请使用「清理全部外链」菜单");
      return true;
    }

    if (command.danger) {
      const spec = command.danger(values);
      const ok = await app.confirm({ title: command.label, danger: true, ...spec });
      if (!ok) {
        app.toast("idle", "已取消");
        return true;
      }
    }

    const code = command.interactive
      ? await app.runInteractive(command.label, command.args(values))
      : await app.run(command.label, command.args(values));
    app.toast(code === 0 ? "ok" : "danger", code === 0
      ? command.interactive ? `${command.label}向导已结束` : `${command.label}完成`
      : `${command.label}退出码 ${code}`);
    return true;
  }

  render(ctx: ViewContext): string[] {
    const command = this.commands[this.selected]!;
    return actionWorkbench(ctx, {
      title: this.title, items: this.commands, selected: this.selected,
      details: [
        ctx.theme.bold(command.summary),
        ctx.theme.c(command.danger || command.interactive ? "warn" : "ok",
          command.interactive ? "交互配置 · 保存前预览并确认" : command.danger ? "修改操作 · 执行前需确认" : "只读查看"),
        "",
        ...(command.ask?.length ? ["需要提供：" + command.ask.join("、"), ""] : []),
        this.intro,
      ],
      note: command.interactive ? "Enter 打开配置向导 · 密码隐藏输入"
        : command.danger ? "Enter 填写范围并查看确认步骤" : "Enter 查看结果 · 支持滚动回看完整输出",
    });
  }
}

export function createRelayView(): View {
  return new CommandMenu(
    "relay",
    "外链",
    "大文件外链",
    "外链是可选功能，可用「配置外链」填写 WebDAV 与公开下载地址，或停用外链。" +
      "确认保存后重启原本运行中的机器人，取消不改变配置和服务。" +
      "清理只删后端对象和索引记录，已经发进群里的旧链接不会因此复活或消失。",
    [
      {
        label: "列出在册外链",
        summary: "旧的排在前面，附有效期规则说明",
        status: "idle",
        args: () => ["relay-ls"],
      },
      {
        label: "按关键字清理",
        summary: "只删文件名或地址包含该关键字的对象",
        status: "warn",
        ask: ["关键字（匹配文件名或地址）"],
        danger: ([value]) => ({
          subject: `删除包含「${value}」的外链对象`,
          steps: [
            "要求维护租约，运行中的机器人会阻止本操作",
            "删除后端对象并清掉索引记录",
            "删除失败的记录会保留，可以重试",
          ],
          untouched: ["不匹配的对象", "群里已发出的消息本身"],
          recovery: "不可恢复：对象从后端删除后无法找回",
        }),
        args: ([value]) => ["relay-purge", "--keyword", value!],
      },
      {
        label: "清理全部外链",
        summary: "删除当前后端全部在册对象",
        status: "danger",
        danger: () => ({
          subject: "删除当前后端的全部在册外链对象",
          steps: [
            "要求维护租约，运行中的机器人会阻止本操作",
            "逐个删除后端对象并清掉索引记录",
            "地址与当前 publicBaseUrl 对不上的记录会保留",
          ],
          untouched: ["群里已发出的消息本身"],
          recovery: "不可恢复：群成员点已发出的链接会得到失效地址",
          typeToConfirm: "全部清理",
        }),
        args: () => ["relay-purge", "--all"],
      },
      {
        label: "配置外链",
        summary: "启用、修改或停用外链；高级设置可选，确认后应用",
        status: "idle",
        interactive: true,
        args: () => ["relay-configure"],
      },
    ]
  );
}

export function createRoutesView(): View {
  return new CommandMenu(
    "routes",
    "回调路由",
    "回调路由",
    "一个 callback key 同时对应多个群就是冲突，机器人会拒绝跨群广播。" +
      "reset 前必须先在平台侧把配置改对，否则下一条入站消息会把冲突重新建起来。",
    [
      {
        label: "列出绑定与冲突",
        summary: "含完整指纹、冲突标记和容量",
        status: "idle",
        args: () => ["routes", "list"],
      },
      {
        label: "重绑到指定群",
        summary: "清除冲突并把指纹绑到一个群，需停机",
        status: "warn",
        ask: ["指纹（日志里的 12 位前缀即可）", "目标群号"],
        danger: ([fingerprint, group]) => {
          return {
            subject: `把 ${fingerprint} 重新绑定到群 ${group}`,
            steps: [
              "要求维护租约，运行中的机器人会阻止本操作",
              "清除该指纹上的冲突记录",
              "绑定到指定群",
            ],
            untouched: ["其他指纹的绑定", "会话历史"],
            recovery: "平台侧配置若仍是错的，下一条入站消息会重新造成冲突",
          };
        },
        args: ([fingerprint, group]) => {
          return ["routes", "reset", fingerprint!, "--group", group!];
        },
      },
      {
        label: "移除废弃绑定",
        summary: "释放容量；该 key 再次入站会重新建立绑定",
        status: "warn",
        ask: ["指纹（日志里的 12 位前缀即可）"],
        danger: ([value]) => ({
          subject: `移除指纹 ${value} 的绑定`,
          steps: ["要求维护租约，运行中的机器人会阻止本操作", "删除该绑定并释放一个容量位"],
          untouched: ["其他指纹的绑定", "会话历史"],
          recovery: "该 key 若再次入站，会自动重新建立绑定",
        }),
        args: ([value]) => ["routes", "forget", value!],
      },
    ]
  );
}
