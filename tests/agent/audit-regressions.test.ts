import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test.each(["runtime", "legacy-schema"])("audit counterexamples and startup schema guard: %s", async mode => {
  const fixture = await tempFixture("audit-regressions-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/audit-runtime-harness.ts", import.meta.url)), mode], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_MAX_ACTIVE_REQUESTS: "32", BOT_MODEL_CACHE_RETENTION: undefined },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("AUDIT_REGRESSIONS_PASSED");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 25000);

test.each([["astra", "auto"], ["zai", "auto"], ["astra", "short"], ["astra", "long"], ["legacy", "long"], ["sdk-env", "short"], ["document-work-disabled", "auto"], ["group-env", "auto"], ["shared-env", "auto"]])(
  "production cache policy %s/%s preserves SDK semantics without network calls", async (kind, policy) => {
    const fixture = await tempFixture("cache-payload-");
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/cache-payload-harness.ts", import.meta.url)), kind!, policy!], {
      cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups" }, stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(0); expect(out).toContain("CACHE_PAYLOAD_PASSED");
    } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
  }, 25000);
