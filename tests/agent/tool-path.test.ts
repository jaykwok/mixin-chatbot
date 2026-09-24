import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test.each(["write", "edit"])("%s path keys match the installed Pi resolver in an isolated home", async name => {
  const files = await tempFixture("pi-path-");
  // Pi 0.87 calls realpath before operations: probe home paths in a child with an isolated home.
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/tool-path-harness.ts", import.meta.url)), name], {
    cwd: files.root, env: { ...process.env, HOME: files.root, USERPROFILE: files.root },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    expect(out).toContain("PATHS_PASSED");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await files.cleanup(); }
}, 15000);
