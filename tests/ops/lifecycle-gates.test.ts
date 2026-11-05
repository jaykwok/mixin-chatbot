import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webHealthGate } from "../helpers/lifecycle-gates.ts";
import { tempFixture } from "../helpers/temp.ts";

test("web activation fault gate ignores old instances and waits only for the selected committed target", async () => {
  const f = await tempFixture("web-health-gate-");
  try {
    for (const scenario of [
      { name: "old-instance", marker: "old", phase: null, hold: false },
      { name: "target-before-commit", marker: "chosen", phase: "prepared", hold: false },
      { name: "other-committed", marker: "other", phase: "committed", hold: false },
      { name: "verification", marker: "chosen", phase: "committed", verify: true, hold: false },
      { name: "allow-verification", marker: "chosen", phase: "committed", arg: true, hold: false },
      { name: "target-committed", marker: "chosen", phase: "committed", hold: true },
    ]) {
      const work = join(f.root, scenario.name);
      mkdirSync(join(work, "data/state"), { recursive: true }); mkdirSync(join(work, "src"));
      const gate = join(work, "data/hold-health"), held = join(work, "data/state/health-held");
      writeFileSync(gate, "chosen"); writeFileSync(join(work, "src/upgrade-marker.txt"), scenario.marker);
      if (scenario.phase) writeFileSync(join(work, "data/state/release-data.json"), JSON.stringify({ phase: scenario.phase }));
      if (scenario.verify) writeFileSync(join(work, "data/state/verify-only"), "fixture");
      const script = join(work, "probe.ts"); writeFileSync(script, webHealthGate + '\nconsole.log("health check reached");');
      const child = Bun.spawn([process.execPath, "--no-env-file", script, ...scenario.arg ? ["--allow-verification"] : []], {
        cwd: work, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      try {
        const deadline = Date.now() + 5_000;
        while (child.exitCode === null && !existsSync(held) && Date.now() < deadline) await Bun.sleep(10);
        expect(existsSync(held), scenario.name).toBe(scenario.hold);
        rmSync(gate);
        const timer = setTimeout(() => child.kill(), 5_000);
        try {
          const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect(code, scenario.name + err).toBe(0); expect(out).toContain("health check reached");
        } finally { clearTimeout(timer); }
      } finally { child.kill(); await child.exited; }
    }
  } finally { await f.cleanup(); }
});
