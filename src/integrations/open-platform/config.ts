// 应用机器人凭据与平台地址。主机只允许固定值，避免误配置把凭据发往别处。
import { readFileSync } from "node:fs";
import { APP_BOT_CONFIG_PATH } from "../../core/storage.ts";

export type PlatformEnvironment = "production" | "staging";

export interface AppBotConfig {
  readonly environment: PlatformEnvironment;
  readonly appId: string;
  readonly appSecret: string;
}

const API_HOSTS: Record<PlatformEnvironment, string> = {
  production: "https://imtwo.zdxlz.com",
  staging: "https://mxpre.zdxlz.com:1443",
};

/** 平台入口。正式代码只用 platformEndpoints()；测试可传入指向本地假平台的同形对象。 */
export interface PlatformEndpoints {
  /** OpenAPI 根地址，不带结尾斜杠。 */
  readonly api: string;
  /** Stream WebSocket 地址。 */
  readonly stream: string;
  /** 预签名上传/下载地址是否指向平台对象存储。 */
  storage(url: URL): boolean;
}

export function platformEndpoints(environment: PlatformEnvironment): PlatformEndpoints {
  const api = API_HOSTS[environment];
  return {
    api,
    stream: `${api.replace(/^https:/, "wss:")}/open-apis/v1/events/stream`,
    storage: url => url.protocol === "https:" && (url.hostname === "imfl.zdxlz.com" || url.hostname.endsWith(".zdxlz.com")),
  };
}

const APP_ID = /^[A-Za-z0-9_-]{4,128}$/;
const APP_SECRET = /^[\x21-\x7e]{8,512}$/;

/** 校验配置内容；错误信息不含凭据值。 */
export function parseAppBotConfig(value: unknown): AppBotConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("应用机器人配置应为 JSON 对象");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter(key => !["environment", "appId", "appSecret"].includes(key));
  if (unknown.length) throw new Error(`应用机器人配置含未知字段：${unknown.join("、")}`);
  const environment = record.environment ?? "production";
  if (environment !== "production" && environment !== "staging") throw new Error("environment 只能是 production 或 staging");
  if (typeof record.appId !== "string" || !APP_ID.test(record.appId)) throw new Error("appId 格式不正确");
  if (typeof record.appSecret !== "string" || !APP_SECRET.test(record.appSecret)) throw new Error("appSecret 格式不正确");
  return { environment, appId: record.appId, appSecret: record.appSecret };
}

/** 读取 data/config/app-bot.json；文件不存在时返回 undefined，内容不合法时抛错。 */
export function readAppBotConfig(path = APP_BOT_CONFIG_PATH): AppBotConfig | undefined {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`${path} 不是有效的 JSON`); }
  return parseAppBotConfig(parsed);
}
