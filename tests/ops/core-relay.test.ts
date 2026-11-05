import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCore } from "../../scripts/ops/core/cli.ts";
import { relayRequest, runRelay } from "../../scripts/ops/core/relay.ts";
import { createMaintenanceHost, type MaintenanceHostOptions } from "../../scripts/ops/core/maintenance-host.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { relayScope } from "../../scripts/lib/operation-scope.ts";
import { openRelayIndex, readRelayIndex } from "../../src/integrations/relay-index.ts";
import { storedObjectUrl, validateRelayConfig } from "../../src/integrations/relay-s3.ts";
import { relayBackendId } from "../../src/integrations/relay-s3.ts";
import { tempFixture } from "../helpers/temp.ts";

const repo = join(import.meta.dir, "../..");
test("外链入口拒绝未知和混用参数；显式关键字中的选项样式保持为字面量", async () => {
  for (const keyword of ["-All", "--all", "--group", "含 空格与'引号"]) {
    const request = relayRequest("relay-purge", ["--keyword", keyword, "--expect", "a".repeat(64)]);
    expect(request.args).toEqual(["purge", "--keyword", keyword, "--expect", "a".repeat(64)]);
    let got: unknown;
    await runCore(["maintenance", "relay-purge", "--keyword", keyword, "--project", "."], { relay: async value => { got = value; return { protocol: "mixin-ops", version: 1, command: "relay-purge", exitCode: 0, outcome: "success", finalState: "stopped", wasRunning: false, message: "fixture" }; } });
    expect(got).toEqual(relayRequest("relay-purge", ["--keyword", keyword]));
  }
  for (const [action, ...args] of [["relay-purge"], ["relay-purge", "--alls"], ["relay-purge", "--all", "x"], ["relay-purge", "--all", "--keyword", "x"],
    ["relay-test", "--all"], ["relay-ls", "extra"], ["relay-ls", "--expect", "a".repeat(64)], ["relay-test", "--expect", "bad"],
    ["relay-purge", "--keyword", ""], ["relay-purge", "--keyword", "a\nb"], ["relay-purge", "--all", "--all"]]) {
    expect(() => relayRequest(action!, args)).toThrow(); let called = false;
    await expect(runCore(["maintenance", action!, ...args, "--project", "."], { relay: async () => { called = true; throw new Error(); } })).rejects.toThrow();
    expect(called).toBe(false);
  }
});

async function fixture() {
  const f = await tempFixture("core-relay-");
  for (const tree of ["scripts", "src", "ui", "data/state", "data/config"]) await mkdir(join(f.root, tree), { recursive: true });
  for (const tree of ["scripts", "src", "ui"]) await writeFile(join(f.root, tree, "fixture.ts"), "export {};\n");
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 1, appVersion: "1.0.1", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const ready = { service: "mixin-chatbot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ready) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const facts = { identity: "a".repeat(64), owned: true, state: "running" as "running" | "stopped" }, effects: string[] = [];
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 100, verify: async () => {}, finish: async () => {}, output: () => {},
    platform: async () => ({ inspect: async () => facts, stop: async () => { effects.push("stop"); facts.state = "stopped"; }, start: async () => { effects.push("start"); facts.state = "running"; } }) };
  return { ...f, facts, effects, options, async close() { server.stop(true); await f.cleanup(); } };
}

