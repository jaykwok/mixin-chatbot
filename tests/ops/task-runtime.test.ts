import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { tempFixture } from "../helpers/temp.ts";

const library = fileURLToPath(new URL("../../scripts/lib/task-runtime.sh", import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

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
    const admin = /^group_data_admin\(\) \{\n[\s\S]*?\n\}\n/m.exec(ops)?.[0];
    expect(admin).toBeDefined();
    await Bun.write(join(project, "data/config/task-deployment.json"), "{}");
    await Bun.write(join(project, "data/state/task-runtime"), `endpoint=unix://${socket}\ndaemon=daemon-one\n`);
    const script = join(f.root, "admin.sh");
    // ops.sh runs with set -u: every variable the check reads must be assigned before it.
    await writeFile(script, `set -uo pipefail
. ${quote(library)}
PROJECT_DIR=${quote(project)} CONTAINER=mixin-chatbot
DEFAULT_GROUP_DATA_ROOT="$PROJECT_DIR/data/groups" DEPLOYED_GROUP_DATA_ROOT="$PROJECT_DIR/data/groups"
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
resolve_group_data_root() { printf '%s' "$1"; }
WA() { :; }
ER() { printf 'ERR %s\n' "$*" >&2; }
${admin}
group_data_admin scripts/ops/tmp-admin.ts preview --all
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
