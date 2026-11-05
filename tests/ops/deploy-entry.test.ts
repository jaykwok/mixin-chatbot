import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCandidateRecord } from "../../scripts/ops/core/docker-deployment.ts";
import { readDeployStage } from "../../scripts/ops/core/deploy-stage.ts";
import { serializeTransactionRecord } from "../../scripts/ops/core/transaction-record.ts";
import { tempFixture } from "../helpers/temp.ts";

// The Linux deployment entry (scripts/deploy/deploy.sh): first its hand-over pieces cut out with the preview container and
// the record writers stubbed, then the unmodified script run up to the hand-over with Docker, the build and the core
// replaced (tests/helpers/deploy-entry-stubs.sh, deploy-entry-bun.sh). Stop, configuration, verification and rollback run
// in core-docker-deploy.test.ts.
const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const available = !!bash && existsSync(bash);
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
// Settings the test runner itself may carry never reach the fixtures.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BOT_|PI_)/i.test(name)));

function entryFunctions(...names: string[]): string {
  const source = "\n" + readFileSync(join(project, "scripts/deploy/deploy.sh"), "utf8").replaceAll("\r\n", "\n");
  return names.map(name => {
    const from = source.indexOf("\n" + name + "() {\n");
    if (from < 0) throw new Error("deploy.sh has no function " + name);
    return source.slice(from + 1, source.indexOf("\n}\n", from) + 3);
  }).join("\n");
}

