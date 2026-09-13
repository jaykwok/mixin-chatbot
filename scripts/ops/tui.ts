#!/usr/bin/env bun
// mixin-chatbot 全屏运维界面。
//
// 入口：bun run tui（Windows / Linux 通用）。
//
// 它跑在宿主机上，不在容器里——它要管的正是容器本身，而一个住在容器里的界面在容器起不来
// 的时候也就跟着没了，那恰恰是最需要它的时刻。只依赖 bun 这一个二进制：读数据直接读宿主机
// 上的 data/，写操作转调 ops.sh / ops.ps1。
//
// 非交互环境（管道、CI、非 TTY）直接退出并指回命令行子命令，不去画一屏没人看的转义序列。

import { chdir } from "node:process";
import { App } from "./tui/app.ts";
import { PROJECT_DIR } from "./tui/platform.ts";
import { OverviewView } from "./tui/views/overview.ts";
import { HealthView } from "./tui/views/health.ts";
import { StatsView } from "./tui/views/stats.ts";
import { HistoryView } from "./tui/views/history.ts";
import { StorageView } from "./tui/views/storage.ts";
import { createRelayView, createRoutesView } from "./tui/views/passthrough.ts";
import { LogsView } from "./tui/views/logs.ts";
import { MaintainView } from "./tui/views/maintain.ts";
import type { Section } from "./tui/view.ts";

function usage(): void {
  console.log("mixin-chatbot 运维界面");
  console.log("");
  console.log("  bun run tui                 启动全屏界面（Windows / Linux）");
  console.log("  bun run tui --help          查看帮助");
  console.log("");
  console.log("←→ 切换主分区，Tab 切换子页，↑↓ 选择，Enter 进入，空格打开操作菜单。");
  console.log("总览 · 监控（体检/日志）· 统计 · 数据（会话/临时文件/外链）· 系统（服务部署/路由）");
  console.log("");
  console.log("界面需要交互式终端。脚本和 CI 里请直接用 ops.sh / ops.ps1 的子命令。");
}

async function main(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }

  // 仓库里大量常量是相对路径（data/、logs/），统一把工作目录钉在项目根上，
  // 这样从任何地方启动界面，读到的都是同一份东西。
  chdir(PROJECT_DIR);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("运维界面需要交互式终端（当前 stdin/stdout 不是 TTY）。");
    console.error("请直接使用 scripts/ops/ops.sh 或 scripts/ops/ops.ps1 的子命令。");
    return 1;
  }

  const sections: Section[] = [
    { id: "overview", label: "总览", views: [new OverviewView()] },
    { id: "monitor", label: "监控", views: [new HealthView(), new LogsView()] },
    { id: "stats", label: "统计", views: [new StatsView()] },
    { id: "data", label: "数据", views: [new HistoryView(), new StorageView(), createRelayView()] },
    { id: "system", label: "系统", views: [new MaintainView(), createRoutesView()] },
  ];

  const app = new App(sections);
  await app.start();
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    // Screen 已经在自己的退出路径上恢复了终端；这里只负责把原因说清楚。
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
