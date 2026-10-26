import { afterAll, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeMcp } from "@earendil-works/pi-mcp/oauth";
import { readMcpConfig, type McpServerConfig } from "../../src/core/mcp-config.ts";
import { McpTools, type McpMember } from "../../src/integrations/mcp.ts";
import { mcpOAuth } from "../../src/integrations/mcp-oauth.ts";
import { tempFixture } from "../helpers/temp.ts";

const f = await tempFixture("mcp-"); afterAll(() => f.cleanup());
const fixtureServer = fileURLToPath(new URL("../helpers/mcp-fixture.ts", import.meta.url));
const supervisor = fileURLToPath(new URL("../../src/core/process-supervisor.ts", import.meta.url));
let n = 0;
const GROUP_ID = "群-A";
const member: McpMember = { scope: { kind: "group", groupId: GROUP_ID }, phone: "+86 alice", workspaceDir: join(f.root, "workspace"), tempDir: join(f.root, "alice") };
const direct: McpMember = { ...member, scope: { kind: "direct" } };
await mkdir(member.workspaceDir); await mkdir(member.tempDir);

function http() {
  const state = { changed: false, calls: 0, hanging: false, requests: [] as { method: string; chat: string | null; group: string | null; member: string | null; token: string | null }[],
    started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), discovery: false, onCall: async () => {} };
  let sessions = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const token = request.headers.get("authorization");
    if (request.method === "DELETE") {
      state.requests.push({ method: "DELETE", chat: request.headers.get("x-mixin-chat"), group: request.headers.get("x-mixin-group"), member: request.headers.get("x-mixin-member"), token });
      return new Response(null, { status: 204 });
    }
    if (state.discovery && request.method === "GET") { state.started.resolve(); await state.release.promise; return Response.json({}); }
    if (state.discovery) return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${server.port}/.well-known/oauth-protected-resource"` } });
    const rpc = await request.json() as { id?: number; method: string; params?: { protocolVersion: string } };
    state.requests.push({ method: rpc.method, chat: request.headers.get("x-mixin-chat"), group: request.headers.get("x-mixin-group"), member: request.headers.get("x-mixin-member"), token });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    const headers: Record<string, string> = {};
    if (rpc.method === "initialize") { headers["mcp-session-id"] = `fixture-${++sessions}`; result = { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }; }
    else if (rpc.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: state.changed ? "number" : "string" } }, required: ["text"] } }] };
    else if (rpc.method === "tools/call") { state.calls++; state.started.resolve(); if (state.hanging) await state.release.promise; await state.onCall(); result = { content: [{ type: "text", text: "ok" }] }; }
    else return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "unknown" } });
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers });
  } });
  const config: McpServerConfig = { name: `fixture${++n}`, transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, tools: ["echo"] };
  return { server, config, state, async close() { state.release.resolve(); await server.stop(true); } };
}

test("MCP uses official member sessions, an allowlist, identity headers and a final control gate", async () => {
  const h = http(), manager = new McpTools({ format: 1, servers: [h.config] }, join(f.root, `discovery-${n}`));
  try {
    await manager.initialize(new AbortController().signal); expect(manager.catalogue.map(entry => entry.tool.name)).toEqual(["echo"]);
    const output = await manager.call(manager.catalogue[0]!, member, { text: "hello" }, new AbortController().signal, work => work());
    expect(output.content).toEqual([{ type: "text", text: "ok" }]);
    expect(h.state.requests.find(request => request.method === "tools/call")).toMatchObject({ chat: "group", group: encodeURIComponent(GROUP_ID), member: encodeURIComponent(member.phone) });
    expect(h.state.requests.filter(request => request.method === "DELETE")).toHaveLength(2);
    // A direct-chat member: the chat kind, no group header.
    await manager.call(manager.catalogue[0]!, direct, { text: "direct" }, new AbortController().signal, work => work());
    expect(h.state.requests.filter(request => request.method === "tools/call").at(-1)).toMatchObject({ chat: "direct", group: null, member: encodeURIComponent(member.phone) });
    expect(h.state.calls).toBe(2);
    await expect(manager.call(manager.catalogue[0]!, member, { text: "held" }, new AbortController().signal, async () => { throw new Error("synthetic pending control"); })).rejects.toThrow("synthetic pending control");
    expect(h.state.calls).toBe(2);
    h.state.changed = true;
    await expect(manager.call(manager.catalogue[0]!, member, { text: "schema" }, new AbortController().signal, work => work())).rejects.toThrow("目录变化");
    expect(h.state.calls).toBe(2);
  } finally { await manager.close(); await h.close(); }
});

