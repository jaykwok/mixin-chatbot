import { authorizeMcp, OAuthCallbackServer } from "@earendil-works/pi-mcp/oauth";
import { readMcpConfig } from "../../src/core/mcp-config.ts";
import { acquireLease } from "../../src/core/maintenance.ts";
import { mcpOAuth } from "../../src/integrations/mcp-oauth.ts";

if (import.meta.main) {
  const [command, name, ...extra] = process.argv.slice(2);
  if (command !== "login" || !name || extra.length) { console.error("用法：停机后 bun run mcp login <服务器名>"); process.exit(1); }
  const server = readMcpConfig()?.servers.find(server => server.name === name);
  if (!server?.oauth || !server.url) throw new Error("服务器未配置 HTTP OAuth");
  const release = await acquireLease("service");
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
  const cancel = () => controller.abort(new Error("登录取消"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  let callback: OAuthCallbackServer | undefined;
  const close = () => { void callback?.close(); };
  try {
    callback = await OAuthCallbackServer.listen({ host: "127.0.0.1", port: server.oauth.port, path: `/mcp/${server.name}/callback`, timeoutMs: 120000 });
    signal.addEventListener("abort", close, { once: true });
    const { provider } = mcpOAuth(server, url => { console.log(`请在浏览器打开：${url.href}`); });
    const result = await authorizeMcp(provider, { serverUrl: server.url, signal });
    if (result === "REDIRECT") {
      const response = await callback.waitForCallback(await provider.state());
      const outcome = await authorizeMcp(provider, { serverUrl: server.url, signal, authorizationCode: response.code, iss: response.iss });
      if (outcome !== "AUTHORIZED") throw new Error("MCP OAuth 授权没有完成");
    }
    signal.throwIfAborted();
    console.log(`MCP ${name} 授权已保存`);
  } finally { signal.removeEventListener("abort", close); await callback?.close(); await release(); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
