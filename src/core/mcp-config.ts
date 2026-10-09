import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { MCP_CONFIG_PATH } from "./storage.ts";

export interface McpServerConfig {
  name: string; tools: string[]; transport: "stdio" | "http"; command?: string; args?: string[];
  env?: Record<string, string>; url?: string; headersEnv?: Record<string, string>;
  oauth?: { port: number; clientId?: string; clientSecretEnv?: string };
}
export interface McpConfig { format: 1; servers: McpServerConfig[] }
export function readMcpConfig(path = MCP_CONFIG_PATH): McpConfig | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} 必须是对象`);
  const value = raw as Record<string, unknown>;
  if (value.format !== 1 || !Array.isArray(value.servers) || value.servers.length > 8 || Object.keys(value).some(key => !["format", "servers"].includes(key))) throw new Error(`${path} 格式无效`);
  const names = new Set<string>();
  const servers = value.servers.map((raw): McpServerConfig => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP server 必须是对象");
    const server = raw as Record<string, unknown>;
    if (Object.keys(server).some(key => !["name", "tools", "transport", "command", "args", "env", "url", "headersEnv", "oauth"].includes(key))) throw new Error("MCP server 含未知字段");
    if (typeof server.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(server.name) || names.has(server.name)) throw new Error("MCP server 名称无效或重复");
    names.add(server.name);
    const strings = (value: unknown, path: string, limit: number): string[] => {
      if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== "string" || !item || item.includes("\0"))) throw new Error(`${path} 必须是字符串数组`);
      return value as string[];
    };
    const record = (value: unknown, path: string): Record<string, string> | undefined => {
      if (value === undefined) return undefined;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([name, item]) => !name || name.includes("\0") || typeof item !== "string" || item.includes("\0"))) throw new Error(`${path} 必须是字符串映射`);
      return value as Record<string, string>;
    };
    const tools = strings(server.tools, "MCP tools", 64);
    if (!tools.length || new Set(tools).size !== tools.length) throw new Error("MCP tools 必须是非空、无重复的管理员白名单");
    if (server.transport === "stdio") {
      if (typeof server.command !== "string" || !isAbsolute(server.command) || server.command.includes("\0") || server.url !== undefined || server.headersEnv !== undefined || server.oauth !== undefined) throw new Error("MCP stdio 需要绝对 command 路径且不能包含 HTTP 设置");
      const env = record(server.env, "MCP env");
      if (Object.keys(env ?? {}).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("MCP env 变量名无效");
      return { name: server.name, tools, transport: "stdio", command: server.command, args: strings(server.args ?? [], "MCP args", 64), env };
    }
    if (server.transport !== "http" || typeof server.url !== "string" || server.command !== undefined || server.args !== undefined || server.env !== undefined) throw new Error("MCP http 需要 url 且不能包含 stdio 设置");
    const url = new URL(server.url);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("MCP url 必须是 HTTPS（本机回环可用 HTTP），凭证通过环境变量提供");
    let oauth: McpServerConfig["oauth"];
    if (server.oauth !== undefined) {
      const auth = server.oauth as Record<string, unknown>;
      if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).some(key => !["port", "clientId", "clientSecretEnv"].includes(key))
        || typeof auth.port !== "number" || !Number.isSafeInteger(auth.port) || auth.port < 1024 || auth.port > 65535
        || (auth.clientId !== undefined && (typeof auth.clientId !== "string" || !auth.clientId.trim() || auth.clientId.includes("\0")))
        || (auth.clientSecretEnv !== undefined && (typeof auth.clientSecretEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.clientSecretEnv)))) throw new Error("MCP oauth 配置无效");
      oauth = { port: auth.port, clientId: auth.clientId as string | undefined, clientSecretEnv: auth.clientSecretEnv as string | undefined };
    }
    const headersEnv = record(server.headersEnv, "MCP headersEnv");
    if (Object.entries(headersEnv ?? {}).some(([name, variable]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))) throw new Error("MCP headersEnv 请求头或变量名无效");
    return { name: server.name, tools, transport: "http", url: url.href, headersEnv, ...(oauth ? { oauth } : {}) };
  });
  return { format: 1, servers };
}