async function run(root: string, lines: string[], env: Record<string, string> = {}) {
  const script = join(root, "run.sh");
  writeFileSync(script, ["set -euo pipefail", ...lines].join("\n") + "\n");
  const child = Bun.spawn([bash!, posixPath(script)], { cwd: root, env: { ...inherited, ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

test.skipIf(!available)("部署暂存运行参数：按名称模式转交已导出的非空 BOT_* 和 PI_CACHE_RETENTION，取哪些键交给目标版本；端口和监听地址用本次确定的值", async () => {
  const f = await tempFixture("deploy-entry-runtime-");
  try {
    const body = [entryFunctions("stage_runtime_values"),
      "PROJECT_DIR=/project; PREVIEW_DIR=/stage; IMAGE_ID=sha256:fixture; UNCHANGED=unchanged; BOT_PORT=2022; LOOPBACK_HOST=127.0.0.1; BOT_LOCAL=1",
      'print_error() { echo "ERR $*" >&2; }'];
    const env = { BOT_RUN_TIMEOUT_SECONDS: "5", BOT_CLOSEOUT_SECONDS: "7", PI_CACHE_RETENTION: "long", BOT_EMPTY: "", OTHER_SETTING: "1", PI_OTHER: "1",
      BOT_PORT: "9999", BOT_HOST: "0.0.0.0" };
    const result = await run(f.root, [...body,
      'run_preview() { printf "%s\\n" "$@"; printf "seen=%s\\n" "$(printenv BOT_CLOSEOUT_SECONDS)"; }', "stage_runtime_values"], env);
    expect(result.code, result.out + result.err).toBe(0);
    const args = result.out.trim().split("\n"), tail = args.indexOf("-v");
    const forwarded = args.slice(0, tail).filter((_, index) => index % 2 === 1);
    expect(args.slice(0, tail).filter((_, index) => index % 2 === 0).every(flag => flag === "-e")).toBe(true);
    expect(forwarded.slice(0, -2).sort()).toEqual(["BOT_CLOSEOUT_SECONDS", "BOT_RUN_TIMEOUT_SECONDS", "PI_CACHE_RETENTION"]);
    expect(forwarded.slice(-2)).toEqual(["BOT_PORT=2022", "BOT_HOST=127.0.0.1"]);
    expect(args.slice(tail)).toEqual(["-v", "/project/data:/app/data:ro", "-v", "/stage:/preview", "sha256:fixture",
      "bun", "run", "scripts/config/runtime-settings.ts", "--prepare-values", "/preview/runtime-values.json", "--deployment", "docker", "seen=7"]);

    const refused = await run(f.root, [...body, "run_preview() { return 3; }", "stage_runtime_values", "echo continued"], env);
    expect(refused.code).toBe(1); expect(refused.out).not.toContain("continued");
    expect(refused.err).toContain("ERR 运行参数校验未通过（原因见上方）；unchanged");
  } finally { await f.cleanup(); }
});

test.skipIf(!available)("部署暂存的选择和事实：核心能读回入口写下的记录，共享资料目录中的引号和反斜杠原样保留，记录只给运维身份读", async () => {
  const f = await tempFixture("deploy-entry-records-");
  try {
    const stage = join(f.root, "stage"), target = "c".repeat(40), workspace = '/srv/shared "team"\\files';
    mkdirSync(stage);
    writeFileSync(join(stage, "runtime-values.json"), JSON.stringify({ format: 1, base: null, values: { BOT_PORT: "2022" } }));
    const result = await run(f.root, [entryFunctions("write_stage_records"),
      `declare -A CANDIDATE=([target_sha]=${target}); PREVIEW_DIR='${posixPath(stage)}'; BOT_PORT=2022; REVISION_CLEANUP_CHOICE=skip`,
      "ORIGINAL_CONTAINER_ID=''; ORIGINAL_CONTAINER_IMAGE=''; ORIGINAL_CONTAINER_DATA=''", 'HOST_WORKSPACE_ROOT="$FIXTURE_WORKSPACE"',
      'write_candidate_record() { echo candidate > "$1/candidate-image"; }; write_service_user_record() { echo user > "$1/service-user"; }',
      'task_runtime_record() { echo daemon > "$1"; }', "write_stage_records"], { FIXTURE_WORKSPACE: workspace });
    expect(result.code, result.out + result.err).toBe(0);
    const read = readDeployStage(stage);
    expect(read.choices).toEqual({ format: 1, target, port: 2022, workspace, cleanup: "skip" });
    expect(read.platform).toEqual({ "candidate-image": "candidate\n", "service-user": "user\n", "task-runtime": "daemon\n", facts: "format=1\ncontainer=\nimage=\ndata=\n" });
    if (process.platform !== "win32") for (const name of ["deployment.json", "facts"]) expect(statSync(join(stage, name)).mode & 0o777, name).toBe(0o600);

    // A record writer that fails stops before the choices: the core then refuses the incomplete stage.
    const failed = join(f.root, "failed"); mkdirSync(failed);
    const refused = await run(f.root, [entryFunctions("write_stage_records"),
      `declare -A CANDIDATE=([target_sha]=${target}); PREVIEW_DIR='${posixPath(failed)}'; BOT_PORT=2022; REVISION_CLEANUP_CHOICE=skip; HOST_WORKSPACE_ROOT=''`,
      "ORIGINAL_CONTAINER_ID=''; ORIGINAL_CONTAINER_IMAGE=''; ORIGINAL_CONTAINER_DATA=''",
      "write_candidate_record() { :; }; write_service_user_record() { return 1; }; task_runtime_record() { :; }",
      "write_stage_records || echo refused=$?"]);
    expect(refused.out.trim()).toBe("refused=1"); expect(existsSync(join(failed, "deployment.json"))).toBe(false);
  } finally { await f.cleanup(); }
});

const linux = process.platform === "linux" && available;
const IMAGE = "sha256:" + "c".repeat(64), ORIGINAL = "d".repeat(64), ORIGINAL_IMAGE = "sha256:" + "e".repeat(64);
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

/** A release checkout with the real deploy.sh and libraries plus the stubs, initialized as a Git repository. */
async function release(name: string, setup: { config?: boolean; deployed?: boolean; directory?: boolean } = {}) {
  const f = await tempFixture(name), root = join(realpathSync(f.root), "project");
  for (const directory of ["scripts/deploy", "scripts/lib", "scripts/config", "src/server", "data/config", "data/state", "data/runtime/pi"]) mkdirSync(join(root, directory), { recursive: true });
  copyFileSync(join(project, "scripts/deploy/deploy.sh"), join(root, "scripts/deploy/deploy.sh"));
  for (const name of readdirSync(join(project, "scripts/lib"))) if (name.endsWith(".sh")) copyFileSync(join(project, "scripts/lib", name), join(root, "scripts/lib", name));
  appendFileSync(join(root, "scripts/lib/core-handoff.sh"), "\n" + readFileSync(join(project, "tests/helpers/deploy-entry-stubs.sh"), "utf8"));
  const bun = join(f.root, "bun"); copyFileSync(join(project, "tests/helpers/deploy-entry-bun.sh"), bun); chmodSync(bun, 0o755);
  for (const path of ["package.json", "src/server/index.ts", "scripts/config/configure.ts"]) writeFileSync(join(root, path), "");
  if (setup.config) for (const path of ["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json"]) writeFileSync(join(root, path), "{}\n");
  if (setup.deployed) writeFileSync(join(root, "data/state/bot-port"), "3000\n");
  if (setup.directory) writeFileSync(join(root, "data/config/directory.json"), '{"format":1,"all":true}\n');
  git(root, "init", "--quiet"); git(root, "add", "package.json"); git(root, "commit", "--quiet", "-m", "fixture");
  const head = git(root, "rev-parse", "HEAD"), events = join(f.root, "events"), capture = join(f.root, "capture");
  const run = async (env: Record<string, string> = {}, input = "") => {
    writeFileSync(events, ""); rmSync(capture, { recursive: true, force: true });
    const child = Bun.spawn(["bash", join(root, "scripts/deploy/deploy.sh")], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...inherited, FIXTURE_EVENTS: events, FIXTURE_BUN: bun, FIXTURE_CAPTURE: capture, FIXTURE_IMAGE: IMAGE,
        ...setup.deployed ? { FIXTURE_ORIGINAL: ORIGINAL, FIXTURE_ORIGINAL_IMAGE: ORIGINAL_IMAGE } : {}, ...env } });
    child.stdin.write(input); child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: out + err, out, events: readFileSync(events, "utf8").trim().split("\n") };
  };
  return { root, head, capture, run, stages: () => existsSync(join(root, "tmp")) ? readdirSync(join(root, "tmp")) : [], cleanup: () => f.cleanup() };
}
const handover = (events: string[]) => events.findIndex(line => line.startsWith("bun ") && line.includes(" --stage "));

test.skipIf(!linux)("部署入口：停机前问完全部问题、核对完全部事实，再把完整的暂存交给核心；入口自己不停服务、不改容器", async () => {
  const f = await release("deploy-entry-run-", { config: true, deployed: true, directory: true });
  try {
    const result = await f.run({}, "n\n");
    expect(result.code, result.output).toBe(0);
    expect(result.events.filter(line => line === "FORBIDDEN")).toEqual([]);
    // The question about the models comes before the hand-over, and nothing after it asks.
    const out = result.out, asked = out.indexOf("是否重新配置 AI"), handed = out.indexOf("CORE-HANDOVER");
    expect(asked).toBeGreaterThan(-1); expect(asked).toBeLessThan(handed);
    expect(out.slice(handed)).not.toContain("?>");
    // The read-only core preflight comes before the build, every check before the hand-over, which is the last core call.
    const order = ["operator", "bun ", "build ", "task-runtime", "docker run --rm --network none", "stop-space"]
      .map(prefix => result.events.findIndex(line => line.startsWith(prefix)));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), result.events.join("\n")).toBe(true);
    expect(result.events[order[1]!]).toBe(`bun --no-env-file ${f.root}/scripts/ops/core/cli.ts deployment deploy --project ${f.root} --preflight`);
    const core = handover(result.events), stagePath = result.events[core]!.split(" --stage ")[1]!.split(" ")[0]!;
    expect(core).toBeGreaterThan(order.at(-1)!);
    expect(result.events[core]).toBe(`bun --no-env-file ${f.root}/scripts/ops/core/cli.ts deployment deploy --project ${f.root} --stage ${stagePath} --command deploy`);
    expect(result.events.slice(core + 1).filter(line => line.startsWith("bun ") || line.startsWith("docker run"))).toEqual([]);
    // Previews run the candidate by ID as the recorded identity, without network, with data/ read-only.
    const previews = result.events.filter(line => / scripts\/(runtime\/(data-current|revision-cleanup)|config\/runtime-settings)\.ts /.test(line));
    expect(previews).toHaveLength(3);
    for (const line of previews) {
      expect(line, line).toContain("--network none --user 0:0"); expect(line, line).toContain(`-v ${f.root}/data:/app/data:ro`); expect(line, line).toContain(IMAGE);
    }
    // The hand-over carries every decision and fact; the core inherits the deployment lock and gets no terminal.
    const stage = readDeployStage(f.capture);
    expect(stage.choices).toEqual({ format: 1, target: f.head, port: 3000, workspace: "", cleanup: "apply" });
    expect(stage.runtime.value.values).toEqual({ BOT_PORT: "3000", BOT_HOST: "127.0.0.1" });
    expect(stage.plan).toBe("{}\n"); expect(stage.directoryPlan).toBeNull(); expect(stage.configuration).toEqual({});
    expect(parseCandidateRecord(stage.platform["candidate-image"]!)).toMatchObject({ source: "workspace", target_sha: f.head, image_id: IMAGE });
    expect(stage.platform["service-user"]).toBe("format=1\nuser=0:0\nsource=container\n");
    expect(stage.platform["task-runtime"]).toBe("endpoint=unix:///run/user/1002/docker.sock\ndaemon=task-daemon-01\n");
    expect(stage.platform.facts).toBe(`format=1\ncontainer=${ORIGINAL}\nimage=${ORIGINAL_IMAGE}\ndata=${f.root}/data\n`);
    expect(readFileSync(f.capture + ".env", "utf8")).toBe(`stdin=/dev/null\nlock=${f.root}/data/state/deploy.lock\nhost=unset\n`);
    // The entry removes its stage (it holds credentials) and the reserved tag the finished transaction no longer needs.
    expect(f.stages()).toEqual([]); expect(result.events.slice(core).some(line => line.startsWith("release mixin-chatbot:candidate-"))).toBe(true);
  } finally { await f.cleanup(); }
});

