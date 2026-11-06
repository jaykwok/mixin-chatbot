import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, scenarioRunner, ScenarioProcesses } from "../helpers/concurrent-scenarios.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
// This is the Linux Docker upgrader; Windows exercises upgrade.ps1 in deployment/upgrade-safety tests.
const bash = process.platform === "linux" ? Bun.which("bash") : null;
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

// Docker stub: containers are files "<image> <running> [<user> [<id>]]" under mock/containers (the user defaults to the
// daemon's mode: 0:0 rootless, 1000:1000 rootful), images are files of their platform and labels under mock/images and
// tags files holding an ID under mock/tags. The preview writes its plan into the /preview mount.
// A bare "docker inspect" also matches the mixin-bot image, so the scripts must name the object type.
const dockerStub = `#!/usr/bin/env bash
mock="$FIXTURE_MOCK"
printf '%s\n' "$*" >> "$mock/docker.log"
task_daemon=0
if [ "$1" = --host ]; then task_daemon=1; shift 2; fi
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
            '{{json .SecurityOptions}}') if [ "$task_daemon" = 1 ]; then echo '["name=rootless"]'; else echo '[]'; fi ;;
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
            deploy) printf '\\n# hotfix\\n' >> "$FIXTURE_WORK/scripts/deploy.sh" ;;
            branch) git -C "$FIXTURE_WORK" checkout --quiet -b hotfix ;;
            commit) git -C "$FIXTURE_WORK" commit --quiet --allow-empty -m hotfix ;;
            main) git -C "$FIXTURE_WORK" update-ref refs/heads/main "$(git -C "$FIXTURE_WORK" commit-tree 'HEAD^{tree}' -p HEAD -m hotfix)" ;;
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
        # The directory scope choice writes its plan into the /preview mount (FIXTURE_SCOPE: ok, fail or cancel).
        if [[ " $* " == *" ops/config/directory-scope.ts choose "* ]]; then
            printf '%s\n' "$@" > "$mock/scope-args"
            printf 'scope head=%s\n' "$(current_head)" >> "$FIXTURE_EVENTS"
            case "\${FIXTURE_SCOPE:-ok}" in
                fail) echo 'fixture scope check failed' >&2; exit 1 ;;
                cancel) exit 2 ;;
            esac
            printf '{"format":1,"all":true}\n' > "$preview/directory-scope-plan.json"
            exit 0
        fi
        # Only the preview is a one-off container of the upgrader; others (the model check after ops update) succeed.
        [ -n "$preview" ] || exit 0
        printf '%s\n' "$@" > "$mock/preview-args"
        printf 'preview head=%s\n' "$(current_head)" >> "$FIXTURE_EVENTS"
        # A preview that waits until it is removed.
        [ "\${FIXTURE_PREVIEW:-ok}" != hold ] || exec sleep 30
        [ "\${FIXTURE_PREVIEW:-ok}" = ok ] || { echo '目录没有部署记录，不能升级' >&2; exit 1; }
        # Changes made while the preview runs, which the check before the stop must notice.
        case "\${FIXTURE_DURING_PREVIEW:-}" in
            config) printf '{"changed":true}' > "$FIXTURE_WORK/data/config/models.json" ;;
            container) read -r image running user id < "$mock/containers/mixin-bot"
                printf '%s %s %s replaced\n' "$image" "$running" "\${user:-0:0}" > "$mock/containers/mixin-bot" ;;
            tag) rm -f "$mock"/tags/mixin-bot_candidate-* ;;
            disk) : > "$mock/disk-full" ;;
        esac
        printf '{"format":1,"fixture":"plan"}' > "$preview/data-plan.json" ;;
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
            '{{.Id}}|'*) printf '%s|%s|%s|%s|\n' "\${id:-${"c".repeat(64)}}" "$user" "$image" "\${FIXTURE_DATA_MOUNT:-$FIXTURE_WORK/data}" ;;
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

// Host Bun and shared core stand-in (MIXIN_OPS_BUN): records what the upgrader handed over, then behaves as FIXTURE_CORE (a new
// upgrade), FIXTURE_CORE_RESUME or FIXTURE_CORE_ROLLBACK say. The real core has its own tests (core-docker-upgrade.test.ts);
// here only the hand-off is under test, so success just leaves what the entry scripts look at afterwards.
const coreStub = `#!/usr/bin/env bash
set -u
[ "\${1:-}" != --version ] || { echo 1.4.4; exit 0; }
mock="$FIXTURE_MOCK" work="$FIXTURE_WORK" pointer="$FIXTURE_WORK/data/state/deploy-transaction" entry="$2" args=("$@")
value() {
    local index
    for ((index = 0; index < \${#args[@]}; index++)); do
        if [ "\${args[index]}" = "$1" ]; then printf '%s' "\${args[index + 1]:-}"; return 0; fi
    done
    return 1
}
short() { git -C "$work" rev-parse --short HEAD; }
lock=free
[ "$(readlink /proc/self/fd/9 2>/dev/null)" != "\${BOT_DEPLOY_LOCK_HELD:-none}" ] || lock=held
if value --preflight >/dev/null; then
    printf 'preflight head=%s lock=%s\\n' "$(short)" "$lock" >> "$FIXTURE_EVENTS"
    [ "\${FIXTURE_PREFLIGHT:-ok}" = ok ] || { echo 'fixture preflight refusal' >&2; exit 1; }
    exit 0
fi
printf '%s\\n' "$@" > "$mock/core-args"
input=''; IFS= read -r input || true
kind=fresh mode="\${FIXTURE_CORE:-success}" origin=target
if value --rollback >/dev/null; then kind=rollback mode="\${FIXTURE_CORE_ROLLBACK:-rolled-back}"
elif ! value --plan >/dev/null; then kind=resume mode="\${FIXTURE_CORE_RESUME:-success}"; fi
case "$entry" in */.console/runtime/source-*) origin=pinned ;; esac
printf 'upgrade %s stdin=%s tty=%s head=%s lock=%s core=%s\\n' "$kind" "$input" "$([ -t 0 ] && echo yes || echo no)" "$(short)" "$lock" "$origin" >> "$FIXTURE_EVENTS"
for pair in plan:plan candidate:candidate-image facts:facts directory-plan:directory-scope-plan.json; do
    if file="$(value "--\${pair%%:*}")"; then cp -- "$file" "$mock/\${pair#*:}"; fi
done
[ -z "\${MIXIN_OPS_RESULT_FILE:-}" ] || printf '{"fixture":"result of the core"}\\n' > "$MIXIN_OPS_RESULT_FILE"
target="$(value --target)" original="$(value --original)" branch="$(value --branch)"
forward() {
    git -C "$work" checkout --quiet main && git -C "$work" merge --ff-only --quiet "$target" || exit 70
    printf 'sha256:new true\\n' > "$mock/containers/mixin-bot"; rm -f -- "$pointer"
}
back() {
    git -C "$work" checkout --quiet main && git -C "$work" reset --hard --quiet "$original" || exit 71
    printf 'sha256:old true\\n' > "$mock/containers/mixin-bot"; rm -f -- "$pointer"
}
# The snapshot as far as the entry scripts read it.
publish() {
    local name="deploy-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')" directory
    directory="$work/backup/snapshots/$name"; mkdir -p -- "$directory"
    printf '%s\\n' format=2 operation=upgrade "snapshot=$name" "target_sha=$target" "original_sha=$original" "original_branch=$branch" \\
        original_workspace_root= target_workspace_root= was_running=1 bot_port=2022 reconfigure_ai=0 > "$directory/transaction"
    printf '%064d\\n' 0 > "$directory/host-runtime"
    printf '%s\\n' "$name" > "$pointer"
}
case "$mode" in
    # Like the real core (core/cli.ts), which prints its result message; the entry scripts add no line of their own (A3-4).
    success) forward; printf '升级完成：%s -> %s\\n' "\${original:0:7}" "\${target:0:7}" ;;
    rolled-back) back; printf '升级已回滚：代码恢复到 %s，数据、配置和原运行状态已恢复\\n' "\${original:0:7}" ;;
    pending) publish; exit 1 ;;
    kept) exit 1 ;;
    exit-*) exit "\${mode#exit-}" ;;
    # Waits, as a migration would, until the upgrader forwards an interrupt as TERM or a hangup reaches it, then rolls back
    # once like the real core. The tree it runs from (in the upgrader's export directory) must still be there meanwhile.
    hold)
        interrupted() {
            trap '' TERM HUP; kill "$!" 2>/dev/null; sleep 0.3
            [ ! -f "$entry" ] || printf 'core tree kept\\n' >> "$FIXTURE_EVENTS"
            back; exit "$1"
        }
        trap 'interrupted 143' TERM
        trap 'interrupted 129' HUP
        printf 'core held\\n' >> "$FIXTURE_EVENTS"
        sleep 30 >/dev/null 2>&1 & wait "$!"
        exit 1 ;;
