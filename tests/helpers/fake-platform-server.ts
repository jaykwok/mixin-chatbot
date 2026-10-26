// A local fake platform in its own process for tests/ops/real-docker.test.ts: the deployed service in the container talks
// to it instead of the real platform (the test's synchronous Docker and git calls would stall an in-process server).
// FAKE_PLATFORM_HOST is the listen address, FAKE_PLATFORM_ADVERTISE the host the container reaches it at, and
// FAKE_PLATFORM_APP_ID / FAKE_PLATFORM_APP_SECRET the fixture's synthetic credentials, and one directory member
// FAKE_PLATFORM_MEMBER=<phone>:<imUserId>. Fixture-only control routes, no token needed:
//   POST /__fixture/push   body: an event, pushed to every connected Stream
//   GET  /__fixture/state  connected Streams, tokens issued and the messages sent so far
// Prints FAKE_PLATFORM_READY=<json> once listening and runs until its stdin closes.
import { FakePlatform, json } from "./fake-platform.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const platform = new FakePlatform({
  hostname: env("FAKE_PLATFORM_HOST"), advertise: env("FAKE_PLATFORM_ADVERTISE"),
  config: { environment: "production", appId: env("FAKE_PLATFORM_APP_ID"), appSecret: env("FAKE_PLATFORM_APP_SECRET") },
});
const [phone = "", imUser = ""] = env("FAKE_PLATFORM_MEMBER").split(":");
platform.directory = { children: { "1": [] }, members: { "1": [{ phone, name: "Fixture" }] }, ids: { [phone]: imUser } };
platform.route("POST /__fixture/push", (_request, body) => {
  platform.push(body as Record<string, unknown>);
  return json({ sockets: platform.sockets.size });
});
platform.route("GET /__fixture/state", () => json({ sockets: platform.sockets.size, tokens: platform.tokenCount, sent: platform.sent }));
console.log(`FAKE_PLATFORM_READY=${JSON.stringify({ port: platform.server.port, origin: platform.origin })}`);

for await (const _ of Bun.stdin.stream()) { /* runs until the test closes stdin */ }
platform.stop();
process.exit(0);