// Independent ports, clients and discovery directories, both transport boundaries sharing the wait. The request
// timeout (30 s in service) is shortened here: a tools/call slower than it still finishes, while a tools/list
// equally slow is ended by it, so the call really outlived the timeout.
const REQUEST_MS = 3000, SLOW_MS = 4500;
test.concurrent.each(["headers", "body"])("HTTP MCP tools can take longer than the request timeout before their %s arrive", async phase => {
  let calls = 0, slowList = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const rpc = await request.json() as { id?: number; method: string; params?: { protocolVersion: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name: "slow", version: "1" }, capabilities: { tools: {} } };
    else if (rpc.method === "tools/list") { if (slowList) await Bun.sleep(SLOW_MS); result = { tools: [{ name: "slow", inputSchema: { type: "object", properties: {} } }] }; }
    else {
      calls++; result = { content: [{ type: "text", text: "finished" }] };
      if (phase === "headers") await Bun.sleep(SLOW_MS);
      else return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode(" ")); await Bun.sleep(SLOW_MS);
        try { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))); controller.close(); } catch { /* The failing version aborts the reader. */ }
      } }), { headers: { "content-type": "application/json", "mcp-session-id": "slow-session" } });
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "mcp-session-id": "slow-session" } });
  } });
  const manager = new McpTools({ format: 1, servers: [{ name: `slow${++n}`, tools: ["slow"], transport: "http", url: `http://127.0.0.1:${server.port}/mcp` }] },
    join(f.root, `slow-${n}`), { requestMs: REQUEST_MS });
  try {
    await manager.initialize(new AbortController().signal);
    const output = await manager.call(manager.catalogue[0]!, member, {}, new AbortController().signal, work => work());
    expect(output.content).toEqual([{ type: "text", text: "finished" }]); expect(calls).toBe(1);
    slowList = true;
    await expect(manager.call(manager.catalogue[0]!, member, {}, new AbortController().signal, work => work())).rejects.toThrow();
    expect(calls).toBe(1);
  } finally { await manager.close(); await server.stop(true); }
}, 60000);

test.each(["abort", "close"])("MCP %s cancels active I/O and closes the session", async mode => {
  const h = http(), manager = new McpTools({ format: 1, servers: [h.config] }, join(f.root, `discovery-${n}`)), controller = new AbortController();
  try {
    await manager.initialize(controller.signal); h.state.hanging = true;
    const work = manager.call(manager.catalogue[0]!, member, { text: "wait" }, controller.signal, work => work());
    const failed = expect(work).rejects.toThrow();
    await h.state.started.promise;
    if (mode === "abort") controller.abort(new Error("synthetic cancel")); else await manager.close();
    await failed;
    expect(h.state.calls).toBe(1);
    expect(h.state.requests.filter(request => request.method === "DELETE")).toHaveLength(2);
    await expect(manager.call(manager.catalogue[0]!, member, {}, mode === "abort" ? controller.signal : new AbortController().signal, work => work())).rejects.toThrow();
  } finally { await manager.close(); await h.close(); }
});

