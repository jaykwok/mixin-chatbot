// doctor on macOS: the same rows and JSON as ops.sh and ops.ps1 (the console reads `doctor --json` from either), with the
// LaunchDaemon in place of the container or the scheduled task. Read-only. The model check runs as the service account;
// the rest reads files and the service's /health directly.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDeploymentLock } from "./deployment-lock.ts";
import { LaunchdPlatform, SERVICE_ACCOUNT, type LaunchdService } from "./launchd-host.ts";
import { serviceReady } from "./readiness.ts";
import { attached, hint, ok, step, warn, fail } from "./macos-terminal.ts";
import { doctorRows, readServiceStatus } from "../tools/directory-admin.ts";
import { healthProgram, versionFacts, versionRows } from "../tools/version-info.ts";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorRow { name: string; status: DoctorStatus; detail: string; fix: string }
export interface DoctorReport { pass: number; warn: number; fail: number; port: number; checks: DoctorRow[] }

const row = (name: string, status: DoctorStatus, detail: string, fix = ""): DoctorRow => ({ name, status, detail, fix: status === "pass" ? "" : fix });

export function savedPort(project: string, env: NodeJS.ProcessEnv = process.env): number {
  let raw = env.BOT_PORT?.trim() || "";
  if (!raw) { try { raw = readFileSync(join(project, "data/state/bot-port"), "utf8").trim(); } catch { raw = "10000"; } }
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error(`BOT_PORT/data/state/bot-port 中的端口无效：${raw}`);
  return port;
}

/** A deployment, upgrade or unfinished transaction may hold older code against newer data: the model check waits for it. */
function deploymentInProgress(project: string): boolean {
  if (["deploy-transaction", "upgrade-transaction"].some(name => existsSync(join(project, "data/state", name)))) return true;
  if (!existsSync(join(project, "data/state"))) return false;
  // A busy lock, and an unusable lock file alike, count as in progress.
  try { acquireDeploymentLock(project).close(); return false; }
  catch { return true; }
}

function serviceRow(service: LaunchdService | Error, local: number): DoctorRow {
  const stopped = `有意停止的使用 ${hint("start")} 启动；意外退出时先在 ${hint("logs")} 查看日志，再使用 ${hint("doctor --repair")}。`;
  if (service instanceof Error) return row("LaunchDaemon", "fail", `无法读取：${service.message}`, "以 root 运行（sudo）后重试。");
  if (!service.owned) return row("LaunchDaemon", "fail", "属于其他目录或其他账户", "先在那个目录卸载它，再在本目录部署。");
  switch (service.state) {
    case "absent":
      return local === 200 ? row("LaunchDaemon", "warn", "未安装；机器人当前以前台方式运行", `如需开机自启，请使用 ${hint("deploy")}。`)
        : row("LaunchDaemon", "fail", "未安装，且没有健康的前台机器人", `请使用 ${hint("deploy")}。`);
    case "unsupported": return row("LaunchDaemon", "fail", `状态（${service.rawState}）或服务账户 ${SERVICE_ACCOUNT} 不支持`, `请使用 ${hint("deploy")} 重新部署。`);
    case "running": return row("LaunchDaemon", "pass", `已加载（${service.rawState}），以 ${SERVICE_ACCOUNT} 运行`);
    case "stopped":
      if (service.leftovers > 0) return row("LaunchDaemon", "warn", `已停止；服务账户有 ${service.leftovers} 个进程在运行（前台运行的机器人或残留进程）`,
        `前台机器人用 Ctrl+C 结束；之后使用 ${hint("start")}。`);
      return row("LaunchDaemon", "fail", "已停止（保持禁用，开机也不会启动）", stopped);
  }
}

function relayRows(project: string): DoctorRow[] {
  const path = join(project, "data/config/relay.json");
  if (!existsSync(path)) return [];
  let value: Record<string, unknown> | null = null;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { value = null; }
  const complete = !!value && value.provider === "s3" && ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"].every(key => typeof value![key] === "string" && (value![key] as string).length > 0);
  return complete ? [row("S3 外链配置必填项", "pass", "必填项齐全；启动时执行完整格式校验")]
    : [row("data/config/relay.json", "fail", "S3 必填项不全，请重新运行外链向导", `使用 ${hint("relay-configure")}。`)];
}

export interface DoctorOptions {
  project: string;
  bun: string;
  /** PATH of the service (its definition's), for the model check. */
  path: string;
  env?: NodeJS.ProcessEnv;
  service?: LaunchdPlatform;
}

