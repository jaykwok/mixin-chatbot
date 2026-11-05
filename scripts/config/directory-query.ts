#!/usr/bin/env bun
// Read-only department queries with deployed dependencies. No Stream, member reads or configuration writes.
import { join, resolve } from "node:path";
import { configureLog } from "../../src/core/log.ts";
import { directoryAppHash } from "../lib/directory-choice.ts";
import { parseDepartmentIds, parseScopeDepartments } from "../../src/integrations/open-platform/directory-scope.ts";
import type { AppBotConfig } from "../../src/integrations/open-platform/config.ts";
import type { PlatformClient as Client } from "../../src/integrations/open-platform/client.ts";

export function parseDirectoryQuery(action: string, input: unknown): string[] {
  const raw = input as { ids?: unknown };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || !("ids" in raw)) throw new Error("部门查询参数无效");
  const ids = action === "children" ? parseDepartmentIds(raw.ids) : action === "verify" ? parseScopeDepartments(raw.ids) : (() => { throw new Error("部门查询动作无效"); })();
  if (action === "children" && ids.length !== 1) throw new Error("每次只能查询一个父部门");
  return ids;
}

export async function queryDeploymentDirectory(root: string, action: string, input: unknown, makeClient?: (config: AppBotConfig) => Client) {
  const ids = parseDirectoryQuery(action, input), appHash = directoryAppHash(root);
  const { PlatformClient } = await import("../../src/integrations/open-platform/client.ts");
  const { DirectoryClient } = await import("../../src/integrations/open-platform/directory.ts");
  const { readAppBotConfig } = await import("../../src/integrations/open-platform/config.ts");
  const config = readAppBotConfig(join(root, "data/config/app-bot.json")); if (!config) throw new Error("缺少配置");
  const platform = makeClient ? makeClient(config) : new PlatformClient(config, { timeoutMs: 15_000, retryDelaysMs: [] });
  try {
    const client = new DirectoryClient(platform), signal = AbortSignal.timeout(60_000);
    const departments = action === "children" ? await client.childDepartments(ids[0]!, signal) : await client.verify(ids, signal);
    if (directoryAppHash(root) !== appHash) throw new Error("配置已变化");
    return { protocol: "mixin-directory-query", version: 1, appHash, departments: departments.map(({ id, name }) => ({ id, name })) };
  } finally { platform.close(); }
}

if (import.meta.main) {
  // A read-only query of the deployment: stdout carries the JSON result only, and nothing is written into the project.
  configureLog({ file: null, stream: "stderr" });
  try {
    const [action, project, extra] = process.argv.slice(2);
    if (!project || extra) throw new Error("参数无效");
    const root = resolve(project); let body = "", bytes = 0; const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) { bytes += chunk.length; if (bytes > 32 * 1024) throw new Error("请求过大"); body += decoder.decode(chunk, { stream: true }); }
    const input = JSON.parse(body + decoder.decode()); parseDirectoryQuery(action ?? "", input);
    process.stdout.write(JSON.stringify(await queryDeploymentDirectory(root, action!, input)) + "\n");
  } catch { console.error("部门查询未完成，请检查应用权限、配置与网络；没有修改同步范围"); process.exitCode = 1; }
}