test("MCP close cancels a transport waiting at a gate even when its caller stays live", async () => {
  const h = http(), manager = new McpTools({ format: 1, servers: [h.config] }, join(f.root, `discovery-${n}`));
  const caller = new AbortController(), held = Promise.withResolvers<void>(); let transportCancelled = false;
  try {
    await manager.initialize(caller.signal);
    const work = manager.call(manager.catalogue[0]!, member, {}, caller.signal, async (dispatch, signal) => {
      held.resolve();
      await new Promise<void>(resolve => {
        const abort = () => { transportCancelled = true; resolve(); };
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
      signal.throwIfAborted(); return dispatch();
    });
    const failed = expect(work).rejects.toThrow();
    await held.promise; await manager.close(); await failed;
    expect(transportCancelled).toBe(true); expect(caller.signal.aborted).toBe(false); expect(h.state.calls).toBe(0);
  } finally { await manager.close(); await h.close(); }
});

test("MCP close reuses the last token even if OAuth credentials change after the response", async () => {
  const h = http(); h.config.oauth = { port: 43127, clientId: "fixture-client" };
  const { provider } = mcpOAuth(h.config);
  await provider.saveTokens({ access_token: "before", token_type: "Bearer", expires_in: 1 });
  const manager = new McpTools({ format: 1, servers: [h.config] }, join(f.root, `discovery-${n}`));
  try {
    await manager.initialize(new AbortController().signal);
    h.state.onCall = () => provider.saveTokens({ access_token: "after", token_type: "Bearer" });
    await manager.call(manager.catalogue[0]!, member, {}, new AbortController().signal, work => work());
    expect(h.state.requests.findLast(request => request.method === "DELETE")!.token).toBe("Bearer before");
    expect((await provider.tokens())!.access_token).toBe("after");
  } finally { await manager.close(); await h.close(); }
});

test("OAuth discovery observes cancellation through the official transport and saves no grant", async () => {
  const h = http(); h.config.oauth = { port: 43128, clientId: "fixture-client" }; h.state.discovery = true;
  const manager = new McpTools({ format: 1, servers: [h.config] }, join(f.root, `discovery-${n}`)), controller = new AbortController();
  try {
    const work = manager.initialize(controller.signal), failed = expect(work).rejects.toThrow();
    await h.state.started.promise; controller.abort(new Error("cancel login discovery")); await failed;
    expect(await mcpOAuth(h.config).provider.tokens()).toBeUndefined();
  } finally { await manager.close(); await h.close(); }
});

// A call cancelled while the official provider refreshes after a 401: the refresh request is cancelled with the call,
// the call never reaches the server again, and the stored grant survives for the next call, which refreshes and retries.
test("HTTP MCP cancelled during a 401 refresh sends no retry and keeps the grant for the next call", async () => {
  const toolCalls: (string | null)[] = [], refreshes: string[] = [], refreshing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let hold = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const origin = `http://127.0.0.1:${server.port}`, path = new URL(request.url).pathname;
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/.well-known/oauth-protected-resource") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (path === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`, response_types_supported: ["code"] });
    if (path === "/token") {
      refreshes.push(new URLSearchParams(await request.text()).get("refresh_token") ?? "");
      if (hold) { refreshing.resolve(); await Promise.race([release.promise, new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }))]); }
      return Response.json({ access_token: "fresh", token_type: "Bearer", refresh_token: "refresh-1" });
    }
    if (path !== "/mcp") return new Response(null, { status: 404 });
    const rpc = await request.json() as { id?: number; method: string; params?: { protocolVersion: string } };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const headers = { "mcp-session-id": "refresh-session" };
    if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params!.protocolVersion, serverInfo: { name: "refresh", version: "1" }, capabilities: { tools: {} } } }, { headers });
    if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] } }, { headers });
    toolCalls.push(request.headers.get("authorization"));
    if (request.headers.get("authorization") !== "Bearer fresh") return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "ok" }] } }, { headers });
  } });
  const config: McpServerConfig = { name: `refresh${++n}`, transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, tools: ["echo"], oauth: { port: 43132, clientId: "fixture-client" } };
  const { provider } = mcpOAuth(config);
  await provider.saveTokens({ access_token: "stale", token_type: "Bearer", refresh_token: "refresh-1" });
  const manager = new McpTools({ format: 1, servers: [config] }, join(f.root, `discovery-${n}`)), controller = new AbortController();
  try {
    await manager.initialize(new AbortController().signal);
    const failed = expect(manager.call(manager.catalogue[0]!, member, {}, controller.signal, work => work())).rejects.toThrow();
    await refreshing.promise; controller.abort(new Error("cancelled during refresh")); await failed;
    expect(toolCalls).toEqual(["Bearer stale"]); expect(refreshes).toEqual(["refresh-1"]);
    expect(await provider.tokens()).toMatchObject({ access_token: "stale", refresh_token: "refresh-1" });
    hold = false;
    const output = await manager.call(manager.catalogue[0]!, member, {}, new AbortController().signal, work => work());
    expect(output.content).toEqual([{ type: "text", text: "ok" }]);
    expect(toolCalls).toEqual(["Bearer stale", "Bearer stale", "Bearer fresh"]); expect(refreshes).toEqual(["refresh-1", "refresh-1"]);
    expect((await provider.tokens())!.access_token).toBe("fresh");
  } finally { release.resolve(); await manager.close(); await server.stop(true); }
});

