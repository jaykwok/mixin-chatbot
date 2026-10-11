import { expect, spyOn, test } from "bun:test";
import { log } from "../../src/core/log.ts";
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRelayConfig, validateRelayConfig, listRelayObjects, purgeRelayObjects, refreshRelayReference,
  relayFile, relayReference, sweepExpiredRelayObjects } from "../../src/integrations/relay.ts";
import { downloadUrl, objectBaseUrl, objectNameFromUrl, storedObjectUrl } from "../../src/integrations/relay-s3.ts";
import { openRelayIndex } from "../../src/integrations/relay-index.ts";
import { tempFixture } from "../helpers/temp.ts";

const credentials = { accessKeyId: "fixture-ak", secretAccessKey: "fixture-secret", sessionToken: "fixture-token" };
const base = { provider: "s3", endpoint: "https://s3.example.test", region: "test-region", bucket: "test-bucket", ...credentials };
const object = "20261010-00000000-0000-4000-8000-000000000000/报告 空格+%?#.pdf";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Independently verify SigV4, including the method; a GET signature cannot authorize PUT/DELETE. */
function verifySignature(url: URL, method: string, clockAhead = 0): boolean {
  const p = url.searchParams;
  const credential = p.get("X-Amz-Credential")?.split("/") ?? [];
  const [id, date, region, service, terminator] = credential;
  if (id !== credentials.accessKeyId || region !== "test-region" || service !== "s3" ||
    terminator !== "aws4_request" || p.get("X-Amz-SignedHeaders") !== "host" || p.get("X-Amz-Security-Token") !== credentials.sessionToken) return false;
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(p.get("X-Amz-Date") ?? "");
  if (!stamp) return false;
  const started = Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!);
  if (Date.now() + clockAhead >= started + Number(p.get("X-Amz-Expires")) * 1000) return false;
  const query = [...p.entries()].filter(([k]) => k !== "X-Amz-Signature").map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, av], [b, bv]) => a! < b! ? -1 : a! > b! ? 1 : av! < bv! ? -1 : av! > bv! ? 1 : 0)
    .map(([k, v]) => k + "=" + v).join("&");
  const canonical = [method, url.pathname, query, "host:" + url.host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const scope = credential.slice(1).join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", p.get("X-Amz-Date"), scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + credentials.secretAccessKey, date!), region!), service!), terminator!);
  return hmac(key, stringToSign).toString("hex") === p.get("X-Amz-Signature");
}

async function fixture() {
  const temporary = await tempFixture("s3-relay-");
  const objects = new Map<string, Buffer>();
  const calls: { method: string; url: URL; headers: Headers }[] = [];
  const control = { putStatus: 200, headStatus: 200, deleteStatus: 204, badSize: false, missingStatus: 404, clockAhead: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    calls.push({ method: req.method, url, headers: req.headers });
    if (!verifySignature(url, req.method, control.clockAhead)) return new Response("invalid signature", { status: 403 });
    const path = decodeURIComponent(url.pathname);
    if (req.method === "PUT") {
      const bytes = Buffer.from(await req.arrayBuffer());
      expect(Number(req.headers.get("content-length"))).toBe(bytes.length);
      expect(req.headers.get("cache-control")).toContain("no-store");
      if (control.putStatus === 200) objects.set(path, bytes);
      return new Response(null, { status: control.putStatus });
    }
    if (req.method === "HEAD") return new Response(null, { status: control.headStatus !== 200 ? control.headStatus : objects.has(path) ? 200 : control.missingStatus,
      headers: { "content-length": String(control.badSize ? 999 : objects.get(path)?.length ?? 0) } });
    if (req.method === "DELETE") {
      if (control.deleteStatus === 204) objects.delete(path);
      return new Response(null, { status: control.deleteStatus });
    }
    if (req.method === "GET") {
      const data = objects.get(path);
      return data ? new Response(new Uint8Array(data)) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 405 });
  } });
  const config = validateRelayConfig({ ...base, endpoint: server.url.origin, forcePathStyle: true });
  const file = join(temporary.root, "source.txt");
  await writeFile(file, "hello");
  let index = await openRelayIndex(join(temporary.root, "relay.sqlite"));
  return { ...temporary, config, file, get index() { return index; }, calls, control, objects,
    request: () => ({ config, localPath: file, filename: "报告 空格+%?#.pdf", size: 5, index, tempDir: temporary.root }),
    reopen: async () => { index.close(); index = await openRelayIndex(join(temporary.root, "relay.sqlite")); },
    cleanup: async () => { await server.stop(true); index.close(); await temporary.cleanup(); },
  };
}

