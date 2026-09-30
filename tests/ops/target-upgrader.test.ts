import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand, scenarioRunner, ScenarioProcesses } from "../helpers/concurrent-scenarios.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const token = "eyJhIjoiZml4dHVyZS1hY2NvdW50IiwidCI6ImZpeHR1cmUifQ";

// Docker stub: containers are files "<image> <running> [<user> [<id>]]" under mock/containers (the user defaults to the
// daemon's mode: 0:0 rootless, 1000:1000 rootful), images are files of their platform and labels under mock/images and
// tags files holding an ID under mock/tags. The preview writes its plan into the /preview mount.
// A bare "docker inspect" also matches the mixin-chatbot image, so the scripts must name the object type.
const dockerStub = `#!/usr/bin/env bash
mock="$FIXTURE_MOCK"
printf '%s\n' "$*" >> "$mock/docker.log"
if [ "$1" = container ]; then shift; elif [ "$1" = inspect ]; then echo "ambiguous docker inspect: $*" >&2; exit 97; fi
current_head() { git -C "$FIXTURE_WORK" rev-parse --short HEAD; }
# Rootless unless the tests run as root: a rootful daemon needs a root operator.
rootless="\${FIXTURE_ROOTLESS:-$([ "$(id -u)" = 0 ] && echo 0 || echo 1)}"
options='[name=seccomp,profile=builtin name=cgroupns]'
[ "$rootless" != 1 ] || options='[name=seccomp,profile=builtin name=rootless name=cgroupns]'
ref_file() { printf '%s/tags/%s' "$mock" "$(printf '%s' "$1" | tr '/:' '__')"; }
resolve() {
    local id="$1"
    if [[ "$id" != sha256:* ]]; then [ -f "$(ref_file "$1")" ] || return 1; id="$(cat "$(ref_file "$1")")"; fi
    [ -f "$mock/images/\${id#sha256:}" ] || return 1
    printf '%s\n' "$id"
}
cmd="$1"; shift
case "$cmd" in
    info)
        case "\${2:-}" in
            '') ;;
            '{{.ID}}') echo "\${FIXTURE_DAEMON:-5eec1de4-4518-46da-a461-80c0866ec11d}" ;;
            '{{.SecurityOptions}}') echo "$options" ;;
            *) printf '%s|%s|overlay2|[[Backing Filesystem extfs]]|%s\n' "$(uname -n)" "$mock/docker-root" "$options" ;;
        esac ;;
    version) echo amd64 ;;
    build)
        iid='' tag='' labels=()
        while [ "$#" -gt 1 ]; do
            case "$1" in
                --iidfile) iid="$2"; shift 2 ;;
                --tag) tag="$2"; shift 2 ;;
                --label) labels+=("\${2#*=}"); shift 2 ;;
                *) shift ;;
            esac
        done
        printf 'build head=%s context=%s\n' "$(current_head)" "$(cat "$1/version.txt")" >> "$FIXTURE_EVENTS"
        [ "\${FIXTURE_BUILD:-ok}" != fail ] || { echo 'fixture build failed' >&2; exit 1; }
        id="sha256:$(printf '%s' "$tag" | sha256sum | cut -c1-64)"
        (IFS='|'; printf 'linux|amd64|%s\n' "\${labels[*]}") > "$mock/images/\${id#sha256:}"
        printf '%s' "$id" > "$(ref_file "$tag")"
        # Changes to the checkout while the image builds, which the check before the stop must notice.
        case "\${FIXTURE_DURING_BUILD:-}" in
            version) printf 'hotfix\\n' > "$FIXTURE_WORK/version.txt" ;;
            deploy) printf '\\n# hotfix\\n' >> "$FIXTURE_WORK/scripts/deploy/deploy.sh" ;;
            branch) git -C "$FIXTURE_WORK" checkout --quiet -b hotfix ;;
            commit) git -C "$FIXTURE_WORK" commit --quiet --allow-empty -m hotfix ;;
            main) git -C "$FIXTURE_WORK" update-ref refs/heads/main "$(git -C "$FIXTURE_WORK" commit-tree 'HEAD^{tree}' -p HEAD -m hotfix)" ;;
            # A local file where the target adds one: switching would overwrite it.
            untracked) mkdir -p "$FIXTURE_WORK/release-notes"; printf 'local' > "$FIXTURE_WORK/release-notes/next.md" ;;
        esac
        # A build that is still running when the upgrader is interrupted; its tag already exists.
        if [ "\${FIXTURE_BUILD:-ok}" = hold ]; then echo "$$" > "$mock/build-pid"; exec sleep 30; fi
        printf '%s\n' "$id" > "$iid" ;;
    image)
        sub="$1"; shift
        case "$sub" in
            inspect)
                format=''; if [ "$1" = --format ]; then format="$2"; fi
                ref="\${!#}"
                id="$(resolve "$ref")" || { echo "Error response from daemon: No such image: $ref" >&2; exit 1; }
                case "$format" in
                    '{{.Id}}'|'') echo "$id" ;;
                    '{{.Id}}|'*) printf '%s|%s\n' "$id" "$(cat "$mock/images/\${id#sha256:}")" ;;
                    *) cut -d'|' -f5 "$mock/images/\${id#sha256:}" ;;
                esac ;;
            rm) rm -f -- "$(ref_file "\${!#}")" ;;
            ls) : ;;
            *) exit 93 ;;
        esac ;;
    tag)
        id="$(resolve "$1")" || { echo "Error response from daemon: No such image: $1" >&2; exit 1; }
        printf '%s' "$id" > "$(ref_file "$2")" ;;
    run)
        preview=''; previous=''
        for arg in "$@"; do
            if [ "$previous" = -v ] && [[ "$arg" == *:/preview ]]; then preview="\${arg%:/preview}"; fi
            previous="$arg"
        done
        # Only the preview is a one-off container of the upgrader; others (the model check after ops update) succeed.
        [ -n "$preview" ] || exit 0
        printf '%s\n' "$@" > "$mock/preview-args"
        printf 'preview head=%s\n' "$(current_head)" >> "$FIXTURE_EVENTS"
        # A preview that waits (for example for migration decisions) until it is removed.
        [ "\${FIXTURE_PREVIEW:-ok}" != hold ] || exec sleep 30
        [ "\${FIXTURE_PREVIEW:-ok}" = ok ] || { echo '迁移预检需要确认后才能继续' >&2; exit 2; }
        # Changes made while the preview runs, which the check before the stop must notice.
        case "\${FIXTURE_DURING_PREVIEW:-}" in
            config) printf '{"changed":true}' > "$FIXTURE_WORK/data/config/models.json" ;;
            container) read -r image running user id < "$mock/containers/mixin-chatbot"
                printf '%s %s %s replaced\n' "$image" "$running" "\${user:-0:0}" > "$mock/containers/mixin-chatbot" ;;
            tag) rm -f "$mock"/tags/mixin-chatbot_candidate-* ;;
            disk) : > "$mock/disk-full" ;;
        esac
        printf '{"format":1,"fixture":"plan"}' > "$preview/migration-plan.json" ;;
    ps) for file in "$mock"/containers/*; do [ -f "$file" ] && basename "$file"; done ;;
    inspect)
        format=''; if [ "$1" = --format ]; then format="$2"; fi
        name="\${!#}"
        [ -f "$mock/containers/$name" ] || { echo "Error: No such container: $name" >&2; exit 1; }
        read -r image running user id < "$mock/containers/$name"
        [ -n "$user" ] || user="$([ "$rootless" = 1 ] && echo 0:0 || echo 1000:1000)"
        case "$format" in
            '{{.Image}}') echo "$image" ;;
            '{{.State.Running}}') echo "$running" ;;
            '{{.State.Status}}') if [ "$running" = true ]; then echo running; else echo exited; fi ;;
            '{{.Config.User}}') echo "$user" ;;
            '{{.Id}}|'*) printf '%s|%s|%s|%s|\n' "\${id:-c0ffee}" "$user" "$image" "\${FIXTURE_DATA_MOUNT:-$FIXTURE_WORK/data}" ;;
        esac ;;
    stop|start)
        name="\${!#}"; read -r image running user id < "$mock/containers/$name"
        if [ "$cmd" = stop ]; then running=false; else running=true; fi
        printf '%s %s %s %s\n' "$image" "$running" "$user" "$id" > "$mock/containers/$name"
        printf '%s %s head=%s\n' "$cmd" "$name" "$(current_head)" >> "$FIXTURE_EVENTS" ;;
    rename) mv -- "$mock/containers/$1" "$mock/containers/$2"; printf 'rename %s %s\n' "$1" "$2" >> "$FIXTURE_EVENTS" ;;
    # More interrupts reach the whole foreground process group (named in mock/group) while the cleanup removes the preview
    # container: the docker client, this stub, must finish all the same.
    rm) if [ "\${FIXTURE_RM_SIGNALS:-0}" = 1 ]; then for signal in INT TERM; do kill -s "$signal" -- "-$(cat "$mock/group")"; done; sleep 0.5; fi
        printf 'rm %s\n' "$*" >> "$FIXTURE_EVENTS" ;;
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
    for sidecar in candidate-image service-user; do cp "backup/snapshots/$snapshot/$sidecar" "$FIXTURE_MOCK/$sidecar" 2>/dev/null || true; done
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
    # Waits, as a migration would, until the upgrader forwards an interrupt as TERM or a hangup reaches it, then rolls back
    # once like the real script. The upgrader's receipt (in its export directory) must still be there meanwhile.
    hold)
        held_rollback() {
            trap '' TERM HUP; kill "$!" 2>/dev/null; sleep 0.3
            [ ! -e "$BOT_UPDATE_COMMIT_FILE" ] || printf 'deploy receipt kept\\n' >> "$FIXTURE_EVENTS"
            restore; exit "$1"
        }
        trap 'held_rollback 143' TERM
        trap 'held_rollback 129' HUP
        printf 'deploy held\\n' >> "$FIXTURE_EVENTS"
        sleep 30 >/dev/null 2>&1 & wait "$!"
        exit 1 ;;
esac
`;

