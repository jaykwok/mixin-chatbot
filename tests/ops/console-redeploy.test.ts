import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { opsShellFunctions } from "../helpers/ops-shell.ts";
import { deploymentEnvironment } from "../../ops/core/deployment-options.ts";
import { tempFixture } from "../helpers/temp.ts";

const repo = resolve(import.meta.dir, "../.."), ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const posix = (s: string) => s.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, d: string) => "/" + d.toLowerCase());
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
for (const platform of ["windows", "linux"] as const) test.skipIf(platform === "windows" ? process.platform !== "win32" : !bash || !existsSync(bash))(
  `${platform} 重新部署使用固定脚本和真实项目、关闭 stdin、保留子进程失败并核对最终结果`, async () => {
    const f = await tempFixture("console-redeploy-");
    const project = join(f.root, "项目 with spaces"), source = join(f.root, "固定 source");
    const projectArg = platform === "linux" ? posix(project) : project, sourceArg = platform === "linux" ? posix(source) : source;
    try {
      for (const path of ["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json", "data/config/directory.json"]) {
        mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), "{}");
      }
      mkdirSync(join(project, "data/state"), { recursive: true }); mkdirSync(join(source, "scripts"), { recursive: true }); mkdirSync(join(project, "scripts"), { recursive: true });
      const entryName = platform === "windows" ? "deploy.ps1" : "deploy.sh", marker = join(project, "invoked.json"), output = join(project, "result.json");
      writeFileSync(join(project, "scripts", entryName), platform === "windows" ? "exit 99" : "exit 99\n");
      let argv: string[];
      if (platform === "windows") {
        writeFileSync(join(source, "scripts", entryName), "\uFEFF" + [
          "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
          "[IO.File]::WriteAllText((Join-Path $env:MIXIN_OPS_PROJECT 'invoked.json'), (@{project=$env:MIXIN_OPS_PROJECT;port=$env:BOT_PORT;root=$env:WORKSPACE_ROOT;stdin=[Console]::IsInputRedirected}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))",
          "Write-Host ('中文部署输出' * 16000)", "exit ([int]$env:FIXTURE_EXIT)",
        ].join("\r\n"));
        const script = join(f.root, "run.ps1");
        writeFileSync(script, "\uFEFF" + [
          "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
          ". " + ps(join(repo, "scripts/lib/common.ps1")),
          "$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(" + ps(join(repo, "scripts/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
          "if($errors){throw 'syntax'}; foreach($name in @('Invoke-DeployCommand','Invoke-LifecycleOperation','Wait-Local','Write-OpsResult')) { . ([scriptblock]::Create($ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true).Extent.Text)) }",
          "$Project=$env:FIXTURE_PROJECT; $OpsSource=$env:FIXTURE_SOURCE; $Command='deploy'",
          "function Get-FinalRunState { 'running' }; function Test-PendingTransaction { $false }; function Read-StateText { '2022' }; function Test-Local { if($Port -ne '2022'){throw 'wrong final port'}; 200 }; function Err($s) { Write-Host $s }",
          "$okay=Invoke-LifecycleOperation { Invoke-DeployCommand }; if($okay -isnot [bool]){throw 'return polluted'}; if($okay){exit 0}else{exit 1}",
        ].join("\r\n"));
        argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
      } else {
        writeFileSync(join(source, "scripts", entryName), [
          'test ! -t 0 || exit 98',
          'if [ "${FIXTURE_SIGNAL:-}" = 1 ]; then trap \'printf settled > "$MIXIN_OPS_PROJECT/settled"; exit 143\' TERM; printf ready > "$MIXIN_OPS_PROJECT/signal-ready"; while :; do sleep 0.05; done; fi',
          'printf \'{"project":"%s","port":"%s","command":"%s"}\' "$MIXIN_OPS_PROJECT" "$BOT_PORT" "$1" > "$MIXIN_OPS_PROJECT/invoked.json"',
          // A stand-in for the core: it reports the outcome itself, and the wrapper keeps that report.
          'if [ "${FIXTURE_REPORTS:-}" = 1 ]; then printf \'{"command":"deploy","outcome":"refused","exitCode":%s,"finalState":"stopped"}\' "$FIXTURE_EXIT" > "$MIXIN_OPS_RESULT_FILE"; fi',
          "printf '中文部署输出\\n'", 'exit "$FIXTURE_EXIT"',
        ].join("\n"));
        const script = join(f.root, "run.sh");
        writeFileSync(script, ['set -uo pipefail', `source '${posix(join(repo, "scripts/lib/console-plan.sh"))}'`,
          await opsShellFunctions("deploy_command", "run_forwarding", "forward_to_upgrader", "core_reported", "finish_deploy_command", "finish_lifecycle_result", "wait_for_local", "ops_result", "json_escape"),
          'PROJECT_DIR="$FIXTURE_PROJECT"; OPS_SOURCE_DIR="$FIXTURE_SOURCE"; STATE_DIR="$PROJECT_DIR/data/state"; OPS_COMMAND=deploy',
          'operation_start() { :; }; operation_finish() { :; }; final_run_state() { echo running; }; load_saved_settings() { PORT=2022; }; bot_local_ready() { [ "$1" = 2022 ]; }; ER() { echo "$*" >&2; }',
          // The real lock (open_deploy_lock, flock) is covered on Linux by core-lock.test.ts; here only its refusal contract.
          'acquire_deploy_lock() { DEPLOY_LOCK_REFUSAL=""; [ -z "${FIXTURE_REFUSE:-}" ] || { DEPLOY_LOCK_REFUSAL="$FIXTURE_REFUSE"; echo "复核说明" >&2; return 2; }; }',
          'deploy_command',
        ].join("\n"));
        argv = [bash!, posix(script)];
      }
      for (const code of [0, 7, ...(platform === "linux" && process.platform === "linux" ? [143] : [])]) {
        // One result file per console task: the wrapper reports only when the core has not.
        rmSync(output, { force: true });
        const child = Bun.spawn(argv, { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env,
          ...deploymentEnvironment("deploy", { port: 2022, workspace: "", directory: "saved" }, project),
          MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "fixture", MIXIN_OPS_PROJECT: "", MIXIN_OPS_RESULT_FILE: platform === "linux" ? posix(output) : output,
          FIXTURE_PROJECT: projectArg, FIXTURE_SOURCE: sourceArg, FIXTURE_EXIT: String(code), FIXTURE_SIGNAL: code === 143 ? "1" : "" } });
        if (code === 143) {
          const deadline = Date.now() + 5000;
          while (!existsSync(join(project, "signal-ready")) && Date.now() < deadline) await Bun.sleep(10);
          if (!existsSync(join(project, "signal-ready"))) { child.kill(); await child.exited; throw new Error("deployer did not reach signal wait"); }
          child.kill("SIGTERM");
        }
        const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        const expected = platform === "windows" && code ? 1 : code;
        expect(exit, out.slice(-1000) + err).toBe(expected);
        if (code === 143) expect(readFileSync(join(project, "settled"), "utf8")).toBe("settled"); else expect(out).toContain("中文部署输出");
        expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ project: projectArg, port: "2022", ...(platform === "linux" ? { command: "deploy" } : {}) });
        expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ command: "deploy", outcome: code ? "failed" : "success", exitCode: expected, finalState: "running" });
      }
      if (platform === "linux") {
        rmSync(output);
        const child = Bun.spawn(argv, { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env,
          ...deploymentEnvironment("deploy", { port: 2022, workspace: "", directory: "saved" }, project),
          MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "fixture", MIXIN_OPS_PROJECT: "", MIXIN_OPS_RESULT_FILE: posix(output),
          FIXTURE_PROJECT: projectArg, FIXTURE_SOURCE: sourceArg, FIXTURE_EXIT: "9", FIXTURE_SIGNAL: "", FIXTURE_REPORTS: "1" } });
        const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exit, out + err).toBe(9);
        expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ command: "deploy", outcome: "refused", exitCode: 9, finalState: "stopped" });
        // The wrapper takes the lock and rechecks the plan before the deployer: a refusal runs nothing and says so once.
        rmSync(output); rmSync(marker);
        const refusal = "控制台计划复核未通过（原因见任务输出），未执行操作；请重新预览";
        const refused = Bun.spawn(argv, { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env,
          ...deploymentEnvironment("deploy", { port: 2022, workspace: "", directory: "saved" }, project),
          MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "fixture", MIXIN_OPS_PROJECT: "", MIXIN_OPS_RESULT_FILE: posix(output),
          FIXTURE_PROJECT: projectArg, FIXTURE_SOURCE: sourceArg, FIXTURE_EXIT: "0", FIXTURE_SIGNAL: "", FIXTURE_REFUSE: refusal } });
        const [refusedExit, refusedOut, refusedErr] = await Promise.all([refused.exited, new Response(refused.stdout).text(), new Response(refused.stderr).text()]);
        expect({ refusedExit, refusedErr }, refusedOut).toEqual({ refusedExit: 1, refusedErr: "复核说明\n" });
        expect(existsSync(marker)).toBe(false);
        expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ command: "deploy", outcome: "refused", exitCode: 1, finalState: "running", message: refusal });
      }
    } finally { await f.cleanup(); }
  }, 60_000);

