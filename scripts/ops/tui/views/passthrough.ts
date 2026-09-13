// 外链与回调路由。
//
// 这两页不自己解析数据，而是把现有命令的原文输出显示在执行面板里。理由是那两个脚本的输出
// 本来就是为人读的中文说明——外链那段会讲清「到期是删文件还是只让签名失效」，路由那段会
// 讲清指纹冲突意味着什么。把它们拆成表格，等于把这些说明丢掉，再自己编一套同样意思的话。
//
// 界面在这里提供的是「不用记参数」：每条命令要什么参数、危险在哪，列成菜单并在执行前问清楚。

import { box, mark, table } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import type { StatusName } from "../render/theme.ts";
import { wrap } from "../render/widgets.ts";
import type { AppApi, View, ViewContext } from "../view.ts";
import { gap, moveSelection } from "./common.ts";

interface Command {
  label: string;
  summary: string;
  status: StatusName;
  /** 按顺序询问必填参数，群名中的空格不会被拆成多个参数。 */
  ask?: string[];
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
      ["⏎", "执行"],
    ];
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    const moved = moveSelection(key.name, this.selected, this.commands.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }
    if (key.name !== "enter") return false;

    const command = this.commands[this.selected];
    if (!command) return true;

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

    const code = await app.run(command.label, command.args(values));
    app.toast(code === 0 ? "ok" : "danger", code === 0 ? `${command.label}完成` : `${command.label}退出码 ${code}`);
    return true;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total } = ctx;
    const out = box(theme, {
      width: total,
      title: this.title,
      accent: "accent",
      body: table(theme, {
        width: total - 4,
        rows: this.commands,
        selected: this.selected,
        columns: [
          { header: "", size: 2, render: (command) => mark(theme, command.status) },
          { header: "", size: Math.max(12, Math.floor(total * 0.2)), render: (command) => command.label },
          { header: "", flex: 1, render: (command) => theme.c("muted", command.summary) },
        ],
      }).slice(1),
    });
    out.push(gap(total));
    out.push(...wrap(this.intro, total - 2).map((line) => pad(` ${theme.c("muted", line)}`, total)));
    return out;
  }
}

export function createRelayView(): View {
  return new CommandMenu(
    "relay",
    "外链",
    "大文件外链",
    "未配置 data/config/relay.json 时该特性关闭，这里的命令会直接报「未启用」。" +
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
    ]
  );
}

export function createRoutesView(): View {
  return new CommandMenu(
    "routes",
    "路由",
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
