import { expect, test } from "bun:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tempFixture } from "../helpers/temp.ts";

const library = fileURLToPath(new URL("../../scripts/lib/task-runtime.sh", import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const imageIds = Object.fromEntries(Object.entries({ current: "a", old: "b", cancelled: "c", rolledBack: "d",
  running: "e", stopped: "f", tagged: "1", digest: "2", foreign: "3", unlabelled: "4" })
  .map(([name, digit]) => [name, `sha256:${digit.repeat(64)}`])) as Record<string, string>;

async function imageCleanupFixture() {
  const f = await tempFixture("task-images-"), socket = join(f.root, "docker.sock");
  const state = join(f.root, "data/state"), mock = join(f.root, "mock"), script = join(f.root, "cleanup.sh");
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  await mkdir(state, { recursive: true }); await mkdir(mock);
  await writeFile(join(state, "task-runtime"), `endpoint=unix://${socket}\ndaemon=task-daemon-01\n`);
  const projectId = createHash("sha256").update(await realpath(f.root)).digest("hex").slice(0, 12);
  for (const [name, id] of Object.entries(imageIds)) {
    const owner = name === "foreign" ? "000000000000" : name === "unlabelled" ? "" : projectId;
    await writeFile(join(mock, id.slice(7)), `${id}|${owner}|${name === "tagged" ? 1 : 0}|${name === "digest" ? 1 : 0}\n`);
  }
  await writeFile(join(mock, "images"), Object.values(imageIds).join("\n"));
  const candidateLibrary = fileURLToPath(new URL("../../scripts/lib/candidate-image.sh", import.meta.url));
  await writeFile(script, `set -euo pipefail
. ${quote(candidateLibrary)}
. ${quote(library)}
PROJECT_DIR=${quote(f.root)}
SERVICE_USER=${quote(`${process.getuid!()}:${process.getgid!()}`)} DOCKER_ROOTLESS=0
IMAGE_ID=${quote(imageIds.current!)} DEPLOYMENT_COMMITTED="\${FIXTURE_COMMITTED:-1}"
mock=${quote(mock)}
docker() {
    printf '%s\\n' "$*" >> "$mock/calls"
    if [ "$1" != --host ]; then
        [ "$*" = "info --format {{.ID}}" ] || return 90
        printf '%s' "\${FIXTURE_MAIN_ID:-main-daemon-01}"; return
    fi
    [ "$2" = ${quote("unix://" + socket)} ] || return 91
    shift 2
    case "$1 $2" in
        'info --format')
            if [[ "$3" = *SecurityOptions* ]]; then printf '%s' '["name=rootless"]'
            else printf '%s' "\${FIXTURE_TASK_ID:-task-daemon-01}"; fi ;;
        'image ls')
            [ "\${FIXTURE_FAILURE:-}" != list ] || return 92
            cat "$mock/images" ;;
        'image inspect')
            local image="\${!#}"
            [ "\${FIXTURE_FAILURE:-}" != current ] || [ "$image" != "$IMAGE_ID" ] || return 93
            [ "\${FIXTURE_FAILURE:-}" != inspect ] || [ "$image" != ${quote(imageIds.old!)} ] || return 94
            if [[ "$*" = *RepoTags* ]]; then cat "$mock/\${image#sha256:}"
            else cut -d '|' -f 1-2 "$mock/\${image#sha256:}"; fi ;;
        'ps --all')
            [ "\${FIXTURE_FAILURE:-}" != ps ] || return 95
            case "\${!#}" in
                ${quote("ancestor=" + imageIds.running)}) printf '%s' running-container ;;
                ${quote("ancestor=" + imageIds.stopped)}) printf '%s' stopped-container ;;
            esac ;;
        'image rm')
            [ "$3" = --no-prune ] && [ "$#" = 4 ] || return 96
            [ "\${FIXTURE_FAILURE:-}" != rm ] || return 97
            rm -- "$mock/\${4#sha256:}"
            printf '%s\\n' "$4" >> "$mock/removed" ;;
        *) return 98 ;;
    esac
}
task_runtime_cleanup_images
`);
  return {
    f, state, mock, projectId,
    async run(env: Record<string, string> = {}) {
      await writeFile(join(mock, "calls"), "");
      const proc = Bun.spawn(["bash", script], { cwd: f.root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, output: out + err, calls: await readFile(join(mock, "calls"), "utf8") };
    },
    async removed() { return (await readFile(join(mock, "removed"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean); },
    async cleanup() { server.stop(true); await f.cleanup(); },
  };
}

test.skipIf(process.platform !== "linux")("task image cleanup keeps rollback copies until committed activation, including pending resume", async () => {
  const f = await imageCleanupFixture();
  try {
    let result = await f.run({ FIXTURE_COMMITTED: "0" });
    expect(result.code).not.toBe(0); expect(result.calls).toBe("");
    await writeFile(join(f.state, "deploy-transaction"), "pending");
    result = await f.run();
    expect(result.code).not.toBe(0); expect(result.calls).toBe("");
    expect(await f.removed()).toEqual([]);
    await rm(join(f.state, "deploy-transaction"));
    result = await f.run(); expect(result.code, result.output).toBe(0);
    expect(await f.removed()).toEqual([imageIds.old!, imageIds.cancelled!, imageIds.rolledBack!]);
    expect(result.calls).not.toContain("--force");
    expect(result.calls).not.toContain("image prune");
    // Current, running and stopped workers, tagged/pinned images and other projects all remain.
    for (const name of ["current", "running", "stopped", "tagged", "digest", "foreign", "unlabelled"]) {
      expect(await Bun.file(join(f.mock, imageIds[name]!.slice(7))).exists()).toBe(true);
    }
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("task image cleanup does not touch a shared daemon or a changed endpoint identity", async () => {
  const f = await imageCleanupFixture();
  try {
    const shared = await f.run({ FIXTURE_MAIN_ID: "task-daemon-01" });
    expect(shared.code, shared.output).toBe(0); expect(shared.calls).not.toContain("image ls");
    const changed = await f.run({ FIXTURE_TASK_ID: "changed-daemon" });
    expect(changed.code).not.toBe(0); expect(changed.calls).not.toContain("image ls");
    expect(await f.removed()).toEqual([]);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("task image cleanup stops on uncertain inventory and retries failed removal on a later commit", async () => {
  const f = await imageCleanupFixture();
  try {
    for (const failure of ["current", "list", "inspect", "ps", "rm"]) {
      const result = await f.run({ FIXTURE_FAILURE: failure });
      expect(result.code, failure).not.toBe(0);
      expect(await f.removed()).toEqual([]);
    }
    const result = await f.run(); expect(result.code, result.output).toBe(0);
    expect(await f.removed()).toEqual([imageIds.old!, imageIds.cancelled!, imageIds.rolledBack!]);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("activation cleans task images only after readiness and transaction completion; cleanup errors are warnings", async () => {
  const f = await tempFixture("task-images-activation-");
  try {
    const deploy = await readFile(fileURLToPath(new URL("../../scripts/deploy/deploy.sh", import.meta.url)), "utf8");
    const activate = /^activate_committed_deployment\(\) \{\n[\s\S]*?\n\}\n/m.exec(deploy)?.[0];
    expect(activate).toBeDefined();
    await mkdir(join(f.root, "data/config"), { recursive: true });
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await writeFile(join(f.root, "data/config/task-deployment.json"), "{}");
    const script = join(f.root, "activation.sh"), trace = join(f.root, "trace");
    await writeFile(script, `set -euo pipefail
PROJECT_DIR=${quote(f.root)} DEPLOY_SNAPSHOT=${quote(join(f.root, "snapshot"))}
IMAGE_ID=${quote(imageIds.current!)} DEPLOYMENT_COMMITTED=1 PREVIOUS_RUNNING=1 PREVIOUS_CONTAINER_SAVED=1
trace=${quote(trace)}
record() { printf '%s\\n' "$*" >> "$trace"; }
task_runtime_retire_previous() { record retire; [ "\${FIXTURE_FAILURE:-}" != retire ]; }
docker() { record "$*"; [ "\${FIXTURE_FAILURE:-}" != health ] || [ "$1" != exec ]; }
sleep() { :; }
print_status() { :; }
print_error() { record error; }
print_warning() { record warning; }
ops_command_hint() { :; }
downtime_ends() { :; }
candidate_publish() { record publish; [ "\${FIXTURE_FAILURE:-}" != publish ]; }
data_preparation_docker() { record "$*"; }
release_transaction_candidate() { record release-candidate; }
cleanup_completed_backup() { :; }
release_previous_image() { record release-previous; }
task_runtime_cleanup_images() {
    [ "$DEPLOYMENT_COMMITTED" = 1 ] && [ ! -e "$PROJECT_DIR/data/state/deploy-transaction" ] || return 99
    record cleanup
    [ "\${FIXTURE_FAILURE:-}" != cleanup ]
}
${activate}
activate_committed_deployment
`);
    for (const failure of ["retire", "health", "publish", "cleanup", ""]) {
      await writeFile(trace, "");
      await writeFile(join(f.root, "data/state/deploy-transaction"), "pending");
      const proc = Bun.spawn(["bash", script], { cwd: f.root, env: { ...process.env, FIXTURE_FAILURE: failure }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const events = (await readFile(trace, "utf8")).trim().split("\n");
      if (["retire", "health", "publish"].includes(failure)) {
        expect(code, out + err).not.toBe(0); expect(events).not.toContain("cleanup");
      } else {
        expect(code, out + err).toBe(0);
        expect(events.indexOf("cleanup")).toBeGreaterThan(events.indexOf("release-previous"));
        expect(events.includes("warning")).toBe(failure === "cleanup");
      }
    }
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("task runtime refuses another owner, a rootful daemon and changed daemon identity before preparing mounts", async () => {
  const f = await tempFixture("task-runtime-endpoint-"), socket = join(f.root, "docker.sock");
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  try {
    const script = join(f.root, "check.sh");
    await writeFile(script, `set -euo pipefail
. ${quote(library)}
TASK_DOCKER_ENDPOINT=${quote("unix://" + socket)} TASK_DOCKER_ID="\${FIXTURE_EXPECT_ID:-}"
docker() {
  case "$*" in
    *SecurityOptions*) printf '%s' "$FIXTURE_SECURITY" ;;
    *info*) printf '%s' daemon-one ;;
    *) exit 91 ;;
  esac
}
task_runtime_check_endpoint "$FIXTURE_USER" 0
printf '%s\\n' "\${TASK_RUNTIME_ARGS[@]}"
`);
    const run = async (env: Record<string, string>) => {
      const proc = Bun.spawn(["bash", script], { cwd: f.root, env: { ...process.env, FIXTURE_USER: `${process.getuid!()}:1000`, FIXTURE_SECURITY: '["name=rootless"]', ...env }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, output: out + err };
    };
    const good = await run({}); expect(good.code, good.output).toBe(0);
    expect(good.output).toContain("MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json");
    expect(good.output).toContain(`src=${socket},dst=/run/mixin-task/docker.sock`);
    expect((await run({ FIXTURE_USER: "999999:999999" })).output).toContain("需要属于宿主 UID 999999");
    expect((await run({ FIXTURE_SECURITY: '["name=seccomp"]' })).output).toContain("没有报告 rootless");
    expect((await run({ FIXTURE_EXPECT_ID: "daemon-other" })).output).toContain("与部署记录不同");
  } finally { server.stop(true); await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("task runtime record roundtrips exact endpoint and daemon, rejecting unknown or duplicate fields", async () => {
  const f = await tempFixture("task-runtime-record-"), record = join(f.root, "runtime"), script = join(f.root, "record.sh");
  try {
    await writeFile(script, `set -euo pipefail
. ${quote(library)}
if [ "$1" = write ]; then
  TASK_DOCKER_ENDPOINT=unix:///run/user/1000/docker.sock TASK_DOCKER_ID=daemon-one
  task_runtime_record ${quote(record)}
fi
task_runtime_read ${quote(record)}
printf '%s|%s' "$TASK_DOCKER_ENDPOINT" "$TASK_DOCKER_ID"
`);
    const run = async (mode: string) => {
      const proc = Bun.spawn(["bash", script, mode], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
      return { code: await proc.exited, output: await new Response(proc.stdout).text() + await new Response(proc.stderr).text() };
    };
    expect(await run("write")).toEqual({ code: 0, output: "unix:///run/user/1000/docker.sock|daemon-one" });
    const good = await readFile(record, "utf8");
    for (const invalid of [good + "daemon=other\n", good + "arbitrary=value\n", "endpoint=tcp://localhost:2375\ndaemon=daemon-one\n", "endpoint=unix:///tmp/a,readonly\ndaemon=daemon-one\n", "endpoint=unix:///tmp/a\n"]) {
      await writeFile(record, invalid); expect((await run("read")).code).not.toBe(0);
    }
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("ops one-off containers check the task socket against the service identity before running", async () => {
  const f = await tempFixture("task-runtime-ops-"), socket = join(f.root, "docker.sock"), project = join(f.root, "project");
  const server = Bun.listen({ unix: socket, socket: { data() {} } });
  try {
    const ops = await readFile(fileURLToPath(new URL("../../scripts/ops/ops.sh", import.meta.url)), "utf8");
    const admin = /^data_admin\(\) \{\n[\s\S]*?\n\}\n/m.exec(ops)?.[0];
    expect(admin).toBeDefined();
    await Bun.write(join(project, "data/config/task-deployment.json"), "{}");
    await Bun.write(join(project, "data/state/task-runtime"), `endpoint=unix://${socket}\ndaemon=daemon-one\n`);
    const script = join(f.root, "admin.sh");
    // ops.sh runs with set -u: every variable the check reads must be assigned before it.
    await writeFile(script, `set -uo pipefail
. ${quote(library)}
PROJECT_DIR=${quote(project)} CONTAINER=mixin-chatbot DEPLOYED_WORKSPACE_ROOT=''
docker() {
  case "$1" in
    ps) return 0 ;;
    --host) case "$*" in *SecurityOptions*) printf '%s' '["name=rootless"]' ;; *info*) printf '%s' daemon-one ;; *) return 99 ;; esac ;;
    run) shift; printf 'RUN %s\n' "$*" ;;
    *) return 98 ;;
  esac
}
docker_rootless() { return 1; }
guard_one_off_container() { return 0; }
service_container_user() { printf '%s' "$FIXTURE_USER"; }
WA() { :; }
ER() { printf 'ERR %s\n' "$*" >&2; }
${admin}
data_admin scripts/ops/tmp-admin.ts preview --all
`);
    const run = async (user: string) => {
      const proc = Bun.spawn(["bash", script], { cwd: f.root, env: { ...process.env, FIXTURE_USER: user }, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, output: out + err };
    };
    const good = await run(`${process.getuid!()}:${process.getgid!()}`);
    expect(good.code, good.output).toBe(0);
    expect(good.output).toContain(`--user ${process.getuid!()}:${process.getgid!()}`);
    expect(good.output).toContain("DOCKER_HOST=unix:///run/mixin-task/docker.sock");
    const other = await run("999999:999999");
    expect(other.code).not.toBe(0);
    expect(other.output).toContain("需要属于宿主 UID 999999");
    expect(other.output).not.toContain("RUN ");
  } finally { server.stop(true); await f.cleanup(); }
});