test("共享外链窗口：配置和范围在停机前预检，测试不停机，清理才停机；失败按原状态恢复", async () => {
  const f = await fixture();
  try {
    for (const running of [true, false]) for (const action of ["relay-ls", "relay-test", "relay-purge"]) for (const preflight of [true, false]) {
      f.facts.state = running ? "running" : "stopped"; f.effects.length = 0;
      const request = relayRequest(action, action === "relay-purge" ? ["--all"] : []), steps: string[] = [];
      const result = await runRelay(request, f.options, undefined, (options, operation) => {
        const context = createMaintenanceHost(options, operation);
        return { ...context, data: async step => {
          expect(() => acquireDeploymentLock(f.root)).toThrow(); expect(step.currentCode).toBe(true);
          steps.push(step.args[0]!);
          if (step.args[0] === "check") {
            expect(step.readOnly).toBe(true); expect(step.network).toBeUndefined();
            expect(f.facts.state).toBe(running ? "running" : "stopped"); return { code: preflight ? 0 : 19, stdout: "" };
          }
          expect(step.network).toBe(action === "relay-ls" ? undefined : "service");
          expect(f.facts.state).toBe(running && action !== "relay-purge" ? "running" : "stopped");
          return { code: 17, stdout: "" };
        } };
      });
      expect(result).toMatchObject({ outcome: "failed", wasRunning: running, finalState: running ? "running" : "stopped", exitCode: preflight ? 17 : 1 });
      expect(steps).toEqual(preflight ? ["check", request.args[0]!] : ["check"]);
      expect(f.effects).toEqual(running && preflight && action === "relay-purge" ? ["stop", "start"] : []);
    }
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "win32")("真实外链数据工具与本机合成 S3：测试不停止，过期范围拒绝，按字面关键字删除后恢复", async () => {
  const f = await fixture(), objects = new Map<string, Uint8Array>(), gets = new Set<string>();
  const effects: string[] = [];
  // This verifies host orchestration against actual HTTP, not S3 cryptography (covered independently by relay.test.ts).
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), key = decodeURIComponent(url.pathname); effects.push(request.method);
    if (!url.searchParams.has("X-Amz-Signature") || request.method === "DELETE" && gets.has(url.search)) return new Response(null, { status: 403 });
    if (request.method === "PUT") { objects.set(key, new Uint8Array(await request.arrayBuffer())); return new Response(); }
    if (request.method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404, headers: { "content-length": String(objects.get(key)?.byteLength ?? 0) } });
    if (request.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    gets.add(url.search); return objects.has(key) ? new Response(objects.get(key)!) : new Response(null, { status: 404 });
  } });
  try {
    const config = validateRelayConfig({ provider: "s3", endpoint: server.url.origin, forcePathStyle: true, region: "test", bucket: "fixture", accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" });
    await writeFile(join(f.root, "data/config/relay.json"), JSON.stringify(config));
    const output: string[] = [];
    const options = { ...f.options, source: repo, output: (text: string) => { output.push(text); } }, checked = await runRelay(relayRequest("relay-test", []), options);
    expect(checked, checked.message).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual([]); expect(objects.size).toBe(0); expect(effects).toContain("PUT");
    const ledger = join(f.root, "data/state/relay.sqlite"), index = await openRelayIndex(ledger);
    for (const name of ["--all", "keep.txt"]) {
      const url = storedObjectUrl(config, `20261031-${randomUUID()}/${name}`); objects.set(decodeURIComponent(new URL(url).pathname), new Uint8Array([1]));
      await index.remember({ key: relayBackendId(config) + ":" + name, url, name, size: 1, at: new Date().toISOString(), state: "uploaded" });
    }
    index.close(); effects.length = 0;
    const expected = relayScope(join(f.root, "data"), "--all");
    const stale = await runRelay(relayRequest("relay-purge", ["--keyword", "--all", "--expect", "0".repeat(64)]), options);
    expect(stale.exitCode).toBe(1); expect(f.effects).toEqual([]); expect(effects).toEqual([]);
    const cleaned = await runRelay(relayRequest("relay-purge", ["--keyword", "--all", "--expect", expected]), options);
    expect(cleaned, output.join("")).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual(["stop", "start"]); expect(readRelayIndex(ledger).map(entry => entry.name)).toEqual(["keep.txt"]);
    const record = await readFile(join(f.root, "data/state/ops-maintenance.json"), "utf8");
    expect(record).not.toContain("fixture-secret"); expect(record).not.toContain("--all");
    expect(readOpsMaintenanceRecord(f.root)?.writer?.phase).toBe("reaped");
  } finally { server.stop(true); await f.close(); }
}, 45_000);
