import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test("isolated tool entries keep bash output and reclaim probes and failed document jobs", async () => {
  const fixture = await tempFixture("isolated-frontdoors-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/isolated-frontdoors.ts", import.meta.url))], {
    cwd: fixture.root, env: process.env, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("ISOLATED_FRONTDOORS_PASSED");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 20000);
