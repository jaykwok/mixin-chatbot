import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test("real runtime and HTTP scheduling survive lifecycle races", async () => {
  const fixture = await tempFixture("mixin-runtime-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/runtime-harness.ts", import.meta.url))], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_MAX_ACTIVE_REQUESTS: "1" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 25000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    const line = stdout.split("\n").find(line => line.startsWith("HARNESS_RESULT="));
    expect(line, stderr).toBeDefined();
    expect(JSON.parse(line!.slice("HARNESS_RESULT=".length))).toHaveLength(9);
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 30000);