test("administrator OAuth login aborts its discovery and scopes persisted credentials to the exact server", async () => {
  const state = join(f.root, "auth"), controller = new AbortController(), started = Promise.withResolvers<void>();
  const server: McpServerConfig = { name: "login", transport: "http", tools: ["echo"], url: "http://127.0.0.1:43129/mcp", oauth: { port: 43130, clientId: "fixture" } };
  const { provider } = mcpOAuth(server, () => { throw new Error("unexpected redirect"); }, state);
  const work = authorizeMcp(provider, { serverUrl: server.url!, signal: controller.signal, fetch: async (_url, init) => {
    init?.signal?.throwIfAborted();
    started.resolve(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  } });
  const failed = expect(work).rejects.toThrow(); await started.promise; controller.abort(new Error("cancelled login")); await failed;
  expect(await provider.tokens()).toBeUndefined();
  await provider.saveTokens({ access_token: "fixture-secret", token_type: "Bearer" });
  expect((await mcpOAuth(server, undefined, state).provider.tokens())!.access_token).toBe("fixture-secret");
  expect(await mcpOAuth({ ...server, url: "http://127.0.0.1:43129/another" }, undefined, state).provider.tokens()).toBeUndefined();
});

test("stdio MCP inherits only selected environment and uses the member's cwd", async () => {
  const previous = process.env.MIXIN_TEST_AMBIENT_SECRET; process.env.MIXIN_TEST_AMBIENT_SECRET = "must-not-inherit";
  const config: McpServerConfig = { name: `stdio${++n}`, transport: "stdio", command: process.execPath, args: [fixtureServer], tools: ["echo"] };
  const manager = new McpTools({ format: 1, servers: [config] }, join(f.root, `discovery-${n}`));
  try {
    await manager.initialize(new AbortController().signal);
    const output = await manager.call(manager.catalogue[0]!, member, { text: "hello" }, new AbortController().signal, work => work());
    expect(JSON.parse((output.content![0] as { text: string }).text)).toMatchObject({ chat: "group", group: GROUP_ID, phone: member.phone, cwd: member.tempDir, secret: null });
  } finally { await manager.close(); if (previous === undefined) delete process.env.MIXIN_TEST_AMBIENT_SECRET; else process.env.MIXIN_TEST_AMBIENT_SECRET = previous; }
  // Supervisor and server are two Bun processes: alone about 13 s on this Windows host, past 30 s beside parallel test groups.
}, 60000);

// The gate lets the tools/call through only after the request ended (timed out, or its caller cancelled): stdio sends
// nothing then, even though StdioTransport.send itself ignores the signal pi-mcp aborts. A timeout leaves the session
// open, so only the check in the send proxy stops it; a cancel also closes the session (checked here all the same).
test.each(["timeout", "cancel"])("stdio MCP sends no tools/call the gate releases after the request's %s", async mode => {
  const log = join(f.root, `stdio-log-${++n}.txt`);
  const config: McpServerConfig = { name: `stdio${n}`, transport: "stdio", command: process.execPath, args: [fixtureServer, "log", log], tools: ["echo"] };
  const manager = new McpTools({ format: 1, servers: [config] }, join(f.root, `discovery-${n}`), mode === "timeout" ? { callMs: 500 } : {});
  const caller = new AbortController(), held = Promise.withResolvers<void>(), released = Promise.withResolvers<unknown>();
  try {
    await manager.initialize(new AbortController().signal);
    // The gate admits the call the moment its signal says the request ended, while the session is still open.
    const work = manager.call(manager.catalogue[0]!, member, { text: "late" }, caller.signal, async (dispatch, signal) => {
      held.resolve();
      await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); if (signal.aborted) resolve(); });
      try { const sent = await dispatch(); released.resolve(undefined); return sent; } catch (error) { released.resolve(error); throw error; }
    });
    const failed = expect(work).rejects.toThrow();
    await held.promise;
    if (mode === "cancel") caller.abort(new Error("synthetic cancel"));
    await failed;
    expect(await released.promise).toBeInstanceOf(Error);
    // An answered request after it shows the server is reading.
    const output = await manager.call(manager.catalogue[0]!, member, { text: "next" }, new AbortController().signal, work => work());
    expect(JSON.parse((output.content![0] as { text: string }).text)).toMatchObject({ args: { text: "next" } });
    const methods = (await readFile(log, "utf8")).trim().split("\n");
    expect(methods.filter(method => method === "tools/call")).toEqual(["tools/call"]);
  } finally { await manager.close(); }
}, 90000);