const dfFunction = `() { case " $* " in *" --output=avail "*) if [ -e "$FIXTURE_MOCK/disk-full" ]; then printf 'Avail\\n1024\\n'; \
else printf 'Avail\\n1099511627776\\n'; fi ;; *) command df "$@" ;; esac\n}`;

// The upgrader is Linux-only shell code, and a single run starts about 150 processes: cheap on Linux, 20–45 ms each under
// Git Bash on Windows. The scenarios below are independent, so they run concurrently, at most four at a time, each on its
// own copy of a fixture built once per file (see concurrent-scenarios.ts for budgets and process cleanup). Bun's own
// timeout also counts the wait for a slot and is only a backstop.
const runScenario = scenarioRunner({ slots: 4, budgetMs: 150_000 });
const TEST_BACKSTOP_MS = 600_000;

/**
 * Built once per file: a repository with the real upgrader files and ops.sh at an old and a new commit, a stub target
 * deploy script, the target exported exactly as ops.sh update does, and Docker/flock/pgrep stubs. Scenarios only copy it.
 */
async function buildTemplate() {
  const f = await tempFixture("target-upgrader-template-"), work = join(f.root, "work"), state = join(work, "data/state");
  const bin = join(f.root, "bin"), stage = join(work, "tmp/upgrade-fixture");
  const processes = new ScenarioProcesses();
  try {
    const env = { PATH: `${posix(bin)}:${process.env.PATH}` };
    const git = async (...args: string[]) => {
      const result = await runCommand(processes, work, ["git", ...args]); expect(result.code, result.text).toBe(0); return result.text.trim();
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
    // retired.txt exists only in the old commit: restoring it would overwrite an untracked file at that path. The target
    // adds release-notes/next.md: switching to it would overwrite an untracked file there.
    await writeFile(join(work, "version.txt"), "old"); await writeFile(join(work, "retired.txt"), "old only");
    await git("add", "."); await git("commit", "-m", "old");
    const old = await git("rev-parse", "HEAD");
    await writeFile(join(work, "version.txt"), "new"); await rm(join(work, "retired.txt"));
    await mkdir(join(work, "release-notes")); await writeFile(join(work, "release-notes/next.md"), "new");
    await git("add", "-A"); await git("commit", "-m", "fixture-new");
    const target = await git("rev-parse", "HEAD");
    // Export exactly UPGRADER_EXPORT_PATHS from the target, as ops.sh update does.
    await mkdir(stage, { recursive: true });
    const exported = await runCommand(processes, work, [bash!, "-c", `. '${posix(join(project, "scripts/lib/common.sh"))}'; git archive ${target} "\${UPGRADER_EXPORT_PATHS[@]}" | tar -x -C '${posix(stage)}'`], env);
    expect(exported.code, exported.text).toBe(0);
    expect(existsSync(join(stage, "scripts/deploy/deploy.sh"))).toBe(false);
    await writeFile(join(work, "data/config/models.json"), "{}");
    await writeFile(join(state, "bot-port"), "2022"); await writeFile(join(state, "deploy-mode"), "direct"); await writeFile(join(state, "bot-domain"), "Bot.Example.com");
    // Nothing started while building may still run while the scenarios copy the template.
    await processes.stop();
    return { f, work, bin, old, target };
  } catch (error) {
    await processes.stop(); await f.cleanup();
    throw error;
  }
}

let template: ReturnType<typeof buildTemplate> | undefined;
afterAll(async () => { if (template) await (await template).f.cleanup().catch(() => {}); });

/**
 * One scenario's own copy of the template: repository with .git, exported upgrader, data and logs, stubs, and the
 * stub Docker state under mock/. Every command runs through the scenario's process list.
 */
async function upgraderFixture(prefix: string, processes: ScenarioProcesses) {
  const source = await (template ??= buildTemplate());
  const f = await tempFixture(prefix), work = join(f.root, "work"), state = join(work, "data/state");
  const bin = join(f.root, "bin"), mock = join(f.root, "mock"), events = join(f.root, "events"), stage = join(work, "tmp/upgrade-fixture");
  const { old, target } = source;
  const run = (args: string[], env: Record<string, string> = {}, input?: string) => runCommand(processes, work, args, env, input);
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args]); expect(result.code, result.text).toBe(0); return result.text.trim();
  };
  // No MSYS_NO_PATHCONV: Git Bash must translate the POSIX project path for the native git.exe (the stubs are scripts).
  // The disk checks read df: an exported function (a PATH stub loses to /usr/bin under Git Bash) reports plenty of space,
  // or almost none once mock/disk-full exists. A local unix socket endpoint lets the checks find the daemon's storage.
  // Every command runs in work. Git Bash mounts /tmp on a TEMP directory (the test launcher's fixtures, or the user's),
  // so the work tree can have two POSIX names; without a PWD naming it, bash takes getcwd's /tmp/... form and the scripts
  // would see another project than the stub's container mounts. PWD pins the form the stubs use, for every entry.
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${posix(bin)}:${process.env.PATH}`, PWD: posix(work),
    FIXTURE_EVENTS: posix(events), FIXTURE_MOCK: posix(mock), FIXTURE_WORK: posix(work), FIXTURE_TOKEN: token,
    DOCKER_HOST: "unix:///var/run/docker.sock", "BASH_FUNC_df%%": dfFunction, ...extra });
  const clearEvents = async () => {
    for (const name of ["record", "preview-args", "candidate-image", "service-user", "disk-full"]) await rm(join(mock, name), { force: true });
    await rm(events, { force: true });
  };
  /** Reserved candidate tags left in the stub, and the image the official tag names. */
  const candidateTags = async () => (await readdir(join(mock, "tags")).catch(() => [])).filter(name => name.startsWith("mixin-chatbot_candidate-"));
  const officialTag = () => readFile(join(mock, "tags/mixin-chatbot"), "utf8").catch(() => "absent");
  const sidecar = async (name: string) => Object.fromEntries((await readFile(join(mock, name), "utf8")).trim().split("\n")
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
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
  // The original container runs the old image, which the official tag names; no candidate image or tag is left.
  const reset = async (ref: string, running = true, user = "") => {
    await git("reset", "--hard", ref);
    for (const name of ["containers", "images", "tags", "docker-root"]) {
      await rm(join(mock, name), { recursive: true, force: true }); await mkdir(join(mock, name), { recursive: true });
    }
    await writeFile(join(mock, "containers/mixin-chatbot"), `sha256:old ${running} ${user}\n`);
    await writeFile(join(mock, "images/old"), "linux|amd64||||\n"); await writeFile(join(mock, "tags/mixin-chatbot"), "sha256:old");
    await rm(join(state, "deploy-transaction"), { force: true });
  };
  const fixture = { f, work, state, mock, stage, run, git, env, upgrade, ops, log, record, container, reset, old, target, processes,
    candidateTags, officialTag, sidecar, cleanup: () => f.cleanup() };
  try {
    await cp(source.work, work, { recursive: true }); await cp(source.bin, bin, { recursive: true });
    // The copied Git settings still name the template's exclude file; this copy gets its own.
    await writeFile(join(f.root, "gitignore"), ""); await git("config", "core.excludesFile", join(f.root, "gitignore"));
  } catch (error) { await f.cleanup(); throw error; }
  return fixture;
}
type Fixture = Awaited<ReturnType<typeof upgraderFixture>>;

function scenario(name: string, prefix: string, body: (fx: Fixture) => Promise<void>) {
  test.concurrent.skipIf(!bash || !existsSync(bash))(name, () => runScenario(name, processes => upgraderFixture(prefix, processes), body), TEST_BACKSTOP_MS);
}

/** Nothing may change when the upgrader stops before the handoff. */
function unchangedCheck({ log, git, state, container }: Fixture) {
  return async (old: string, result: { code: number; text: string }) => {
    expect(result.code, result.text).toBe(1);
    expect((await log()).filter(line => /^(stop|rename|deploy)/.test(line)), result.text).toEqual([]);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    // Image and running state; a scenario may have changed the container's identity fields itself.
    expect((await container("mixin-chatbot")).split(" ").slice(0, 2).join(" ")).toBe("sha256:old true");
  };
}

scenario("ops update ignores terminal settings through the post-upgrade check", "target-upgrader-ops-", async fx => {
  const { f, git, ops, reset, old, target } = fx;
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
});

scenario("ops rollback finishes a code restore that failed during ops update, which resume and update refuse", "target-upgrader-ops-restore-", async fx => {
  const { f, work, state, git, ops, log, container, reset, old, target } = fx;
  const origin = join(f.root, "origin.git");
  await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);

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
});

scenario("rolling back never overwrites changes made after the upgrade: tracked edits and untracked files at old paths are listed and the transaction stays", "target-upgrader-manual-", async fx => {
  const { work, state, git, upgrade, log, reset, old, target } = fx;
  const pointer = join(state, "deploy-transaction");
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
});

scenario("restoring only the code stops at a commit made after the upgrade and finishes once that commit is kept on its own branch", "target-upgrader-manual-commit-", async fx => {
  const { work, state, git, upgrade, ops, container, reset, old, target } = fx;
  let result: { code: number; text: string };
  const pointer = join(state, "deploy-transaction");
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
});

scenario("target upgrader: refusals before the stop leave code, data and service untouched; an unmanaged connector is confirmed first", "target-upgrader-refusals-", async fx => {
  const { f, work, state, stage, git, env, upgrade, log, record, reset, candidateTags, old, target, processes } = fx;
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
  // Refusals before the stop leave code, data and service untouched, and release the candidate's reserved tag.
  await reset(old);
  result = await upgrade([target], { FIXTURE_PREVIEW: "fail" });
  await unchanged(old, result); expect(result.text).toContain("迁移预览或配置校验未通过"); expect(result.text).toContain("服务尚未停止");
  expect(await candidateTags()).toEqual([]);
  // Decisions (exit 2) cannot be answered by flags through the upgrader; without a terminal it says where to answer them.
  expect(result.text).toContain("迁移选择需要在交互终端中确认");
  // An interrupted preview (ops.sh forwards TERM to the upgrader) removes the named preview container before the
  // upgrader exits, so no Docker CLI or container is left behind, even when INT and TERM reach its whole process group
  // again during that cleanup; an interrupted build ends only this build's client. Windows cannot deliver the signal to bash.
  if (process.platform !== "win32") {
    // `ready`: a file the stub writes last before it holds (the build logs its event first, then tags and holds).
    const interrupt = async (extra: Record<string, string>, started: string, ready?: string) => {
      await rm(join(f.root, "events"), { force: true });
      if (ready) await rm(ready, { force: true });
      const held = processes.spawn([bash!, posix(join(stage, "scripts/deploy/upgrade.sh")), posix(work), target],
        { cwd: work, env: { ...process.env, ...env(extra) } });
      await writeFile(join(fx.mock, "group"), String(held.pid));
      const holding = async () => (await log()).some(line => line.startsWith(started)) && (!ready || existsSync(ready));
      for (let waited = 0; !(await holding()) && waited < 20000; waited += 50) await Bun.sleep(50);
      held.kill("SIGTERM");
      const [code, { out, err }] = await Promise.all([held.exited, held.output()]);
      expect(code, out + err).toBe(143);
      expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
      expect(await candidateTags()).toEqual([]); expect(await fx.officialTag()).toBe("sha256:old");
      expect(await fx.container("mixin-chatbot")).toBe("sha256:old true");
      return out + err;
    };
    expect(await interrupt({ FIXTURE_PREVIEW: "hold", FIXTURE_RM_SIGNALS: "1" }, "preview")).toContain("迁移预览已中断并清理");
    expect((await log()).filter(line => !/^(build|preview)/.test(line))).toEqual([expect.stringMatching(/^rm -f mixin-chatbot-preview-[0-9a-f]{12}$/)]);
    // The build's tag exists before its ID is known: it is claimed by the operation label and released.
    expect(await interrupt({ FIXTURE_BUILD: "hold" }, "build", join(fx.mock, "build-pid"))).toContain("镜像构建已中断");
    expect((await log()).filter(line => !line.startsWith("build"))).toEqual([]);
    const client = Number(await readFile(join(fx.mock, "build-pid"), "utf8"));
    const alive = () => { try { process.kill(client, 0); return true; } catch { return false; } };
    for (let waited = 0; alive() && waited < 5000; waited += 50) await Bun.sleep(50);
    expect(alive()).toBe(false);
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
});

// ops.sh starts the upgrader in the background, so the upgrader ignores the INT of a Ctrl+C and gets it from ops.sh
// as TERM, also after the build ran in its own process group. Before the pointer the preview container and this
// upgrade's reserved tag are removed, even when more interrupts arrive during that cleanup; after the handoff the
// upgrader forwards the interrupt to the deploy script, waits for its rollback and restores the code. On a hangup
// ops.sh, too, waits for the upgrader before it removes the export directory with the upgrader's receipt. Windows
// cannot deliver the signals.
scenario("ops update interrupted by Ctrl+C, TERM or a hangup cleans up before the stop and rolls back after the handoff", "target-upgrader-ops-cancel-", async fx => {
  if (process.platform === "win32") return;
  const { f, work, mock, state, git, env, log, container, reset, candidateTags, processes, old, target } = fx;
  const origin = join(f.root, "origin.git");
  await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
  const interrupt = async (signal: "group" | "hangup" | "ops", started: string, extra: Record<string, string>) => {
    await reset(old); await rm(join(f.root, "events"), { force: true });
    const held = processes.spawn([bash!, "scripts/ops/ops.sh", "update"], { cwd: work, env: { ...process.env, ...env(extra) } });
    // ops.sh leads its own process group, as the foreground job of a terminal would.
    await writeFile(join(mock, "group"), String(held.pid));
    for (let waited = 0; !(await log()).some(line => line.startsWith(started)) && waited < 20000; waited += 50) await Bun.sleep(50);
    if (signal === "ops") held.kill("SIGTERM"); else process.kill(-held.pid, signal === "group" ? "SIGINT" : "SIGHUP");
    const [code, { out, err }] = await Promise.all([held.exited, held.output()]);
    expect(code, out + err).not.toBe(0);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    expect((await readdir(join(work, "tmp"))).filter(name => name.startsWith("upgrade-") && name !== "upgrade-fixture")).toEqual([]);
    expect(await container("mixin-chatbot")).toBe("sha256:old true"); expect(await fx.officialTag()).toBe("sha256:old");
    return out + err;
  };
  for (const [signal, extra] of [["group", {}], ["ops", {}], ["ops", { FIXTURE_RM_SIGNALS: "1" }]] as const) {
    expect(await interrupt(signal, "preview", { FIXTURE_PREVIEW: "hold", ...extra })).toContain("迁移预览已中断并清理");
    expect((await log()).filter(line => !/^(build|preview)/.test(line))).toEqual([expect.stringMatching(/^rm -f mixin-chatbot-preview-[0-9a-f]{12}$/)]);
    expect(await candidateTags()).toEqual([]);
  }
  // The stub deploy script's rollback does not release the reserved tag; the real one does (deployment.test.ts).
  for (const signal of ["group", "hangup", "ops"] as const) {
    expect(await interrupt(signal, "deploy held", { FIXTURE_DEPLOY: "hold" })).toContain("升级失败，已回滚");
    expect(await container("mixin-chatbot")).toBe("sha256:old true");
    expect((await log()).filter(line => /^(deploy|rename|start)/.test(line))).toEqual(["rename mixin-chatbot mixin-chatbot-rollback",
      expect.stringMatching(/^deploy action=continue /), "deploy held", "deploy receipt kept", "rename mixin-chatbot-rollback mixin-chatbot",
      `start mixin-chatbot head=${target.slice(0, 7)}`]);
  }
});

scenario("target upgrader: the operator is checked before any question and the service identity before any build; an unclear identity is refused", "target-upgrader-identity-", async fx => {
  const { mock, upgrade, log, reset, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  const root = process.platform !== "win32" && process.getuid!() === 0;
  let result: { code: number; text: string };
  // A rootful daemon needs root and a rootless one its own user: refused before any question, build or change.
  await reset(old);
  result = await upgrade([target], { FIXTURE_ROOTLESS: root ? "1" : "0", FIXTURE_UNMANAGED: "1" }, "y\n");
  await unchanged(old, result); expect(await log()).toEqual([]); expect(result.text).not.toContain("?>");
  expect(result.text).toContain(root ? "rootless 模式" : "sudo scripts/ops/ops.sh update");
  // The service identity comes from the original container, checked before anything else; an unclear one is refused.
  const refusedIdentity = async (message: string, extra: Record<string, string> = {}) => {
    const refused = await upgrade([target], extra);
    expect(refused.code, refused.text).toBe(1); expect(await log()).toEqual([]); expect(refused.text).toContain(message);
    expect(refused.text).toContain("服务和数据未改动");
  };
  await reset(old, true, "appuser");
  await refusedIdentity("不是数值 UID:GID（appuser）");
  await reset(old, true, root ? "0:0" : "1000:1000");
  await refusedIdentity(root ? "rootful Docker 下服务不应以 root（0:0）运行" : "rootless Docker 下服务应以映射为部署用户的 0:0 运行");
  await reset(old);
  await refusedIdentity("不是本项目的", { FIXTURE_DATA_MOUNT: "/elsewhere/data" });
  await rm(join(mock, "containers/mixin-chatbot"));
  await refusedIdentity("找不到原容器 mixin-chatbot");
});

scenario("target upgrader: a failed build, too little disk space or any input changed after the preview stops before the stop", "target-upgrader-recheck-", async fx => {
  const { work, mock, upgrade, log, reset, candidateTags, officialTag, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
  // A failed build and a disk too small to build stop before the preview; nothing is tagged or changed.
  await reset(old);
  result = await upgrade([target], { FIXTURE_BUILD: "fail" });
  await unchanged(old, result); expect(result.text).toContain("镜像构建失败");
  expect(await log()).toEqual([`build head=${old.slice(0, 7)} context=new`]); expect(await candidateTags()).toEqual([]);
  // (upgrade() clears mock/disk-full, so this run starts the upgrader directly.)
  await rm(join(fx.f.root, "events"), { force: true }); await writeFile(join(mock, "disk-full"), "");
  result = await fx.run([bash!, posix(join(fx.stage, "scripts/deploy/upgrade.sh")), posix(work), target], fx.env());
  await unchanged(old, result); expect(result.text).toContain("磁盘空间不足"); expect(result.text).toContain("需要");
  expect(await log()).toEqual([]);
  // The checkout must stay as it was checked when the upgrade started. Changes made while the image builds stop the upgrade
  // before the stop: an edit to a file the target also changes, one the fast-forward would keep (the deploy script that
  // runs after the stop), another branch, a new commit, and main moving while a detached HEAD is upgraded (confirmed).
  for (const change of ["version", "deploy", "branch", "commit", "main"]) {
    await reset(old);
    if (change === "main") await fx.git("checkout", "--quiet", "--detach");
    result = await upgrade([target], { FIXTURE_DURING_BUILD: change }, change === "main" ? "y\n" : undefined);
    expect(result.code, result.text).toBe(1); expect(result.text, change).toContain("升级开始后检出发生了变化");
    expect((await log()).filter(line => !/^(build|preview) /.test(line)), change).toEqual([]);
    expect(await candidateTags()).toEqual([]); expect(existsSync(join(fx.state, "deploy-transaction"))).toBe(false);
    expect(await fx.container("mixin-chatbot")).toBe("sha256:old true");
    if (change === "branch") { await fx.git("checkout", "--quiet", "main"); await fx.git("branch", "--quiet", "-D", "hotfix"); }
    if (change === "main") await fx.git("checkout", "--quiet", "main");
  }
  // Anything that changes between the preview and the stop stops the upgrade before the stop; the reserved tag is released.
  for (const [change, message] of [["config", "预览之后配置或版本标记发生了变化"], ["container", "原容器 mixin-chatbot 在准备期间被删除、替换或改动"],
    ["tag", "候选镜像核对未通过"], ["disk", "剩余空间不够写入停机后的快照"]] as const) {
    await reset(old);
    result = await upgrade([target], { FIXTURE_DURING_PREVIEW: change });
    await unchanged(old, result); expect(result.text, change).toContain(message);
    expect(await log()).toEqual([`build head=${old.slice(0, 7)} context=new`, `preview head=${old.slice(0, 7)}`]);
    expect(await candidateTags()).toEqual([]); expect(await officialTag()).toBe("sha256:old");
    await writeFile(join(work, "data/config/models.json"), "{}");
  }
});

// The switch after the stop (checkout main, then fast-forward) would stop at local files on paths the target or the
// intermediate main adds, or overwrite ignored ones. They are listed before the build, again before the stop (files may
// appear while the image builds), and before a resumed upgrade stops the service. The upgrader never moves or rewrites
// them and leaves the index as it was.
scenario("target upgrader: untracked files on the switch route through main are refused before the build, before the stop and before a resumed upgrade stops the service", "target-upgrader-untracked-", async fx => {
  const { work, state, stage, mock, git, upgrade, log, reset, container, candidateTags, old, target } = fx;
  const notes = join(work, "release-notes/next.md"), pointer = join(state, "deploy-transaction");
  const oldShort = old.slice(0, 7);
  let result: { code: number; text: string };
  /** Refused with the service, the code, the index and the operator's files as they were. */
  const refused = async (head: string, files: Record<string, string>, index: string) => {
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级不移动、不删除这些文件");
    expect(await git("rev-parse", "HEAD")).toBe(head); expect(await git("ls-files", "--stage")).toBe(index);
    expect(existsSync(join(work, ".git/index.lock"))).toBe(false); expect(existsSync(join(stage, "switch-index"))).toBe(false);
    for (const [path, content] of Object.entries(files)) expect(await readFile(join(work, path), "utf8")).toBe(content);
    expect(await candidateTags()).toEqual([]);
  };
  // Before the build: a local file where the target adds one.
  await reset(old);
  let index = await git("ls-files", "--stage");
  await mkdir(join(work, "release-notes")); await writeFile(notes, "local notes");
  result = await upgrade([target]);
  await refused(old, { "release-notes/next.md": "local notes" }, index);
  expect(result.text).toContain("  - 未跟踪的文件会被目标版本覆盖：release-notes/next.md"); expect(result.text).toContain("服务尚未停止，未构建镜像");
  expect(await log()).toEqual([]); expect(await container("mixin-chatbot")).toBe("sha256:old true"); expect(existsSync(pointer)).toBe(false);
  await rm(join(work, "release-notes"), { recursive: true });

  // From a detached HEAD the switch checks out main first: a file only main adds (the target removes it again) is listed,
  // although switching straight to the target would keep it. Once it is moved away the same upgrade completes and keeps
  // the operator's other files.
  await reset(old);
  await git("checkout", "-q", "--detach", old);
  await writeFile(join(work, "mid.txt"), "main"); await git("add", "mid.txt"); await git("commit", "-qm", "mid");
  const mid = await git("rev-parse", "HEAD");
  const next = await git("commit-tree", `${target}^{tree}`, "-p", mid, "-m", "fixture-new");
  await git("checkout", "-q", "--detach", old); await git("update-ref", "refs/heads/main", mid);
  index = await git("ls-files", "--stage");
  await writeFile(join(work, "mid.txt"), "local mid"); await writeFile(join(work, "operator.txt"), "kept");
  result = await upgrade([next], {}, "y\n");
  await refused(old, { "mid.txt": "local mid", "operator.txt": "kept" }, index);
  expect(result.text).toContain(`切换代码（当前 ${oldShort} -> main ${mid.slice(0, 7)} -> 目标 ${next.slice(0, 7)}）`);
  expect(result.text).toContain("  - 未跟踪的文件会被切换途经的 main 分支覆盖：mid.txt"); expect(result.text).not.toContain("release-notes");
  expect(await log()).toEqual([]); expect(await git("rev-parse", "main")).toBe(mid);
  await rm(join(work, "mid.txt"));
  result = await upgrade([next], {}, "y\n");
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级完成");
  expect(await git("rev-parse", "HEAD")).toBe(next); expect(await git("rev-parse", "main")).toBe(next);
  expect(await readFile(join(work, "operator.txt"), "utf8")).toBe("kept"); expect(existsSync(join(work, "mid.txt"))).toBe(false);
  await rm(join(work, "operator.txt"));

  // A file that appears while the image builds is found by the check before the stop.
  await reset(old);
  index = await git("ls-files", "--stage");
  result = await upgrade([target], { FIXTURE_DURING_BUILD: "untracked" });
  await refused(old, { "release-notes/next.md": "local" }, index);
  expect(result.text).toContain("准备期间工作区出现了切换代码会覆盖的未跟踪内容");
  expect(result.text).toContain("  - 未跟踪的文件会被目标版本覆盖：release-notes/next.md");
  expect(await log()).toEqual([`build head=${oldShort} context=new`, `preview head=${oldShort}`]);
  expect(await container("mixin-chatbot")).toBe("sha256:old true"); expect(existsSync(pointer)).toBe(false);
  await rm(join(work, "release-notes"), { recursive: true });

  // Resumed after the pointer was published but before the stop (the service still runs): the switch is checked before
  // the service is stopped, for local files and for a main that no longer fast-forwards to the target.
  await reset(old);
  const failed = await upgrade([target], { FIXTURE_DEPLOY: "pending", FIXTURE_ROLLBACK: "fail" });
  expect(failed.code, failed.text).toBe(1); expect(existsSync(pointer)).toBe(true);
  await git("reset", "--hard", old);
  await rm(join(mock, "containers/mixin-chatbot-rollback")); await writeFile(join(mock, "containers/mixin-chatbot"), "sha256:old true\n");
  index = await git("ls-files", "--stage");
  await mkdir(join(work, "release-notes")); await writeFile(notes, "local notes");
  result = await upgrade([target, "continue"]);
  expect(result.text).toContain("不能切换到目标提交"); expect(result.text).toContain("服务和代码保持现状");
  expect(result.text).toContain("  - 未跟踪的文件会被目标版本覆盖：release-notes/next.md");
  expect(await log()).toEqual([]); expect(await container("mixin-chatbot")).toBe("sha256:old true"); expect(existsSync(pointer)).toBe(true);
  expect(result.code, result.text).toBe(1); expect(await git("rev-parse", "HEAD")).toBe(old); expect(await git("ls-files", "--stage")).toBe(index);
  expect(await readFile(notes, "utf8")).toBe("local notes"); expect(existsSync(join(work, ".git/index.lock"))).toBe(false);
  await rm(join(work, "release-notes"), { recursive: true });
  await git("checkout", "-q", "--detach", old);
  const side = await git("commit-tree", `${old}^{tree}`, "-p", old, "-m", "side");
  await git("update-ref", "refs/heads/main", side);
  result = await upgrade([target, "continue"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain(`本地 main（${side.slice(0, 7)}）无法快进到目标提交`);
  expect(await log()).toEqual([]); expect(await container("mixin-chatbot")).toBe("sha256:old true");
  await git("update-ref", "refs/heads/main", old); await git("checkout", "-q", "main");
  // Nothing in the way: the resumed upgrade stops the service, switches and hands over.
  result = await upgrade([target, "continue"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级完成");
  expect(await log()).toEqual([`stop mixin-chatbot head=${oldShort}`, `deploy action=continue handoff= token=none receipt=[] stdin= tty=no head=${target.slice(0, 7)}`]);
  expect(await git("rev-parse", "HEAD")).toBe(target);
});

scenario("target upgrader: failures after the handoff roll back automatically, committed data keeps the new code, and a failed rollback waits for an explicit one", "target-upgrader-failures-", async fx => {
  const { state, mock, git, upgrade, log, container, reset, old, target } = fx;
  const short = target.slice(0, 7);
  let result: { code: number; text: string };
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
});

scenario("target upgrader: an upgrade interrupted before the checkout continues on the recorded target or rolls back without the deploy script", "target-upgrader-interrupted-", async fx => {
  const { state, git, upgrade, log, reset, old, target } = fx;
  const short = target.slice(0, 7);
  const oldShort = old.slice(0, 7);
  let result: { code: number; text: string };
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
  // Continue does not switch a checkout with changes to tracked files: the fast-forward would keep them, and the deploy
  // script that runs next would not be the target's.
  await writeFile(join(fx.work, "scripts/deploy/deploy.sh"), "# hotfix\n", { flag: "a" });
  result = await upgrade([target, "continue"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("已跟踪文件有未提交的改动，不切换代码");
  expect(result.text).toContain("scripts/deploy/deploy.sh"); expect(await log()).toEqual([]);
  expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(true);
  await git("checkout", "--", "scripts/deploy/deploy.sh");
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
  // Recovery reads the recorded image first: on another Docker daemon it refuses both ways before touching any container.
  for (const action of ["continue", "rollback"]) {
    result = await upgrade([target, action], { FIXTURE_DAEMON: "feb63570-4e9c-4408-bcc5-f4ddbfad1aa3" });
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("Docker daemon 与开始事务时不同"); expect(await log()).toEqual([]);
  }
  await writeFile(join(state, "bot-port"), "3033");
  result = await upgrade([target, "rollback"]);
  expect(result.code, result.text).toBe(0);
  expect(await log()).toEqual(["rename mixin-chatbot-rollback mixin-chatbot", `start mixin-chatbot head=${oldShort}`]);
  expect(await readFile(join(state, "bot-port"), "utf8")).toBe("2022");
  expect(existsSync(join(state, "deploy-transaction"))).toBe(false); expect(await git("rev-parse", "HEAD")).toBe(old);
  // The completed rollback released the candidate's reserved tag, and the official tag still names the old image.
  expect(await fx.candidateTags()).toEqual([]); expect(await fx.officialTag()).toBe("sha256:old");
  // A candidate image removed meanwhile (for example by image prune -a) cannot be rebuilt in its place: continuing is
  // refused, while a rollback that never reached the migration needs no candidate and restores the original container.
  await interrupted();
  await rm(join(fx.mock, "images"), { recursive: true }); await mkdir(join(fx.mock, "images"));
  await writeFile(join(fx.mock, "images/old"), "linux|amd64||||\n");
  result = await upgrade([target, "continue"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("重新构建的镜像不能代替"); expect(await log()).toEqual([]);
  result = await upgrade([target, "rollback"]);
  expect(result.code, result.text).toBe(0); expect(await git("rev-parse", "HEAD")).toBe(old);
  expect(await fx.container("mixin-chatbot")).toBe("sha256:old true");
  // Interrupted after the pointer was published but before the stop, so the service still runs: the rollback stops it,
  // restores the snapshot and starts the original container again, clears the transaction and releases the reserved tag.
  await interrupted();
  await rm(join(fx.mock, "containers/mixin-chatbot-rollback")); await writeFile(join(fx.mock, "containers/mixin-chatbot"), "sha256:old true\n");
  expect(await fx.candidateTags()).toHaveLength(1);
  result = await upgrade([target, "rollback"]);
  expect(result.code, result.text).toBe(0);
  expect(await log()).toEqual([`stop mixin-chatbot head=${oldShort}`, "rename mixin-chatbot mixin-chatbot-rollback",
    "rename mixin-chatbot-rollback mixin-chatbot", `start mixin-chatbot head=${oldShort}`]);
  expect(await fx.container("mixin-chatbot")).toBe("sha256:old true"); expect(await fx.container("mixin-chatbot-rollback")).toBe("absent");
  expect(existsSync(join(state, "deploy-transaction"))).toBe(false); expect(await git("rev-parse", "HEAD")).toBe(old);
  expect(await fx.candidateTags()).toEqual([]); expect(await fx.officialTag()).toBe("sha256:old");
});

// Interrupts reach the upgrader's whole process group, as a terminal's Ctrl+C and hangup do, while it restores the code:
// in the rollback before the handoff (after a TERM during the checkout) and after the deploy script has rolled back. Git
// hooks send them at those points; git and the hooks run on and the code is restored. A hangup while the deploy script
// runs is forwarded like TERM: the deploy script rolls back, then the upgrader restores the code. Windows cannot deliver
// the signals to bash.
scenario("target upgrader: interrupts reaching its process group while it restores the code, and a hangup after the handoff, still roll back completely", "target-upgrader-checkout-signal-", async fx => {
  if (process.platform === "win32") return;
  const { f, work, mock, state, stage, git, env, log, container, reset, candidateTags, processes, old, target } = fx;
  const hooks = join(f.root, "hooks"), group = posix(join(mock, "group")), merged = posix(join(mock, "merged"));
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "post-merge"), `#!/usr/bin/env bash\n: > '${merged}'\n[ "\${FIXTURE_MERGE_TERM:-0}" != 1 ] || kill -TERM "$(cat '${group}')"\n`);
  await writeFile(join(hooks, "post-checkout"), `#!/usr/bin/env bash\n[ -f '${merged}' ] || exit 0\nrm -f '${merged}'\n` +
    `for signal in INT TERM HUP; do kill -s $signal -- "-$(cat '${group}')"; done\nsleep 0.5\n`);
  for (const name of ["post-merge", "post-checkout"]) await chmod(join(hooks, name), 0o755);
  await git("config", "core.hooksPath", posix(hooks));
  const upgrade = async (extra: Record<string, string>, hangupAfter?: string) => {
    await reset(old); await rm(join(f.root, "events"), { force: true });
    const held = processes.spawn([bash!, posix(join(stage, "scripts/deploy/upgrade.sh")), posix(work), target], { cwd: work, env: { ...process.env, ...env(extra) } });
    // The upgrader leads its own process group, as the foreground job of a terminal would.
    await writeFile(join(mock, "group"), String(held.pid));
    if (hangupAfter) {
      for (let waited = 0; !(await log()).includes(hangupAfter) && waited < 20000; waited += 50) await Bun.sleep(50);
      process.kill(-held.pid, "SIGHUP");
    }
    const [code, { out, err }] = await Promise.all([held.exited, held.output()]);
    const text = out + err;
    expect(existsSync(join(mock, "merged")), text).toBe(false);
    expect(await git("rev-parse", "HEAD"), text).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    expect(await container("mixin-chatbot")).toBe("sha256:old true"); expect(await container("mixin-chatbot-rollback")).toBe("absent");
    return { code, text };
  };
  let result = await upgrade({ FIXTURE_MERGE_TERM: "1" });
  expect(result.code, result.text).toBe(143); expect(result.text).toContain("已恢复配置、容器、网络入口和原运行状态");
  expect((await log()).filter(line => !/^(build|preview)/.test(line))).toEqual([
    `stop mixin-chatbot head=${old.slice(0, 7)}`, "rename mixin-chatbot mixin-chatbot-rollback",
    "rename mixin-chatbot-rollback mixin-chatbot", `start mixin-chatbot head=${old.slice(0, 7)}`]);
  expect(await candidateTags()).toEqual([]);
  result = await upgrade({ FIXTURE_DEPLOY: "rolled-back" });
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级失败，已回滚");
  result = await upgrade({ FIXTURE_DEPLOY: "hold" }, "deploy held");
  expect(result.code, result.text).toBe(129); expect(result.text).toContain("升级失败，已回滚");
  await git("config", "--unset", "core.hooksPath");
});

