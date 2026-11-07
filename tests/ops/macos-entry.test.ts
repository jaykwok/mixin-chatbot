import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { LAUNCHD_LABEL, LaunchdPlatform, SERVICE_ACCOUNT } from "../../ops/core/launchd-host.ts";
import { ensureServiceAccount } from "../../ops/core/macos-account.ts";
import { assertConsoleLifecycle } from "../../ops/core/macos-deploy.ts";
import { doctorReport } from "../../ops/core/macos-doctor.ts";
import { main } from "../../ops/core/macos-entry.ts";
import { hint } from "../../ops/core/macos-terminal.ts";
import { opsCommand } from "../../ops/core/platform.ts";

const root = resolve(import.meta.dir, "../..");
const darwin = process.platform === "darwin";

/** dscl and id as a script: `users`/`groups` are the taken IDs; the account exists once its user record was created. */
function directoryService(options: { users?: number[]; groups?: number[]; existing?: boolean; failOn?: string } = {}) {
  const calls: string[] = [];
  let created = options.existing ?? false, id = 0;
  const run = async (argv: string[]) => {
    const line = argv.join(" "); calls.push(line);
    if (argv[0] === "/usr/bin/id") return created ? { code: 0, stdout: `${options.existing ? 499 : id}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no such user" };
    if (argv[2] === "-list") return { code: 0, stdout: (argv[3] === "/Users" ? options.users ?? [] : options.groups ?? []).map(value => `_x${value}  ${value}`).join("\n") + "\n", stderr: "" };
    if (argv[2] === "-read") return { code: 1, stdout: "", stderr: "eDSRecordNotFound" };
    if (options.failOn && line.includes(options.failOn)) return { code: 1, stdout: "", stderr: "denied" };
    if (argv[2] === "-create" && argv[3] === `/Users/${SERVICE_ACCOUNT}` && argv[4] === "UniqueID") { created = true; id = Number(argv[5]); }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("服务账户：已有时沿用；新建时 UID 与 GID 取同一个空闲号，带自己的组、无 shell、无家目录、无密码、隐藏", async () => {
  const kept = directoryService({ existing: true });
  expect(await ensureServiceAccount(kept.run)).toEqual({ identity: { uid: 499, gid: 499 }, created: false });
  expect(kept.calls.some(call => call.includes("-create"))).toBe(false);

  const made = directoryService({ users: [480, 501], groups: [479, 20] });
  expect(await ensureServiceAccount(made.run)).toEqual({ identity: { uid: 478, gid: 478 }, created: true });
  const creates = made.calls.filter(call => call.includes("-create"));
  for (const expected of [`/Groups/${SERVICE_ACCOUNT} PrimaryGroupID 478`, `/Users/${SERVICE_ACCOUNT} UniqueID 478`, `/Users/${SERVICE_ACCOUNT} PrimaryGroupID 478`,
    `/Users/${SERVICE_ACCOUNT} UserShell /usr/bin/false`, `/Users/${SERVICE_ACCOUNT} NFSHomeDirectory /var/empty`, `/Users/${SERVICE_ACCOUNT} Password *`, `/Users/${SERVICE_ACCOUNT} IsHidden 1`])
    expect(creates.some(call => call.endsWith(expected))).toBe(true);
  // The group comes first: the user's primary group must exist when the user does.
  expect(creates[0]).toBe(`/usr/bin/dscl . -create /Groups/${SERVICE_ACCOUNT}`);

  const broken = directoryService({ failOn: "UserShell" });
  await expect(ensureServiceAccount(broken.run)).rejects.toThrow("dscl");
  expect(broken.calls.filter(call => call.includes("-delete"))).toEqual([`/usr/bin/dscl . -delete /Users/${SERVICE_ACCOUNT}`, `/usr/bin/dscl . -delete /Groups/${SERVICE_ACCOUNT}`]);
});

test("控制台调用 macOS 入口：系统 bash 只做交接，Bun 取控制台自己的；提示指向控制台页面或 sudo 命令", () => {
  const command = opsCommand("macos", ["tmp-purge", "--group", "123", "--days", "7"], "/opt/mixin-bot", "/opt/mixin-bot", "console");
  expect(command).toEqual({ command: "/bin/bash", args: [join("/opt/mixin-bot", "scripts", "ops.sh"), "tmp-purge", "--group=123", "--days=7"],
    env: { MIXIN_OPS_UI: "console", MIXIN_OPS_BUN: process.execPath } });
  expect(hint("restart", { MIXIN_OPS_UI: "console" })).toBe("「维护 → 重启」");
  expect(hint("restart", {})).toBe("sudo bash scripts/ops.sh restart");
  expect(hint("tmp-ls", { MIXIN_OPS_UI: "console" })).toBe("sudo bash scripts/ops.sh tmp-ls");
});

test("控制台部署和升级必须带明确选择；恢复入口不检查", async () => {
  const f = await tempFixture("macos-console-lifecycle-");
  try {
    const project = f.root;
    expect(() => assertConsoleLifecycle("deploy", project, "main", {})).not.toThrow();
    const base = { MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_LIFECYCLE: "update", MIXIN_OPS_TASK_ID: "task-1", MIXIN_OPS_SWITCH_MAIN: "0", MIXIN_OPS_DIRECTORY: "all", BOT_DIRECTORY_SCOPE: "all" };
    expect(() => assertConsoleLifecycle("deploy", project, "main", base)).toThrow("明确选择或任务记录");
    expect(() => assertConsoleLifecycle("update", project, "feature", base)).toThrow("未允许切换到 main");
    expect(() => assertConsoleLifecycle("update", project, "main", { ...base, MIXIN_OPS_SWITCH_MAIN: "" })).toThrow("是否允许切换分支");
    expect(() => assertConsoleLifecycle("update", project, "main", { ...base, MIXIN_OPS_DIRECTORY: "saved", BOT_DIRECTORY_SCOPE: "" })).toThrow("已保存的通讯录范围");
    expect(() => assertConsoleLifecycle("update", project, "main", base)).toThrow("缺少已有配置");
    for (const file of ["data/config/models.json", "data/config/app-bot.json", "data/runtime/pi/settings.json"]) {
      await mkdir(join(project, file, ".."), { recursive: true }); await writeFile(join(project, file), "{}");
    }
    expect(() => assertConsoleLifecycle("update", project, "main", base)).not.toThrow();
    await writeFile(join(project, "data/config/directory.json"), "{}");
    expect(() => assertConsoleLifecycle("update", project, "main", base)).toThrow("首次通讯录范围");
  } finally { await f.cleanup(); }
});

test("macOS 体检：与 ops.sh 相同的 JSON 字段；未部署时 LaunchDaemon 与本地健康失败，并指向部署", async () => {
  const f = await tempFixture("macos-doctor-");
  try {
    const project = f.root;
    await writeFile(join(project, "package.json"), JSON.stringify({ version: "2.0.0" }));
    const service = new LaunchdPlatform(project, { plist: join(project, "absent.plist"), euid: () => 0, processes: () => new Map(), kill: () => 0,
      run: async argv => argv[0] === "/usr/bin/id" ? { code: 1, stdout: "", stderr: "no such user" } : argv.join(" ").endsWith(`print system/${LAUNCHD_LABEL}`)
        ? { code: 113, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" } });
    const report = await doctorReport({ project, bun: process.execPath, path: "/usr/bin:/bin", env: {}, service });
    expect(Object.keys(report)).toEqual(["pass", "warn", "fail", "port", "checks"]);
    expect(report.port).toBe(10000);
    const rows = Object.fromEntries(report.checks.map(row => [row.name, row]));
    expect(rows.LaunchDaemon).toMatchObject({ status: "fail", detail: "未安装，且没有健康的前台机器人", fix: expect.stringContaining("sudo bash scripts/ops.sh deploy") });
    expect(rows["本地机器人健康"]).toMatchObject({ status: "fail" });
    expect(rows["data/config/app-bot.json"]).toMatchObject({ status: "fail" });
    expect(rows["共享资料目录"]).toMatchObject({ status: "pass" });
    expect(report.fail).toBe(report.checks.filter(row => row.status === "fail").length);
    for (const row of report.checks) expect(Object.keys(row)).toEqual(["name", "status", "detail", "fix"]);
  } finally { await f.cleanup(); }
});

test.skipIf(darwin)("macOS 入口只在 macOS 上运行", async () => {
  expect(await main(["ops", "help"])).toBe(1);
});

test.skipIf(!darwin || process.geteuid?.() === 0)("macOS 入口：帮助不需要 root；其他命令要求 sudo，未知命令和多余参数报用法错误", async () => {
  const run = (script: string, ...args: string[]) => Bun.spawnSync(["/bin/bash", join(root, "scripts", script), ...args], { cwd: root, env: { ...process.env, MIXIN_OPS_BUN: process.execPath } });
  const help = run("ops.sh");
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("mixin-bot 运维工具（macOS，实验性支持）");
  const doctor = run("ops.sh", "doctor");
  expect(doctor.exitCode).toBe(1);
  expect(doctor.stderr.toString()).toContain("需要 root");
  const unknown = run("ops.sh", "restrat");
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr.toString()).toContain("无法识别的命令：restrat");
  const deploy = run("deploy.sh", "bogus");
  expect(deploy.exitCode).toBe(2);
  const upgrader = run("upgrade.sh", root, "a".repeat(40));
  expect(upgrader.exitCode).toBe(2);
  expect(upgrader.stderr.toString()).toContain("需要从目标提交导出后运行");
}, 60_000);
