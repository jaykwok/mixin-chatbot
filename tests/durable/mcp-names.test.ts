import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodemodeSandbox, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { mcpMemberTools } from "../../src/durable/mcp.ts";
import { groupDoor } from "../../src/durable/models.ts";
import { McpTools } from "../../src/integrations/mcp.ts";
import { tempFixture } from "../helpers/temp.ts";

test("two MCP servers whose names normalize alike remain independently callable through the official sandbox", async () => {
  const f = await tempFixture("mcp-names-"), dispatched: string[] = [];
  const servers = ["docs-a", "docs_a"].map(name => ({ name, server: Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = await request.json() as { id?: number; method: string; params?: { protocolVersion: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name, version: "1" }, capabilities: { tools: {} } };
    else if (rpc.method === "tools/list") result = { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] };
    else if (rpc.method === "tools/call") { dispatched.push(name); result = { content: [{ type: "text", text: name }] }; }
    else throw new Error("unexpected RPC");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  } }) }));
  const manager = new McpTools({ format: 1, servers: servers.map(({ name, server }) => ({ name, transport: "http", tools: ["search"], url: `http://127.0.0.1:${server.port}/mcp` })) }, join(f.root, "discovery"));
  const door = groupDoor({}), signal = new AbortController().signal;
  const member = { groupId: "group", phone: "alice", workspaceDir: join(f.root, "workspace"), tempDir: join(f.root, "tmp") };
  let sandbox: CodemodeSandbox | undefined;
  try {
    await mkdir(member.workspaceDir); await mkdir(member.tempDir); await manager.initialize(signal);
    const adapters = mcpMemberTools({ root: f.root, groupId: member.groupId }, manager, door);
    const tools = adapters.map((adapter, i) => ({ name: adapter.definition.name,
      execute: (args: unknown) => manager.call(manager.catalogue[i]!, member, args as Record<string, unknown>, signal, dispatch => dispatch()),
    }));
    sandbox = new CodemodeSandbox({ tools });
    const names = tools.map(tool => toCodemodeIdentifier(tool.name));
    const output = await sandbox.execute(`return [await tools.${names[0]}({}), await tools.${names[1]}({})];`);
    expect(output.ok).toBe(true);
    expect(dispatched).toEqual(servers.map(server => server.name));
  } finally { await sandbox?.close(); await manager.close(); await door.close(); await Promise.all(servers.map(({ server }) => server.stop(true))); await f.cleanup(); }
}, 15000);
