import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

test.skipIf(!bash || !existsSync(bash))("Docker update stops before checkout and build, restores failures and resumes the original running state", async () => {
  const f = await tempFixture("update-order-"), work = join(f.root, "work"), state = join(work, "data/state");
  const run = async (args: string[], env: Record<string, string> = {}, input?: string) => {
    const stdin = input === undefined ? "ignore" : new Blob([input]);
    const child = Bun.spawn(args, { cwd: work, env: { ...process.env, ...env }, stdin, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 20000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, text: out + err };
    } finally { clearTimeout(timeout); }
  };
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args]); expect(result.code, result.text).toBe(0); return result.text.trim();
  };
  try {
    await mkdir(join(work, "scripts/deploy"), { recursive: true }); await mkdir(state, { recursive: true });
    const models = join(work, "data/config/models.json");
    await mkdir(join(work, "data/config"), { recursive: true }); await writeFile(models, "{}");
    await writeFile(join(work, ".gitignore"), "data/\nlogs/\ntmp/\nbackup/\n");
    await writeFile(join(work, "scripts/deploy/deploy.sh"), `#!/usr/bin/env bash
set -euo pipefail
test "$(cat data/state/running)" = false
test "$(cat version.txt)" = new
test "$DEPLOY_PREVIOUS_RUNNING" = "$EXPECT_RUNNING"
test "$DEPLOY_REUSE_SETTINGS" = 1
test "$DEPLOY_TUNNEL_INPUT_PREPARED" = "\${EXPECT_TUNNEL_PREPARED:-}"
test "$DEPLOY_TUNNEL_TOKEN_INPUT" = "\${EXPECT_TUNNEL_INPUT:-}"
test "$DEPLOY_UNMANAGED_TUNNEL_CONFIRMED" = "\${EXPECT_UNMANAGED:-}"
printf 'build\\n' >> data/state/events
if [ "$FIXTURE_MODE" = build-fail ]; then exit 19; fi
printf committed > "$BOT_UPDATE_COMMIT_FILE"
if [ "$DEPLOY_PREVIOUS_RUNNING" = 1 ]; then printf true > data/state/running; fi
`);
    const source = await readFile(join(project, "scripts/ops/ops.sh"), "utf8");
    const update = source.match(/^update\(\) \([\s\S]*?^\)/m)![0];
    const restore = source.match(/^restore_checkout\(\) \{[\s\S]*?^\}/m)![0];
    const launcher = join(f.root, "launch.sh");
    await writeFile(launcher, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_DIR="$1"; STATE_DIR="$PROJECT_DIR/data/state"; CONTAINER=mixin-chatbot
MODELS_FILE="$PROJECT_DIR/data/config/models.json"; ops_command_hint(){ echo "$*"; }
CYAN=''; NC=''; ROLLBACK_CONTAINER=mixin-chatbot-rollback
cd "$PROJECT_DIR"
. '${posix(join(project, "scripts/lib/operation-log.sh"))}'
P(){ echo "$*"; }; OK(){ echo "$*"; }; WA(){ echo "$*"; }; ER(){ echo "$*" >&2; }
acquire_deploy_lock(){ :; }; has_container(){ return 0; }; doctor(){ return 0; }
DEPLOY_MODE="\${FIXTURE_DEPLOY_MODE:-direct}"
# Tunnel answers are recorded as events so the test can prove they precede the stop.
ask_yes_no(){ case "$1" in *connector*) printf 'confirm-tunnel\\n' >> data/state/events; [ "\${FIXTURE_CONFIRM:-y}" = y ] ;; *) return 0 ;; esac; }
managed_cloudflared_pid(){ return 1; }
pgrep(){ if [ "\${FIXTURE_UNMANAGED:-0}" = 1 ]; then echo 4242; return 0; fi; return 1; }
show_tunnel_token_help(){ :; }
load_tunnel_token(){
    if [ -z "\${1:-}" ]; then [ "\${FIXTURE_SAVED_TOKEN:-0}" = 1 ]; return; fi
    [ "$1" = fixture-token ] || { echo 'invalid token' >&2; return 1; }
    printf 'token\\n' >> data/state/events
}
git_here(){
    case "$1" in checkout|merge|reset)
        if [ "$(cat data/state/running)" != false ]; then echo 'MUTATION_WHILE_RUNNING' >&2; return 91; fi
        printf '%s\\n' "$1" >> data/state/events
        if [ "$FIXTURE_MODE" = checkout-fail ] && [ "$1" = checkout ]; then return 18; fi ;;
    esac
    git "$@"
}
docker(){
    case "$1" in
      info) : ;;
      inspect) if [ "$3" = '{{.Id}}' ]; then printf '%064d\\n' 1; else cat data/state/running; fi ;;
      stop) printf 'stop\\n' >> data/state/events; if [ "$FIXTURE_MODE" = stop-fail ]; then return 17; fi; printf false > data/state/running ;;
      start) test "$(cat version.txt)" = old || return 92; printf 'restore-service\\n' >> data/state/events; printf true > data/state/running ;;
      *) return 93 ;;
    esac
}
${restore}
${update}
update
`);
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("config", "core.autocrlf", "false");
    await writeFile(join(f.root, "gitignore"), "");
    await git("config", "core.excludesFile", join(f.root, "gitignore"));
    await writeFile(join(work, "version.txt"), "old"); await git("add", "."); await git("commit", "-m", "old");
    const old = await git("rev-parse", "HEAD");
    await writeFile(join(work, "version.txt"), "new"); await git("add", "."); await git("commit", "-m", "new");
    const target = await git("rev-parse", "HEAD"), origin = join(f.root, "origin.git");
    await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", "main");
    for (const running of [false, true]) for (const mode of ["success", "build-fail", "stop-fail", "resume"]) {
      await git("reset", "--hard", mode === "resume" ? target : old);
      await writeFile(join(state, "running"), String(mode === "resume" ? false : running));
      await writeFile(join(state, "events"), "");
      if (mode === "resume") {
        await writeFile(join(state, "update-transaction"), ["1", old, "main", target, "1".padStart(64, "0"), Number(running), ""].join("\n"));
        await writeFile(join(state, "update-commit"), "");
      }
      const result = await run([bash!, posix(launcher), posix(work)], { FIXTURE_MODE: mode, EXPECT_RUNNING: String(Number(running)) });
      const succeeded = mode === "success" || mode === "resume";
      expect(result.code, `${mode}/${running}: ${result.text}`).toBe(succeeded ? 0 : 1);
      expect(result.text).not.toContain("MUTATION_WHILE_RUNNING");
      expect(await git("rev-parse", "HEAD")).toBe(succeeded ? target : old);
      expect(await readFile(join(state, "running"), "utf8")).toBe(String(running));
      const events = (await readFile(join(state, "events"), "utf8")).trim().split("\n");
      expect(events[0]).toBe("stop");
      if (mode === "stop-fail") expect(events).not.toContain("checkout");
      else { expect(events.indexOf("checkout")).toBeGreaterThan(events.indexOf("stop")); expect(events.indexOf("build")).toBeGreaterThan(events.indexOf("merge")); }
      expect(existsSync(join(state, "update-transaction"))).toBe(false);
      expect(existsSync(join(state, "update-commit"))).toBe(false);
    }

    // Tunnel answers are collected before the stop and handed to the target deploy script.
    const tunnelCases: { name: string; env: Record<string, string>; input: string; first: string; ok: boolean }[] = [
      { name: "token-prompt", env: { FIXTURE_DEPLOY_MODE: "cloudflare", EXPECT_TUNNEL_PREPARED: "1", EXPECT_TUNNEL_INPUT: "fixture-token" }, input: "invalid\nfixture-token\n", first: "token", ok: true },
      { name: "saved-token", env: { FIXTURE_DEPLOY_MODE: "cloudflare", FIXTURE_SAVED_TOKEN: "1", EXPECT_TUNNEL_PREPARED: "1" }, input: "", first: "stop", ok: true },
      { name: "unmanaged-confirmed", env: { FIXTURE_DEPLOY_MODE: "cloudflare", FIXTURE_UNMANAGED: "1", EXPECT_UNMANAGED: "cloudflare" }, input: "", first: "confirm-tunnel", ok: true },
      { name: "unmanaged-declined", env: { FIXTURE_UNMANAGED: "1", FIXTURE_CONFIRM: "n" }, input: "", first: "confirm-tunnel", ok: false },
      { name: "token-input-ended", env: { FIXTURE_DEPLOY_MODE: "cloudflare" }, input: "", first: "", ok: false },
    ];
    for (const tunnel of tunnelCases) {
      await git("reset", "--hard", old);
      await writeFile(join(state, "running"), "true"); await writeFile(join(state, "events"), "");
      const result = await run([bash!, posix(launcher), posix(work)], { FIXTURE_MODE: "success", EXPECT_RUNNING: "1", ...tunnel.env }, tunnel.input);
      expect(result.code, `${tunnel.name}: ${result.text}`).toBe(tunnel.ok ? 0 : 1);
      const events = (await readFile(join(state, "events"), "utf8")).trim().split("\n").filter(Boolean);
      expect(events[0] ?? "", tunnel.name).toBe(tunnel.first);
      // events[0] proves any tunnel answer preceded the stop; the target deploy script then checked the handoff.
      if (tunnel.ok) expect(events, tunnel.name).toContain("build");
      else { expect(events, tunnel.name).not.toContain("stop"); expect(await git("rev-parse", "HEAD")).toBe(old); }
      expect(await readFile(join(state, "running"), "utf8"), tunnel.name).toBe("true");
      expect(result.text, tunnel.name).not.toContain("fixture-token");
    }

    // Updates reuse the saved AI configuration; a missing one needs the interactive wizard, so refuse before the stop.
    await git("reset", "--hard", old);
    await rm(models); await writeFile(join(state, "running"), "true"); await writeFile(join(state, "events"), "");
    const unconfigured = await run([bash!, posix(launcher), posix(work)], { FIXTURE_MODE: "success", EXPECT_RUNNING: "1" });
    expect(unconfigured.code, unconfigured.text).toBe(1); expect(unconfigured.text).toContain("models.json");
    expect(await readFile(join(state, "events"), "utf8")).toBe("");
    expect(await git("rev-parse", "HEAD")).toBe(old);
    await writeFile(models, "{}");

    // Preflight must report the local main branch, even when HEAD is elsewhere.
    await git("branch", "-m", "topic");
    await writeFile(join(state, "running"), "true"); await writeFile(join(state, "events"), "");
    const missing = await run([bash!, posix(launcher), posix(work)], { FIXTURE_MODE: "success" });
    expect(missing.code).toBe(1); expect(missing.text).toContain("main 分支不存在");
    expect(await readFile(join(state, "events"), "utf8")).toBe("");
    await git("branch", "-m", "main");
    await writeFile(join(work, "main-only.txt"), "local"); await git("add", "."); await git("commit", "-m", "fixture-local-main");
    await git("checkout", "-b", "topic", old);
    await writeFile(join(work, "topic-only.txt"), "topic"); await git("add", "."); await git("commit", "-m", "fixture-topic-only");
    const topic = await git("rev-parse", "HEAD");
    const diverged = await run([bash!, posix(launcher), posix(work)], { FIXTURE_MODE: "success" });
    expect(diverged.code).toBe(1); expect(diverged.text).toContain("fixture-local-main");
    expect(diverged.text).not.toContain("fixture-topic-only");
    expect(await readFile(join(state, "events"), "utf8")).toBe("");
    expect(await readFile(join(state, "running"), "utf8")).toBe("true");
    await git("branch", "-f", "main", old);
    const planned = await run([bash!, posix(launcher), posix(work)], { FIXTURE_MODE: "stop-fail" });
    expect(planned.code).toBe(1); expect(planned.text).toContain(`${target.slice(0, 7)} new`);
    expect(planned.text).not.toContain("fixture-topic-only");
    expect(await git("rev-parse", "HEAD")).toBe(topic);
  } finally { await f.cleanup(); }
}, 150000);
