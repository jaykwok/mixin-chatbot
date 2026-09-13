// 展示 ops.sh doctor --json / ops.ps1 doctor -Json 的结果，并转交平台对应的修复操作。

import { box, mark, table, wrap } from "../render/widgets.ts";
import { pad } from "../render/width.ts";
import { Viewport } from "../render/viewport.ts";
import { loadHealth, type Health, type HealthCheck } from "../data.ts";
import type { AppApi, Loading, View, ViewContext } from "../view.ts";
import { gap, moveSelection, pending, windowStart } from "./common.ts";

function statusOf(check: HealthCheck): "ok" | "warn" | "danger" {
  if (check.status === "pass") return "ok";
  return check.status === "warn" ? "warn" : "danger";
}

export class HealthView implements View {
  readonly id = "health";
  readonly label = "健康";
  private state: Loading<Health> = { kind: "idle" };
  private selected = 0;
  private expanded = false;
  private scroll = new Viewport();
  private platform: "windows" | "linux" = "linux";

  hints(): [string, string][] {
    const keys: [string, string][] = this.expanded
      ? [["Esc", "返回"], ["↑↓", "滚动"], ["PgUp/Dn", "翻页"]]
      : [["↑↓", "选择"], ["Enter", "完整详情"]];
    keys.push(["f", this.platform === "windows" ? "自动修复" : "重建修复"]);
    return keys;
  }

  async refresh(app: AppApi): Promise<void> {
    this.platform = app.deployment.platform;
    this.state = { kind: "loading" };
    app.redraw();
    try {
      this.state = { kind: "ready", value: await loadHealth(app.deployment) };
      this.selected = Math.min(this.selected, Math.max(0, this.state.value.checks.length - 1));
      if (!this.state.value.checks.length) this.expanded = false;
    } catch (error) {
      this.state = { kind: "error", message: String(error instanceof Error ? error.message : error) };
    }
    app.redraw();
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (this.state.kind !== "ready") return false;
    const checks = this.state.value.checks;
    if (this.expanded) {
      if (key.name === "escape") { this.expanded = false; return true; }
      if (this.scroll.onKey(key.name)) return true;
    } else if (key.name === "enter" && checks[this.selected]) {
      this.expanded = true;
      this.scroll.reset();
      return true;
    }
    const moved = this.expanded ? null : moveSelection(key.name, this.selected, checks.length);
    if (moved !== null) {
      this.selected = moved;
      return true;
    }
    if (key.name === "f") {
      const windows = app.deployment.platform === "windows";
      const ok = await app.confirm({
        title: windows ? "自动修复" : "重建修复",
        subject: windows ? "修复可确定的部署问题" : "通过部署向导重新构建当前版本",
        steps: windows ? [
          "重新注册计划任务、修正防火墙规则一类可确定的修复",
          "按当前 token 来源处理隧道（必要时重装 Cloudflared 服务）",
          "修复后再跑一次体检",
        ] : ["确认部署选项，回车默认沿用已有配置", "重建镜像并核对新实例的健康状态", "失败时恢复原部署"],
        untouched: ["data/ 配置与群数据", "已有的会话历史"],
        recovery: "修复只改部署侧设施，不动数据；失败时体检结果会指出剩下的问题",
      });
      if (ok) {
        const code = windows ? await app.run("自动修复", ["doctor", "-Repair"])
          : await app.runInteractive("重建修复", ["deploy"]);
        app.toast(code === 0 ? "ok" : "danger", code === 0 ? "修复完成" : `修复未成功（退出码 ${code}）`);
      }
      return true;
    }
    return false;
  }

  render(ctx: ViewContext): string[] {
    const { theme, width: total, height } = ctx;
    const waiting = pending(theme, total, this.state, "体检尚未运行");
    if (waiting) return waiting;
    const health = (this.state as { value: Health }).value;

    const out: string[] = [];
    const summary = [
      `${mark(theme, "ok")} ${health.pass} 通过`,
      health.warn > 0 ? `${mark(theme, "warn")} ${health.warn} 警告` : "",
      health.fail > 0 ? `${mark(theme, "danger")} ${health.fail} 失败` : theme.c("muted", "0 失败"),
    ]
      .filter(Boolean)
      .join("    ");

    const current = health.checks[this.selected];
    if (this.expanded && current) {
      const content = [
        `${mark(theme, statusOf(current))} ${theme.bold(current.name)}`, "",
        current.detail, "", theme.bold("处理建议"), current.fix || "此项没有额外处理建议。",
      ].flatMap(line => wrap(line, total - 4));
      const visible = this.scroll.slice(content, Math.max(1, height - 3));
      return box(theme, {
        width: total, title: `体检详情 · ${this.selected + 1} / ${health.checks.length}`,
        note: this.scroll.label, accent: statusOf(current), body: [summary, ...visible],
      });
    }

    // 表格留给检查项，摘要单独一行：摘要是唯一需要一眼看到的东西。
    const room = Math.max(1, height - 6);
    const start = windowStart(this.selected, health.checks.length, room);
    const visible = health.checks.slice(start, start + room);

    const rows = table(theme, {
      width: total - 4,
      rows: visible,
      selected: this.selected - start,
      gap: 1,
      columns: [
        { header: "", size: 2, render: (check) => mark(theme, statusOf(check)) },
        { header: "检查项", size: Math.min(26, Math.floor(total * 0.32)), render: (check) => check.name },
        { header: "结果", flex: 1, render: (check) => check.detail },
      ],
    });

    out.push(
      ...box(theme, {
        width: total,
        title: "体检",
        note: summary,
        accent: health.fail > 0 ? "danger" : health.warn > 0 ? "warn" : "ok",
        body: rows,
      })
    );

    // 选中项的修复建议单独展开：把它塞进表格里会把「结果」列挤到没法读。
    out.push(gap(total));
    out.push(pad(` ${theme.c("muted", "建议")}  ${current?.fix || "按 Enter 查看完整检查结果"}`, total));
    if (health.checks.length > room) {
      out.push(pad(` ${theme.c("muted", `显示 ${start + 1}-${start + visible.length} / ${health.checks.length}`)}`, total));
    }
    return out;
  }
}
