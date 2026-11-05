#!/usr/bin/env bun
// 通讯录同步范围的选择（部署用）：整个通讯录，或选定的部门及其全部子部门，没有默认值。
//
// choose：设置了 BOT_DIRECTORY_SCOPE 时不交互，它只接受 all（整个通讯录）；部门只能在向导里逐层勾选（部门 ID 是一长串数字，
// 没人记得住，不接受手填）。没有设置时在终端里运行向导，不是终端就失败。向导与部署后的修改共用（directory-scope-wizard.ts）；
// 这里直接向平台查询。结果写入 --plan 指定的计划文件：部署在停机前选择，停机后 install；续做沿用这份计划，不再运行 choose。
// 首次部署在停机前还没有安装应用凭据：--app 指向同一次部署暂存的应用机器人配置（configuration-app.json），向平台核对时用它。
// 不取维护租约、不碰数据库，服务运行时也可以执行；另取一个应用 token（服务遇到 401 会重取），不连接 Stream。
// install：校验计划文件后写入 data/config/directory.json（同目录临时文件加替换）。
//
// 用法：directory-scope.ts choose --plan <文件> [--project <目录>] [--app <暂存的应用配置>]
//       directory-scope.ts install --plan <文件> [--project <目录>]
// 退出码：0 已写入；1 失败（含用法错误）；2 取消。
import { intro, outro } from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_BOT_CONFIG_PATH, DIRECTORY_CONFIG_PATH } from "../../src/core/storage.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { parseAppBotText, readAppBotConfig, type AppBotConfig } from "../../src/integrations/open-platform/config.ts";
import { DirectoryClient } from "../../src/integrations/open-platform/directory.ts";
import { parseScopeDepartments, parseScopeFile, WHOLE_DIRECTORY,
  type DirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { writeDirectoryScope } from "../../src/integrations/open-platform/directory-scope-write.ts";
import { describeScope } from "../ops/directory-admin.ts";
import { chooseInteractively, type WizardDepartments } from "./directory-scope-wizard.ts";
import { consoleDirectoryScope } from "../lib/directory-choice.ts";
import { readBoundedText } from "../lib/bounded-text.ts";
import { Protocol } from "../lib/maintenance-protocol.ts";
import { parseConfigurationStage } from "./configuration-stage.ts";

const USAGE = "用法：directory-scope.ts choose --plan <文件> [--project <目录>] [--app <暂存的应用配置>] | install --plan <文件> [--project <目录>]";
const ENVIRONMENT_HINT = "请设置 BOT_DIRECTORY_SCOPE=all（整个通讯录）后重试；只同步部分部门时请在终端里运行，由向导逐层勾选";
/** 一次平台查询（列子部门、核对部门）的时限。 */
const PLATFORM_WAIT_MS = 60_000;

export type ScopeArgs = { command: "choose" | "install"; plan: string; project?: string; app?: string; json?: true };

/** 严格解析参数：未知或重复的参数、缺值都是用法错误。 */
export function parseScopeArgs(argv: readonly string[]): ScopeArgs {
  const [command, ...rest] = argv;
  if (command !== "choose" && command !== "install") throw new Error(USAGE);
  const args: Partial<ScopeArgs> & Pick<ScopeArgs, "command"> = { command };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--plan" || arg === "--project" || arg === "--app" && command === "choose") {
      const value = rest[++index], key = arg === "--plan" ? "plan" : arg === "--app" ? "app" : "project";
      if (!value || value.startsWith("--") || args[key] !== undefined) throw new Error(USAGE);
      args[key] = value;
    } else if (arg === "--json" && command === "install" && !args.json) args.json = true;
    else throw new Error(USAGE);
  }
  if (args.plan === undefined) throw new Error(USAGE);
  return { ...args, plan: args.plan };
}