test("configuration is S3 only with two-hour downloads and separate 30-minute cleanup grace", async () => {
  const config = validateRelayConfig(base);
  expect(config.expireHours).toBe(2);
  expect(config.cleanupGraceMinutes).toBe(30);
  expect(config.maxBytes).toBe(2 * 1024 ** 3);
  expect(config.forcePathStyle).toBe(false);
  expect(config.prefix).toBe("relay/");
  const f = await tempFixture("s3-config-");
  try {
    expect(loadRelayConfig(join(f.root, "missing"))).toBeNull();
    await writeFile(join(f.root, "relay.json"), JSON.stringify(base));
    expect(loadRelayConfig(join(f.root, "relay.json"))).toEqual(config);
    for (const invalid of [
      null, [], {}, { ...base, provider: "webdav" }, { ...base, webdavUrl: "https://dav.invalid" },
      { ...base, endpoint: "ftp://host" }, { ...base, endpoint: "https://user:private@host" },
      { ...base, endpoint: "https://host/bucket" }, { ...base, endpoint: "https://host?private=secret" },
      { ...base, endpoint: "http://127.0.0.1:9000" }, { ...base, region: "" }, { ...base, bucket: "../other" },
      { ...base, accessKeyId: "" }, { ...base, secretAccessKey: " secret " }, { ...base, sessionToken: "" },
      { ...base, forcePathStyle: "true" }, { ...base, prefix: "../" }, { ...base, prefix: "" },
      { ...base, prefix: "a//b" }, { ...base, prefix: "a\\b" }, { ...base, prefix: "a?b" },
      { ...base, expireHours: 0 }, { ...base, expireHours: null }, { ...base, expireHours: 169 },
      { ...base, cleanupGraceMinutes: 0 }, { ...base, cleanupGraceMinutes: 1441 },
      { ...base, maxBytes: 25 * 1024 ** 2 }, { ...base, maxBytes: 6 * 1024 ** 3 },
    ]) expect(() => validateRelayConfig(invalid)).toThrow();
    await writeFile(join(f.root, "relay.json"), "{secret");
    expect(() => loadRelayConfig(join(f.root, "relay.json"))).toThrow("不是有效 JSON");
  } finally { await f.cleanup(); }
});

test.each([false, true])("signing supports Unicode, literal reserved characters and path style=%s", pathStyle => {
  const config = validateRelayConfig({ ...base, forcePathStyle: pathStyle, prefix: "临时/relay/" });
  const stored = storedObjectUrl(config, object);
  expect(objectNameFromUrl(config, stored)).toBe(object);
  const url = new URL(downloadUrl(config, stored, new Date(Date.now() + 7200000).toISOString()));
  expect(url.hostname).toBe(pathStyle ? "s3.example.test" : "test-bucket.s3.example.test");
  expect(decodeURIComponent(url.pathname)).toBe((pathStyle ? "/test-bucket" : "") + "/临时/relay/" + object);
  expect(verifySignature(url, "GET")).toBe(true);
  expect(verifySignature(url, "HEAD")).toBe(false);
  expect(verifySignature(url, "PUT")).toBe(false);
  expect(verifySignature(url, "DELETE")).toBe(false);
  expect(url.href).not.toContain(credentials.secretAccessKey);
  expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeGreaterThanOrEqual(7198);
  for (const suffix of ["../a", "flat.txt", "a/b/c", object.split("/")[0] + "/%2fsecret", object.split("/")[0] + "/.."]) {
    expect(objectNameFromUrl(config, objectBaseUrl(config) + suffix)).toBeNull();
  }
});