// A console task exports every runtime key (empty unless chosen) and the core compares that environment with the accepted task
// under the lock: the entry must hand it over unchanged. The service still listens on loopback through the staged runtime values.
test.skipIf(!linux)("部署入口：调用方环境中的 BOT_HOST 原样交给核心，运行参数仍只监听本机回环", async () => {
  const f = await release("deploy-entry-host-", { config: true, deployed: true, directory: true });
  try {
    for (const host of ["", "0.0.0.0"]) {
      const result = await f.run({ BOT_HOST: host }, "n\n");
      expect(result.code, result.output).toBe(0);
      expect(readFileSync(f.capture + ".env", "utf8")).toBe(`stdin=/dev/null\nlock=${f.root}/data/state/deploy.lock\nhost=${host}\n`);
      expect(readDeployStage(f.capture).runtime.value.values).toEqual({ BOT_PORT: "3000", BOT_HOST: "127.0.0.1" });
      expect(result.out).toContain("本机管理:  127.0.0.1:3000");
    }
  } finally { await f.cleanup(); }
});

test.skipIf(!linux)("部署入口：缺少的通讯录范围在停机前选定，计划随暂存交给核心", async () => {
  const f = await release("deploy-entry-scope-", { config: true, deployed: true });
  try {
    const refused = await f.run({}, "n\n");
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain("没有选定通讯录同步范围（原因见上方）；服务尚未停止，未做任何改动");
    expect(handover(refused.events)).toBe(-1); expect(f.stages()).toEqual([]);
    const result = await f.run({ BOT_DIRECTORY_SCOPE: "all" }, "n\n");
    expect(result.code, result.output).toBe(0);
    const choose = result.events.find(line => line.includes(" scripts/config/directory-scope.ts choose "))!;
    expect(choose).toContain("-e BOT_DIRECTORY_SCOPE"); expect(choose).toContain("--plan /preview/directory-scope-plan.json");
    expect(result.events.indexOf(choose)).toBeLessThan(handover(result.events));
    expect(readDeployStage(f.capture).directoryPlan).toBe('{"format":1,"all":true}\n');
  } finally { await f.cleanup(); }
});