esac
`;

const dfFunction = `() { case " $* " in *" --output=avail "*) if [ -e "$FIXTURE_MOCK/disk-full" ]; then printf 'Avail\\n1024\\n'; \
else printf 'Avail\\n1099511627776\\n'; fi ;; *) command df "$@" ;; esac\n}`;

// The upgrader is Linux-only shell code. The scenarios below are independent, so they run concurrently, at most four at a time, each on its
// own copy of a fixture built once per file (see concurrent-scenarios.ts for budgets and process cleanup). Bun's own
// timeout also counts the wait for a slot and is only a backstop.
const runScenario = scenarioRunner({ slots: 4, budgetMs: 150_000 });
const TEST_BACKSTOP_MS = 600_000;

/**
 * Built once per file: a repository with the real upgrader files and ops.sh at an old and a new commit, the target exported
 * exactly as ops.sh update does, and Docker, flock and core stubs. Scenarios only copy it.
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
    await writeFile(join(bin, "fixture-core"), coreStub);
    for (const name of ["docker", "flock", "fixture-core"]) await chmod(join(bin, name), 0o755);
    // The fixture repository carries the real upgrader files at both commits. The stub above runs instead of the core
    // entry, which only has to exist; the deploy script is only a tracked file here, nothing runs it.
    for (const path of ["scripts/upgrade.sh", "scripts/lib", "ops/tools", "scripts/ops.sh", "src/core/data-version.ts", "Dockerfile"]) {
      await cp(join(project, path), join(work, path), { recursive: true });
    }
    await mkdir(join(work, "ops/core")); await writeFile(join(work, "ops/core/cli.ts"), "");
    await writeFile(join(work, "scripts/deploy.sh"), "#!/usr/bin/env bash\nexit 99\n");
    await writeFile(join(work, ".gitignore"), "data/\nlogs/\ntmp/\nbackup/\n.console/\n");
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
    expect(existsSync(join(stage, "scripts/deploy.sh"))).toBe(false);
    await writeFile(join(work, "data/config/models.json"), "{}"); await writeFile(join(work, "data/config/app-bot.json"), "{}");
    await writeFile(join(work, "data/config/directory.json"), '{"format":1,"all":true}\n');
    await writeFile(join(state, "bot-port"), "2022");
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
  const socket = join(f.root, "task.sock");
  const taskSocket = Bun.listen({ unix: socket, socket: { data() {} } });
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
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${posix(bin)}:${process.env.PATH}`, PWD: posix(work), MIXIN_OPS_BUN: posix(join(bin, "fixture-core")),
    FIXTURE_EVENTS: posix(events), FIXTURE_MOCK: posix(mock), FIXTURE_WORK: posix(work),
    DOCKER_HOST: "unix:///var/run/docker.sock", BOT_TASK_DOCKER_HOST: `unix://${socket}`, "BASH_FUNC_df%%": dfFunction,
    // Socket ownership is part of the synthetic daemon's fixture, including root-operated UID 1000 scenarios.
    "BASH_FUNC_stat%%": `() { if [ "$*" = '-c %u -- ${socket}' ]; then if [ "\${FIXTURE_ROOTLESS:-$([ "$(id -u)" = 0 ] && echo 0 || echo 1)}" = 1 ]; then id -u; else printf '%s' "\${FIXTURE_TASK_UID:-1000}"; fi; else command stat "$@"; fi\n}`, ...extra });
  const clearEvents = async () => {
    for (const name of ["core-args", "preview-args", "scope-args", "candidate-image", "facts", "plan",
      "directory-scope-plan.json", "disk-full"]) await rm(join(mock, name), { force: true });
    await rm(events, { force: true });
  };
  /** Reserved candidate tags left in the stub, and the image the official tag names. */
  const candidateTags = async () => (await readdir(join(mock, "tags")).catch(() => [])).filter(name => name.startsWith("mixin-bot_candidate-"));
  const officialTag = () => readFile(join(mock, "tags/mixin-bot"), "utf8").catch(() => "absent");
  const sidecar = async (name: string) => Object.fromEntries((await readFile(join(mock, name), "utf8")).trim().split("\n")
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const upgrade = async (args: string[], extra: Record<string, string> = {}, input?: string) => {
    await clearEvents();
    return run([bash!, posix(join(stage, "scripts/upgrade.sh")), posix(work), ...args], env(extra), input);
  };
  const ops = async (args: string[], extra: Record<string, string> = {}) => {
    await clearEvents();
    return run([bash!, "scripts/ops.sh", ...args], env(extra));
  };
  const log = async () => existsSync(events) ? (await readFile(events, "utf8")).trim().split("\n").filter(Boolean) : [];
  const coreArgs = async () => (await readFile(join(mock, "core-args"), "utf8")).trim().split("\n");
  const container = (name: string) => readFile(join(mock, "containers", name), "utf8").then(text => text.trim(), () => "absent");
  // The original container runs the old image, which the official tag names; no candidate image or tag is left.
  const reset = async (ref: string, running = true, user = "") => {
    await git("reset", "--hard", ref);
    for (const name of ["containers", "images", "tags", "docker-root"]) {
      await rm(join(mock, name), { recursive: true, force: true }); await mkdir(join(mock, name), { recursive: true });
    }
    await writeFile(join(mock, "containers/mixin-bot"), `sha256:old ${running} ${user}\n`);
    await writeFile(join(mock, "images/old"), "linux|amd64||||\n"); await writeFile(join(mock, "tags/mixin-bot"), "sha256:old");
    await rm(join(state, "deploy-transaction"), { force: true });
  };
  const fixture = { f, work, state, mock, stage, socket, run, git, env, upgrade, ops, log, coreArgs, container, reset, old, target, processes,
    candidateTags, officialTag, sidecar, cleanup: () => { taskSocket.stop(true); return f.cleanup(); } };
  try {
    await cp(source.work, work, { recursive: true }); await cp(source.bin, bin, { recursive: true });
    // The copied Git settings still name the template's exclude file; this copy gets its own.
    await writeFile(join(f.root, "gitignore"), ""); await git("config", "core.excludesFile", join(f.root, "gitignore"));
  } catch (error) { taskSocket.stop(true); await f.cleanup(); throw error; }
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
    expect((await log()).filter(line => /^(stop|rename|upgrade)/.test(line)), result.text).toEqual([]);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    // Image and running state; a scenario may have changed the container's identity fields itself.
    expect((await container("mixin-bot")).split(" ").slice(0, 2).join(" ")).toBe("sha256:old true");
  };
}

