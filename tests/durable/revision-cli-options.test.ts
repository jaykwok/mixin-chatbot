import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

test("修订工具拒绝对象原型名称，不凭继承属性接受动作或静默成功", async () => {
  const fixture = await tempFixture("revision-cli-options-");
  try {
    const script = join(import.meta.dir, "../../scripts/runtime/revision-cleanup.ts"), before = readdirSync(fixture.root);
    for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", script, action], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ action, code }).toEqual({ action, code: 1 });
      expect(stdout + stderr).toContain(`未知动作 ${action}`);
      expect(readdirSync(fixture.root)).toEqual(before);
    }
  } finally { await fixture.cleanup(); }
}, 30_000);
