// 外链与通讯录同步。
//
// 这两页不自己解析数据，而是把现有命令的原文输出显示在执行面板里。理由是那两个脚本的输出
// 本来就是为人读的中文说明——外链那段会讲清「到期是删文件还是只让签名失效」，通讯录那段会
// 讲清待确认撤销是哪一轮、多少人。把它们拆成表格，等于把这些说明丢掉，再自己编一套同样意思的话。
//
// 界面在这里提供的是「不用记参数」：每条命令要什么参数、危险在哪，列成菜单并在执行前问清楚。

import type { StatusName } from "../render/theme.ts";
import type { AppApi, View, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";

interface Command {
  label: string;
  summary: string;
  status: StatusName;
  /** 按顺序询问参数，群名中的空格不会被拆成多个参数；默认必填，optional 的可以留空（传空字符串）。 */
  ask?: (string | { label: string; optional: true })[];
  /** 不需确认、但会改动外部状态的操作，替代「只读查看」的说明。 */
  effect?: string;
  /** 向导类命令需要真正的终端（隐藏输入、确认提问），交给 runInteractive。 */
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

const askLabel = (question: NonNullable<Command["ask"]>[number]) => typeof question === "string" ? question : question.label;

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
    for (const question of command.ask ?? []) {
      const answer = await app.ask(askLabel(question));
      if (answer === null) {
        app.toast("idle", "已取消");
        return true;
      }
      if (!answer.trim() && typeof question === "string") {
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

    const code = command.interactive ? await app.runInteractive(command.label, command.args(values))
      : await app.run(command.label, command.args(values));
    app.toast(code === 0 ? "ok" : "danger", code === 0
      ? `${command.label}完成`
      : `${command.label}退出码 ${code}`);
    return true;
  }

  render(ctx: ViewContext): string[] {
    const command = this.commands[this.selected]!;
    return actionWorkbench(ctx, {
      title: this.title, items: this.commands, selected: this.selected,
      details: [
        ctx.theme.bold(command.summary),
        ctx.theme.c(command.danger || command.interactive ? "warn" : "ok", command.danger ? "修改操作 · 执行前需确认" : command.effect ?? "只读查看"),
        "",
        ...(command.ask?.length ? ["需要提供：" + command.ask.map(askLabel).join("、"), ""] : []),
        this.intro,
      ],
      note: command.danger ? "Enter 填写范围并查看确认步骤" : "Enter 查看结果 · 支持滚动回看完整输出",
    });
  }
}

export function createRelayView(): View {
  return new CommandMenu(
    "relay",
    "外链",
    "大文件外链",
    "这里修改外链配置，并查看、测试和清理已生成的外链；配置也可在「系统 → 设置 → 外链配置」修改。" +
      "清理只删后端对象和索引记录，已经发进群里的旧链接不会因此复活或消失。" +
      "测试不需停机，修改配置或云端权限、生命周期后用它验收。",
    [
      {
        label: "修改外链配置",
        summary: "启用、修改或停用 S3 外链，保存前预览确认",
        status: "idle",
        effect: "向导 · 确认后短暂重启运行中的机器人，取消不修改",
        interactive: true,
        args: () => ["relay-configure"],
      },
      {
        label: "列出在册外链",
        summary: "旧的排在前面，附有效期规则说明",
        status: "idle",
        args: () => ["relay-ls"],
      },
      {
        label: "测试外链",
        summary: "上传 8 MiB 随机文件，检查下载、私有访问和删除",
        status: "idle",
        effect: "在线检查 · 测试对象检查完即删除",
        args: () => ["relay-test"],
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
            "不属于当前 S3 后端的记录会保留",
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

export function createDirectoryView(): View {
  return new CommandMenu(
    "directory",
    "通讯录",
    "通讯录同步",
    "机器人按开放平台通讯录把成员的平台 ID 对应到手机号，统计和会话都按手机号归属。每天 03:00 完整同步一次，" +
      "遇到未知成员时也会触发。一轮里缺席的成员太多时（例如接口异常或权限变化），本轮不撤销，等管理员核对后确认。" +
      "通讯录很大时可以只同步选定的部门及其子部门：先「列出部门」找到部门 ID，再「设置同步范围」。",
    [
      {
        label: "查看 Stream 与同步状态",
        summary: "事件 Stream 连接、映射数量、最近同步和待确认撤销",
        status: "idle",
        args: () => ["directory"],
      },
      {
        label: "确认暂停的撤销",
        summary: "填写状态里显示的轮次；服务重新完整扫描后才撤销",
        status: "warn",
        ask: ["待确认撤销的轮次（见「查看 Stream 与同步状态」）"],
        danger: ([scanId]) => ({
          subject: `确认第 ${scanId} 轮暂停的撤销`,
          steps: [
            "只接受最近一次暂停的那一轮；之后又同步过时需要重新查看",
            "服务立即重新完整扫描通讯录",
            "缺席成员全部在该轮名单内时撤销他们的映射；名单外又有人缺席时再次暂停",
          ],
          untouched: ["统计账本和会话历史", "仍在通讯录中的成员"],
          recovery: "被撤销的成员重新出现在通讯录后，下一次同步自动恢复映射",
        }),
        args: ([scanId]) => ["directory-confirm", scanId!],
      },
      {
        label: "列出部门",
        summary: "某个部门的直属子部门：ID、人数、名称；用来选择同步范围",
        status: "idle",
        ask: [{ label: "上级部门 ID（留空为根部门）", optional: true }],
        args: ([parent]) => parent ? ["directory-departments", parent] : ["directory-departments"],
      },
      {
        label: "设置同步范围",
        summary: "只同步选定的部门及其子部门，留空为整个通讯录；范围有变化时立即重新同步",
        status: "warn",
        ask: [{ label: "部门 ID（多个用逗号分隔；留空为整个通讯录）", optional: true }],
        danger: ([departments]) => ({
          subject: departments ? `只同步部门 ${departments} 及其子部门` : "同步整个通讯录",
          steps: [
            ...(departments ? ["服务先向平台核对每个部门，任何一个不存在或无权读取都不改"] : []),
            "与现有范围相同则不改、不重新同步；否则保存范围，正在进行的同步中止，按新范围立即重新同步",
            "范围外成员的映射在这一轮完整同步后撤销；超过撤销阈值时暂停，等你确认",
          ],
          untouched: ["统计账本和会话历史", "范围内成员已有的映射"],
          recovery: "重新设置范围（留空为整个通讯录）后，下一轮同步恢复被撤销成员的映射",
        }),
        args: ([departments]) => departments ? ["directory-scope", departments] : ["directory-scope"],
      },
    ]
  );
}
