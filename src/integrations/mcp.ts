import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpClient, StdioTransport, StreamableHttpTransport, type AuthProvider, type CallToolResult, type McpTransport, type Tool } from "@earendil-works/pi-mcp";
import type { McpConfig, McpServerConfig } from "../core/mcp-config.ts";
import { mcpOAuth } from "./mcp-oauth.ts";

export interface McpMember { groupId: string; phone: string; workspaceDir: string; tempDir: string }
export type ExternalGate = <T>(dispatch: () => Promise<T>, signal: AbortSignal) => Promise<T>;
export interface McpCatalogueTool { server: McpServerConfig; tool: Tool }
const supervisor = fileURLToPath(new URL("../core/process-supervisor.ts", import.meta.url));
const sameSchema = (a: Tool, b: Tool) => JSON.stringify(a.inputSchema) === JSON.stringify(b.inputSchema) && JSON.stringify(a.outputSchema) === JSON.stringify(b.outputSchema);

/** Official protocol/transports, short-lived member sessions, and a fixed administrator tool allowlist. */
export class McpTools {
  readonly catalogue: McpCatalogueTool[] = [];
  readonly #clients = new Set<McpClient>();
  readonly #clientClose = new WeakMap<McpClient, Promise<void>>();
  readonly #closing = new AbortController();
  readonly #scope = new AsyncLocalStorage<{ signal: AbortSignal; gate?: ExternalGate }>();
  readonly #auth = new Map<string, AuthProvider>();
  constructor(private readonly config: McpConfig, private readonly discoveryDir = "data/runtime/mcp/discovery") {
    for (const server of config.servers) if (server.oauth) this.#auth.set(server.name, mcpOAuth(server).auth);
  }

  async initialize(signal: AbortSignal): Promise<void> {
    try {
      await mkdir(this.discoveryDir, { recursive: true, mode: 0o700 });
      for (const server of this.config.servers) {
        const tools = await this.#use(server, undefined, signal, undefined, client => client.listTools({ signal, timeoutMs: 30000 }));
        const names = new Set<string>();
        for (const tool of tools) {
          if (names.has(tool.name)) throw new Error(`MCP ${server.name} 返回重复工具名称`);
          names.add(tool.name);
          if (server.tools.includes(tool.name)) this.catalogue.push({ server, tool });
        }
        if (server.tools.some(name => !names.has(name))) throw new Error(`MCP ${server.name} 的工具白名单有未发现的名称`);
      }
    } catch (error) { await this.close(); throw error; }
  }

  async call(entry: McpCatalogueTool, member: McpMember, args: Record<string, unknown>, signal: AbortSignal, gate: ExternalGate): Promise<CallToolResult> {
    return this.#use(entry.server, member, signal, gate, async client => {
      const current = (await client.listTools({ signal, timeoutMs: 30000 })).find(tool => tool.name === entry.tool.name);
      if (!current || !sameSchema(current, entry.tool)) throw new Error("MCP 工具目录变化，请由管理员检查并重启后重新发现；本次工具未执行");
      signal.throwIfAborted();
      const callSignal = AbortSignal.any([signal, this.#closing.signal, AbortSignal.timeout(120000)]);
      return this.#scope.run({ signal: callSignal, gate }, () => client.callTool(entry.tool.name, args, { signal: callSignal, timeoutMs: 120000 }));
    });
  }

