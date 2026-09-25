import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

test.skipIf(process.platform !== "linux")("Linux update shares its real flock with deployment, serializes competitors and rolls back only uncommitted upgrades", async () => {
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
  try {
    const deployment = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
    const commit = deployment.indexOf("\ncommit_deployment\n");
    expect(commit).toBeGreaterThan(0);
    const completion = deployment.slice(commit);
    for (const dir of ["scripts/ops", "scripts/lib", "scripts/deploy"]) await mkdir(join(work, dir), { recursive: true });
    const ops = await readFile(join(project, "scripts/ops/ops.sh"), "utf8");
    const dispatch = ops.indexOf('\ncase "${1:-}" in\n');
    expect(dispatch).toBeGreaterThan(0);
    // Source the original function definitions without the CLI dispatcher's explicit exit.
    await writeFile(join(work, "scripts/ops/ops.sh"), ops.slice(0, dispatch));
    for (const path of ["scripts/lib/common.sh", "scripts/lib/lifecycle.sh", "scripts/lib/tunnel-logging.sh", "scripts/lib/operation-log.sh", "scripts/lib/deployment.sh"]) await copyFile(join(project, path), join(work, path));
    await writeFile(join(work, ".gitignore"), "data/\nbackup/\n");
    await writeFile(join(work, "scripts/deploy/deploy.sh"), [
      "#!/usr/bin/env bash", "set -euo pipefail",
      'PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"',
      '. "$PROJECT_DIR/scripts/lib/deployment.sh"',
      'acquire_deploy_lock || exit 20',
      'test "$(readlink /proc/self/fd/9)" = "$BOT_DEPLOY_LOCK_HELD"',
      'if flock -n "$BOT_DEPLOY_LOCK_HELD" true; then exit 21; fi',
      'trap \'printf "child-restored\\n" >> "$FIXTURE_MARKERS/order"; exit 143\' TERM INT',
      'printf "%s" "$PPID" > "$FIXTURE_MARKERS/update-pid"',
      'printf "child-started\\n" >> "$FIXTURE_MARKERS/order"',
      'test "$(cat "$FIXTURE_MARKERS/running")" = false',
      'test "$DEPLOY_PREVIOUS_RUNNING" = 1',
      'if [ "$FIXTURE_MODE" = fail ]; then exit 1; fi',
      'while [ ! -f "$FIXTURE_MARKERS/release" ]; do sleep 0.05; done',
      'printf "child-committed\\n" >> "$FIXTURE_MARKERS/order"',
      'PREVIOUS_RUNNING=0; PREVIOUS_CONTAINER_SAVED=0; DEPLOY_SNAPSHOT="$FIXTURE_MARKERS"',
      'cleanup_completed_backup() { :; }; print_success() { :; }; print_warning() { :; }',
      completion,
      'printf committed > "$FIXTURE_MARKERS/committed"',
      'if [ "$FIXTURE_MODE" = postcommit-fail ]; then exit 23; fi',
      'if [ "$FIXTURE_MODE" = signal-committed ]; then while true; do sleep 0.05; done; fi',
    ].join("\n") + "\n");
    const launcher = join(fixture.root, "launch.sh");
    await writeFile(launcher, [
      'source "$FIXTURE_WORK/scripts/ops/ops.sh" help >/dev/null',
      'docker() { case "$1" in info) : ;; ps) echo mixin-chatbot ;; inspect) if [ "$3" = "{{.Id}}" ]; then printf "%064d\\n" 1; else cat "$FIXTURE_MARKERS/running"; fi ;; stop) printf false > "$FIXTURE_MARKERS/running" ;; start) printf true > "$FIXTURE_MARKERS/running" ;; *) return 1 ;; esac; }',
      'doctor() { if flock -n "$FIXTURE_WORK/data/state/deploy.lock" true; then echo "update lock released before doctor"; return 22; fi; if [ "$FIXTURE_MODE" = doctor-fail ]; then return 17; fi; return 0; }',
      'update',
    ].join("\n") + "\n");
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("config", "core.autocrlf", "false");
    await writeFile(join(work, "version.txt"), "old"); await git("add", "."); await git("commit", "-m", "old");
    const old = await git("rev-parse", "HEAD");
    await writeFile(join(work, "version.txt"), "new"); await git("add", "."); await git("commit", "-m", "new");
    const target = await git("rev-parse", "HEAD");
    expect((await run(["git", "init", "--bare", origin])).code).toBe(0);
    await git("remote", "add", "origin", origin); await git("push", "origin", "main");
    for (const mode of ["fail", "doctor-fail", "postcommit-fail", "signal", "signal-committed", "success"]) {
      await git("reset", "--hard", old);
      const markers = join(fixture.root, mode); await mkdir(markers);
      await writeFile(join(markers, "running"), "true");
      if (["doctor-fail", "postcommit-fail", "signal-committed"].includes(mode)) await writeFile(join(markers, "release"), "go");
      const env = { ...process.env, FIXTURE_WORK: work, FIXTURE_MARKERS: markers, FIXTURE_MODE: mode };
      const child = Bun.spawn(["bash", launcher], { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
      let updatePid: number | undefined;
      const timer = setTimeout(() => { if (updatePid) { try { process.kill(updatePid, "SIGTERM"); } catch {} } child.kill(); }, 15000);
      try {
        if (mode.startsWith("signal") || mode === "success") {
          const until = Date.now() + 6000;
          while (!await Bun.file(join(markers, "update-pid")).exists()) {
            expect(Date.now()).toBeLessThan(until); await Bun.sleep(20);
          }
          updatePid = Number(await readFile(join(markers, "update-pid"), "utf8"));
          expect(updatePid).toBeGreaterThan(1);
          expect(await git("rev-parse", "HEAD")).toBe(target);
          if (mode === "signal-committed") {
            while (!await Bun.file(join(markers, "committed")).exists()) {
              expect(Date.now()).toBeLessThan(until); await Bun.sleep(20);
            }
          }
          if (mode.startsWith("signal")) process.kill(updatePid, "SIGTERM");
          else {
            const competitor = await run(["bash", launcher], { FIXTURE_WORK: work, FIXTURE_MARKERS: markers, FIXTURE_MODE: mode });
            expect(competitor.code).toBe(1); expect(competitor.text).toContain("另一个部署或升级");
            await writeFile(join(markers, "release"), "go");
          }
        }
        const code = await child.exited, text = await output + await errors;
        expect(code, mode + ": " + text).toBe(mode === "fail" || mode === "postcommit-fail" ? 1 : mode === "doctor-fail" ? 17 : mode.startsWith("signal") ? 143 : 0);
        expect(await git("rev-parse", "HEAD")).toBe(mode === "fail" || mode === "signal" ? old : target);
        if (mode === "signal") expect(await readFile(join(markers, "order"), "utf8")).toContain("child-restored");
        expect((await run(["flock", "-n", join(work, "data/state/deploy.lock"), "true"])).code).toBe(0);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && updatePid) { try { process.kill(updatePid, "SIGTERM"); } catch {} }
        child.kill(); await child.exited;
      }
    }
  } finally { await fixture.cleanup(); }
}, 60000);