test.each(["eof", "force"])("stdio supervisor reaps detached descendants when the parent ends by %s", async mode => {
  const pidPath = join(f.root, `descendant-${++n}.pid`);
  const args = [supervisor, "--stdio", process.execPath, fixtureServer, "spawn", pidPath];
  if (mode === "force") {
    const owner = join(f.root, `owner-${n}.ts`);
    await writeFile(owner, "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,process.argv.slice(2),{stdio:['pipe','ignore','inherit'],windowsHide:true}); child.once('exit',code=>process.exit(code??1)); setInterval(()=>{},1000);");
    args.unshift(owner);
  }
  const child = Bun.spawn([process.execPath, ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  // This chain starts up to four Bun processes; Windows security scanning delays each first spawn.
  const startupMs = process.platform === "win32" ? 45000 : 20000;
  const watchdog = setTimeout(() => child.kill(), startupMs + 8000);
  let pid = 0;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const deadline = Date.now() + startupMs;
    while (!pid && Date.now() < deadline) { pid = Number(await readFile(pidPath, "utf8").catch(() => "0")); if (!pid) await Bun.sleep(20); }
    expect(pid).toBeGreaterThan(0);
    // Forced death of the owner closes its stdin; the supervisor must remain alive to reap its children.
    if (mode === "force") child.kill("SIGKILL"); else child.stdin.end();
    await child.exited;
    const end = Date.now() + 2000; while (alive() && Date.now() < end) await Bun.sleep(20);
    expect(alive()).toBe(false);
  } finally { clearTimeout(watchdog); child.kill(); await child.exited; if (pid && alive()) process.kill(pid, "SIGKILL"); }
}, 60000);

test("MCP configuration rejects untrusted commands, absent allowlists and embedded credentials", async () => {
  const path = join(f.root, "config.json");
  for (const server of [
    { name: "a", transport: "stdio", command: "server", tools: ["echo"] },
    { name: "a", transport: "http", url: "https://example.invalid/mcp", tools: [] },
    { name: "a", transport: "http", url: "https://secret@example.invalid/mcp", tools: ["echo"] },
    { name: "a", transport: "http", url: "http://example.invalid/mcp", tools: ["echo"] },
    { name: "a", transport: "http", url: "https://example.invalid/mcp", tools: ["echo"], headersEnv: { "x-fixture": "invalid environment name" } },
    { name: "a", transport: "http", url: "https://example.invalid/mcp", tools: ["echo"], oauth: { port: 43131, clientSecretEnv: "" } },
  ]) { await writeFile(path, JSON.stringify({ format: 1, servers: [server] })); expect(() => readMcpConfig(path)).toThrow(); }
});