// The first upgrade to a version with candidate images starts from 98f1b4a: its recovery entry (ops.sh resume/rollback,
// and the TUI that shows the transaction and runs them) reads the record with the checked-out old code and exports the
// target's upgrader by its own UPGRADER_EXPORT_PATHS. The history must include that commit (CI checks out fetch-depth 0).
const LEGACY_ENTRY = "98f1b4a94575ebeb0f4653e221ad6c701a00598e";
const LEGACY_PATHS = ["scripts/ops/ops.sh", "scripts/lib", "scripts/ops/tui/transaction.ts", "scripts/ops/tui/platform.ts", "src/core/data-version.ts"];

/**
 * A commit after the fixture's old one whose recovery entry and libraries are those of 98f1b4a, and after it a target
 * with the fixture target's tree, so that main fast-forwards to it.
 */
async function legacyCommits({ run, git, work, reset, old, target, processes }: Fixture) {
  const available = await runCommand(processes, project, ["git", "cat-file", "-e", `${LEGACY_ENTRY}^{commit}`]);
  expect(available.code, `需要包含 ${LEGACY_ENTRY} 的 git 历史（CI 的 checkout 使用 fetch-depth: 0）`).toBe(0);
  await reset(old);
  await rm(join(work, "scripts/lib"), { recursive: true });
  const exported = await run([bash!, "-c", `git -C '${posix(project)}' archive ${LEGACY_ENTRY} ${LEGACY_PATHS.join(" ")} | tar -x -C .`]);
  expect(exported.code, exported.text).toBe(0);
  await git("add", "-A"); await git("commit", "-m", "legacy entry");
  const legacy = await git("rev-parse", "HEAD");
  return { legacy, next: await git("commit-tree", `${target}^{tree}`, "-p", legacy, "-m", "fixture-new") };
}