test.skipIf(!linux)("部署入口：首次部署没有终端时在停机前拒绝运行配置向导；只核对数据版本，不交给核心，暂存和保留标签都收尾", async () => {
  const f = await release("deploy-entry-first-");
  try {
    const result = await f.run();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("首次配置 AI（provider/key/model）需要在终端里运行向导；服务尚未停止，未做任何改动");
    expect(result.events.some(line => line.includes(" scripts/runtime/data-current.ts check "))).toBe(true);
    expect(handover(result.events)).toBe(-1); expect(result.events.filter(line => line === "FORBIDDEN")).toEqual([]);
    expect(result.events.some(line => line.startsWith("release mixin-chatbot:candidate-"))).toBe(true); expect(f.stages()).toEqual([]);
  } finally { await f.cleanup(); }
});

test.skipIf(!linux)("部署入口：核心预检拒绝、构建失败或有未完成的事务时，在交给核心之前停止", async () => {
  const f = await release("deploy-entry-refusals-", { config: true, deployed: true, directory: true });
  try {
    const failed = await f.run({ FIXTURE_PREFLIGHT: "1" });
    expect(failed.code).toBe(1); expect(failed.output).toContain("部署预检未通过（原因见上方）；服务尚未停止");
    expect(failed.events.some(line => line.startsWith("build "))).toBe(false);
    const build = await f.run({ FIXTURE_BUILD: "1" });
    expect(build.code).toBe(1); expect(build.output).toContain("镜像构建失败（原因见上方）；服务尚未停止");
    expect(handover(build.events)).toBe(-1);
    const name = "deploy-" + "a".repeat(32), snapshot = join(f.root, "backup/snapshots", name);
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "transaction"), serializeTransactionRecord({ format: "2", operation: "deploy", snapshot: name, target_sha: f.head, original_sha: "",
      original_branch: "", original_workspace_root: "", target_workspace_root: "", was_running: "1", bot_port: "3000", reconfigure_ai: "0" }));
    writeFileSync(join(f.root, "data/state/deploy-transaction"), name + "\n");
    const pending = await f.run();
    expect(pending.code).toBe(1);
    expect(pending.output).toContain(`未完成的部署：目标提交 ${f.head.slice(0, 7)}`);
    expect(pending.output).toContain("续做和回滚只使用事务记录，不重新部署");
    expect(pending.events.some(line => line.startsWith("bun ") || line.startsWith("build "))).toBe(false);
  } finally { await f.cleanup(); }
});