test("真实部署入口从固定包加载库，但项目目录与当前目录均指向实际部署", async () => {
  const f = await tempFixture("deployer-source-");
  try {
    const project = join(f.root, "live project"), source = join(f.root, "fixed source"), windows = process.platform === "win32";
    for (const path of [project, join(source, "scripts"), join(source, "scripts/lib")]) mkdirSync(path, { recursive: true });
    const name = windows ? "deploy.ps1" : "deploy.sh";
    writeFileSync(join(source, "scripts", name), readFileSync(join(repo, "scripts", name)));
    if (windows) writeFileSync(join(source, "scripts/lib/common.ps1"), "\uFEFF" + [
      "function Start-OperationLog { [Console]::WriteLine(('PROJECT=' + $Project)); [Console]::WriteLine(('CWD=' + (Get-Location).Path)); exit 0 }",
    ].join("\r\n"));
    else {
      writeFileSync(join(source, "scripts/lib/common.sh"), 'operation_start() { printf "PROJECT=%s\\nCWD=%s\\n" "$PROJECT_DIR" "$PWD"; exit 0; }\n');
      for (const library of ["deployment.sh", "ops-runtime.sh", "core-handoff.sh"]) writeFileSync(join(source, "scripts/lib", library), "# fixture library\n");
      // The real entry changes cwd after operation_start, so capture its resolved project at this early boundary.
    }
    const child = Bun.spawn(windows ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(source, "scripts", name)]
      : ["bash", join(source, "scripts", name)], {
      cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_PROJECT: project },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0); expect(out).toContain("PROJECT=" + project); expect(out).toContain("CWD=" + project);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("real deploy validates incoming console choices first and keeps its loopback default to itself, never rewriting the caller's BOT_HOST", async () => {
  const f = await tempFixture("deployer-default-order-");
  try {
    const work = join(f.root, "work"), source = join(f.root, "fixed"), marker = join(f.root, "after-guard"), guard = join(f.root, "guard.ts");
    // The console redeploys an existing configuration only: the entry checks it right after the lock, before the defaults.
    for (const path of ["package.json", "src/server/index.ts", "ops/config/configure.ts", "data/config/models.json", "data/config/app-bot.json",
      "data/config/directory.json", "data/runtime/pi/settings.json"]) {
      mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), "");
    }
    mkdirSync(join(source, "scripts"), { recursive: true }); mkdirSync(join(source, "scripts/lib"), { recursive: true });
    writeFileSync(join(source, "scripts/deploy.sh"), readFileSync(join(repo, "scripts/deploy.sh")));
    writeFileSync(join(source, "scripts/lib/deployment.sh"), "# No transaction or Docker mutation is allowed in this pre-lock fixture.\n");
    writeFileSync(join(source, "scripts/lib/core-handoff.sh"), "# fixture library\n");
    // Neither Bun nor the core exists here: the core's read-only preflight passes.
    writeFileSync(join(source, "scripts/lib/ops-runtime.sh"), "ops_bun() { echo true; }\n");
    writeFileSync(join(source, "scripts/lib/common.sh"), [
      'source "$FIXTURE_COMMON"',
      'operation_start() { :; }; operation_finish() { :; }; operation_event() { :; }; operation_stage() { :; }',
      'docker() { return 0; }; require_deploy_operator() { DOCKER_ROOTLESS=0; }',
      'saved_workspace_root() { printf "%s|%s" "$BOT_HOST" "$LOOPBACK_HOST" > "$FIXTURE_MARKER"; exit 23; }',
    ].join("\n"));
    const params = { port: 2022, workspace: "", directory: "saved" };
    writeFileSync(guard, `import { assertDeploymentEnvironment } from ${JSON.stringify(pathToFileURL(join(repo, "ops/core/deployment-options.ts")).href)};\n` +
      `assertDeploymentEnvironment("deploy", ${JSON.stringify(params)}, process.env.MIXIN_OPS_PROJECT!);\n`);
    for (const incoming of ["", "0.0.0.0"]) {
      if (existsSync(marker)) unlinkSync(marker);
      const child = Bun.spawn(["bash", join(source, "scripts/deploy.sh")], { cwd: work, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, ...deploymentEnvironment("deploy", params, work), BOT_HOST: incoming, BOT_DEPLOY_LOCK_HELD: "",
          MIXIN_OPS_PROJECT: work, MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_TASK_ID: "fixture", MIXIN_OPS_BUN: process.execPath,
          MIXIN_OPS_GUARD: guard, MIXIN_OPS_EXPECT_CODE: "0".repeat(64), FIXTURE_COMMON: join(repo, "scripts/lib/common.sh"), FIXTURE_MARKER: marker } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(incoming ? 1 : 23);
      // The core checks the exported choices again under the lock: a rewritten BOT_HOST would read as a choice not passed on.
      if (!incoming) expect(readFileSync(marker, "utf8")).toBe("|127.0.0.1");
      else { expect(err).toContain("BOT_HOST"); expect(existsSync(marker)).toBe(false); }
    }
  } finally { await f.cleanup(); }
});