/** What the old TUI's maintenance view reads to offer continuing or rolling back. */
async function legacyTui({ run, work }: Fixture) {
  const module = JSON.stringify(pathToFileURL(join(work, "scripts/ops/tui/transaction.ts")).href);
  const result = await run([process.execPath, "-e", `const { loadPendingTransaction: load } = await import(${module}); const p = load();
    console.log(JSON.stringify(p && { operation: p.operation, target: p.targetSha, committed: p.committed, restore: p.codeRestorePending }));`]);
  expect(result.code, result.text).toBe(0);
  return JSON.parse(result.text.trim().split("\n").pop()!);
}

scenario("first transition: the 98f1b4a recovery entry continues or rolls back an upgrade the new upgrader left before the checkout", "target-upgrader-legacy-", async fx => {
  const { state, git, upgrade, ops, log } = fx;
  const { legacy, next } = await legacyCommits(fx);
  // The new upgrader published the pointer and stopped the service; the code is still the old one.
  const interrupted = async () => {
    await fx.reset(legacy);
    const failed = await upgrade([next], { FIXTURE_DEPLOY: "pending", FIXTURE_ROLLBACK: "fail" });
    expect(failed.code, failed.text).toBe(1);
    expect(existsSync(join(state, "deploy-transaction")), failed.text).toBe(true);
    await git("reset", "--hard", legacy);
    expect(await legacyTui(fx)).toEqual({ operation: "upgrade", target: next, committed: false, restore: false });
  };
  await interrupted();
  // The TUI runs the old ops.sh; it exports the target's upgrader, which continues with the recorded image.
  let result = await ops(["resume"], { MIXIN_OPS_TUI: "1" });
  expect(result.text).toContain("升级完成");
  expect(await log()).toEqual([`deploy action=continue handoff= token=none receipt=[] stdin= tty=no head=${next.slice(0, 7)}`]);
  expect(await git("rev-parse", "HEAD")).toBe(next); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
  await interrupted();
  result = await ops(["rollback"], { MIXIN_OPS_TUI: "1" });
  expect(result.code, result.text).toBe(0);
  expect(await log()).toEqual(["rename mixin-chatbot-rollback mixin-chatbot", `start mixin-chatbot head=${legacy.slice(0, 7)}`]);
  expect(await git("rev-parse", "HEAD")).toBe(legacy); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
  expect(await fx.candidateTags()).toEqual([]); expect(await fx.officialTag()).toBe("sha256:old");
  expect(await fx.container("mixin-chatbot")).toBe("sha256:old true");
});

