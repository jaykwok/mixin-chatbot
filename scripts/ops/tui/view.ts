// 视图契约。
//
// 每个页面只做三件事：报出自己需要的数据（refresh）、把状态画成若干行（render）、处理自己
// 的按键（onKey）。导航、确认框、子进程执行、提示条都由 app 统一提供——九个页面各写一套
// 确认逻辑，迟早会有一个页面忘了问「你确定吗」。

import type { Key } from "./render/screen.ts";
import type { StatusName, Theme } from "./render/theme.ts";
import type { Deployment } from "./platform.ts";

export interface ViewContext {
  theme: Theme;
  /** 可用宽度（整个终端宽度）。 */
  width: number;
  /** 正文区可用行数，已扣掉页眉、导航和页脚。 */
  height: number;
  deployment: Deployment;
}

/** 危险操作的确认框。字段是刻意分成这几项的，见 app.ts 里的说明。 */
export interface ConfirmSpec {
  title: string;
  /** 目标是什么，一行说清。 */
  subject: string;
  /** 会依次发生什么。 */
  steps: string[];
  /** 不受影响的东西；列出来比不列更能让人敢按下去。 */
  untouched?: string[];
  /** 能否撤销，以及怎么撤销。 */
  recovery?: string;
  /** 要求原样输入这段文字才放行；不给则回车即确认。 */
  typeToConfirm?: string;
  danger?: boolean;
}

/** 选择菜单只返回选择，不直接执行操作；调用方继续走原有确认与执行通道。 */
export interface Choice {
  value: string;
  label: string;
  description?: string;
  danger?: boolean;
  disabled?: boolean;
}

export interface SelectSpec {
  title: string;
  description?: string;
  choices: Choice[];
  initial?: string;
}

/** value 对应本页 onKey 的键名，菜单与快捷键共用同一份操作逻辑。 */
export type ViewAction = Choice;

export interface AppApi {
  theme: Theme;
  deployment: Deployment;
  /** 底部提示一条消息，几秒后自己消失。 */
  toast(status: StatusName, text: string): void;
  /** 弹确认框，等用户决定。 */
  confirm(spec: ConfirmSpec): Promise<boolean>;
  /** 要一行输入。空字符串表示留空，null 表示取消。 */
  ask(label: string, initial?: string): Promise<string | null>;
  /** 支持方向键与文字筛选的选择菜单，Esc 返回 null。 */
  choose(spec: SelectSpec): Promise<string | null>;
  /** 跑一条运维命令，实时显示每一行输出；返回退出码。仅用于不会向用户提问的命令。 */
  run(title: string, args: string[]): Promise<number>;
  /**
   * 退出全屏、把终端整个交给子进程，结束后回到界面。
   *
   * 部署、升级、Linux 重建修复和卸载需要真正的 TTY，不能放进关闭 stdin 的执行面板。
   */
  runInteractive(title: string, args: string[]): Promise<number>;
  /** 用宿主机默认应用打开导出的文件；失败时仍保留路径。 */
  openFile(path: string): Promise<void>;
  /** 请求重绘（数据异步到达后调用）。 */
  redraw(): void;
  /** 切到另一个页面。 */
  go(view: string): void;
}

export interface View {
  id: string;
  /** 导航栏上的标签。 */
  label: string;
  render(ctx: ViewContext): string[];
  /** 本页特有的按键提示；通用键由 app 补。 */
  hints(): [string, string][];
  /** 空格操作菜单；只列出当前上下文可用的动作。 */
  actions?(): ViewAction[];
  /** 进入本页或按 r 时调用。 */
  refresh?(app: AppApi): Promise<void>;
  /** 运维操作结束后丢弃已失效的快照和在途读取；隐藏页面等重入时再加载。 */
  invalidate?(): void;
  /** refresh 之外的后台工作；返回提示文字，由 App 持续显示加载动画。 */
  activity?(): string | null;
  /** 内存中尚未提交的编辑；退出 TUI 前由 App 统一提醒。 */
  hasUnsavedChanges?(): boolean;
  /** 离开时停止轮询；返回 true 表示当前读取已失效，重入时需要补一次刷新。 */
  onLeave?(): boolean | void;
  /** 返回 true 表示按键已被消费，app 不再继续处理。 */
  onKey?(key: Key, app: AppApi): boolean | Promise<boolean>;
}

/** 按管理员任务组织主分区；App 记住每个分区最后查看的子页。 */
export interface Section {
  id: string;
  label: string;
  views: View[];
}

/** 数据加载的三种状态。界面要能区分「还在读」和「读到了但是空的」。 */
export type Loading<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };
