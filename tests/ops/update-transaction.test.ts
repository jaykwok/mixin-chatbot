import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

test.skipIf(process.platform !== "linux")("Linux update holds its real flock through the exported upgrader, refuses competitors, forwards signals and removes the export", async () => {
  const fixture = await tempFixture("linux-update-"), work = join(fixture.root, "work"), origin = join(fixture.root, "origin.git");
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn(argv, { cwd: work, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, text: out + err };
    } finally { clearTimeout(timer); }
  };
  const git = async (...args: string[]) => {
    const result = await run(["git", "-C", work, ...args]);
    expect(result.code, result.text).toBe(0); return result.text.trim();
  };
  const exports = async () => existsSync(join(work, "tmp")) ? (await readdir(join(work, "tmp"))).filter(name => name.startsWith("upgrade-")) : [];
  try {
    for (const dir of ["scripts/ops", "scripts/lib", "scripts/deploy", "scripts/migrations", "src/core"]) await mkdir(join(work, dir), { recursive: true });
    const ops = await readFile(join(project, "scripts/ops/ops.sh"), "utf8");
    const dispatch = ops.indexOf('\ncase "${1:-}" in\n');
    expect(dispatch).toBeGreaterThan(0);
    // Source the original function definitions without the CLI dispatcher's explicit exit.
    await writeFile(join(work, "scripts/ops/ops.sh"), ops.slice(0, dispatch));
    for (const name of await readdir(join(project, "scripts/lib"))) {
      if (name.endsWith(".sh")) await copyFile(join(project, "scripts/lib", name), join(work, "scripts/lib", name));
    }
    await writeFile(join(work, "scripts/migrations/fixture.ts"), ""); await writeFile(join(work, "src/core/data-version.ts"), ""); await writeFile(join(work, "Dockerfile"), "");
    await writeFile(join(work, ".gitignore"), "data/\nbackup/\ntmp/\nlogs/\n");
    // The upgrader exported from the target re-enters the lock held by update through the inherited descriptor.
    await writeFile(join(work, "scripts/deploy/upgrade.sh"), [
      "#!/usr/bin/env bash", "set -euo pipefail",
      'here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
      'PROJECT_DIR="$1"',
      '. "$here/scripts/lib/common.sh"',
      'acquire_deploy_lock || exit 20',
      'test "$(readlink /proc/self/fd/9)" = "$BOT_DEPLOY_LOCK_HELD"',
      'if flock -n "$BOT_DEPLOY_LOCK_HELD" true; then exit 21; fi',
      // The export must still exist while the upgrader rolls back after a forwarded signal.
      'trap \'[ -d "$here" ] && printf "upgrader-rolled-back-with-export\\n" >> "$FIXTURE_MARKERS/order"; exit 143\' TERM',
      'printf "%s" "$PPID" > "$FIXTURE_MARKERS/update-pid"',
      'printf "upgrader-started\\n" >> "$FIXTURE_MARKERS/order"',
      'if [ "$FIXTURE_MODE" = fail ]; then exit 1; fi',
      'while [ ! -f "$FIXTURE_MARKERS/release" ]; do sleep 0.05; done',
      'printf "upgrader-finished\\n" >> "$FIXTURE_MARKERS/order"',
    ].join("\n") + "\n");
    const launcher = join(fixture.root, "launch.sh");
    await writeFile(launcher, [
      'source "$FIXTURE_WORK/scripts/ops/ops.sh" help >/dev/null',
      'docker() { case "$1 $2" in "container inspect") echo true ;; *) return 1 ;; esac; }',
      'doctor() { if flock -n "$FIXTURE_WORK/data/state/deploy.lock" true; then echo "update lock released before doctor"; return 22; fi; return 0; }',
      'update',
    ].join("\n") + "\n");
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("config", "core.autocrlf", "false");
    await writeFile(join(work, "version.txt"), "old"); await git("add", "."); await git("commit", "-m", "old");
    const old = await git("rev-parse", "HEAD");
    await writeFile(join(work, "version.txt"), "new"); await git("add", "."); await git("commit", "-m", "new");
    expect((await run(["git", "init", "--bare", origin])).code).toBe(0);
    await git("remote", "add", "origin", origin); await git("push", "origin", "main");
    for (const mode of ["fail", "signal-term", "signal-int", "success"]) {
      await git("reset", "--hard", old);
      const markers = join(fixture.root, mode); await mkdir(markers);
      const env = { ...process.env, FIXTURE_WORK: work, FIXTURE_MARKERS: markers, FIXTURE_MODE: mode };
      const child = Bun.spawn(["bash", launcher], { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
      let updatePid: number | undefined;
      const timer = setTimeout(() => { if (updatePid) { try { process.kill(updatePid, "SIGTERM"); } catch {} } child.kill(); }, 15000);
      try {
        if (mode !== "fail") {
          const until = Date.now() + 6000;
          while (!await Bun.file(join(markers, "update-pid")).exists()) {
            expect(Date.now()).toBeLessThan(until); await Bun.sleep(20);
          }
          updatePid = Number(await readFile(join(markers, "update-pid"), "utf8"));
          expect(updatePid).toBeGreaterThan(1);
          expect(await exports()).toHaveLength(1);
          if (mode === "signal-term") process.kill(updatePid, "SIGTERM");
          else if (mode === "signal-int") process.kill(updatePid, "SIGINT");
          else {
            const competitor = await run(["bash", launcher], { FIXTURE_WORK: work, FIXTURE_MARKERS: markers, FIXTURE_MODE: mode });
            expect(competitor.code).toBe(1); expect(competitor.text).toContain("另一个部署或升级");
            await writeFile(join(markers, "release"), "go");
          }
        }
        const code = await child.exited, text = await output + await errors;
        expect(code, mode + ": " + text).toBe(mode === "fail" ? 1 : mode.startsWith("signal") ? 143 : 0);
        const order = await readFile(join(markers, "order"), "utf8");
        // Interrupts reach the upgrader (as TERM), which finishes its rollback before the export is removed.
        if (mode.startsWith("signal")) expect(order).toBe("upgrader-started\nupgrader-rolled-back-with-export\n");
        if (mode === "success") { expect(order).toBe("upgrader-started\nupgrader-finished\n"); expect(text).not.toContain("released before doctor"); }
        expect(await exports()).toEqual([]);
        expect((await run(["flock", "-n", join(work, "data/state/deploy.lock"), "true"])).code).toBe(0);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && updatePid) { try { process.kill(updatePid, "SIGTERM"); } catch {} }
        child.kill(); await child.exited;
      }
    }
  } finally { await fixture.cleanup(); }
}, 60000);