/** BOT_DIRECTORY_SCOPE 的范围：只接受 all（整个通讯录）。 */
export function scopeFromEnvironment(value: string): DirectoryScope {
  if (value.trim() === "all") return WHOLE_DIRECTORY;
  throw new Error("BOT_DIRECTORY_SCOPE 只接受 all（整个通讯录），不接受部门 ID；只同步部分部门时请清除这个变量，在终端里运行，由向导逐层勾选");
}

/** 校验计划文件并写入 data/config/directory.json。这是一次保存：与其他保存一样拒绝根部门 1。 */
export async function installScopePlan(plan: string, project: string): Promise<DirectoryScope> {
  let raw: unknown;
  try { raw = JSON.parse((await readFile(plan, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`读不到通讯录同步范围的计划文件 ${plan}：${error instanceof Error ? error.message : String(error)}`); }
  const scope = parseScopeFile(raw, plan);
  if (scope.kind === "departments") parseScopeDepartments(scope.departments);
  await writeDirectoryScope(scope, join(project, DIRECTORY_CONFIG_PATH));
  return scope;
}

/** 同一次部署暂存的应用机器人配置（停机后才安装）：只取其中的结果，内容不出现在错误里。 */
export function stagedAppBotConfig(path: string): AppBotConfig {
  let text: string | null = null;
  try { text = readBoundedText(path, 1024 * 1024); } catch { /* Reported below. */ }
  if (text === null) throw new Error("读不到暂存的应用机器人配置");
  return parseAppBotText(parseConfigurationStage(text, "app").next.files.app!, "暂存的 app-bot.json");
}

const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 向导直接向平台查询；每次查询限时 PLATFORM_WAIT_MS，用户在查询中按 Ctrl+C 时随即取消。 */
function platformDepartments(client: DirectoryClient): WizardDepartments {
  const limited = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(PLATFORM_WAIT_MS)]);
  return {
    childDepartments: (parent, signal) => client.childDepartments(parent, limited(signal)),
    verify: (ids, signal) => client.verify(ids, limited(signal)),
  };
}

if (import.meta.main) {
  let platform: PlatformClient | undefined;
  const protocol = process.argv.includes("--json") ? new Protocol("json", "install") : undefined;
  try {
    const args = parseScopeArgs(process.argv.slice(2));
    const project = resolve(args.project ?? ".");
    if (args.command === "install") {
      const scope = await installScopePlan(resolve(args.plan), project);
      const text = `已写入通讯录同步范围：${describeScope(scope)}`;
      if (protocol) protocol.emit("success", { text, result: null }); else console.log(text);
    } else {
      const client = () => {
        const config = args.app !== undefined ? stagedAppBotConfig(resolve(args.app)) : readAppBotConfig(join(project, APP_BOT_CONFIG_PATH));
        if (!config) throw new Error("缺少应用机器人配置（data/config/app-bot.json）：向平台核对部门需要应用凭据");
        platform = new PlatformClient(config, { timeoutMs: 15_000 });
        return new DirectoryClient(platform);
      };
      const value = process.env.BOT_DIRECTORY_SCOPE?.trim();
      let scope: DirectoryScope;
      if (process.env.MIXIN_OPS_DIRECTORY === "selected") {
        scope = consoleDirectoryScope(project);
      } else if (value) {
        scope = scopeFromEnvironment(value);
      } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(`没有终端，不能运行通讯录同步范围的选择向导；${ENVIRONMENT_HINT}`);
      } else {
        intro("通讯录同步范围");
        scope = await chooseInteractively(platformDepartments(client()));
      }
      await writeDirectoryScope(scope, resolve(args.plan));
      const saved = `已选择通讯录同步范围：${describeScope(scope)}（停止服务后写入 data/config/directory.json）`;
      if (value || process.env.MIXIN_OPS_DIRECTORY === "selected") console.log(saved); else outro(saved);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") process.exitCode = 2;
    else if (protocol) protocol.fail(error, "failed", "通讯录范围未写入：");
    else { console.error(describeError(error)); process.exitCode = 1; }
  } finally { platform?.close(); }
}
