import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";
const cases = [
  { kind: "document", script: new URL("../helpers/document-cache-harness.ts", import.meta.url) },
  { kind: "readiness", script: new URL("../helpers/readiness-cache-harness.ts", import.meta.url) },
];
test.each(cases)("$kind cache invalidates changed inputs and coalesces cancellable work", async ({ kind, script }) => {
  const fixture = await tempFixture(kind + "-cache-");
  const child = Bun.spawn([process.execPath, fileURLToPath(script)], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups" }, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain(kind.toUpperCase() + "_CACHE_PASSED");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 20000);
