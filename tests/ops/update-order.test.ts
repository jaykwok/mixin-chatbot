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
// from the target commit. The stub upgrader and deploy script record what they received.
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
CONTAINER=mixin-chatbot; STATE_DIR="$PROJECT_DIR/data/state"; LOG_DIR="$PROJECT_DIR/logs"
cd "$PROJECT_DIR"
P(){ echo "$*"; }; OK(){ echo "$*"; }; WA(){ echo "$*"; }; ER(){ echo "$*" >&2; }
acquire_deploy_lock(){ :; }; doctor(){ echo DOCTOR; }
# The post-upgrade check reloads the persisted settings (see load_saved_settings in ops.sh).
load_saved_settings(){ echo SETTINGS-RELOADED; }; check_ordinary_settings(){ :; }
docker(){
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
    await mkdir(join(work, "scripts/deploy"), { recursive: true }); await mkdir(join(work, "scripts/lib")); await mkdir(join(work, "scripts/migrations"));
    await mkdir(join(work, "src/core"), { recursive: true });
    await writeFile(join(work, "scripts/lib/fixture.sh"), ""); await writeFile(join(work, "scripts/migrations/fixture.ts"), "");
    await writeFile(join(work, "src/core/data-version.ts"), "");
    await writeFile(join(work, "scripts/deploy/upgrade.sh"), `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$here/src/core/data-version.ts" ] && [ -f "$here/scripts/lib/fixture.sh" ] && [ -f "$here/scripts/migrations/fixture.ts" ] || exit 44
input=''; IFS= read -r input || true
printf 'upgrader version=%s dir=%s args=%s stdin=%s\\n' "$(cat "$here/Dockerfile")" "\${here#"$1"/}" "\${*:2}" "$input" >> "$FIXTURE_EVENTS"
exit "\${FIXTURE_UPGRADER_EXIT:-0}"
`);
    await writeFile(join(work, "scripts/deploy/deploy.sh"), `#!/usr/bin/env bash
input=''; IFS= read -r input || true
printf 'deploy action=%s receipt=%s stdin=%s version=%s\\n' "\${DEPLOY_TRANSACTION_ACTION:-}" "\${BOT_UPDATE_COMMIT_FILE##*/}" "$input" "$(cat Dockerfile)" >> "$FIXTURE_EVENTS"
case "\${FIXTURE_DEPLOY:-}" in
    commit) printf 'committed\\n' > "$BOT_UPDATE_COMMIT_FILE"; rm -f data/state/deploy-transaction ;;
    rollback) rm -f data/state/deploy-transaction ;;
    # Like rollback_deployment for an upgrade still on the target code: the pointer stays, marked code-restore.
    restore-data) : > "backup/snapshots/$(cat data/state/deploy-transaction)/code-restore" ;;
    fail) exit 1 ;;
esac
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
    // Tracked changes stop the update before fetching.
    await writeFile(join(work, "Dockerfile"), "dirty");
    result = await update();
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("未提交的改动"); expect(result.text).not.toContain("拉取");
    expect(await events_()).toEqual([]);
    await git("checkout", "--", "Dockerfile");

    // Pending transactions: origin is unreachable and has moved on; nothing is fetched and the recorded target is used.
    await git("remote", "set-url", "origin", join(f.root, "missing.git"));
    const snapshot = join(work, "backup/snapshots/deploy-fixture"), groups = posix(join(work, "data/groups"));
    await mkdir(snapshot, { recursive: true });
    const record = (overrides: Record<string, string> = {}) => writeFile(join(snapshot, "transaction"), Object.entries({
      format: "1", operation: "upgrade", snapshot: "deploy-fixture", target_sha: target, original_sha: old, original_branch: "main",
      original_group_root: groups, target_group_root: groups, was_running: "1", bot_port: "1011", deploy_mode: "direct", bot_domain: "",
      domain_action: "keep", unmanaged_tunnel: "", platform_ip: "198.51.100.9", reconfigure_ai: "0", ...overrides,
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

    // The recorded target is missing locally: continuing is impossible; rollback before the checkout uses the current deploy script.
    await record({ target_sha: "b".repeat(40) });
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("在本地不存在，无法继续"); expect(result.text).toContain("rollback");
    expect(await events_()).toEqual([]);
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback", FIXTURE_DEPLOY: "rollback" }, "unexpected\n");
    expect(result.code, result.text).toBe(0);
    expect(await events_()).toEqual(["deploy action=rollback receipt= stdin= version=old"]);
    await writeFile(join(state, "deploy-transaction"), "deploy-fixture");
    await record({ target_sha: "b".repeat(40), original_sha: target });
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("当前代码也不是升级前的"); expect(await events_()).toEqual([]);
    // Only the code was left to restore and it is already the original: the transaction is cleared without the deploy script.
    await record({ target_sha: "b".repeat(40) }); await writeFile(join(snapshot, "code-restore"), "");
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚"); expect(await events_()).toEqual([]);
    expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    await rm(join(snapshot, "code-restore")); await writeFile(join(state, "deploy-transaction"), "deploy-fixture");

    // An interrupted deployment goes to the deploy script without a TTY, never to the upgrader.
    await record({ operation: "deploy", original_sha: "", original_branch: "" });
    for (const action of ["continue", "rollback"]) {
      result = await update({ UPDATE_TRANSACTION_ACTION: action }, "unexpected\n");
      expect(result.code, result.text).toBe(0); expect(result.text).toContain("未完成的部署");
      expect(await events_()).toEqual([`deploy action=${action} receipt= stdin= version=old`]);
    }
    await rm(join(state, "deploy-transaction"));
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("没有未完成的部署或升级"); expect(await events_()).toEqual([]);

    // Legacy update records written by the previous ops.sh remain recoverable.
    await git("reset", "--hard", target);
    const legacy = async (deployment: boolean) => {
      await writeFile(join(state, "update-transaction"), ["1", old, "main", target, "1".padStart(64, "0"), "1", ""].join("\n"));
      await writeFile(join(state, "update-commit"), ""); await writeFile(join(state, "running"), "false");
      await rm(join(snapshot, "transaction"), { force: true });
      if (deployment) {
        await writeFile(join(state, "deploy-transaction"), "deploy-fixture");
        await writeFile(join(snapshot, "target-sha"), target); await writeFile(join(snapshot, "was-running"), "1"); await writeFile(join(snapshot, "group-root"), groups);
      } else await rm(join(state, "deploy-transaction"), { force: true });
    };
    await legacy(true);
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue", FIXTURE_DEPLOY: "fail" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("部署事务尚未完成");
    expect(existsSync(join(state, "update-transaction"))).toBe(true); expect(await git("rev-parse", "HEAD")).toBe(target);
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue", FIXTURE_DEPLOY: "commit" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("中断的升级已完成");
    expect(await events_()).toEqual(["deploy action=continue receipt=update-commit stdin= version=new"]);
    expect(await git("rev-parse", "HEAD")).toBe(target);
    expect(existsSync(join(state, "update-transaction"))).toBe(false); expect(existsSync(join(state, "update-commit"))).toBe(false);
    await legacy(true);
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback", FIXTURE_DEPLOY: "rollback" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "update-transaction"))).toBe(false);
    // A failed code restore after the data rollback keeps both records; the retry restores only the code, continuing is refused.
    await git("reset", "--hard", target); await legacy(true);
    await writeFile(join(work, ".git/index.lock"), "");
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback", FIXTURE_DEPLOY: "restore-data" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("只恢复代码");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(true); expect(existsSync(join(state, "update-transaction"))).toBe(true);
    await rm(join(work, ".git/index.lock"));
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("不能继续"); expect(await git("rev-parse", "HEAD")).toBe(target);
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚"); expect(await events_()).toEqual([]);
    expect(await git("rev-parse", "HEAD")).toBe(old);
    for (const file of ["deploy-transaction", "update-transaction", "update-commit"]) expect(existsSync(join(state, file)), file).toBe(false);
    // Stopped before the old deploy began: only rollback (original code and container) is possible.
    await git("reset", "--hard", target); await legacy(false);
    result = await update({ UPDATE_TRANSACTION_ACTION: "continue" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("部署开始前中断"); expect(await git("rev-parse", "HEAD")).toBe(target);
    result = await update({ UPDATE_TRANSACTION_ACTION: "rollback" });
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("原容器已重新启动");
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(await readFile(join(state, "running"), "utf8")).toBe("true");
    expect(await events_()).toEqual(["docker inspect", "docker start"]);
    expect(existsSync(join(state, "update-transaction"))).toBe(false); expect(existsSync(join(state, "update-commit"))).toBe(false);
    expect(await exports()).toEqual([]);
  } finally { await f.cleanup(); }
}, 150000);
