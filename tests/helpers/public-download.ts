import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { spyOn } from "bun:test";
let dnsCalls = 0, requests = 0, sent = 0, status = 200, peer = "93.184.215.14", declared: string | undefined;
let answers = [{ address: "93.184.215.14", family: 4 }], body = [Buffer.from("hello")], hold = false;
spyOn(dns, "lookup").mockImplementation((async () => { dnsCalls++; return answers; }) as unknown as typeof dns.lookup);
const request = (url: URL, options: any, respond: (response: any) => void) => {
  requests++; assert.equal(options.agent, false); assert.equal(url.hostname, "public.example");
  assert.equal(options.rejectUnauthorized, undefined); // Node's default certificate/hostname verification stays enabled.
  assert.equal(options.headers["Accept-Encoding"], "identity");
  // A later resolver answer becomes private. The connection lookup must still return the vetted address.
  answers = [{ address: "127.0.0.1", family: 4 }];
  for (const all of [false, true]) options.lookup("public.example", { all }, (error: unknown, address: any, family?: number) => {
    assert.equal(error, null);
    assert.deepEqual(all ? address : [{ address, family }], [{ address: "93.184.215.14", family: 4 }]);
  });
  const req: any = new EventEmitter();
  req.destroy = (error: Error) => req.emit("error", error);
  req.end = () => {
    sent++;
    if (hold) return;
    const response: any = Readable.from(body); response.statusCode = status; response.headers = { "content-length": declared };
    respond(response);
  };
  options.signal.addEventListener("abort", () => req.destroy(options.signal.reason), { once: true });
  queueMicrotask(() => { const socket: any = new EventEmitter(); socket.remoteAddress = peer; req.emit("socket", socket); socket.emit(url.protocol === "https:" ? "secureConnect" : "connect"); });
  return req;
};
spyOn(http, "request").mockImplementation(request as unknown as typeof http.request);
spyOn(https, "request").mockImplementation(request as unknown as typeof https.request);
const { downloadPublicBytes } = await import("../../src/core/public-download.ts");
const reset = () => { answers = [{ address: "93.184.215.14", family: 4 }]; status = 200; peer = "93.184.215.14"; declared = undefined; body = [Buffer.from("hello")]; };
assert.equal(Buffer.from(await downloadPublicBytes("https://public.example/file", 10, AbortSignal.timeout(2000))).toString(), "hello");
assert.equal(dnsCalls, 1); assert.equal(requests, 1); assert.equal(sent, 1);
reset(); answers.push({ address: "10.0.0.1", family: 4 });
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /非公网/);
assert.equal(requests, 1);
reset(); status = 302;
await assert.rejects(downloadPublicBytes("https://public.example/redirect", 10, AbortSignal.timeout(2000)), /重定向/);
assert.equal(requests, 2); // No second request, regardless of Location.
reset(); peer = "127.0.0.1"; const before = sent;
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /地址不一致/);
assert.equal(sent, before); // Verify the peer before sending any HTTP headers.
reset(); peer = "::ffff:93.184.215.14";
assert.equal((await downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000))).length, 5);
reset(); declared = "11";
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /大小上限/);
reset(); body = [Buffer.from("123456"), Buffer.from("123456")];
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /大小上限/);
reset(); hold = true; const abort = new AbortController();
const pending = downloadPublicBytes("http://public.example/", 10, abort.signal);
setTimeout(() => abort.abort(new Error("cancelled download")), 10);
await assert.rejects(pending, /cancelled download/);
console.log("PUBLIC_DOWNLOAD_PASSED");