scenario("ops update ignores terminal settings through the post-upgrade check", "target-upgrader-ops-", async fx => {
  const { f, git, ops, reset, old, target } = fx;
  const origin = join(f.root, "origin.git");
  await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
  // Upgrading uses only the saved settings, so the health check afterwards runs against the saved port as well
  // (its heading shows the port it probes). Invalid terminal values neither block the entry nor reach the check.
  for (const port of ["9999", "invalid"]) {
    await reset(old);
    const result = await ops(["update"], { BOT_PORT: port });
    expect(result.text).toContain("升级完成"); expect(result.text).not.toContain("端口无效");
    expect(result.text).toContain("健康检查（本机端口=2022）"); expect(result.text).not.toContain(`端口=${port}`);
    expect(await git("rev-parse", "HEAD")).toBe(target);
  }
});

scenario("ops resume and rollback run the recorded target's core; without the target commit a rollback takes the pinned runtime", "target-upgrader-ops-recovery-", async fx => {
  const { f, work, state, git, ops, log, coreArgs, container, reset, old, target } = fx;
  const origin = join(f.root, "origin.git"), pointer = join(state, "deploy-transaction"), oldShort = old.slice(0, 7);
  await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
  // The core kept its transaction: only resume or rollback go on, and neither passes a new choice.
  await reset(old);
  let result = await ops(["update"], { FIXTURE_CORE: "pending" });
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级未完成，事务已保留"); expect(existsSync(pointer)).toBe(true);
  result = await ops(["update"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("发现未完成的部署或升级"); expect(await log()).toEqual([]);
  result = await ops(["resume"]);
  expect(result.text).toContain(`升级完成：${oldShort} -> ${target.slice(0, 7)}`);
  expect(await log()).toEqual([`upgrade resume stdin= tty=no head=${oldShort} lock=held core=target`]);
  expect(await coreArgs()).not.toContain("--plan"); expect(await git("rev-parse", "HEAD")).toBe(target); expect(existsSync(pointer)).toBe(false);
  await reset(old);
  await ops(["update"], { FIXTURE_CORE: "pending" });
  result = await ops(["rollback"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("升级已回滚");
  expect(await coreArgs()).toContain("--rollback"); expect(await container("mixin-bot")).toBe("sha256:old true"); expect(existsSync(pointer)).toBe(false);
  result = await ops(["rollback"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("没有未完成的部署或升级");
  // The recorded target commit left the repository: continuing is impossible, and rolling back needs the core pinned for
  // this transaction. Without it the transaction stays as it is.
  await reset(old);
  await ops(["update"], { FIXTURE_CORE: "pending" });
  const name = (await readFile(pointer, "utf8")).trim(), record = join(work, "backup/snapshots", name, "transaction");
  await writeFile(record, (await readFile(record, "utf8")).replace(`target_sha=${target}`, `target_sha=${"f".repeat(40)}`));
  result = await ops(["resume"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("在本地不存在，无法继续"); expect(await log()).toEqual([]);
  result = await ops(["rollback"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("事务固定的运维运行包都不在本地"); expect(await log()).toEqual([]); expect(existsSync(pointer)).toBe(true);
  const pinned = join(work, ".console/runtime/source-" + "0".repeat(64), "ops/core");
  await mkdir(pinned, { recursive: true }); await writeFile(join(pinned, "cli.ts"), "");
  result = await ops(["rollback"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("由事务固定的运维运行包回滚");
  expect(await log()).toEqual([`upgrade rollback stdin= tty=no head=${oldShort} lock=held core=pinned`]);
  expect(await coreArgs()).toContain("--rollback"); expect(existsSync(pointer)).toBe(false);
});

scenario("ops update leaves the structured result to the core once it took over and writes it only for an earlier failure", "target-upgrader-ops-result-", async fx => {
  const { f, git, ops, reset, old, target } = fx;
  const origin = join(f.root, "origin.git"), file = join(f.root, "result.json"), core = { fixture: "result of the core" };
  await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
  await reset(old);
  let result = await ops(["update"], { MIXIN_OPS_RESULT_FILE: posix(file) });
  expect(result.code, result.text).toBe(0); expect(result.text).not.toContain("健康检查");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(core);
  await reset(old);
  result = await ops(["update"], { MIXIN_OPS_RESULT_FILE: posix(file), FIXTURE_CORE: "exit-3" });
  expect(result.code, result.text).toBe(3); expect(JSON.parse(await readFile(file, "utf8"))).toEqual(core);
  await rm(file); await reset(old);
  result = await ops(["update"], { MIXIN_OPS_RESULT_FILE: posix(file), FIXTURE_PREVIEW: "fail" });
  expect(result.code, result.text).toBe(1);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ protocol: "mixin-ops", version: 1, outcome: "failed", exitCode: 1 });
});

scenario("target upgrader: the core's exit code passes through; a kept transaction keeps the candidate and only its records can go on", "target-upgrader-handoff-", async fx => {
  const { work, state, upgrade, log, coreArgs, candidateTags, reset, old, target } = fx;
  const pointer = join(state, "deploy-transaction"), oldShort = old.slice(0, 7), resumed = `upgrade resume stdin= tty=no head=${oldShort} lock=held core=target`;
  // Refused or rolled back by the core: no transaction remains, so the reserved tag goes and nothing needs adding.
  await reset(old);
  let result = await upgrade([target], { FIXTURE_CORE: "exit-3" });
  expect(result.code, result.text).toBe(3); expect(result.text).not.toContain("事务已保留"); expect(await candidateTags()).toEqual([]);
  // A kept transaction owns the candidate.
  await reset(old);
  result = await upgrade([target], { FIXTURE_CORE: "pending" });
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级未完成，事务已保留");
  expect(result.text).toContain("resume"); expect(result.text).toContain("rollback");
  expect(await candidateTags()).toHaveLength(1); expect(existsSync(pointer)).toBe(true);
  // Without a terminal the action must be explicit, and another target is not this transaction.
  result = await upgrade([target]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("发现未完成的升级"); expect(await log()).toEqual([]);
  result = await upgrade([old, "continue"]);
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("不是本升级器的版本"); expect(await log()).toEqual([]);
  result = await upgrade([target, "continue"], { FIXTURE_CORE_RESUME: "kept" });
  expect(result.code, result.text).toBe(1); expect(result.text).toContain("升级未完成，事务已保留");
  expect(await log()).toEqual([resumed]); expect(await candidateTags()).toHaveLength(1);
  result = await upgrade([target, "continue"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain(`升级完成：${oldShort} -> ${target.slice(0, 7)}`);
  expect(await log()).toEqual([resumed]);
  expect((await coreArgs()).slice(1)).toEqual([join(fx.stage, "target/ops/core/cli.ts").replaceAll("\\", "/"), "deployment", "upgrade", "--project", posix(work),
    "--original", old, "--target", target, "--branch", "main"]);
  result = await upgrade([target, "rollback"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain("没有未完成的升级");
  await reset(old);
  await upgrade([target], { FIXTURE_CORE: "pending" });
  result = await upgrade([target, "rollback"]);
  expect(result.code, result.text).toBe(0); expect(result.text).toContain(`升级已回滚：代码恢复到 ${oldShort}`);
  expect(await coreArgs()).toContain("--rollback");
  // A transaction the core did not start has no pinned runtime to resume with: left for inspection.
  await reset(old);
  await upgrade([target], { FIXTURE_CORE: "pending" });
  await rm(join(work, "backup/snapshots", (await readFile(pointer, "utf8")).trim(), "host-runtime"));
  for (const action of ["continue", "rollback"]) {
    result = await upgrade([target, action]);
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("不是由运维核心开始的"); expect(await log()).toEqual([]);
    expect(existsSync(pointer)).toBe(true);
  }
});

scenario("target upgrader: refusals before the stop leave code, data and service untouched", "target-upgrader-refusals-", async fx => {
  const { f, work, state, stage, git, env, upgrade, log, reset, candidateTags, old, target, processes } = fx;
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
  // Refusals before the stop leave code, data and service untouched, and release the candidate's reserved tag.
  await reset(old);
  result = await upgrade([target], { FIXTURE_PREVIEW: "fail" });
  await unchanged(old, result); expect(result.text).toContain("数据版本或配置校验未通过"); expect(result.text).toContain("服务尚未停止");
  expect(result.text).toContain("目录没有部署记录，不能升级");
  expect(await candidateTags()).toEqual([]);
  // An interrupted preview (ops.sh forwards TERM to the upgrader) removes the named preview container before the
  // upgrader exits, so no Docker CLI or container is left behind, even when INT and TERM reach its whole process group
  // again during that cleanup; an interrupted build ends only this build's client. Windows cannot deliver the signal to bash.
  if (process.platform !== "win32") {
    // `ready`: a file the stub writes last before it holds (the build logs its event first, then tags and holds).
    const interrupt = async (extra: Record<string, string>, started: string, ready?: string) => {
      await rm(join(f.root, "events"), { force: true });
      if (ready) await rm(ready, { force: true });
      const held = processes.spawn([bash!, posix(join(stage, "scripts/upgrade.sh")), posix(work), target],
        { cwd: work, env: { ...process.env, ...env(extra) } });
      await writeFile(join(fx.mock, "group"), String(held.pid));
      const holding = async () => (await log()).some(line => line.startsWith(started)) && (!ready || existsSync(ready));
      for (let waited = 0; !(await holding()) && waited < 20000; waited += 50) await Bun.sleep(50);
      held.kill("SIGTERM");
      const [code, { out, err }] = await Promise.all([held.exited, held.output()]);
      expect(code, out + err).toBe(143);
      expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
      expect(await candidateTags()).toEqual([]); expect(await fx.officialTag()).toBe("sha256:old");
      expect(await fx.container("mixin-bot")).toBe("sha256:old true");
      return out + err;
    };
    expect(await interrupt({ FIXTURE_PREVIEW: "hold", FIXTURE_RM_SIGNALS: "1" }, "preview")).toContain("数据预检已中断并清理");
    expect((await log()).filter(line => !/^(preflight|build|preview)/.test(line))).toEqual([expect.stringMatching(/^rm -f mixin-bot-preview-[0-9a-f]{12}$/)]);
    // The build's tag exists before its ID is known: it is claimed by the operation label and released.
    expect(await interrupt({ FIXTURE_BUILD: "hold" }, "build", join(fx.mock, "build-pid"))).toContain("镜像构建已中断");
    expect((await log()).filter(line => !/^(preflight|build)/.test(line))).toEqual([]);
    const client = Number(await readFile(join(fx.mock, "build-pid"), "utf8"));
    const alive = () => { try { process.kill(client, 0); return true; } catch { return false; } };
    for (let waited = 0; alive() && waited < 5000; waited += 50) await Bun.sleep(50);
    expect(alive()).toBe(false);
  }
  await writeFile(join(state, "bot-port"), "abc");
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("端口无效");
  await writeFile(join(state, "bot-port"), "2022");
  await rm(join(work, "data/config/models.json"));
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("缺少 data/config/models.json");
  await writeFile(join(work, "data/config/models.json"), "{}");
  await rm(join(work, "data/config/app-bot.json"));
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("缺少 data/config/app-bot.json"); expect(result.text).toContain("服务尚未停止");
  await writeFile(join(work, "data/config/app-bot.json"), "{}");
  await writeFile(join(work, "version.txt"), "dirty");
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("未提交的改动");
  await git("checkout", "--", "version.txt");
  // The core is the target's, run by the host's Bun: without either the upgrade stops before the build, and the core's own
  // read-only start checks (lock, unfinished work, main, the original container) refuse before it too.
  await reset(old);
  result = await upgrade([target], { MIXIN_OPS_BUN: posix(join(f.root, "no-such-bun")) });
  await unchanged(old, result); expect(result.text).toContain("宿主机没有可用的 Bun"); expect(result.text).toContain("服务尚未停止"); expect(await log()).toEqual([]);
  result = await upgrade([target], { FIXTURE_PREFLIGHT: "refused" });
  await unchanged(old, result); expect(result.text).toContain("fixture preflight refusal"); expect(result.text).toContain("升级预检未通过");
  expect(await log()).toEqual([`preflight head=${old.slice(0, 7)} lock=held`]);
  await reset(target);
  await git("rm", "-q", "ops/core/cli.ts"); await git("commit", "-qm", "fixture-no-core");
  const coreless = await git("rev-parse", "HEAD");
  await reset(old);
  result = await upgrade([coreless]);
  await unchanged(old, result); expect(result.text).toContain(`无法从目标提交 ${coreless.slice(0, 7)} 导出运维核心`); expect(await log()).toEqual([]);
  await reset(old);
  result = await upgrade([target]);
  expect(result.code, result.text).toBe(0);
});

// ops.sh starts the upgrader in the background, so the upgrader ignores the INT of a Ctrl+C and gets it from ops.sh
// as TERM, also after the build ran in its own process group. Before the pointer the preview container and this
// upgrade's reserved tag are removed, even when more interrupts arrive during that cleanup; after the handoff the
// upgrader forwards the interrupt to the core, waits for its rollback and exits with its code. On a hangup ops.sh, too,
// waits for the upgrader before it removes the export directory the core runs from. Windows cannot deliver the signals.
scenario("ops update interrupted by Ctrl+C, TERM or a hangup cleans up before the stop and rolls back after the handoff", "target-upgrader-ops-cancel-", async fx => {
  if (process.platform === "win32") return;
  const { f, work, mock, state, git, env, log, container, reset, candidateTags, processes, old, target } = fx;
  const origin = join(f.root, "origin.git");
  await git("init", "--bare", origin); await git("remote", "add", "origin", origin); await git("push", "origin", `${target}:refs/heads/main`);
  const interrupt = async (signal: "group" | "hangup" | "ops", started: string, extra: Record<string, string>) => {
    await reset(old); await rm(join(f.root, "events"), { force: true });
    const held = processes.spawn([bash!, "scripts/ops.sh", "update"], { cwd: work, env: { ...process.env, ...env(extra) } });
    // ops.sh leads its own process group, as the foreground job of a terminal would.
    await writeFile(join(mock, "group"), String(held.pid));
    for (let waited = 0; !(await log()).some(line => line.startsWith(started)) && waited < 20000; waited += 50) await Bun.sleep(50);
    if (signal === "ops") held.kill("SIGTERM"); else process.kill(-held.pid, signal === "group" ? "SIGINT" : "SIGHUP");
    const [code, { out, err }] = await Promise.all([held.exited, held.output()]);
    expect(code, out + err).not.toBe(0);
    expect(await git("rev-parse", "HEAD")).toBe(old); expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    expect((await readdir(join(work, "tmp"))).filter(name => name.startsWith("upgrade-") && name !== "upgrade-fixture")).toEqual([]);
    expect(await container("mixin-bot")).toBe("sha256:old true"); expect(await fx.officialTag()).toBe("sha256:old");
    return out + err;
  };
  for (const [signal, extra] of [["group", {}], ["ops", {}], ["ops", { FIXTURE_RM_SIGNALS: "1" }]] as const) {
    expect(await interrupt(signal, "preview", { FIXTURE_PREVIEW: "hold", ...extra })).toContain("数据预检已中断并清理");
    expect((await log()).filter(line => !/^(preflight|build|preview)/.test(line))).toEqual([expect.stringMatching(/^rm -f mixin-bot-preview-[0-9a-f]{12}$/)]);
    expect(await candidateTags()).toEqual([]);
  }
  for (const signal of ["group", "hangup", "ops"] as const) {
    await interrupt(signal, "core held", { FIXTURE_CORE: "hold" });
    expect((await log()).filter(line => /^(upgrade|core)/.test(line))).toEqual([expect.stringMatching(/^upgrade fresh /), "core held", "core tree kept"]);
    // Once the core has closed its transaction the upgrader's exit releases what is left of the reservation.
    expect(await candidateTags()).toEqual([]);
  }
});

scenario("target upgrader: the operator is checked before any question and the service identity before any build; an unclear identity is refused", "target-upgrader-identity-", async fx => {
  const { mock, upgrade, log, reset, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  const root = process.platform !== "win32" && process.getuid!() === 0;
  let result: { code: number; text: string };
  // A rootful daemon needs root and a rootless one its own user: refused before any question, build or change.
  await reset(old);
  result = await upgrade([target], { FIXTURE_ROOTLESS: root ? "1" : "0" }, "y\n");
  await unchanged(old, result); expect(await log()).toEqual([]); expect(result.text).not.toContain("?>");
  expect(result.text).toContain(root ? "rootless 模式" : "sudo scripts/ops.sh update");
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
  await rm(join(mock, "containers/mixin-bot"));
  await refusedIdentity("找不到原容器 mixin-bot");
});

scenario("target upgrader: a failed build, too little disk space or any input changed after the preview stops before the stop", "target-upgrader-recheck-", async fx => {
  const { work, mock, upgrade, log, reset, candidateTags, officialTag, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
  // A failed build and a disk too small to build stop before the preview; nothing is tagged or changed.
  await reset(old);
  result = await upgrade([target], { FIXTURE_BUILD: "fail" });
  await unchanged(old, result); expect(result.text).toContain("镜像构建失败");
  expect(await log()).toEqual([`preflight head=${old.slice(0, 7)} lock=held`, `build head=${old.slice(0, 7)} context=new`]); expect(await candidateTags()).toEqual([]);
  // (upgrade() clears mock/disk-full, so this run starts the upgrader directly.)
  await rm(join(fx.f.root, "events"), { force: true }); await writeFile(join(mock, "disk-full"), "");
  result = await fx.run([bash!, posix(join(fx.stage, "scripts/upgrade.sh")), posix(work), target], fx.env());
  await unchanged(old, result); expect(result.text).toContain("磁盘空间不足"); expect(result.text).toContain("需要");
  expect(await log()).toEqual([`preflight head=${old.slice(0, 7)} lock=held`]);
  // The checkout must stay as it was checked when the upgrade started. Changes made while the image builds stop the upgrade
  // before the stop: an edit to a file the target also changes, one the fast-forward would keep (the deploy script that
  // runs after the stop), another branch, a new commit, and main moving while a detached HEAD is upgraded (confirmed).
  for (const change of ["version", "deploy", "branch", "commit", "main"]) {
    await reset(old);
    if (change === "main") await fx.git("checkout", "--quiet", "--detach");
    result = await upgrade([target], { FIXTURE_DURING_BUILD: change }, change === "main" ? "y\n" : undefined);
    expect(result.code, result.text).toBe(1); expect(result.text, change).toContain("升级开始后检出发生了变化");
    expect((await log()).filter(line => !/^(preflight|build|preview) /.test(line)), change).toEqual([]);
    expect(await candidateTags()).toEqual([]); expect(existsSync(join(fx.state, "deploy-transaction"))).toBe(false);
    expect(await fx.container("mixin-bot")).toBe("sha256:old true");
    if (change === "branch") { await fx.git("checkout", "--quiet", "main"); await fx.git("branch", "--quiet", "-D", "hotfix"); }
    if (change === "main") await fx.git("checkout", "--quiet", "main");
  }
  // Anything that changes between the preview and the stop stops the upgrade before the stop; the reserved tag is released.
  for (const [change, message] of [["config", "预览之后配置或版本标记发生了变化"], ["container", "原容器 mixin-bot 在准备期间被删除、替换或改动"],
    ["tag", "候选镜像核对未通过"], ["disk", "剩余空间不够写入停机后的快照"]] as const) {
    await reset(old);
    result = await upgrade([target], { FIXTURE_DURING_PREVIEW: change });
    await unchanged(old, result); expect(result.text, change).toContain(message);
    expect(await log()).toEqual([`preflight head=${old.slice(0, 7)} lock=held`, `build head=${old.slice(0, 7)} context=new`, `preview head=${old.slice(0, 7)}`]);
    expect(await candidateTags()).toEqual([]); expect(await officialTag()).toBe("sha256:old");
    await writeFile(join(work, "data/config/models.json"), "{}");
  }
});

// Local files the switch after the stop would overwrite are the core's check (DeploymentGit.switchConflicts, all routes in
// switch-preflight.test.ts): its preflight refuses them before the build and its real run again under the lock before the
// stop, so files that appear while the image builds are found too (core-docker-upgrade.test.ts). The upgrader only relays
// the core's refusal (the stub core's preflight refusal above).

scenario("target upgrader: a new upgrade builds the target once, previews in that image as the original service identity, records every choice before the stop and hands over with stdin closed; low ports under rootless", "target-upgrader-new-", async fx => {
  const { work, state, mock, stage, socket, git, upgrade, log, coreArgs, reset, candidateTags, sidecar, old, target } = fx;
  const short = target.slice(0, 7);
  const oldShort = old.slice(0, 7);
  const unchanged = unchangedCheck(fx);
  // Non-root test runs see a rootless daemon, whose service runs as the mapped 0:0. Root runs see a rootful daemon and an
  // instance deployed by a docker group user: its 1000:1000 is kept, not replaced by the image's 1001.
  const root = process.platform !== "win32" && process.getuid!() === 0;
  const identity = root ? "1000:1000" : "0:0";
  // A new upgrade builds the target commit (not the work tree, still at the old commit) once before the stop, previews in
  // that image with data mounted read-only, then hands every fact and choice to the target's core with the lock held and
  // stdin closed; the core stops the service and switches the code. Terminal overrides are ignored.
  await reset(old);
  let result = await upgrade([target], { BOT_PORT: "9999", WORKSPACE_ROOT: "/elsewhere", BOT_RUN_TIMEOUT_SECONDS: "5" }, "leftover\n");
  expect(result.code, result.text).toBe(0); expect(result.text).toContain(`升级完成：${oldShort} -> ${short}`);
  expect(result.text).toContain("忽略当前终端的环境变量：BOT_PORT WORKSPACE_ROOT BOT_RUN_TIMEOUT_SECONDS");
  expect(result.text).toContain("fixture-new");
  expect(await log()).toEqual([`preflight head=${oldShort} lock=held`, `build head=${oldShort} context=new`, `preview head=${oldShort}`,
    `upgrade fresh stdin= tty=no head=${oldShort} lock=held core=target`]);
  expect((await coreArgs()).slice(1)).toEqual([posix(join(stage, "target/ops/core/cli.ts")), "deployment", "upgrade", "--project", posix(work), "--original", old, "--target", target,
    "--branch", "main", "--plan", posix(join(stage, "preview/data-plan.json")), "--candidate", posix(join(stage, "candidate-image")), "--facts", posix(join(stage, "upgrade-facts"))]);
  const candidate = await sidecar("candidate-image");
  expect(candidate).toEqual({ format: "1", source: "commit", target_sha: target, image_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    image_tag: expect.stringMatching(/^mixin-bot:candidate-[0-9a-f]{12}-[0-9a-f]{16}$/), daemon_id: "5eec1de4-4518-46da-a461-80c0866ec11d",
    project_id: expect.stringMatching(/^[0-9a-f]{12}$/), operation_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
  expect(await sidecar("facts")).toEqual({ format: "1", container: "c".repeat(64), user: identity, image: "sha256:old", data: `${posix(work)}/data`, main: old,
    endpoint: `unix://${posix(socket)}`, daemon: candidate.daemon_id });
  expect(await candidateTags()).toEqual([]);
  const args = (await readFile(join(mock, "preview-args"), "utf8")).trim().split("\n");
  const mounts = args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : []);
  expect(mounts).toEqual([`${posix(work)}/data:/app/data:ro`, `${posix(work)}/logs:/app/logs`, `${posix(stage)}/preview:/preview`]);
  expect(args.slice(args.indexOf(candidate.image_id))).toEqual([candidate.image_id, "bun", "run", "ops/tools/data-current.ts",
    "preview", "--project", "/app", "--plan", "/preview/data-plan.json", "--upgrade"]);
  // The data gate reads data/ only: the shared workspace is not mounted.
  expect(args.some(arg => arg.includes("/app/workspace"))).toBe(false);
  expect(args[args.indexOf("--user") + 1]).toBe(identity); expect(args[args.indexOf("--network") + 1]).toBe("none");
  expect(await readFile(join(mock, "plan"), "utf8")).toBe('{"format":1,"fixture":"plan"}');
  expect(await git("rev-parse", "HEAD")).toBe(target);
  // The operation log records the build's duration; the core records the downtime.
  const operationLogs = (await readdir(join(work, "logs/operations"))).filter(name => name.startsWith("upgrade-")).sort();
  const operationLog = await readFile(join(work, "logs/operations", operationLogs.at(-1)!), "utf8");
  expect(operationLog).toMatch(/candidate build took \d+s; exit=0/);
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
      expect(result.code, result.text).toBe(0);
    } else {
      await unchanged(old, result); expect(await log()).toEqual([]);
      expect(result.text).toContain(`rootless Docker 不能发布低于 ${start} 的端口 ${low}`); expect(result.text).toContain("服务尚未停止");
    }
    await writeFile(join(state, "bot-port"), "2022");
  }
});

scenario("target upgrader: an external workspace root is checked in the preview; a missing one stops before any change", "target-upgrader-roots-", async fx => {
  const { f, state, upgrade, reset, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  let result: { code: number; text: string };
  // The core records the saved external root itself and mounts it read-only.
  const external = join(f.root, "external shared");
  await mkdir(external); await writeFile(join(state, "workspace-root"), posix(external));
  await reset(old);
  result = await upgrade([target]);
  expect(result.code, result.text).toBe(0);
  // A missing external root stops before anything changes and is never recreated.
  await rm(external, { recursive: true });
  await reset(old);
  result = await upgrade([target]);
  await unchanged(old, result); expect(result.text).toContain("已部署的共享资料目录不存在"); expect(existsSync(external)).toBe(false);
  await rm(join(state, "workspace-root"));
});

scenario("target upgrader: without a directory scope one is chosen before the stop and handed over; a cancelled or failed choice changes nothing", "target-upgrader-scope-", async fx => {
  const { work, mock, stage, upgrade, log, coreArgs, reset, old, target } = fx;
  const unchanged = unchangedCheck(fx);
  const oldShort = old.slice(0, 7);
  const scope = join(work, "data/config/directory.json");
  await rm(scope);
  try {
    // 1.0.1 and earlier have no scope: the target image chooses it after the data preview, before the recheck and the stop,
    // with data read-only and the network on (departments are checked with the platform). The plan goes into the snapshot.
    await reset(old);
    let result = await upgrade([target], { BOT_DIRECTORY_SCOPE: "all" });
    expect(result.code, result.text).toBe(0);
    expect(await log()).toEqual([`preflight head=${oldShort} lock=held`, `build head=${oldShort} context=new`, `preview head=${oldShort}`, `scope head=${oldShort}`,
      `upgrade fresh stdin= tty=no head=${oldShort} lock=held core=target`]);
    expect((await coreArgs()).slice(-2)).toEqual(["--directory-plan", posix(join(stage, "preview/directory-scope-plan.json"))]);
    const args = (await readFile(join(mock, "scope-args"), "utf8")).trim().split("\n");
    expect(args.flatMap((arg, index) => args[index - 1] === "-v" ? [arg] : [])).toEqual([`${posix(work)}/data:/app/data:ro`, `${posix(stage)}/preview:/preview`]);
    // W4 passes only these named fields to the chooser; absent host variables stay absent in an ordinary CLI upgrade.
    expect(args.flatMap((arg, index) => args[index - 1] === "-e" ? [arg] : [])).toEqual(["HOME=/tmp", "BOT_DIRECTORY_SCOPE",
      "MIXIN_OPS_CONSOLE", "MIXIN_OPS_TASK_ID", "MIXIN_OPS_DIRECTORY", "MIXIN_OPS_DIRECTORY_INPUT", "MIXIN_OPS_DIRECTORY_APP"]);
    expect(args).toContain("-i"); expect(args).not.toContain("-it"); expect(args).not.toContain("--network");
    expect(args.slice(args.indexOf("bun"))).toEqual(["bun", "run", "ops/config/directory-scope.ts", "choose", "--plan",
      "/preview/directory-scope-plan.json", "--project", "/app"]);
    expect(await readFile(join(mock, "directory-scope-plan.json"), "utf8")).toBe('{"format":1,"all":true}\n');
    // A cancelled or failed choice stops before the recheck: nothing stopped, recorded or switched.
    for (const [mode, message] of [["cancel", "已取消选择通讯录同步范围"], ["fail", "没有选定通讯录同步范围"]] as const) {
      await reset(old);
      result = await upgrade([target], { FIXTURE_SCOPE: mode });
      await unchanged(old, result); expect(result.text).toContain(message); expect(result.text).toContain("服务尚未停止");
      expect(await log()).toEqual([`preflight head=${oldShort} lock=held`, `build head=${oldShort} context=new`, `preview head=${oldShort}`, `scope head=${oldShort}`]);
    }
    // A saved scope is kept: nothing is chosen.
    await writeFile(scope, '{"format":1,"departments":["10"]}\n');
    await reset(old);
    result = await upgrade([target]);
    expect(result.code, result.text).toBe(0); expect(existsSync(join(mock, "scope-args"))).toBe(false);
    expect(existsSync(join(mock, "directory-scope-plan.json"))).toBe(false);
  } finally { await writeFile(scope, '{"format":1,"all":true}\n'); }
});

scenario("target upgrader: never runs from inside the work tree", "target-upgrader-bootstrap-", async fx => {
  const { work, run, env, target } = fx;
  // The upgrader never runs from inside the work tree.
  const result = await run([bash!, posix(join(work, "scripts/upgrade.sh")), posix(work), target], env());
  expect(result.code, result.text).toBe(2); expect(result.text).toContain("导出后运行");
});
