// Frozen historical transformation. Only built-ins and migrations/lib are allowed here.
import { join } from "node:path";
import { json, publishJson } from "./lib/io.ts";
import { validateSessions } from "./lib/sessions.ts";
import type { Context, Migration, Preview } from "./lib/types.ts";

async function changes({ project, decisions }: Pick<Context, "project" | "decisions">) {
  if (process.env.BOT_MODEL_CACHE_RETENTION?.trim()) throw new Error("请先移除 BOT_MODEL_CACHE_RETENTION 环境变量，配置文件由迁移转换");
  const settingsPath = join(project, "data/runtime/pi/settings.json");
  const runtimePath = join(project, "data/config/runtime.json");
  const settings = await json(settingsPath);
  if (!settings?.defaultProvider || !settings.defaultModel) throw new Error("模型选型缺失，请先完成模型配置");
  const runtime = await json(runtimePath) ?? {};
  const beforeSettings = JSON.stringify(settings), beforeRuntime = JSON.stringify(runtime);
  const questions: Preview["decisions"] = [];
  if (settings.cacheWarming !== undefined && !["off", "streaming", "idle"].includes(settings.cacheWarming)) throw new Error("cacheWarming 格式无法识别");
  settings.cacheWarming ??= "off";
  const old = runtime.BOT_MODEL_CACHE_RETENTION;
  const nativeEnv = process.env.PI_CACHE_RETENTION?.trim();
  if (nativeEnv && !["short", "long"].includes(nativeEnv)) throw new Error("PI_CACHE_RETENTION 环境变量格式无法识别");
  if (old !== undefined && !["auto", "none", "short", "long"].includes(old)) throw new Error("旧缓存设置格式无法识别");
  if (old === "none" || ["short", "long"].includes(old) && [runtime.PI_CACHE_RETENTION, nativeEnv].some(value => value && value !== old)) {
    if (!decisions.acceptNativeCache) questions.push({ key: "acceptNativeCache", message: "旧缓存策略无等价项或与原生配置冲突。是否接受 Pi 原生缓存（保留现有原生配置，缺省 short）？" });
    else if (nativeEnv) runtime.PI_CACHE_RETENTION = nativeEnv;
  } else if (["short", "long"].includes(old)) runtime.PI_CACHE_RETENTION = old;
  delete runtime.BOT_MODEL_CACHE_RETENTION;
  if (decisions.provider || decisions.model) {
    if (!decisions.provider || !decisions.model) throw new Error("必须同时指定 provider 和 model");
    settings.defaultProvider = decisions.provider;
    settings.defaultModel = decisions.model;
  }
  if (settings.defaultProvider === "openai-codex" && ["gpt-5.4", "gpt-5.4-mini"].includes(settings.defaultModel)) {
    questions.push({ key: "model", message: "旧 Codex 模型已移除，请指定替代模型的 provider 和 model；不会自动选型" });
  }
  return { questions, files: [
    { path: settingsPath, relative: "data/runtime/pi/settings.json", value: settings, changed: beforeSettings !== JSON.stringify(settings) },
    { path: runtimePath, relative: "data/config/runtime.json", value: runtime, changed: beforeRuntime !== JSON.stringify(runtime) },
  ] };
}

export const v1: Migration = {
  to: 1,
  async preview(context) {
    const result = await changes(context);
    return { files: result.files.filter(file => file.changed).map(file => ({ root: "project", path: file.relative })), decisions: result.questions,
      configuration: Object.fromEntries(result.files.filter(file => file.changed).map(file => [file.relative, file.value])),
      steps: ["确保运行配置使用 PI_CACHE_RETENTION", "确保 Pi 原生保温和模型选型有效", "完整校验配置与账本，登记项目和群根版本 1"] };
  },
  async apply(context) {
    const result = await changes(context);
    if (result.questions.length) throw new Error("迁移决策尚未完成；请重新预览并确认选择");
    for (const file of result.files) if (file.changed) await publishJson(file.path, file.value);
  },
  async validate(context) {
    const result = await changes(context);
    if (result.questions.length || result.files.some(file => file.changed)) throw new Error("v1 迁移校验失败");
    await validateSessions(context.groups);
  },
};
