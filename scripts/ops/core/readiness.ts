import { lstatSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { matchesInstance, type InstanceIdentity } from "../../../src/core/health.ts";

function instance(project: string): InstanceIdentity | null {
  try {
    const path = join(project, "data/state/instance.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.instanceId)
      || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
      || !Number.isFinite(value.startedAt) || value.startedAt <= 0) return null;
    return { instanceId: value.instanceId, pid: value.pid, port: value.port, startedAt: value.startedAt };
  } catch { return null; }
}

/** The ready answer of the instance instance.json names. Local HTTP only, no proxy, redirect or credential header; size and time bounded. */
async function readyHealth(project: string, deadlineMs: number): Promise<Record<string, unknown> | null> {
  const identity = instance(project);
  if (!identity) return null;
  return new Promise(resolve => {
    let done = false;
    const finish = (body: Record<string, unknown> | null) => { if (!done) { done = true; clearTimeout(timer); request.destroy(); resolve(body); } };
    const request = get({ host: "127.0.0.1", port: identity.port, path: "/health", agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); finish(null); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { if ((size += chunk.length) > 64 * 1024) finish(null); else chunks.push(chunk); });
      response.once("error", () => finish(null));
      response.once("end", () => {
        try {
          const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString("utf8")), current = instance(project);
          finish(!!current && matchesInstance(body, identity, identity.port) && matchesInstance(body, current, current.port) && body.status === "ready" ? body : null);
        } catch { finish(null); }
      });
    });
    const timer = setTimeout(() => finish(null), deadlineMs);
    request.once("error", () => finish(null));
  });
}

export async function serviceReady(project: string, deadlineMs = 2500, expected: { verification?: boolean; build?: string } = {}): Promise<boolean> {
  const body = await readyHealth(project, deadlineMs);
  return !!body && (expected.verification ? body.verificationOnly === true : !body.verificationOnly) && (expected.build === undefined || body.build === expected.build);
}

/**
 * Waits for the ready service's event Stream: the only proof that the app credentials work. Reports the last disconnect
 * reason (the bot's own text, as on the status page) when the deadline passes first.
 */
export async function waitStream(project: string, deadlineMs = 45_000): Promise<{ connected: true } | { connected: false; reason?: string }> {
  const until = performance.now() + deadlineMs;
  let reason: string | undefined;
  for (;;) {
    const body = await readyHealth(project, Math.min(2500, Math.max(1, until - performance.now())));
    const stream = body?.stream as { connected?: unknown; lastDisconnect?: { reason?: unknown } } | undefined;
    if (stream?.connected === true) return { connected: true };
    if (typeof stream?.lastDisconnect?.reason === "string") reason = stream.lastDisconnect.reason.slice(0, 300);
    if (performance.now() >= until) return { connected: false, ...(reason ? { reason } : {}) };
    await Bun.sleep(Math.min(500, Math.max(1, until - performance.now())));
  }
}