scenario("first transition: the 98f1b4a recovery entry finishes a rollback whose code was restored before the pointer was cleared", "target-upgrader-legacy-restore-", async fx => {
  const { work, state, git, upgrade, ops, log } = fx;
  const { legacy, next } = await legacyCommits(fx);
  // The data, configuration and container were rolled back and the code restore failed; then the old code came back
  // without the pointer being cleared.
  await fx.reset(legacy);
  const failed = await upgrade([next], { FIXTURE_DEPLOY: "pending", FIXTURE_INDEX_LOCK: "1" });
  expect(failed.code, failed.text).toBe(1); expect(failed.text).toContain("只恢复代码");
  await rm(join(work, ".git/index.lock")); await git("reset", "--hard", legacy);
  expect(await legacyTui(fx)).toEqual({ operation: "upgrade", target: next, committed: false, restore: true });
  let result = await ops(["resume"], { MIXIN_OPS_TUI: "1" });
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("不能继续");
  result = await ops(["rollback"], { MIXIN_OPS_TUI: "1" });
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
  expect(await log()).toEqual([]);
  expect(await git("rev-parse", "HEAD")).toBe(legacy); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
  expect(await fx.container("mixin-chatbot")).toBe("sha256:old true");
});

scenario("target upgrader: a new upgrade builds the target once, previews in that image as the original service identity, records every choice before the stop and hands over with stdin closed; low ports under rootless", "target-upgrader-new-", async fx => {
  const { work, state, mock, stage, git, upgrade, log, record, reset, candidateTags, officialTag, sidecar, old, target } = fx;
  const short = target.slice(0, 7);
  const oldShort = old.slice(0, 7);
  const groups = posix(join(work, "data/groups"));
  const unchanged = unchangedCheck(fx);
  // Non-root test runs see a rootless daemon, whose service runs as the mapped 0:0. Root runs see a rootful daemon and an
  // instance deployed by a docker group user: its 1000:1000 is kept, not replaced by the image's 1001.
  const root = process.platform !== "win32" && process.getuid!() === 0;
  const identity = root ? "1000:1000" : "0:0";
  // A new upgrade builds the target commit (not the work tree, still at the old commit) once before the stop, previews in
  // that image with data mounted read-only, records every choice with the image and the identity, stops, checks out, then
  // hands over to the target deploy script with the snapshot as marker and stdin closed. Terminal overrides are ignored.
  await reset(old);
  let result = await upgrade([target], { BOT_PORT: "9999", DEPLOY_MODE: "cloudflare", GROUP_DATA_ROOT: "/elsewhere", BOT_DEBUG: "1" }, "leftover\n");
  expect(result.code, result.text).toBe(0); expect(result.text).toContain(`升级完成：${oldShort} -> ${short}`);
  expect(result.text).toContain("忽略当前终端的环境变量：BOT_PORT DEPLOY_MODE GROUP_DATA_ROOT BOT_DEBUG");
  expect(result.text).toContain("fixture-new");
  const snapshot = await readFile(join(mock, "snapshot"), "utf8");
  expect(await log()).toEqual([`build head=${oldShort} context=new`, `preview head=${oldShort}`, `stop mixin-chatbot head=${oldShort}`,
    "rename mixin-chatbot mixin-chatbot-rollback", `deploy action=continue handoff=${snapshot} token=none receipt=[] stdin= tty=no head=${short}`]);
  const candidate = await sidecar("candidate-image");
  expect(candidate).toEqual({ format: "1", source: "commit", target_sha: target, image_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    image_tag: expect.stringMatching(/^mixin-chatbot:candidate-[0-9a-f]{12}-[0-9a-f]{16}$/), daemon_id: "5eec1de4-4518-46da-a461-80c0866ec11d",
    project_id: expect.stringMatching(/^[0-9a-f]{12}$/), operation_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
  expect(await sidecar("service-user")).toEqual({ format: "1", user: identity, source: "container" });
  // The reserved tag keeps the candidate until the deploy script finishes; the official tag moves only after the data commit.
  expect(await candidateTags()).toEqual([candidate.image_tag.replace(":", "_")]);
  expect(await officialTag()).toBe("sha256:old");
  expect(existsSync(join(stage, "build-context"))).toBe(false);
  const args = (await readFile(join(mock, "preview-args"), "utf8")).trim().split("\n");
  const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
  expect(mounts).toEqual([`${posix(work)}/data:/app/data:ro`, `${posix(work)}/logs:/app/logs`, `${posix(stage)}/preview:/preview`]);
  expect(args.slice(args.indexOf(candidate.image_id))).toEqual([candidate.image_id, "bun", "run", "scripts/migrations/run.ts",
    "preview", "--project", "/app", "--groups", "/app/data/groups", "--scratch", "/preview", "--plan", "/preview/migration-plan.json"]);
  expect(args).toContain("GROUP_DATA_ROOT=/app/data/groups");
  expect(args[args.indexOf("--user") + 1]).toBe(identity); expect(args[args.indexOf("--network") + 1]).toBe("none");
  expect(await record()).toEqual({ format: "1", operation: "upgrade", snapshot, target_sha: target, original_sha: old, original_branch: "main",
    original_group_root: groups, target_group_root: groups, was_running: "1", bot_port: "2022", deploy_mode: "direct", bot_domain: "bot.example.com",
    domain_action: "persist", unmanaged_tunnel: "", platform_ip: expect.any(String), reconfigure_ai: "0" });
  expect(await readFile(join(mock, "plan"), "utf8")).toBe('{"format":1,"fixture":"plan"}');
  expect(await git("rev-parse", "HEAD")).toBe(target);
  // The operation log records the build's duration and the start of the downtime (the deploy script records its end).
  const operationLogs = (await readdir(join(work, "logs/operations"))).filter(name => name.startsWith("upgrade-")).sort();
  const operationLog = await readFile(join(work, "logs/operations", operationLogs.at(-1)!), "utf8");
  expect(operationLog).toMatch(/candidate build took \d+s; exit=0/); expect(operationLog).toContain("service stopped; downtime begins");
  expect(operationLog.indexOf("candidate build took")).toBeLessThan(operationLog.indexOf("downtime begins"));
  // Rootless Docker cannot publish a saved privileged port (rootlesskit listens as the deploying user): the upgrade
  // stops before the build and the stop instead of failing at the container start. Rootful Docker keeps upgrading.
  const kernel = "/proc/sys/net/ipv4/ip_unprivileged_port_start";
  const start = process.platform !== "win32" && existsSync(kernel) ? Number((await readFile(kernel, "utf8")).trim()) : 1024;
  if (start > 1) {
    const low = String(Math.min(1011, start - 1));
    await writeFile(join(state, "bot-port"), low);
    await reset(old);
    result = await upgrade([target]);
    if (root) {
      expect(result.code, result.text).toBe(0); expect((await record()).bot_port).toBe(low);
    } else {
      await unchanged(old, result); expect(await log()).toEqual([]);
      expect(result.text).toContain(`rootless Docker 不能发布低于 ${start} 的端口 ${low}`); expect(result.text).toContain("服务尚未停止");
    }
    await writeFile(join(state, "bot-port"), "2022");
  }
});

scenario("target upgrader: a failed code restore keeps the transaction, marked so that the explicit rollback restores only the code", "target-upgrader-code-restore-", async fx => {
  const { work, state, git, upgrade, log, container, reset, old, target } = fx;
  let result: { code: number; text: string };
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
});

scenario("target upgrader: an external group root is mounted read-only; missing registered roots stop before any change", "target-upgrader-roots-", async fx => {
  const { f, work, state, mock, upgrade, record, reset, old, target } = fx;
  const groups = posix(join(work, "data/groups"));
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
  // An external group root is mounted read-only at the service path.
  const external = join(f.root, "external groups");
  await mkdir(external); await writeFile(join(state, "group-data-root"), posix(external));
  await reset(old);
  result = await upgrade([target]);
  expect(result.code, result.text).toBe(0);
  const externalArgs = (await readFile(join(mock, "preview-args"), "utf8")).trim().split("\n");
  expect(externalArgs).toContain(`${posix(external)}:/app/group-data:ro`); expect(externalArgs).toContain("/app/group-data");
  expect((await record()).target_group_root).toBe(posix(external));
  // A missing external root stops before anything changes and is never recreated.
  await rm(external, { recursive: true });
  await reset(old);
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("群数据总根不存在"); expect(existsSync(external)).toBe(false);
  // A registered default root is checked the same way: its loss is reported, not hidden behind a new empty directory.
  // A registered default root that exists (in the single long sequence, earlier upgrades had created it).
  await mkdir(join(work, "data/groups"), { recursive: true });
  await writeFile(join(state, "group-data-root"), groups);
  await rm(join(work, "data/groups"), { recursive: true });
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("群数据总根不存在"); expect(existsSync(join(work, "data/groups"))).toBe(false);
  await rm(join(state, "group-data-root"));
});

scenario("target upgrader: a Cloudflare token is asked before the stop and handed over only in memory", "target-upgrader-token-", async fx => {
  const { state, mock, upgrade, log, reset, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
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
});

scenario("target upgrader: never runs from inside the work tree; the documented bootstrap command performs a complete upgrade", "target-upgrader-bootstrap-", async fx => {
  const { f, work, run, git, env, reset, old, target } = fx;
  let result: { code: number; text: string };
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
});
