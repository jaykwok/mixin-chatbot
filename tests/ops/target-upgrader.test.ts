import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const token = "eyJhIjoiZml4dHVyZS1hY2NvdW50IiwidCI6ImZpeHR1cmUifQ";

// Docker stub: containers are files "<image> <running>" under mock/containers; the preview writes its plan into the /preview mount.
// A bare "docker inspect" also matches the mixin-chatbot image, so the scripts must name the object type.
const dockerStub = `#!/usr/bin/env bash
mock="$FIXTURE_MOCK"
printf '%s\\n' "$*" >> "$mock/docker.log"
if [ "$1" = container ]; then shift; elif [ "$1" = inspect ]; then echo "ambiguous docker inspect: $*" >&2; exit 97; fi
current_head() { git -C "$FIXTURE_WORK" rev-parse --short HEAD; }
cmd="$1"; shift
case "$cmd" in
    info) [ "\${FIXTURE_ROOTLESS:-0}" != 1 ] || echo '[name=seccomp,profile=builtin name=rootless name=cgroupns]'; exit 0 ;;
    image) [ "\${FIXTURE_IMAGE:-present}" = present ] ;;
    pull) printf 'pull %s\\n' "$1" >> "$FIXTURE_EVENTS" ;;
    run)
        printf '%s\\n' "$@" > "$mock/preview-args"
        preview=''; previous=''
        for arg in "$@"; do
            if [ "$previous" = -v ] && [[ "$arg" == *:/preview ]]; then preview="\${arg%:/preview}"; fi
            previous="$arg"
        done
        printf 'preview head=%s\\n' "$(current_head)" >> "$FIXTURE_EVENTS"
        # A preview that waits (for example for migration decisions) until it is removed.
        [ "\${FIXTURE_PREVIEW:-ok}" != hold ] || exec sleep 30
        [ "\${FIXTURE_PREVIEW:-ok}" = ok ] || { echo '迁移预检需要确认后才能继续' >&2; exit 2; }
        printf '{"format":1,"fixture":"plan"}' > "$preview/migration-plan.json" ;;
    ps) for file in "$mock"/containers/*; do [ -f "$file" ] && basename "$file"; done ;;
    inspect)
        name="\${!#}"; [ -f "$mock/containers/$name" ] || exit 1
        read -r image running < "$mock/containers/$name"
        case "\${2:-}" in
            '{{.Image}}') echo "$image" ;;
            '{{.State.Running}}') echo "$running" ;;
            '{{.State.Status}}') if [ "$running" = true ]; then echo running; else echo exited; fi ;;
        esac ;;
    stop|start)
        name="\${!#}"; read -r image running < "$mock/containers/$name"
        if [ "$cmd" = stop ]; then running=false; else running=true; fi
        printf '%s %s\\n' "$image" "$running" > "$mock/containers/$name"
        printf '%s %s head=%s\\n' "$cmd" "$name" "$(current_head)" >> "$FIXTURE_EVENTS" ;;
    rename) mv -- "$mock/containers/$1" "$mock/containers/$2"; printf 'rename %s %s\\n' "$1" "$2" >> "$FIXTURE_EVENTS" ;;
    rm) printf 'rm %s\\n' "$*" >> "$FIXTURE_EVENTS" ;;
    tag) : ;;
    *) exit 93 ;;
esac
`;

