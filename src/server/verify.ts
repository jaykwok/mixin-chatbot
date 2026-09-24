// Deployment readiness only: no business imports, requests, database initialization or maintenance.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireLease } from "../core/maintenance.ts";
import { validateCurrentData } from "../core/data-validation.ts";
import { serviceGroupRoot, verificationPending } from "../core/data-version.ts";

const release = await acquireLease("verification");
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  if (!verificationPending(process.cwd(), serviceGroupRoot())) throw new Error("升级事务已提交或不再允许只验证启动");
  await validateCurrentData(process.cwd(), serviceGroupRoot());
  const { HOST, PORT } = await import("../core/config.ts");
  const token = randomBytes(32).toString("hex"), instanceId = randomUUID(), startedAt = Date.now();
  const path = join("data/state", "instance.json");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server?.stop(true);
    await unlink(path).catch(() => {});
    await release();
    process.exit(0);
  };
  server = Bun.serve({ hostname: HOST, port: PORT, fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({
      service: "mixin-chatbot", version: 1, status: "ready", instanceId, startedAt, pid: process.pid, verificationOnly: true,
    });
    if (request.method === "POST" && url.pathname === "/_admin/shutdown" && request.headers.get("Authorization") === `Bearer ${token}`) {
      setTimeout(() => void stop(), 0);
      return Response.json({ status: "stopping" });
    }
    return Response.json({ status: "maintenance" }, { status: 503 });
  } });
  await writeFile(path, JSON.stringify({ pid: process.pid, port: server.port, token, host: HOST, cwd: process.cwd(), instanceId, startedAt }), { mode: 0o600 });
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
} catch (error) { await server?.stop(true); await release(); throw error; }
