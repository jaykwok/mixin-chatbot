import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adaptOAuthProvider, McpOAuthProvider, type McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import type { McpServerConfig } from "../core/mcp-config.ts";
import { replaceFile } from "../core/maintenance.ts";

export function mcpOAuth(server: McpServerConfig, onRedirect: (url: URL) => void | Promise<void> = () => {
  throw new Error(`MCP ${server.name} 需要管理员执行 bun run mcp login ${server.name}`);
}, stateRoot = "data/runtime/mcp") {
  if (!server.oauth || !server.url) throw new Error("服务器未配置 OAuth");
  if (server.oauth.clientSecretEnv && !process.env[server.oauth.clientSecretEnv]) throw new Error(`MCP ${server.name} 缺少管理员配置的 OAuth 凭证`);
  const path = join(stateRoot, `${server.name}.json`);
  const provider = new McpOAuthProvider({ serverUrl: server.url,
    redirectUrl: `http://127.0.0.1:${server.oauth.port}/mcp/${server.name}/callback`,
    clientMetadata: { client_name: "mixin-chatbot", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: server.oauth.clientSecretEnv ? "client_secret_post" : "none" },
    clientId: server.oauth.clientId,
    clientSecret: server.oauth.clientSecretEnv ? process.env[server.oauth.clientSecretEnv] : undefined,
    store: {
      async load(): Promise<McpOAuthState | undefined> {
        try { return JSON.parse(await readFile(path, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      },
      async save(state: McpOAuthState) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = path + "." + randomUUID() + ".tmp";
        try {
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
          await replaceFile(temporary, path);
        } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      },
    }, onRedirect,
  });
  return { provider, auth: adaptOAuthProvider(provider) };
}