// Target deploy script stub: records what the upgrader handed over, then behaves as FIXTURE_DEPLOY / FIXTURE_ROLLBACK say.
// Its rollback follows rollback_deployment: an upgrade whose code is not restored yet keeps the pointer, marked code-restore.
const deployStub = `#!/usr/bin/env bash
set -u
input=''; IFS= read -r input || true
snapshot="$(cat data/state/deploy-transaction 2>/dev/null || true)"
token=none
if [ -n "\${DEPLOY_TUNNEL_TOKEN_INPUT:-}" ]; then token=other; [ "$DEPLOY_TUNNEL_TOKEN_INPUT" != "$FIXTURE_TOKEN" ] || token=match; fi
printf 'deploy action=%s handoff=%s token=%s receipt=[%s] stdin=%s tty=%s head=%s\\n' "\${DEPLOY_TRANSACTION_ACTION:-}" "\${DEPLOY_TRANSACTION_HANDOFF-unset}" \\
    "$token" "$(cat "$BOT_UPDATE_COMMIT_FILE")" "$input" "$([ -t 0 ] && echo yes || echo no)" "$(git rev-parse --short HEAD)" >> "$FIXTURE_EVENTS"
if [ -n "$snapshot" ]; then
    printf '%s' "$snapshot" > "$FIXTURE_MOCK/snapshot"
    cp "backup/snapshots/$snapshot/transaction" "$FIXTURE_MOCK/record"
    cp "backup/snapshots/$snapshot/migration-plan.json" "$FIXTURE_MOCK/plan" 2>/dev/null || true
fi
mode="\${FIXTURE_DEPLOY:-success}"
[ "\${DEPLOY_TRANSACTION_ACTION:-}" != rollback ] || mode="\${FIXTURE_ROLLBACK:-rollback}"
restore() {
    docker rename mixin-chatbot-rollback mixin-chatbot
    if grep -qx 'was_running=1' "backup/snapshots/$snapshot/transaction"; then docker start mixin-chatbot; fi
    : > "$BOT_UPDATE_COMMIT_FILE"
    if grep -qx "original_sha=$(git rev-parse HEAD)" "backup/snapshots/$snapshot/transaction"; then rm -f data/state/deploy-transaction
    else : > "backup/snapshots/$snapshot/code-restore"; fi
    # A Git lock left behind by another git process makes the following code restore fail.
    [ "\${FIXTURE_INDEX_LOCK:-0}" != 1 ] || : > .git/index.lock
}
case "$mode" in
    success)
        printf 'committed\\n' > "$BOT_UPDATE_COMMIT_FILE"; rm -f data/state/deploy-transaction
        printf 'sha256:new true\\n' > "$FIXTURE_MOCK/containers/mixin-chatbot"; rm -f "$FIXTURE_MOCK/containers/mixin-chatbot-rollback" ;;
    pending) exit 1 ;;
    rollback) restore ;;
    rolled-back) restore; exit 1 ;;
    committed) printf 'committed\\n' > "$BOT_UPDATE_COMMIT_FILE"; rm -f data/state/deploy-transaction; exit 1 ;;
    fail) exit 1 ;;
esac
`;

/**
 * A repository with the real upgrader files and ops.sh at an old and a new commit, a stub target deploy script,
 * the target exported exactly as ops.sh update does, and Docker/flock/pgrep/curl stubs on PATH.
 */
