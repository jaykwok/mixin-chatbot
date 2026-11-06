import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryPool } from "../../console/server/exec-client.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (value: string) => "'" + value.replaceAll("'", "''") + "'";

// One test per response variant: each starts a Bun and (on Windows) one or two PowerShell processes, so a
// single shared budget for all variants ran out on a loaded machine.
describe("deployment health requires a ready matching instance, including UUID with reused PID", () => {
  const queries = new QueryPool();
  const identity = { service: "mixin-bot", version: 1, instanceId: crypto.randomUUID(), pid: 42, startedAt: Date.now() };
  let fixture: Awaited<ReturnType<typeof tempFixture>>, server: ReturnType<typeof Bun.serve>, port = 0, instance = "", ps = "";
  let status = 200;
  let body: unknown = { ...identity, status: "ready" };
  beforeAll(async () => {
    fixture = await tempFixture("health-protocol-");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body, { status }) });
    port = server.port!;
    await mkdir(join(fixture.root, "data/state"), { recursive: true });
    instance = join(fixture.root, "data/state/instance.json");
    ps = join(fixture.root, "health.ps1");
    await writeFile(ps, "\ufeff" + [
      "$ErrorActionPreference='Stop'",
      "[Console]::Out.WriteLine('HEALTH_FIXTURE_STARTED'); [Console]::Out.Flush()",
      ". " + quotePS(join(project, "scripts/lib/common.ps1")),
      "[Console]::Out.WriteLine('HEALTH_FIXTURE_LOADED'); [Console]::Out.Flush()",
      // The scripts' one health probe (ops.ps1 Test-Local); deployments wait in the core (readiness.ts, the Bun probe above).
      "$healthy=Test-ProjectBotHealth $env:FIXTURE_PROJECT ([int]$env:BOT_PORT) -AllowVerification:($env:ALLOW_VERIFICATION -eq '1')",
      "[Console]::Out.WriteLine(('HEALTH_RESULT ' + $healthy)); [Console]::Out.Flush()",
      "if($healthy){exit 0}else{exit 1}",
    ].join("\n"));
  });
  afterAll(async () => { await queries.stop(); await server?.stop(true); await fixture?.cleanup(); });

  test.each(["ready", "verification", "stopping", "wrong-service", "wrong-instance", "wrong-pid", "wrong-port", "503"])("%s", async variant => {
    body = { ...identity, status: variant === "stopping" ? "stopping" : "ready",
      ...(variant === "verification" && { verificationOnly: true }),
      ...(variant === "wrong-service" && { service: "other" }),
      ...(variant === "wrong-instance" && { instanceId: crypto.randomUUID() }),
      ...(variant === "wrong-pid" && { pid: 43 }) };
    status = variant === "503" ? 503 : 200;
    await writeFile(instance, JSON.stringify({ ...identity, port: variant === "wrong-port" ? port + 1 : port }));
    const child = Bun.spawn([process.execPath, join(project, "ops/tools/health-check.ts")], {
      cwd: fixture.root, env: { ...process.env, BOT_PORT: String(port) }, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, variant + out + err).toBe(variant === "ready" ? 0 : variant === "verification" ? 3 : 1);
    if (process.platform === "win32") {
      // This budget includes cold PowerShell/module startup; the production HTTP request still has its 3 s deadline.
      const result = await queries.capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps],
        { timeout: 60000, env: { FIXTURE_PROJECT: fixture.root, BOT_PORT: String(port), ALLOW_VERIFICATION: "0" } });
      const detail = JSON.stringify({ variant, ...result });
      expect(result.timedOut, detail).toBe(false);
      expect(result.code, detail).toBe(variant === "ready" ? 0 : 1);
      if (variant === "verification") {
        const allowed = await queries.capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps],
          { timeout: 60000, env: { FIXTURE_PROJECT: fixture.root, BOT_PORT: String(port), ALLOW_VERIFICATION: "1" } });
        const allowedDetail = JSON.stringify({ variant, allowVerification: true, ...allowed });
        expect(allowed.timedOut, allowedDetail).toBe(false);
        expect(allowed.code, allowedDetail).toBe(0);
      }
    }
  }, process.platform === "win32" ? 150000 : 30000);
});

