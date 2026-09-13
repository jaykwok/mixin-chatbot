// 日志。尾部跟随、级别过滤、按任务 ID 取证。
//
// 按任务 ID 那一项是这页最值钱的功能：排查一次超时要把 8 位任务 ID 在当前日志和几个轮转
// 文件里捞一遍，再对齐模型就绪记录、心跳和流结束记录——scripts/ops/task-logs.sh 已经把这套
// awk 写好了，这里只负责问一句 ID 然后把它跑起来。

import { box } from "../render/widgets.ts";
import { pad, truncate } from "../render/width.ts";
import type { ColorName } from "../render/theme.ts";
import { loadLogTail, type LogLine } from "../data.ts";
import { PROJECT_DIR } from "../platform.ts";
import { capture } from "../exec.ts";
import type { AppApi, Loading, View, ViewContext } from "../view.ts";
import { gap, pending } from "./common.ts";
import { join } from "node:path";

const LEVELS = ["全部", "warn", "error"] as const;

const LEVEL_COLOR: Record<LogLine["level"], ColorName> = {
  error: "danger",
  warn: "warn",
  info: "muted",
  other: "muted",
};

export class LogsView implements View {
  readonly id = "logs";
  readonly label = "日志";
  private state: Loading<LogLine[]> = { kind: "idle" };
  private levelIndex = 0;
  private follow = true;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  hints(): [string, string][] {
    return [
      ["f", this.follow ? "跟随中" : "已暂停"],
      ["l", `级别 ${LEVELS[this.levelIndex]}`],
      ["t", "查任务"],
    ];
  }

  async refresh(app: AppApi): Promise<void> {
    if (this.state.kind === "idle") this.state = { kind: "loading" };
    try {
      this.state = { kind: "ready", value: await loadLogTail(400) };
    } catch (error) {
      this.state = { kind: "error", message: `读不到日志：${String(error)}` };
    }
    app.redraw();

    // 跟随模式下自己拉一个两秒的轮询。用轮询而不是 fs.watch：日志会轮转，watch 会盯着
    // 一个已经被改名的旧文件，而轮询每次都重新按路径读，轮转后自动跟到新文件上。
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (!this.follow) return;
        void loadLogTail(400)
          .then((lines) => {
            this.state = { kind: "ready", value: lines };
            app.redraw();
          })
          .catch(() => {});
      }, 2000);
    }
  }

  /** 离开本页就停掉轮询：没人看的时候每两秒读一次日志纯属浪费，还会引起无谓的重绘。 */
  onLeave(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private filtered(lines: LogLine[]): LogLine[] {
    const level = LEVELS[this.levelIndex];
    if (level === "全部") return lines;
    if (level === "warn") return lines.filter((line) => line.level === "warn" || line.level === "error");
    return lines.filter((line) => line.level === "error");
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (key.name === "f") {
      this.follow = !this.follow;
      if (this.follow) this.offset = 0;
      app.toast("idle", this.follow ? "跟随最新" : "已暂停，↑↓ 可回看");
      return true;
    }
    if (key.name === "l") {
      this.levelIndex = (this.levelIndex + 1) % LEVELS.length;
      return true;
    }
    if (key.name === "up" || key.name === "k") {
      this.follow = false;
      this.offset += 1;
      return true;
    }
    if (key.name === "down" || key.name === "j") {
      this.offset = Math.max(0, this.offset - 1);
      return true;
    }
    if (key.name === "pageup") {
      this.follow = false;
      this.offset += 10;
      return true;
    }
    if (key.name === "pagedown") {
      this.offset = Math.max(0, this.offset - 10);
      return true;
    }
    if (key.name === "t") {
      const id = await app.ask("任务 ID（8 位十六进制，日志里「任务：」后面那串）");
      if (!id) return true;
      if (!/^[0-9a-fA-F]{8}$/.test(id.trim())) {
        app.toast("warn", "任务 ID 应为 8 位十六进制");
        return true;
      }
      await this.lookup(app, id.trim());
      return true;
    }
    return false;
  }

  /**
   * 取证走 task-logs 脚本本身，不经过 ops 包装器：它是宿主机侧的独立工具，不需要容器，
   * 机器人停着也能用——而排查超时的时候，机器人往往正停着。
   */
  private async lookup(app: AppApi, id: string): Promise<void> {
    app.toast("busy", `正在扫描日志找任务 ${id}…`);
    const windows = app.deployment.platform === "windows";
    const script = join(PROJECT_DIR, "scripts", "ops", windows ? "task-logs.ps1" : "task-logs.sh");
    const result = windows
      ? await capture("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, id], { timeout: 120_000 })
      : await capture("bash", [script, id], { timeout: 120_000 });

    if (result.code === 2) {
      app.toast("warn", `保留的日志里没有任务 ${id}；可能已被轮转覆盖`);
      return;
    }
    if (result.code !== 0) {
      app.toast("danger", `取证失败：${result.stderr.trim().slice(0, 80) || `退出码 ${result.code}`}`);
      return;
    }
    // 摘要里最后一行是结果目录，那是运维接下来真正要打开的东西。
    const lines = result.stdout.trim().split(/\r?\n/);
    const dir = lines.reverse().find((line) => line.includes("结果目录")) ?? "";
    app.toast("ok", dir.trim() || `任务 ${id} 已提取`);
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "日志文件还不存在（机器人可能从未启动）");
    if (waiting) return waiting;
    const all = this.filtered((this.state as { value: LogLine[] }).value);

    const room = Math.max(3, height - 2);
    // offset 从尾部往回数；跟随时恒为 0。
    const end = Math.max(room, all.length - this.offset);
    const visible = all.slice(Math.max(0, end - room), end);

    const note = this.follow
      ? `跟随中 · ${LEVELS[this.levelIndex]}`
      : `已暂停 · 距末尾 ${this.offset} 行 · ${LEVELS[this.levelIndex]}`;

    return box(theme, {
      width: total,
      title: "日志",
      note,
      accent: this.follow ? "accent" : "muted",
      body: [
        ...visible.map((line) => theme.c(LEVEL_COLOR[line.level], truncate(line.text, total - 4))),
        ...(visible.length === 0 ? [theme.c("muted", "该级别下没有记录")] : []),
      ],
    }).concat(all.length === 0 ? [gap(total), pad(`  ${theme.c("muted", "日志为空")}`, total)] : []);
  }
}