  async #use<T>(server: McpServerConfig, member: McpMember | undefined, signal: AbortSignal, gate: ExternalGate | undefined,
    work: (client: McpClient) => Promise<T>): Promise<T> {
    if (this.#clients.size >= 8) throw new Error("MCP 活跃会话已达上限");
    const requestSignal = AbortSignal.any([signal, this.#closing.signal]);
    return this.#scope.run({ signal: requestSignal, gate }, async () => {
      requestSignal.throwIfAborted();
      const client = new McpClient({ name: "mixin-chatbot", version: "1.1.0", requestTimeoutMs: 30000,
        roots: member ? [{ uri: pathToFileURL(member.workspaceDir).href, name: "workspace (read only)" }, { uri: pathToFileURL(member.tempDir).href, name: "member tmp" }] : [],
      });
      this.#clients.add(client);
      const abort = () => { void this.#close(client).catch(() => {}); };
      requestSignal.addEventListener("abort", abort, { once: true });
      try {
        const transport = this.#transport(server, member);
        await client.connect(transport);
        requestSignal.throwIfAborted();
        return await work(client);
      } finally {
        requestSignal.removeEventListener("abort", abort);
        try { await this.#close(client); } finally { this.#clients.delete(client); }
      }
    });
  }

  #close(client: McpClient): Promise<void> {
    let work = this.#clientClose.get(client);
    if (!work) { work = client.close(); this.#clientClose.set(client, work); }
    return work;
  }

  #transport(server: McpServerConfig, member: McpMember | undefined): McpTransport {
    if (server.transport === "stdio") {
      const env: Record<string, string> = {};
      for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP", "LANG"]) if (process.env[name]) env[name] = process.env[name]!;
      Object.assign(env, server.env, { MIXIN_GROUP_ID: member?.groupId ?? "", MIXIN_MEMBER_PHONE: member?.phone ?? "" });
      const transport = new StdioTransport({ command: process.execPath, args: [supervisor, "--stdio", server.command!, ...server.args ?? []],
        cwd: member?.tempDir ?? this.discoveryDir, env, inheritEnv: false, maxMessageBytes: 8 * 1024 * 1024, maxStderrBytes: 65536, closeTimeoutMs: 2000 });
      return new Proxy(transport, { get: (target, property) => {
        if (property === "send") return (message: Parameters<McpTransport["send"]>[0]) => {
          const scope = this.#scope.getStore();
          return "method" in message && message.method === "tools/call" && scope?.gate
            ? scope.gate(() => target.send(message), scope.signal) : target.send(message);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const headers: Record<string, string> = {};
    for (const [name, variable] of Object.entries(server.headersEnv ?? {})) {
      const value = process.env[variable];
      if (!value) throw new Error(`MCP ${server.name} 缺少管理员配置的请求凭证`);
      headers[name] = value;
    }
    for (const name of Object.keys(headers)) if (["x-mixin-group", "x-mixin-member"].includes(name.toLowerCase())) delete headers[name];
    if (member) Object.assign(headers, { "x-mixin-group": encodeURIComponent(member.groupId), "x-mixin-member": encodeURIComponent(member.phone) });
    return new StreamableHttpTransport({ url: server.url!, headers, authProvider: this.#auth.get(server.name),
      maxMessageBytes: 8 * 1024 * 1024, openGetStream: false,
      fetch: (url, init) => {
        const scope = this.#scope.getStore();
        // Session DELETE and cancellation must still reach the server after a tool's cancellation.
        let method: string | undefined;
        if (init?.method === "POST" && typeof init.body === "string") {
          try { method = JSON.parse(init.body).method; } catch { /* The official transport owns protocol validation. */ }
        }
        const signal = AbortSignal.any([this.#closing.signal, ...(scope ? [scope.signal] : []), ...(init?.signal ? [init.signal] : []),
          ...(method === "tools/call" ? [] : [AbortSignal.timeout(30000)])]);
        const dispatch = () => { signal.throwIfAborted(); return fetch(url, { ...init, signal }); };
        return init?.method === "DELETE" || method === "notifications/cancelled" ? fetch(url, { ...init, signal: AbortSignal.timeout(5000) }) : scope?.gate ? scope.gate(dispatch, signal) : dispatch();
      },
    });
  }

  async close(): Promise<void> {
    this.#closing.abort();
    const results = await Promise.allSettled([...this.#clients].map(client => this.#close(client)));
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => (result as PromiseRejectedResult).reason), "MCP 会话关闭失败");
  }
}