async function upgraderFixture(prefix: string) {
  const f = await tempFixture(prefix), work = join(f.root, "work"), state = join(work, "data/state");
  const bin = join(f.root, "bin"), mock = join(f.root, "mock"), events = join(f.root, "events"), stage = join(work, "tmp/upgrade-fixture");
  const run = async (args: string[], env: Record<string, string> = {}, input?: string) => {
    const stdin = input === undefined ? "ignore" : new Blob([input]);
    const child = Bun.spawn(args, { cwd: work, env: { ...process.env, ...env }, stdin, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 30000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, text: out + err };
    } finally { clearTimeout(timeout); }
  };
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args]); expect(result.code, result.text).toBe(0); return result.text.trim();
  };
  // No MSYS_NO_PATHCONV: Git Bash must translate the POSIX project path for the native git.exe (the stubs are scripts).
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${posix(bin)}:${process.env.PATH}`, FIXTURE_EVENTS: posix(events),
    FIXTURE_MOCK: posix(mock), FIXTURE_WORK: posix(work), FIXTURE_TOKEN: token, ...extra });
  const clearEvents = async () => {
    await rm(events, { force: true }); await rm(join(mock, "record"), { force: true }); await rm(join(mock, "preview-args"), { force: true });
  };
  const upgrade = async (args: string[], extra: Record<string, string> = {}, input?: string) => {
    await clearEvents();
    return run([bash!, posix(join(stage, "scripts/deploy/upgrade.sh")), posix(work), ...args], env(extra), input);
  };
  const ops = async (args: string[], extra: Record<string, string> = {}) => {
    await clearEvents();
    return run([bash!, "scripts/ops/ops.sh", ...args], env(extra));
  };
  const log = async () => existsSync(events) ? (await readFile(events, "utf8")).trim().split("\n").filter(Boolean) : [];
  const record = async () => Object.fromEntries((await readFile(join(mock, "record"), "utf8")).trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const container = (name: string) => readFile(join(mock, "containers", name), "utf8").then(text => text.trim(), () => "absent");
  const reset = async (ref: string, running = true) => {
    await git("reset", "--hard", ref);
    await rm(join(mock, "containers"), { recursive: true, force: true }); await mkdir(join(mock, "containers"), { recursive: true });
    await writeFile(join(mock, "containers/mixin-chatbot"), `sha256:old ${running}\n`);
    await rm(join(state, "deploy-transaction"), { force: true });
  };
  await mkdir(bin, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(join(work, "data/config"), { recursive: true });
  await writeFile(join(bin, "docker"), dockerStub);
  await writeFile(join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(join(bin, "pgrep"), '#!/usr/bin/env bash\n[ "${FIXTURE_UNMANAGED:-0}" = 1 ] && echo 4242\n');
  for (const name of ["docker", "flock", "pgrep"]) await chmod(join(bin, name), 0o755);
  // The fixture repository carries the real upgrader files at both commits and a stub target deploy script.
  for (const path of ["scripts/deploy/upgrade.sh", "scripts/lib", "scripts/migrations", "scripts/ops/ops.sh", "src/core/data-version.ts", "Dockerfile"]) {
    await cp(join(project, path), join(work, path), { recursive: true });
  }
  await writeFile(join(work, "scripts/deploy/deploy.sh"), deployStub);
  await writeFile(join(work, ".gitignore"), "data/\nlogs/\ntmp/\nbackup/\n");
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid"); await git("config", "core.autocrlf", "false");
  await writeFile(join(f.root, "gitignore"), ""); await git("config", "core.excludesFile", join(f.root, "gitignore"));
  // retired.txt exists only in the old commit: restoring it would overwrite an untracked file at that path.
  await writeFile(join(work, "version.txt"), "old"); await writeFile(join(work, "retired.txt"), "old only");
  await git("add", "."); await git("commit", "-m", "old");
  const old = await git("rev-parse", "HEAD");
  await writeFile(join(work, "version.txt"), "new"); await rm(join(work, "retired.txt")); await git("add", "-A"); await git("commit", "-m", "fixture-new");
  const target = await git("rev-parse", "HEAD");
  // Export exactly UPGRADER_EXPORT_PATHS from the target, as ops.sh update does.
  await mkdir(stage, { recursive: true });
  expect((await run([bash!, "-c", `. '${posix(join(project, "scripts/lib/common.sh"))}'; git archive ${target} "\${UPGRADER_EXPORT_PATHS[@]}" | tar -x -C '${posix(stage)}'`], env())).code).toBe(0);
  expect(existsSync(join(stage, "scripts/deploy/deploy.sh"))).toBe(false);
  await writeFile(join(work, "data/config/models.json"), "{}");
  await writeFile(join(state, "bot-port"), "2022"); await writeFile(join(state, "deploy-mode"), "direct"); await writeFile(join(state, "bot-domain"), "Bot.Example.com");
  return { f, work, state, mock, stage, run, git, env, upgrade, ops, log, record, container, reset, old, target };
}

test.skipIf(!bash || !existsSync(bash))("the target upgrader confirms everything before the stop and hands the recorded transaction to the target deploy script", async () => {
  const { f, work, state, mock, stage, run, git, env, upgrade, log, record, container, reset, old, target } = await upgraderFixture("target-upgrader-");
  const short = target.slice(0, 7), oldShort = old.slice(0, 7);
  // Nothing may change when the upgrader stops before the handoff.
  const unchanged = async (old: string, result: { code: number; text: string }) => {
    expect(result.code, result.text).toBe(1);
    expect((await log()).filter(line => /^(stop|rename|deploy)/.test(line)), result.text).toEqual([]);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    expect(await container("mixin-chatbot")).toBe("sha256:old true");
  };
  try {
    const groups = posix(join(work, "data/groups"));

    // A new upgrade: preview in the target's Bun base image with data mounted read-only, record every choice, stop, check out,
    // then hand over to the target deploy script with the snapshot as marker and stdin closed. Terminal overrides are ignored.
    await reset(old);
    let result = await upgrade([target], { BOT_PORT: "9999", DEPLOY_MODE: "cloudflare", GROUP_DATA_ROOT: "/elsewhere", BOT_DEBUG: "1" }, "leftover\n");
    expect(result.code, result.text).toBe(0); expect(result.text).toContain(`升级完成：${oldShort} -> ${short}`);
    expect(result.text).toContain("忽略当前终端的环境变量：BOT_PORT DEPLOY_MODE GROUP_DATA_ROOT BOT_DEBUG");
    expect(result.text).toContain("fixture-new");
    const snapshot = await readFile(join(mock, "snapshot"), "utf8");
    expect(await log()).toEqual([`preview head=${oldShort}`, `stop mixin-chatbot head=${oldShort}`, "rename mixin-chatbot mixin-chatbot-rollback",
      `deploy action=continue handoff=${snapshot} token=none receipt=[] stdin= tty=no head=${short}`]);
    const args = (await readFile(join(mock, "preview-args"), "utf8")).trim().split("\n");
    const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
    expect(mounts).toEqual([`${posix(work)}/data:/app/data:ro`, `${posix(work)}/logs:/app/logs`, `${posix(stage)}:/upgrade:ro`, `${posix(stage)}/preview:/preview`]);
    expect(args.slice(args.indexOf("oven/bun:1.4.2-debian"))).toEqual(["oven/bun:1.4.2-debian", "bun", "--no-install", "/upgrade/scripts/migrations/run.ts",
      "preview", "--decisions-only", "--project", "/app", "--groups", "/app/data/groups", "--scratch", "/preview", "--plan", "/preview/migration-plan.json"]);
    expect(args).toContain("GROUP_DATA_ROOT=/app/data/groups");
    expect(await record()).toEqual({ format: "1", operation: "upgrade", snapshot, target_sha: target, original_sha: old, original_branch: "main",
      original_group_root: groups, target_group_root: groups, was_running: "1", bot_port: "2022", deploy_mode: "direct", bot_domain: "bot.example.com",
      domain_action: "persist", unmanaged_tunnel: "", platform_ip: expect.any(String), reconfigure_ai: "0" });
    expect(await readFile(join(mock, "plan"), "utf8")).toBe('{"format":1,"fixture":"plan"}');
    expect(await git("rev-parse", "HEAD")).toBe(target);
    // The preview runs as the deploying user (root deploys drop to 1001). Rootless Docker maps other UIDs to the
    // subordinate range, which cannot read the deploying user's files; there the container's root is that user.
    const user = (list: string[]) => list[list.indexOf("--user") + 1];
    const root = process.platform !== "win32" && process.getuid!() === 0;
    if (process.platform !== "win32") expect(user(args)).toBe(root ? "1001:1001" : `${process.getuid!()}:${process.getgid!()}`);
    expect(user(args)).not.toBe("0:0");
    await reset(old);
    result = await upgrade([target], { FIXTURE_ROOTLESS: "1" });
    expect(result.code, result.text).toBe(0);
    expect(user((await readFile(join(mock, "preview-args"), "utf8")).trim().split("\n"))).toBe(root ? "1001:1001" : "0:0");
    // Rootless Docker cannot publish a saved privileged port (rootlesskit listens as the deploying user): the upgrade
    // stops before the preview and the stop instead of failing at the container start. Rootful Docker keeps upgrading.
    const kernel = "/proc/sys/net/ipv4/ip_unprivileged_port_start";
    const start = process.platform !== "win32" && existsSync(kernel) ? Number((await readFile(kernel, "utf8")).trim()) : 1024;
    if (start > 1) {
      const low = String(Math.min(1011, start - 1));
      await writeFile(join(state, "bot-port"), low);
      await reset(old);
      result = await upgrade([target], { FIXTURE_ROOTLESS: "1" });
      await unchanged(old, result); expect(await log()).toEqual([]);
      expect(result.text).toContain(`rootless Docker 不能发布低于 ${start} 的端口 ${low}`); expect(result.text).toContain("服务尚未停止");
      result = await upgrade([target]);
      expect(result.code, result.text).toBe(0); expect((await record()).bot_port).toBe(low);
      await writeFile(join(state, "bot-port"), "2022");
    }

    // An external group root is mounted read-only at the service path; a missing base image is pulled first.
    const external = join(f.root, "external groups");
    await mkdir(external); await writeFile(join(state, "group-data-root"), posix(external));
    await reset(old);
    result = await upgrade([target], { FIXTURE_IMAGE: "missing" });
    expect(result.code, result.text).toBe(0);
    expect((await log())[0]).toBe("pull oven/bun:1.4.2-debian");
    const externalArgs = (await readFile(join(mock, "preview-args"), "utf8")).trim().split("\n");
    expect(externalArgs).toContain(`${posix(external)}:/app/group-data:ro`); expect(externalArgs).toContain("/app/group-data");
    expect((await record()).target_group_root).toBe(posix(external));
    // A missing external root stops before anything changes and is never recreated.
    await rm(external, { recursive: true });
    await reset(old);
    result = await upgrade([target]);
    await unchanged(old, result); expect(result.text).toContain("群数据总根不存在"); expect(existsSync(external)).toBe(false);
    // A registered default root is checked the same way: its loss is reported, not hidden behind a new empty directory.
    await writeFile(join(state, "group-data-root"), groups);
    await rm(join(work, "data/groups"), { recursive: true });
    result = await upgrade([target]);
    await unchanged(old, result); expect(result.text).toContain("群数据总根不存在"); expect(existsSync(join(work, "data/groups"))).toBe(false);
    await rm(join(state, "group-data-root"));

    // Refusals before the stop leave code, data and service untouched.
    await reset(old);
    result = await upgrade([target], { FIXTURE_PREVIEW: "fail" });
    await unchanged(old, result); expect(result.text).toContain("迁移预览未完成"); expect(result.text).toContain("服务尚未停止");
    // Decisions (exit 2) cannot be answered by flags through the upgrader; without a terminal it says where to answer them.
    expect(result.text).toContain("迁移选择需要在交互终端中确认");
    // An interrupted preview (ops.sh forwards TERM to the upgrader) removes the named preview container before the
    // upgrader exits, so no Docker CLI or container is left behind. Windows cannot deliver the signal to bash.
    if (process.platform !== "win32") {
      await rm(join(f.root, "events"), { force: true });
      const held = Bun.spawn([bash!, posix(join(stage, "scripts/deploy/upgrade.sh")), posix(work), target],
        { cwd: work, env: { ...process.env, ...env({ FIXTURE_PREVIEW: "hold" }) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      for (let waited = 0; !(await log()).some(line => line.startsWith("preview")) && waited < 20000; waited += 50) await Bun.sleep(50);
      held.kill("SIGTERM");
      const [code, out, err] = await Promise.all([held.exited, new Response(held.stdout).text(), new Response(held.stderr).text()]);
      expect(code, out + err).toBe(143); expect(out + err).toContain("迁移预览已中断并清理");
      expect((await log()).filter(line => !line.startsWith("preview"))).toEqual([expect.stringMatching(/^rm -f mixin-chatbot-preview-[0-9a-f]{12}$/)]);
      expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    }
    result = await upgrade([target], { BOT_MODEL_CACHE_RETENTION: "short" });
    await unchanged(old, result); expect(result.text).toContain("BOT_MODEL_CACHE_RETENTION 已移除");
    await writeFile(join(state, "bot-port"), "abc");
    result = await upgrade([target]);
    await unchanged(old, result); expect(result.text).toContain("端口无效");
    await writeFile(join(state, "bot-port"), "2022");
    await rm(join(work, "data/config/models.json"));
    result = await upgrade([target]);
    await unchanged(old, result); expect(result.text).toContain("缺少 data/config/models.json");
    await writeFile(join(work, "data/config/models.json"), "{}");
    await writeFile(join(work, "version.txt"), "dirty");
    result = await upgrade([target]);
    await unchanged(old, result); expect(result.text).toContain("未提交的改动");
    await git("checkout", "--", "version.txt");
    await writeFile(join(state, "update-transaction"), "legacy");
    result = await upgrade([target]);
    await unchanged(old, result); expect(result.text).toContain("旧版升级留下的停机记录");
    await rm(join(state, "update-transaction"));
    // An unmanaged connector is confirmed before the stop and recorded; declining cancels.
    result = await upgrade([target], { FIXTURE_UNMANAGED: "1" }, "n\n");
    await unchanged(old, result); expect(result.text).toContain("已取消升级");
    await reset(old);
    result = await upgrade([target], { FIXTURE_UNMANAGED: "1" }, "y\n");
    expect(result.code, result.text).toBe(0); expect((await record()).unmanaged_tunnel).toBe("direct");

    // Cloudflare without a connector or saved token: the hidden token is asked before the stop and handed over only in memory.
    await writeFile(join(state, "deploy-mode"), "cloudflare");
    await reset(old);
    result = await upgrade([target], {}, "");
    await unchanged(old, result); expect(result.text).toContain("输入已结束");
    result = await upgrade([target], {}, `${token}\n`);
    expect(result.code, result.text).toBe(0);
    expect((await log()).at(-1)).toMatch(/^deploy action=continue handoff=deploy-\w+ token=match receipt=\[\] stdin= tty=no /);
    expect(result.text).not.toContain(token);
    expect(await readFile(join(mock, "record"), "utf8")).not.toContain(token);
    await writeFile(join(state, "deploy-mode"), "direct");

    // Failures after the handoff: still pending and uncommitted rolls back automatically, then the code is restored.
    await reset(old);
    result = await upgrade([target], { FIXTURE_DEPLOY: "pending" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级失败，已回滚");
    let lines = await log();
    expect(lines.filter(line => line.startsWith("deploy")).map(line => line.split(" ").slice(1, 3).join(" "))).toEqual(["action=continue handoff=" + (await readFile(join(mock, "snapshot"), "utf8")), "action=rollback handoff="]);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(await container("mixin-chatbot")).toBe("sha256:old true");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    // The deploy script rolled back itself: only the code is restored.
    await reset(old);
    result = await upgrade([target], { FIXTURE_DEPLOY: "rolled-back" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级失败，已回滚");
    expect((await log()).filter(line => line.startsWith("deploy"))).toHaveLength(1);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    // Committed data keeps the new code.
    await reset(old);
    result = await upgrade([target], { FIXTURE_DEPLOY: "committed" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("数据已经提交"); expect(await git("rev-parse", "HEAD")).toBe(target);
    // A rollback that fails keeps the target code and the stop for an explicit retry.
    await reset(old);
    result = await upgrade([target], { FIXTURE_DEPLOY: "pending", FIXTURE_ROLLBACK: "fail" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级未能回滚");
    expect(await git("rev-parse", "HEAD")).toBe(target); expect(existsSync(join(state, "deploy-transaction"))).toBe(true);

    // Pending upgrade after the checkout: rollback goes through the target deploy script without a marker, then restores the code.
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
    lines = await log();
    expect(lines[0]).toMatch(new RegExp(`^deploy action=rollback handoff= token=none receipt=\\[\\] stdin= tty=no head=${short}$`));
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(await container("mixin-chatbot")).toBe("sha256:old true");
    // Without a TTY a pending upgrade needs an explicit action; nothing is left to do afterwards.
    result = await upgrade([target, "continue"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("没有未完成的升级");

    // The code restore fails after data, configuration and containers were rolled back: the transaction stays,
    // marked so that only the code is left. Continuing is refused and, without a TTY, rolling back must be explicit.
    await reset(old);
    result = await upgrade([target], { FIXTURE_DEPLOY: "pending", FIXTURE_INDEX_LOCK: "1" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("只恢复代码");
    expect(await git("rev-parse", "HEAD")).toBe(target); expect(await container("mixin-chatbot")).toBe("sha256:old true");
    const marked = await readFile(join(state, "deploy-transaction"), "utf8");
    expect(existsSync(join(work, "backup/snapshots", marked, "code-restore"))).toBe(true);
    result = await upgrade([target, "continue"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("只剩代码待恢复，不能继续");
    result = await upgrade([target]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("只剩代码待恢复；请使用"); expect(result.text).toContain("rollback");
    expect(await log()).toEqual([]);
    // The retry restores only the code (no deploy script, no container change) and clears the transaction afterwards.
    await rm(join(work, ".git/index.lock"));
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
    expect(await log()).toEqual([]);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);

    // Pending upgrade interrupted before the checkout (code still original).
    const interrupted = async () => {
      await reset(old);
      const failed = await upgrade([target], { FIXTURE_DEPLOY: "pending", FIXTURE_ROLLBACK: "fail" });
      expect(failed.code, failed.text).toBe(1);
      await git("reset", "--hard", old);
    };
    await interrupted();
    result = await upgrade([target]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("resume"); expect(result.text).toContain("未完成的升级");
    expect(await log()).toEqual([]);
    // Continue checks out the recorded target and hands over without a marker or token.
    result = await upgrade([target, "continue"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级完成");
    expect(await log()).toEqual([`deploy action=continue handoff= token=none receipt=[] stdin= tty=no head=${short}`]);
    expect(await git("rev-parse", "HEAD")).toBe(target);
    // Rollback before the checkout restores the snapshot and the original container without the deploy script,
    // unless this upgrade's migration already started.
    await interrupted();
    const pending = await readFile(join(state, "deploy-transaction"), "utf8");
    await writeFile(join(state, "migration.json"), `{\n  "deployment": "${pending}"\n}\n`);
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("数据迁移已经开始");
    await rm(join(state, "migration.json"));
    await writeFile(join(state, "bot-port"), "3033");
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(0);
    expect(await log()).toEqual(["rename mixin-chatbot-rollback mixin-chatbot", `start mixin-chatbot head=${oldShort}`]);
    expect(await readFile(join(state, "bot-port"), "utf8")).toBe("2022");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(false); expect(await git("rev-parse", "HEAD")).toBe(old);

    // The upgrader never runs from inside the work tree.
    result = await run([bash!, posix(join(work, "scripts/deploy/upgrade.sh")), posix(work), target], env());
    expect(result.code, result.text).toBe(2); expect(result.text).toContain("导出后运行");

    // The documented one-time bootstrap command performs a complete upgrade from origin/main.
    const origin = join(f.root, "origin.git");
    await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
    await reset(old);
    const bootstrap = await run([bash!, "-c", `. '${posix(join(project, "scripts/lib/common.sh"))}'; upgrade_bootstrap_command`], env());
    expect(bootstrap.code, bootstrap.text).toBe(0);
    result = await run([bash!, "-c", `set -e\n${bootstrap.text.trim()}`], env());
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级完成");
    expect(await git("rev-parse", "HEAD")).toBe(target); expect(existsSync(join(work, "tmp/upgrade-bootstrap"))).toBe(false);
    expect(await readdir(join(work, "tmp"))).toEqual(["upgrade-fixture"]);
  } finally { await f.cleanup(); }
}, 240000);

test.skipIf(!bash || !existsSync(bash))("ops update ignores terminal settings through the post-upgrade check, and ops rollback finishes a failed code restore", async () => {
  const { f, work, state, git, ops, log, container, reset, old, target } = await upgraderFixture("target-upgrader-ops-");
  try {
    const origin = join(f.root, "origin.git");
    await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
    // Upgrading uses only the saved settings, so the health check afterwards runs against the saved port as well
    // (its heading shows the port it probes). Invalid terminal values neither block the entry nor reach the check.
    for (const [port, domain] of [["9999", "other.example.com"], ["invalid", "-invalid-"]] as const) {
      await reset(old);
      const result = await ops(["update"], { BOT_PORT: port, BOT_DOMAIN: domain });
      expect(result.text).toContain("升级完成"); expect(result.text).not.toContain("端口无效"); expect(result.text).not.toContain("域名无效");
      expect(result.text).toContain("健康检查（模式=直连，端口=2022）"); expect(result.text).not.toContain(`端口=${port}`);
      expect(await git("rev-parse", "HEAD")).toBe(target);
    }

    // The code restore fails after the data rollback: the transaction survives, only rolling back is offered.
    await reset(old);
    let result = await ops(["update"], { FIXTURE_DEPLOY: "pending", FIXTURE_INDEX_LOCK: "1" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("只恢复代码");
    expect(await git("rev-parse", "HEAD")).toBe(target); expect(existsSync(join(state, "deploy-transaction"))).toBe(true);
    await rm(join(work, ".git/index.lock"));
    result = await ops(["resume"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("不能继续");
    result = await ops(["update"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("只剩代码待恢复；请使用");
    expect(await log()).toEqual([]);
    // ops rollback restores only the code, without the deploy script or any container change, then clears the transaction.
    result = await ops(["rollback"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
    expect(await log()).toEqual([]);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(await container("mixin-chatbot")).toBe("sha256:old true");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    result = await ops(["rollback"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("没有未完成的部署或升级");
  } finally { await f.cleanup(); }
}, 240000);

test.skipIf(!bash || !existsSync(bash))("rolling back never overwrites changes made after the upgrade: they are listed and the transaction stays", async () => {
  const { f, work, state, git, upgrade, ops, log, container, reset, old, target } = await upgraderFixture("target-upgrader-manual-");
  const pointer = join(state, "deploy-transaction");
  try {
    // A failed automatic rollback leaves the upgrade pending on the target code.
    await reset(old);
    let result = await upgrade([target], { FIXTURE_DEPLOY: "pending", FIXTURE_ROLLBACK: "fail" });
    expect(result.code, result.text).toBe(1); expect(await git("rev-parse", "HEAD")).toBe(target);
    // A tracked edit stops the explicit rollback before the deploy script restores anything.
    await writeFile(join(work, "version.txt"), "hotfix");
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("没有回滚");
    expect(result.text).toContain("未提交的改动： M version.txt");
    expect(await log()).toEqual([]);
    expect(await readFile(join(work, "version.txt"), "utf8")).toBe("hotfix"); expect(existsSync(pointer)).toBe(true);
    await git("checkout", "--", "version.txt");
    // So does an untracked file at a path the original commit tracks.
    await writeFile(join(work, "retired.txt"), "local notes");
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("未跟踪的文件会被升级前的版本覆盖：retired.txt");
    expect(await log()).toEqual([]); expect(await readFile(join(work, "retired.txt"), "utf8")).toBe("local notes");
    await rm(join(work, "retired.txt"));
    result = await upgrade([target, "rollback"]);
    expect(result.code, result.text).toBe(0); expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(pointer)).toBe(false);

    // Only the code is left to restore, and a commit was made on main after the upgrade: the restore stops and keeps
    // the marker. A detached HEAD on the target with main still carrying the commit is refused too (the reset would drop it).
    await reset(old);
    result = await upgrade([target], { FIXTURE_DEPLOY: "pending", FIXTURE_INDEX_LOCK: "1" });
    expect(result.code, result.text).toBe(1);
    await rm(join(work, ".git/index.lock"));
    await writeFile(join(work, "version.txt"), "hotfix"); await git("commit", "-qam", "hotfix");
    const hotfix = await git("rev-parse", "HEAD");
    result = await ops(["rollback"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("代码没有恢复"); expect(result.text).toContain("既不是升级前的");
    expect(await git("rev-parse", "HEAD")).toBe(hotfix); expect(existsSync(pointer)).toBe(true);
    await git("branch", "hotfix", hotfix); await git("checkout", "-q", "--detach", target);
    result = await ops(["rollback"]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain(`分支 main 指向 ${hotfix.slice(0, 7)}`);
    // With the commit kept on its own branch, the same rollback finishes the code restore.
    await git("branch", "-f", "main", target); await git("checkout", "-q", "main");
    result = await ops(["rollback"]);
    expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(await git("rev-parse", "hotfix")).toBe(hotfix);
    expect(existsSync(pointer)).toBe(false); expect(await container("mixin-chatbot")).toBe("sha256:old true");
  } finally { await f.cleanup(); }
}, 240000);
