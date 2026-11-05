// Console sections. Items with a `stage` are planned and shown disabled until that stage ships.
import type { IconName } from "./icons.tsx";

export interface NavItem { id: string; label: string; icon: IconName; group: string; description: string; stage?: string }

export const NAV: NavItem[] = [
  { id: "overview", label: "总览", icon: "dashboard", group: "", description: "部署身份、机器人状态与版本" },
  { id: "conversations", label: "会话", icon: "messages", group: "洞察", description: "单聊与群聊记录、工具调用和交付状态" },
  { id: "stats", label: "统计", icon: "chart", group: "洞察", description: "提问量、成员排行、趋势与导出" },
  { id: "health", label: "体检", icon: "activity", group: "监控", description: "运行环境与依赖检查" },
  { id: "logs", label: "日志", icon: "logs", group: "监控", description: "日志搜索与按任务导出" },
  { id: "storage", label: "临时文件", icon: "folder", group: "数据", description: "临时文件、归档与回收" },
  { id: "relay", label: "外链", icon: "link", group: "数据", description: "外链存储与测试" },
  { id: "maintain", label: "维护", icon: "wrench", group: "系统", description: "启停、后台任务与恢复" },
  { id: "directory", label: "通讯录", icon: "users", group: "系统", description: "同步状态与部门范围" },
  { id: "push", label: "推送", icon: "radio", group: "系统", description: "推送记录、补推送与推送设置" },
  { id: "settings", label: "设置", icon: "sliders", group: "系统", description: "模型、机器人凭据与运行参数" },
];

export const available = (item: NavItem) => item.stage === undefined;

export function routeFromHash(hash: string): string {
  const id = hash.replace(/^#\/?/, "");
  return NAV.some(item => item.id === id && available(item)) ? id : "overview";
}
