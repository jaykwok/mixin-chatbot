import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { McpTools } from "../../src/integrations/mcp.ts";
import { codemodeExtension } from "../../src/durable/codemode/index.ts";
import { removeCodemodeResults } from "../../src/durable/codemode/results.ts";
import { claimGroup, memberConversation } from "../../src/durable/identity.ts";
import { mcpMemberTools } from "../../src/durable/mcp.ts";
import { groupDoor } from "../../src/durable/models.ts";
import { ResultsDoc } from "../../src/durable/result-lifecycle.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { memberPlaces } from "../../src/durable/tools.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const f = await tempFixture("durable-mcp-"); afterAll(() => f.cleanup());
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";

test("deferred MCP in codemode keeps long results and images in each member's owned, sweepable tmp", async () => {
  const identities: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = await request.json() as { id?: number; method: string; params?: { protocolVersion: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
    else if (rpc.method === "tools/list") result = { tools: [{ name: "report", inputSchema: { type: "object", properties: {} } }] };
    else if (rpc.method === "tools/call") {
      const member = decodeURIComponent(request.headers.get("x-mixin-member")!); identities.push(member);
      result = { content: [{ type: "text", text: member + "x".repeat(30000) }, { type: "image", data: png, mimeType: "image/png" }], structuredContent: { member } };
    } else throw new Error("unexpected RPC");
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  } });
  const manager = new McpTools({ format: 1, servers: [{ name: "reports", tools: ["report"], transport: "http", url: `http://127.0.0.1:${server.port}/mcp` }] }, join(f.root, "discovery"));
  const { models, faux, model } = fauxModels(), holder: { harness?: Harness } = {};
  const door = groupDoor(holder, { startTries: 1 }), members = { root: join(f.root, "root"), groupId: "group-a" };
  let harness: Harness | undefined;
  try {
    await mkdir(members.root); await manager.initialize(new AbortController().signal);
    const tools = mcpMemberTools(members, manager, door), registry = createRegistry(); registry.install(door.extension());
    expect(tools[0]!.definition.exposure).toBe("deferred"); expect(tools[0]!.replay).toBe("unsafe");
    registry.install(defineExtension({ name: "mixin.mcp" }));
    registry.install(codemodeExtension({ members, tools: tools.map(tool => ({ extension: "mixin.mcp", tool })) }));
    harness = await Harness.open(await openGroupStorage(join(f.root, "group.sqlite")), { registry, models: door.wrap(models), settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } }, context);
    holder.harness = harness; await claimGroup(harness, "group-a", context);
    for (const phone of ["alice", "bob"]) {
      const { conversation } = await memberConversation(harness, "group-a", phone, { model }, context);
      const callId = `report-${phone}`;
      faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: `return await tools.${tools[0]!.definition.name}({});` }, { id: callId })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      await (await conversation.submit({ type: "input", content: "report" }, context)).wait(context);
      const output = (await conversation.entries({}, 200, undefined, context)).items.flatMap(entry => entry.model ?? [])
        .find(message => message.role === "toolResult" && message.toolCallId === callId) as ToolResultMessage;
      expect(output.isError, JSON.stringify(output.content)).toBe(false); expect(output.usage).toBeUndefined();
      const calls = (await harness.snapshot(ResultsDoc, context))!.calls;
      const owned = Object.entries(calls).filter(([, owner]) => owner.phone === phone).map(([name]) => name);
      expect(owned.some(name => /^\d+-mcp-/.test(name))).toBe(true);
      const tempDir = memberPlaces(members, members.groupId, phone).tempDir;
      const mcpDir = join(tempDir, "codemode", owned.find(name => /^\d+-mcp-/.test(name))!);
      expect(await readFile(join(mcpDir, "output-1.png"))).toEqual(Buffer.from(png, "base64"));
      const full = JSON.parse(await readFile(join(mcpDir, "output.txt"), "utf8"));
      expect(full.structuredContent).toEqual({ member: phone }); expect(full.content[0].text).toHaveLength(phone.length + 30000);
      expect(JSON.stringify(output.content)).toContain(tempDir.replaceAll("\\", "\\\\"));
      expect(await removeCodemodeResults(tempDir, Infinity, { registered: new Set(owned), protected: new Set(), expire: async () => {} })).toEqual(process.platform === "linux" ? [] : [...owned].sort());
    }
    expect(identities).toEqual(["alice", "bob"]);
  } finally { await manager.close(); await door.close(); await harness?.close(context); await server.stop(true); }
}, 20000);