test("real HTTP PUT and HEAD precede a GET-only link; SQLite has unsigned identity and distinct deadlines", async () => {
  const f = await fixture();
  try {
    const url = await relayFile(f.request());
    expect(f.calls.map(c => c.method)).toEqual(["PUT", "HEAD"]);
    const response = await fetch(url);
    expect(await response.text()).toBe("hello");
    const unsigned = new URL(url); unsigned.search = "";
    expect((await fetch(unsigned)).status).toBe(403);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(403);
    expect(f.calls[0]!.headers.get("content-disposition")).toContain("filename*=UTF-8''%E6%8A%A5");
    const row = f.index.entries()[0]!;
    expect(row.state).toBe("uploaded");
    expect(row.url).not.toContain("X-Amz-");
    expect(Date.parse(row.expiresAt!) - Date.now()).toBeGreaterThan(7190000);
    expect(Date.parse(row.deleteAfter!) - Date.parse(row.expiresAt!)).toBeCloseTo(1800000, -2);
    expect(JSON.stringify(relayReference(f.config, url, row.name, row.size))).not.toContain(credentials.accessKeyId);
    expect((await readdir(f.root)).some(name => name.startsWith(".relay-"))).toBe(false);
    await f.reopen();
    expect(f.index.entries()[0]).toEqual(row);
  } finally { await f.cleanup(); }
});