test.skipIf(!linux)("部署入口：核心的退出码原样带回；事务已发布时说明继续或回滚并保留候选标签，未发布时释放它", async () => {
  const f = await release("deploy-entry-core-", { config: true, deployed: true, directory: true });
  try {
    const kept = await f.run({ FIXTURE_CORE: "3", FIXTURE_POINTER: "deploy-" + "b".repeat(32) }, "n\n");
    expect(kept.code).toBe(3); expect(kept.output).toContain("部署未完成，事务已保留（原因见上方）");
    expect(kept.events.slice(handover(kept.events)).some(line => line.startsWith("release "))).toBe(false); expect(f.stages()).toEqual([]);
    rmSync(join(f.root, "data/state/deploy-transaction"));
    const refused = await f.run({ FIXTURE_CORE: "1" }, "n\n");
    expect(refused.code).toBe(1); expect(refused.output).not.toContain("部署未完成，事务已保留");
    expect(refused.events.slice(handover(refused.events)).some(line => line.startsWith("release mixin-chatbot:candidate-"))).toBe(true);
  } finally { await f.cleanup(); }
});

// Ctrl+C and a hangup reach the terminal's whole foreground process group, which the entry leads, while the docker client (a
// child process) removes the reserved tag: the release must finish all the same. Windows cannot deliver the signals to bash.
test.skipIf(!linux)("部署入口在事务指针发布之前退出、构建失败或被中断时释放保留标签，收尾期间再来的中断不打断它；指针发布后由事务负责", async () => {
  const f = await tempFixture("deploy-entry-release-");
  try {
    const script = join(f.root, "release.sh");
    writeFileSync(script, [
      `PROJECT_DIR="$1" DATA_DIR="$1/data" UNCHANGED=unchanged`, `mkdir -p "$1/data/state"`,
      `. '${join(project, "scripts/lib/deployment.sh")}'`, `. '${join(project, "scripts/lib/core-handoff.sh")}'`,
      `release_transaction_candidate() { bash -c 'for signal in INT TERM HUP; do kill -s "$signal" -- "-$1"; done; sleep 0.5; echo released' - "$$"; }`,
      `operation_finish() { echo "finished $1"; }`,
      "print_status() { :; }; print_success() { :; }; print_error() { echo error; }; print_warning() { echo warning; }",
      `docker() { return 1; }; check_build_disk_space() { :; }; prepare_candidate_image() { return "$BUILD"; }`,
      entryFunctions("build_workspace_candidate"),
      `trap cleanup_before_pointer EXIT`, `trap_preparation_signals`, `[ "$2" != build ] || build_workspace_candidate`, "exit 7"].join("\n") + "\n");
    const run = async (mode: string, build = 0) => {
      const child = Bun.spawn(["bash", script, f.root, mode], { env: { ...inherited, BUILD: String(build) }, stdout: "pipe", stderr: "pipe", detached: true });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: (out + err).trim() };
    };
    expect(await run("exit")).toEqual({ code: 7, output: "released\nfinished 7" });
    // A failed or interrupted build releases the tag as well: it exists before the build ends.
    expect(await run("build", 1)).toEqual({ code: 1, output: "error\nreleased\nfinished 1" });
    expect(await run("build", 130)).toEqual({ code: 130, output: "warning\nreleased\nfinished 130" });
    // Once the pointer is published the transaction's commit or rollback owns the tag.
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "deploy-fixture\n");
    expect(await run("exit")).toEqual({ code: 7, output: "finished 7" });
  } finally { await f.cleanup(); }
});
