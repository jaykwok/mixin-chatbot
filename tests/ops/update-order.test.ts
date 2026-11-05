import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

// ops.sh update only routes: pending transactions first (no fetch), otherwise fetch and run the upgrader exported
// from the target commit. A pending deployment and a rollback without its target go to the core. The stub upgrader and
// core record what they received.
test.skipIf(!bash || !existsSync(bash))("update handles pending transactions before fetching and runs the upgrader exported from the target", async () => {
  const f = await tempFixture("update-order-"), work = join(f.root, "work"), state = join(work, "data/state"), events = join(f.root, "events");
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
  const source = await readFile(join(project, "scripts/ops/ops.sh"), "utf8");
  const start = source.indexOf("\nchoose_pending_action() {"), end = source.indexOf("\nshow_logs() {");
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const launcher = join(f.root, "launch.sh");
  await writeFile(launcher, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_DIR="$1"
. '${posix(join(project, "scripts/lib/common.sh"))}'
. '${posix(join(project, "scripts/lib/ops-runtime.sh"))}'
CONTAINER=mixin-chatbot; STATE_DIR="$PROJECT_DIR/data/state"; LOG_DIR="$PROJECT_DIR/logs"; OPS_SOURCE_DIR=/fixed-source
cd "$PROJECT_DIR"
P(){ echo "$*"; }; OK(){ echo "$*"; }; WA(){ echo "$*"; }; ER(){ echo "$*" >&2; }
acquire_deploy_lock(){ :; }; doctor(){ echo DOCTOR; }
# The host Bun running the core: what it was handed, with the project and the fixed source masked.
ops_bun(){ echo fixture_core; }
fixture_core(){
    input=''; IFS= read -r input || true
    args="$*"; args="\${args//$PROJECT_DIR/<project>}"
    printf 'core %s stdin=%s\\n' "$args" "$input" >> "$FIXTURE_EVENTS"
}
# The post-upgrade check reloads the persisted settings (see load_saved_settings in ops.sh).
load_saved_settings(){ echo SETTINGS-RELOADED; }; check_ordinary_settings(){ :; }
docker(){
    if [ "$1" = container ]; then shift; elif [ "$1" = inspect ]; then return 97; fi
    printf 'docker %s\\n' "$1" >> "$FIXTURE_EVENTS"
    case "$1" in
        inspect) if [[ "$*" = *'{{.Id}}'* ]]; then printf '%064d\\n' 1; else cat data/state/running; fi ;;
        start) printf true > data/state/running ;;
    esac
}
${source.slice(start, end)}
update
`);
  const events_ = async () => existsSync(events) ? (await readFile(events, "utf8")).trim().split("\n").filter(Boolean) : [];
  const exports = async () => existsSync(join(work, "tmp")) ? (await readdir(join(work, "tmp"))).filter(name => name.startsWith("upgrade-")) : [];
  const update = async (env: Record<string, string> = {}, input?: string) => {
    await rm(events, { force: true });
    return run([bash!, posix(launcher), posix(work)], { FIXTURE_EVENTS: posix(events), ...env }, input);
  };
  try {
    await mkdir(state, { recursive: true });
    await writeFile(join(work, ".gitignore"), "data/\nlogs/\ntmp/\nbackup/\n");
    // Every path of UPGRADER_EXPORT_PATHS exists in each commit; the Dockerfile content names the version.
    await mkdir(join(work, "scripts/deploy"), { recursive: true }); await mkdir(join(work, "scripts/lib")); await mkdir(join(work, "scripts/runtime"));
    await writeFile(join(work, "scripts/lib/fixture.sh"), ""); await writeFile(join(work, "scripts/runtime/fixture.ts"), "");
    await writeFile(join(work, "scripts/deploy/upgrade.sh"), `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$here/scripts/lib/fixture.sh" ] && [ -f "$here/scripts/runtime/fixture.ts" ] || exit 44
input=''; IFS= read -r input || true
printf 'upgrader version=%s dir=%s args=%s stdin=%s\\n' "$(cat "$here/Dockerfile")" "\${here#"$1"/}" "\${*:2}" "$input" >> "$FIXTURE_EVENTS"
if [ "\${FIXTURE_UPGRADER_HOLD:-0}" = 1 ]; then
    sleep 30 >/dev/null 2>&1 &
    trap 'kill $!; echo "upgrader TERM" >> "$FIXTURE_EVENTS"; exit 143' TERM
    wait
fi
exit "\${FIXTURE_UPGRADER_EXIT:-0}"
`);
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await git("config", "core.autocrlf", "false");
    await writeFile(join(f.root, "gitignore"), ""); await git("config", "core.excludesFile", join(f.root, "gitignore"));
    const commit = async (version: string) => {
      await writeFile(join(work, "Dockerfile"), version); await git("add", "."); await git("commit", "-m", version); return git("rev-parse", "HEAD");
    };
    const old = await commit("old"), target = await commit("new");
    const origin = join(f.root, "origin.git");
    await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", "main");
    await git("reset", "--hard", old); await git("update-ref", "refs/remotes/origin/main", old);

    // A new upgrade fetches origin/main, exports its upgrader to tmp/upgrade-*, passes stdin through for the
    // interactive preview, runs a full check when the service runs, and removes the export.
    await writeFile(join(state, "running"), "true");
    let result = await update({}, "answer\n");
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain("拉取 origin/main");
    expect(await git("rev-parse", "refs/remotes/origin/main")).toBe(target);
    const [fresh] = await events_();
    expect(fresh).toMatch(new RegExp(`^upgrader version=new dir=tmp/upgrade-[A-Za-z0-9]{8} args=${target} stdin=answer$`));
    expect(result.text).toContain("SETTINGS-RELOADED\nDOCTOR"); expect(await exports()).toEqual([]);
    await writeFile(join(state, "running"), "false");
    result = await update();
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("保留原停止状态"); expect(result.text).not.toContain("DOCTOR");
    // The upgrader's failure is the update's failure; the export is still removed.
    result = await update({ FIXTURE_UPGRADER_EXIT: "7" });
    expect(result.code, result.text).toBe(7); expect(result.text).not.toContain("DOCTOR"); expect(await exports()).toEqual([]);
    // A TERM sent to ops.sh itself reaches the upgrader, which cancels where it stands; update waits for it and removes
    // the export. (When update ran in a subshell, only the parent died and the upgrade went on.) Windows cannot signal bash.
    if (process.platform !== "win32") {
      await rm(events, { force: true });
      const held = Bun.spawn([bash!, posix(launcher), posix(work)], { cwd: work,
        env: { ...process.env, FIXTURE_EVENTS: posix(events), FIXTURE_UPGRADER_HOLD: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const output = Promise.all([new Response(held.stdout).text(), new Response(held.stderr).text()]);
      for (let attempt = 0; attempt < 100 && !(await events_()).some(line => line.startsWith("upgrader version=")); attempt++) await Bun.sleep(100);
      held.kill("SIGTERM");
      expect(await Promise.race([held.exited, Bun.sleep(10_000).then(() => "still running")])).toBe(143);
      expect(await events_()).toContain("upgrader TERM");
      await output; expect(await exports()).toEqual([]);
    }
    // Tracked changes stop the update before fetching.
    await writeFile(join(work, "Dockerfile"), "dirty");
    result = await update();
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("未提交的改动"); expect(result.text).not.toContain("拉取");
    expect(await events_()).toEqual([]);
    await git("checkout", "--", "Dockerfile");

    // Pending transactions: origin is unreachable and has moved on; nothing is fetched and the recorded target is used.
    await git("remote", "set-url", "origin", join(f.root, "missing.git"));
    const snapshot = join(work, "backup/snapshots/deploy-fixture");
    await mkdir(snapshot, { recursive: true });
    const record = (overrides: Record<string, string> = {}) => writeFile(join(snapshot, "transaction"), Object.entries({
      format: "2", operation: "upgrade", snapshot: "deploy-fixture", target_sha: target, original_sha: old, original_branch: "main",
      original_workspace_root: "", target_workspace_root: "", was_running: "1", bot_port: "1011", reconfigure_ai: "0", ...overrides,
    }).map(([key, value]) => `${key}=${value}\n`).join(""));
    await writeFile(join(state, "deploy-transaction"), "deploy-fixture"); await record();
    await writeFile(join(state, "running"), "true");
    for (const action of ["continue", "rollback"]) {
      result = await update({ UPDATE_TRANSACTION_ACTION: action });
      expect(result.code, result.text).toBe(0); expect(result.text).not.toContain("拉取");
      expect((await events_())[0]).toMatch(new RegExp(`^upgrader version=new dir=tmp/upgrade-[A-Za-z0-9]{8} args=${target} ${action} stdin=$`));
      // Only a completed continue runs the full check.
      expect(result.text.includes("DOCTOR")).toBe(action === "continue");
      expect(await exports()).toEqual([]);
    }
    // Without a TTY the pending upgrade needs an explicit action; nothing runs.
    result = await update();
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("resume"); expect(result.text).toContain("未完成的升级");
    expect(await events_()).toEqual([]);

    // The recorded target is missing locally: continuing is impossible; rollback before the checkout is the pinned runtime's.
    await record({ target_sha: "b".repeat(40) });
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("在本地不存在，无法继续"); expect(result.text).toContain("rollback");
    expect(await events_()).toEqual([]);
    // A transaction without a pinned runtime was not started by the core: this release does not take it over.
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" }, "unexpected\n");
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("不是由运维核心开始的"); expect(await events_()).toEqual([]);
    const pinnedRuntime = "a".repeat(64), pinned = `.console/runtime/source-${pinnedRuntime}/scripts/ops/core/cli.ts`;
    await writeFile(join(snapshot, "host-runtime"), pinnedRuntime + "\n");
    await mkdir(join(work, `.console/runtime/source-${pinnedRuntime}/scripts/ops/core`), { recursive: true }); await writeFile(join(work, pinned), "");
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" }, "unexpected\n");
    expect(result.code, result.text).toBe(0);
    expect(await events_()).toEqual([`core --no-env-file <project>/${pinned} deployment upgrade --project <project> --original ${old} --target ${"b".repeat(40)} --branch main --rollback stdin=`]);
    await rm(join(snapshot, "host-runtime"));
    await record({ target_sha: "b".repeat(40), original_sha: target });
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("当前代码也不是升级前的"); expect(await events_()).toEqual([]);

    // An interrupted deployment goes to the core without a TTY, never to the upgrader: the pinned runtime when it is there,
    // otherwise this release's core, which accepts only byte-identical code.
    await record({ operation: "deploy", original_sha: "", original_branch: "" });
    for (const action of ["continue", "rollback"]) {
      result = await update({ UPDATE_TRANSACTION_ACTION: action }, "unexpected\n");
      expect(result.code, result.text).toBe(0); expect(result.text).toContain("未完成的部署");
      expect(await events_()).toEqual([`core --no-env-file /fixed-source/scripts/ops/core/cli.ts deployment deploy --project <project>${action === "rollback" ? " --rollback" : ""} stdin=`]);
    }
    await writeFile(join(snapshot, "host-runtime"), pinnedRuntime + "\n");
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" }, "unexpected\n");
    expect(result.code, result.text).toBe(0);
    expect(await events_()).toEqual([`core --no-env-file <project>/${pinned} deployment deploy --project <project> stdin=`]);
    await rm(join(state, "deploy-transaction"));
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("没有未完成的部署或升级"); expect(await events_()).toEqual([]);
    expect(await exports()).toEqual([]);
  } finally { await f.cleanup(); }
}, 150000);
