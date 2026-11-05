// BotLink against a fake bot on a loopback port: which instance it trusts, how it follows a restart, and that the admin
// token never shows up in what it reports.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BotLink, BotOffline, BotReadError } from "../../scripts/ops/console/bot.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("console-bot-");
const file = join(fixture.root, "instance.json");

type Health = { status?: string; verificationOnly?: boolean; instanceId?: string };
const fake = {
  token: "token-0123456789abcdef", instanceId: crypto.randomUUID(), startedAt: 1_000, health: {} as Health,
  healthCalls: 0, delayMs: 0, inFlight: 0, maxInFlight: 0,
  answer: (_op: Record<string, unknown>) => new Response(JSON.stringify({ status: "ok", result: { ok: true } }), { headers: { "content-type": "application/json" } }),
};
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      fake.healthCalls++;
      return Response.json({ service: "mixin-chatbot", version: 1, status: "ready", instanceId: fake.instanceId, pid: process.pid, startedAt: fake.startedAt, ...fake.health });
    }
    if (request.headers.get("authorization") !== `Bearer ${fake.token}`) return new Response("404 Not Found", { status: 404 });
    fake.inFlight++;
    fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
    try {
      if (fake.delayMs) await Bun.sleep(fake.delayMs);
      return fake.answer(await request.json() as Record<string, unknown>);
    } finally { fake.inFlight--; }
  },
});
afterAll(async () => { server.stop(true); await fixture.cleanup(); });

const record = (token = fake.token, instanceId = fake.instanceId) =>
  writeFile(file, JSON.stringify({ pid: process.pid, port: server.port, token, instanceId, startedAt: fake.startedAt }));

beforeEach(async () => {
  fake.token = "token-0123456789abcdef"; fake.instanceId = crypto.randomUUID(); fake.health = {}; fake.healthCalls = 0; fake.delayMs = 0; fake.maxInFlight = 0;
  fake.answer = () => Response.json({ status: "ok", result: { ok: true } });
  await record();
});

const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (error: Error) => error);

test("checks /health once per instance within the interval and again after it", async () => {
  let now = 0;
  const link = new BotLink({ instanceFile: file, verifyMs: 10_000, now: () => now });
  expect(await link.read({ op: "spaces" })).toEqual({ ok: true });
  await link.read({ op: "spaces" });
  expect(fake.healthCalls).toBe(1);
  now += 10_001;
  await link.read({ op: "spaces" });
  expect(fake.healthCalls).toBe(2);
});

test("trusts only the recorded instance: another instance, a stopping bot or a verification instance is offline", async () => {
  const link = new BotLink({ instanceFile: file });
  fake.health = { instanceId: crypto.randomUUID() };
  expect(await failure(link.read({ op: "spaces" }))).toBeInstanceOf(BotOffline);
  fake.health = { status: "stopping" };
  expect((await failure(link.read({ op: "spaces" }))).message).toContain("正在停止");
  fake.health = { verificationOnly: true };
  expect((await failure(link.read({ op: "spaces" }))).message).toContain("验证实例");
  const missing = new BotLink({ instanceFile: join(fixture.root, "none.json") });
  expect((await failure(missing.read({ op: "spaces" }))).message).toContain("没有服务实例记录");
});

test("follows a restart: a bare 404 rereads the record once; a token that still fails is offline, never echoed", async () => {
  const link = new BotLink({ instanceFile: file });
  await link.read({ op: "spaces" });
  // The bot restarted with a new token and instance; the record was rewritten after the link last read it.
  fake.token = "token-new-0123456789abcdef"; fake.instanceId = crypto.randomUUID();
  await record();
  expect(await link.read({ op: "spaces" })).toEqual({ ok: true });

  await record("token-stale-0123456789abcdef");
  const error = await failure(link.read({ op: "spaces" }));
  expect(error).toBeInstanceOf(BotOffline);
  expect(error.message).not.toContain("token-");
});

test("the route's own 404 (a missing space) is an answer, not a token mismatch", async () => {
  fake.answer = () => Response.json({ status: "error", code: "SpaceAbsent", message: "会话空间不存在" }, { status: 404 });
  const error = await failure(new BotLink({ instanceFile: file }).read({ op: "spaces" }));
  expect(error).toBeInstanceOf(BotReadError);
  expect([(error as BotReadError).status, (error as BotReadError).code]).toEqual([404, "SpaceAbsent"]);
  expect(fake.healthCalls).toBe(1);
});

test("keeps at most `concurrency` requests in flight; a waiting caller can give up", async () => {
  fake.delayMs = 80;
  const link = new BotLink({ instanceFile: file, concurrency: 2 });
  await link.read({ op: "spaces" });
  const controller = new AbortController();
  const runs = [link.read({ op: "spaces" }), link.read({ op: "spaces" })];
  const waiting = link.read({ op: "spaces" }, controller.signal);
  const last = link.read({ op: "spaces" });
  controller.abort(new Error("page closed"));
  expect((await failure(waiting)).message).toBe("page closed");
  await Promise.all([...runs, last]);
  expect(fake.maxInFlight).toBe(2);
});

test("a bot that does not answer in time is a timeout, a closed port is offline", async () => {
  fake.delayMs = 300;
  const slow = await failure(new BotLink({ instanceFile: file, timeoutMs: 50 }).read({ op: "spaces" }));
  expect([slow.name, (slow as BotReadError).status]).toEqual(["BotReadError", 504]);
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = closed.port;
  closed.stop(true);
  await writeFile(file, JSON.stringify({ pid: process.pid, port, token: fake.token, instanceId: fake.instanceId, startedAt: fake.startedAt }));
  expect(await failure(new BotLink({ instanceFile: file }).read({ op: "spaces" }))).toBeInstanceOf(BotOffline);
});