test("concurrent deduplication and new shares preserve old deadlines while near-expiry objects retire", async () => {
  const f = await fixture();
  try {
    const [first, second] = await Promise.all([relayFile(f.request()), relayFile(f.request())]);
    expect(new URL(first).pathname).toBe(new URL(second).pathname);
    expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(1);
    const row = f.index.entries()[0]!;
    const shortened = { ...row, expiresAt: new Date(Date.now() + 120000).toISOString(), deleteAfter: new Date(Date.now() + 1920000).toISOString() };
    await f.index.remember(shortened);
    const changed = { ...f.config, expireHours: 8, cleanupGraceMinutes: 60 };
    const again = await relayFile({ ...f.request(), config: changed });
    const listing = await listRelayObjects({ config: changed, index: f.index });
    const refreshed = await refreshRelayReference(relayReference(changed, first, row.name, row.size), undefined, changed, f.index);
    for (const url of [listing.find(entry => entry.name === row.name && new URL(entry.url).pathname === new URL(first).pathname)!.url, refreshed.url]) expect(Number(new URL(url).searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(120);
    expect(new URL(again).pathname).not.toBe(new URL(first).pathname);
    expect(Number(new URL(again).searchParams.get("X-Amz-Expires"))).toBeGreaterThan(28780);
    expect(refreshed.expiry).toContain("北京时间 UTC+8");
    expect(f.index.entries().find(entry => entry.url === row.url)).toMatchObject({ expiresAt: shortened.expiresAt, deleteAfter: shortened.deleteAfter });
    expect(f.index.entries()).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("expired links are not refreshed or deleted during grace; a new share has a different key", async () => {
  const f = await fixture();
  try {
    const first = await relayFile(f.request());
    const row = f.index.entries()[0]!;
    const expired = { ...row, expiresAt: new Date(Date.now() - 10000).toISOString() };
    await f.index.remember(expired);
    await expect(refreshRelayReference(relayReference(f.config, first, row.name, row.size), undefined, f.config, f.index)).rejects.toThrow("链接已过期");
    await sweepExpiredRelayObjects({ config: f.config, index: f.index });
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(0);
    expect((await listRelayObjects({ config: f.config, index: f.index }))[0]!.url).toBe(row.url);
    const second = await relayFile(f.request());
    expect(new URL(second).pathname).not.toBe(new URL(first).pathname);
    const retired = f.index.entries().find(r => r.url === row.url)!;
    expect(retired.expiresAt).toBe(expired.expiresAt);
    expect(retired.deleteAfter).toBe(expired.deleteAfter);
    expect(f.objects.size).toBe(2);
    await f.index.remember({ ...retired, deleteAfter: new Date(Date.now() - 1).toISOString() });
    await sweepExpiredRelayObjects({ config: f.config, index: f.index });
    expect(f.objects.size).toBe(1);
    expect(f.index.entries()).toHaveLength(1);
    expect(f.index.entries()[0]!.url).not.toBe(row.url);
  } finally { await f.cleanup(); }
});

test("failed deletion survives restart; retry removes the exact object then its record", async () => {
  const f = await fixture();
  try {
    await relayFile(f.request());
    const row = f.index.entries()[0]!;
    await f.index.remember({ ...row, expiresAt: new Date(0).toISOString(), deleteAfter: new Date(0).toISOString() });
    f.control.deleteStatus = 503;
    await sweepExpiredRelayObjects({ config: f.config, index: f.index });
    expect(f.index.entries()).toHaveLength(1);
    await f.reopen();
    f.control.deleteStatus = 204;
    await sweepExpiredRelayObjects({ config: f.config, index: f.index });
    expect(f.index.entries()).toHaveLength(0);
    expect(f.objects.size).toBe(0);
    expect(f.calls.filter(c => c.method === "DELETE").every(c => c.url.pathname === new URL(row.url).pathname)).toBe(true);
  } finally { await f.cleanup(); }
});

test.each(["upload", "missing", "size", "denied"] as const)("unconfirmed %s upload is never published and remains reclaimable", async fault => {
  const f = await fixture();
  try {
    if (fault === "upload") f.control.putStatus = 503;
    if (fault === "missing") f.control.headStatus = 404;
    if (fault === "size") f.control.badSize = true;
    if (fault === "denied") f.control.headStatus = 403;
    await expect(relayFile(f.request())).rejects.toThrow();
    const row = f.index.entries()[0]!;
    expect(row.state).toBe("planned");
    expect(row.expiresAt).toBeNull();
    await f.index.remember({ ...row, at: new Date(0).toISOString() });
    await sweepExpiredRelayObjects({ config: f.config, index: f.index });
    expect(f.index.entries()).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test("cancelled upload preserves its cleanup record and retries the same object without leaving a snapshot", async () => {
  const f = await fixture(), original = globalThis.fetch, controller = new AbortController();
  try {
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      controller.abort(new Error("stop upload"));
      throw controller.signal.reason;
    }) as unknown as typeof fetch;
    await expect(relayFile({ ...f.request(), signal: controller.signal })).rejects.toThrow("stop upload");
    const planned = f.index.entries()[0]!;
    expect(planned.state).toBe("planned");
    globalThis.fetch = original;
    const url = await relayFile(f.request());
    expect(new URL(url).pathname).toBe(new URL(planned.url).pathname);
    expect(f.index.entries()).toHaveLength(1);
    expect((await readdir(f.root)).some(name => name.startsWith(".relay-"))).toBe(false);
  } finally { globalThis.fetch = original; await f.cleanup(); }
});

test.each([404, 403])("missing cached object (HEAD %s) gets a new key and full lifetime without ListBucket", async missingStatus => {
  const f = await fixture();
  try {
    await relayFile(f.request());
    const row = f.index.entries()[0]!;
    f.objects.clear();
    f.control.missingStatus = missingStatus;
    const renewed = await relayFile(f.request());
    expect(new URL(renewed).pathname).not.toBe(new URL(row.url).pathname);
    expect(Number(new URL(renewed).searchParams.get("X-Amz-Expires"))).toBeGreaterThan(7190);
    expect(f.index.entries().find(entry => entry.url === row.url)).toMatchObject({ expiresAt: row.expiresAt, deleteAfter: row.deleteAfter });
    f.control.headStatus = 403;
    const count = f.calls.filter(c => c.method === "PUT").length;
    await expect(relayFile(f.request())).rejects.toThrow("403");
    expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(count + 1);
    expect(f.index.entries().filter(entry => entry.state === "planned")).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("new shares reuse above the 90 percent boundary and retire below it; HEAD and DELETE tolerate one minute clock skew", async () => {
  const f = await fixture();
  try {
    f.control.clockAhead = 60000;
    const first = await relayFile(f.request()), row = f.index.entries()[0]!;
    await f.index.remember({ ...row, expiresAt: new Date(Date.now() + 6490000).toISOString() });
    expect(new URL(await relayFile(f.request())).pathname).toBe(new URL(first).pathname);
    await f.index.remember({ ...row, expiresAt: new Date(Date.now() + 6470000).toISOString() });
    expect(new URL(await relayFile(f.request())).pathname).not.toBe(new URL(first).pathname);
    expect((await purgeRelayObjects({ config: f.config, index: f.index })).deleted).toBe(2);
    expect(f.index.entries()).toEqual([]);
    expect(f.calls.filter(call => call.method === "HEAD" || call.method === "DELETE").every(call => Number(call.url.searchParams.get("X-Amz-Expires")) >= 300)).toBe(true);
  } finally { await f.cleanup(); }
});

test("namespace changes cannot sign, reuse or delete objects from the old backend", async () => {
  const f = await fixture();
  const warnings = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const url = await relayFile(f.request()), row = f.index.entries()[0]!;
    const changed = { ...f.config, prefix: "other/" };
    await expect(refreshRelayReference(relayReference(f.config, url, row.name, row.size), undefined, changed, f.index)).rejects.toThrow("后端已变更");
    expect(await purgeRelayObjects({ config: changed, index: f.index })).toEqual({ matched: 1, deleted: 0, failed: 0, orphaned: 1 });
    expect((await purgeRelayObjects({ config: changed, index: f.index })).orphaned).toBe(1);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(0);
    expect(f.index.entries()).toEqual([row]);
    expect(await purgeRelayObjects({ config: f.config, index: f.index, match: "not-here" })).toEqual({ matched: 0, deleted: 0, failed: 0, orphaned: 0 });
    expect((await purgeRelayObjects({ config: f.config, index: f.index, match: row.name })).deleted).toBe(1);
  } finally { warnings.mockRestore(); await f.cleanup(); }
});

test("snapshot limits, changed source size and cancellation reject before remote requests", async () => {
  const f = await fixture();
  try {
    await expect(relayFile({ ...f.request(), size: 6 })).rejects.toThrow("大小发生变化");
    await expect(relayFile({ ...f.request(), config: { ...f.config, maxBytes: 4 } })).rejects.toThrow("上限");
    await expect(relayFile({ ...f.request(), signal: AbortSignal.abort(new Error("pre-cancel")) })).rejects.toThrow("pre-cancel");
    await expect(relayFile({ ...f.request(), filename: "../file" })).rejects.toThrow("文件名");
    expect(f.calls).toHaveLength(0);
    expect(await readFile(f.file, "utf8")).toBe("hello");
  } finally { await f.cleanup(); }
});

test("signed request URLs and backend bodies are never forwarded in network errors", async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => { throw new Error("failed fetch " + String(url) + credentials.secretAccessKey); }) as unknown as typeof fetch;
    const error = await relayFile(f.request()).catch(e => e as Error);
    expect(String(error)).toContain("S3 PUT 请求失败");
    expect(String(error)).not.toContain(credentials.accessKeyId);
    expect(String(error)).not.toContain("X-Amz-");
    expect(String(error)).not.toContain(credentials.secretAccessKey);
  } finally { globalThis.fetch = original; await f.cleanup(); }
});

test("download authorization expires while the private object remains during cleanup grace", async () => {
  const f = await fixture();
  try {
    await relayFile(f.request());
    const entry = f.index.entries()[0]!;
    const expiresAt = new Date(Date.now() + 2500).toISOString();
    await f.index.remember({ ...entry, expiresAt, deleteAfter: new Date(Date.now() + 62500).toISOString() });
    const link = downloadUrl(f.config, entry.url, expiresAt);
    expect((await fetch(link)).status).toBe(200);
    await Bun.sleep(2600);
    expect((await fetch(link)).status).toBe(403);
    await sweepExpiredRelayObjects({ config: f.config, index: f.index });
    expect(f.objects.size).toBe(1);
    expect(f.index.entries()).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("a sweep queued behind an upload rechecks its completed state; cancelling another request leaves the upload running", async () => {
  const f = await fixture(), original = globalThis.fetch;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let upload: Promise<string> | undefined, sweep: Promise<void> | undefined;
  try {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "PUT") { entered.resolve(); await release.promise; }
      return original(url, init);
    }) as unknown as typeof fetch;
    upload = relayFile(f.request());
    await entered.promise;
    const entry = f.index.entries()[0]!;
    await f.index.remember({ ...entry, at: new Date(0).toISOString() });
    sweep = sweepExpiredRelayObjects({ config: f.config, index: f.index });
    const waiter = relayFile({ ...f.request(), signal: controller.signal });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await Promise.all([upload, sweep]);
    expect(f.index.entries()[0]!.state).toBe("uploaded");
    expect(f.calls.filter(c => c.method === "DELETE")).toHaveLength(0);
    expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(1);
  } finally { release.resolve(); await Promise.allSettled([upload, sweep]); globalThis.fetch = original; await f.cleanup(); }
});
