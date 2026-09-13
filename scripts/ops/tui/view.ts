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

export interface AppApi {
  theme: Theme;
  deployment: Deployment;
  /** 底部提示一条消息，几秒后自己消失。 */
  toast(status: StatusName, text: string): void;
  /** 弹确认框，等用户决定。 */
  confirm(spec: ConfirmSpec): Promise<boolean>;
  /** 要一行输入。空字符串表示留空，null 表示取消。 */
  ask(label: string, initial?: string): Promise<string | null>;
  /** 跑一条运维命令，实时显示每一行输出；返回退出码。仅用于不会向用户提问的命令。 */
  run(title: string, args: string[]): Promise<number>;
  /**
   * 退出全屏、把终端整个交给子进程，结束后回到界面。
   *
   * update 和 uninstall 都会问问题（update 转调的 deploy.sh 更是逐项确认端口、模式、域名），
   * 这些命令必须拿到真正的 TTY。塞进执行面板里它们只会在「输入已结束」上失败。
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
  /** 导航栏上的两字标签。 */
  label: string;
  render(ctx: ViewContext): string[];
  /** 本页特有的按键提示；通用键由 app 补。 */
  hints(): [string, string][];
  /** 进入本页或按 r 时调用。 */
  refresh?(app: AppApi): Promise<void>;
  /** 离开本页时调用，用来停掉本页自己起的轮询。 */
  onLeave?(): void;
  /** 返回 true 表示按键已被消费，app 不再继续处理。 */
  onKey?(key: Key, app: AppApi): boolean | Promise<boolean>;
}

/** 数据加载的三种状态。界面要能区分「还在读」和「读到了但是空的」。 */
export type Loading<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "error"; message: string };