export async function doctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const { project, bun, path } = options, env = options.env ?? process.env, port = savedPort(project, env);
  const rows: DoctorRow[] = [];
  let workspace = "";
  try { workspace = readFileSync(join(project, "data/state/workspace-root"), "utf8").trim(); } catch { workspace = ""; }
  if (!workspace) rows.push(row("共享资料目录", "pass", `${join(project, "data/workspace")}（默认）`));
  else if (existsSync(workspace)) rows.push(row("共享资料目录", "pass", `${workspace}（外置，只读）`));
  else rows.push(row("共享资料目录", "fail", `外置目录不存在：${workspace}`, `恢复该目录或挂载；改用其他目录请用 sudo WORKSPACE_ROOT=<目录> bash scripts/ops.sh deploy。`));

  const local = await serviceReady(project, 3000) ? 200 : await serviceReady(project, 3000, { verification: true }) ? 503 : 0;
  const platform = options.service ?? new LaunchdPlatform(project);
  const service = await platform.inspect().catch(error => error instanceof Error ? error : new Error(String(error)));
  rows.push(serviceRow(service, local));
  const stoppedService = !(service instanceof Error) && service.state === "stopped" && service.leftovers === 0;
  rows.push(row("本地机器人健康", local === 200 ? "pass" : "fail", local === 200 ? "就绪且实例身份匹配" : local === 503 ? "只验证实例，不处理消息" : "未就绪或实例身份不匹配",
    local === 503 ? `使用 ${hint("resume")} 继续上次操作并完成提交。` : stoppedService ? `使用 ${hint("start")} 启动。` : `使用 ${hint("doctor --repair")}，再到 ${hint("logs")} 查看日志。`));

  // The Stream and the directory come from the running service's /health: a second Stream connection is not allowed.
  let running: ReturnType<typeof healthProgram>;
  if (local === 200) {
    try {
      const status = await readServiceStatus(port, join(project, "data/state/instance.json"));
      for (const line of doctorRows(status)) {
        const [state, name, detail] = line.split("\t", 3);
        if (!name) continue;
        const fix = name === "事件 Stream" ? `检查出站访问 imtwo.zdxlz.com 的 443 端口和应用凭据（${hint("configure-app-bot")}），再查看 ${hint("logs")}。`
          : name === "通讯录同步" ? `服务会自动重试和复核；用 ${hint("directory")} 查看范围状态和原因，长时间没有恢复时查看 ${hint("logs")}。`
          : name === "运行状况" ? `在 ${hint("logs")} 中查看对应记录（Durable 报告、交付超时放弃、统计累计值回退等）；停住的任务由成员用 /status 查看、/stop 或 /clear 结束。` : "";
        rows.push(row(name, state === "pass" || state === "warn" ? state : "fail", detail ?? "", fix));
      }
    } catch { rows.push(row("事件 Stream", "warn", "无法读取服务状态", `查看 ${hint("logs")}。`)); }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      running = healthProgram(await response.json());
    } catch { running = undefined; }
  }
  try {
    for (const [name, value] of versionRows(versionFacts(project, running)))
      rows.push(value.startsWith("未知：") ? row(name, "fail", value, "部署记录无法读取；不要在此目录覆盖部署，参见 docs/data-migrations.md。") : row(name, "pass", value));
  } catch { rows.push(row("应用机器人", "warn", "无法读取版本信息")); }

  rows.push(existsSync(join(project, "data/config/app-bot.json")) ? row("data/config/app-bot.json", "pass", "已配置（不显示凭据）")
    : row("data/config/app-bot.json", "fail", "缺少（服务拒绝启动）", `使用 ${hint("configure-app-bot")} 填写 AppID 和 AppSecret。`));

  // The whole model configuration at once: providers and credentials in models.json, the choice in the Pi settings.
  const models = "模型配置（models.json + Pi 设置）";
  if (!existsSync(join(project, "data/config/models.json"))) rows.push(row(models, "fail", "缺少或无效", `通过 ${hint("deploy")} 完成首次模型配置。`));
  else if (deploymentInProgress(project)) rows.push(row(models, "fail", "部署或升级尚未完成，未检查", `完成或回滚上次操作（${hint("resume")} / ${hint("rollback")}）后重新体检。`));
  else {
    const user = service instanceof Error ? undefined : service.user;
    const code = user ? await attached([bun, "--no-env-file", "run", join(project, "ops/config/validate-models.ts"), project],
      { cwd: project, env: { ...env, HOME: join(project, "data/runtime/home"), PATH: path }, identity: user, quiet: true }) : 1;
    rows.push(code === 0 ? row(models, "pass", "有效") : row(models, "fail", "缺少或无效", "先修正 data/config/models.json 与 data/runtime/pi/settings.json。"));
  }
  rows.push(...relayRows(project));
  const count = (status: DoctorStatus) => rows.filter(item => item.status === status).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), port, checks: rows };
}

/** Human output; true when nothing failed. */
export function printDoctor(report: DoctorReport): boolean {
  step(`mixin-bot 健康检查（本机端口=${report.port}）`);
  for (const item of report.checks) {
    const text = `${item.name.padEnd(26)} ${item.detail}`;
    if (item.status === "pass") ok(text); else if (item.status === "warn") warn(text); else fail(text);
  }
  console.log(`\n结果：${report.pass} 项通过，${report.warn} 项警告，${report.fail} 项失败`);
  const actions = [...new Map(report.checks.filter(item => item.status !== "pass" && item.fix).map(item => [item.name + item.fix, item])).values()];
  if (actions.length) {
    console.log("\n建议操作：");
    for (const item of actions) console.log(`  - ${item.name}: ${item.fix}`);
  }
  if (report.fail > 0) { warn(`可尝试修复：${hint("doctor --repair")}`); return false; }
  if (report.warn > 0) warn("必需检查已通过，但仍有警告"); else ok("全部检查通过");
  return true;
}
