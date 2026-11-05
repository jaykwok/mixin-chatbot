import { expect, test } from "bun:test";
import { hostingCheck, systemdRunArgv, windowsArguments, type HostFacts } from "../../scripts/ops/console/hosting.ts";
import { sshForwardHint } from "../../scripts/ops/console/open.ts";

type Reply = { code?: number; stdout?: string; stderr?: string };

function host(platform: NodeJS.Platform, uid: number | undefined, replies: Record<string, Reply>, extra: Partial<HostFacts> = {}) {
  const calls: string[] = [];
  const facts: HostFacts = {
    platform, uid, systemdBooted: () => true, which: command => `/usr/bin/${command}`,
    run: async argv => {
      const key = argv.join(" ");
      calls.push(key);
      const reply = Object.entries(replies).find(([prefix]) => key.startsWith(prefix))?.[1] ?? {};
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    },
    ...extra,
  };
  return { facts, calls };
}

test("Windows 后台托管需要管理员终端", async () => {
  const user = host("win32", undefined, { powershell: { stdout: "False\r\n" } });
  expect(await hostingCheck(user.facts)).toMatchObject({ ok: false, reason: expect.stringContaining("管理员终端") });
  const admin = host("win32", undefined, { powershell: { stdout: "True\r\n" } });
  expect(await hostingCheck(admin.facts)).toMatchObject({ ok: true, mechanism: "windows-task" });
});

test("Linux 没有 systemd 或 systemd-run 时拒绝，不改用终端后台进程", async () => {
  const none = host("linux", 0, {}, { systemdBooted: () => false });
  expect(await hostingCheck(none.facts)).toMatchObject({ ok: false, reason: expect.stringContaining("没有以 systemd 启动") });
  expect(none.calls).toEqual([]);
  const noRun = host("linux", 0, {}, { which: () => null });
  expect(await hostingCheck(noRun.facts)).toMatchObject({ ok: false, reason: expect.stringContaining("systemd-run") });
});

test("rootful 使用系统级 transient service", async () => {
  const root = host("linux", 0, { "systemctl --version": { stdout: "systemd 258 (258.1)\n+PAM" }, "systemctl is-system-running": { stdout: "degraded\n" } });
  expect(await hostingCheck(root.facts)).toMatchObject({ ok: true, mechanism: "systemd-system", facts: ["systemd 258 (258.1)", "系统管理器：degraded"] });
  const offline = host("linux", 0, { "systemctl is-system-running": { stdout: "offline\n", code: 1 } });
  expect(await hostingCheck(offline.facts)).toMatchObject({ ok: false });
  const starting = host("linux", 0, { "systemctl is-system-running": { stdout: "starting\n", code: 1 } });
  expect(await hostingCheck(starting.facts)).toMatchObject({ ok: true, mechanism: "systemd-system" });
});

test("rootless 必须实际启用 linger 且用户管理器可用；不满足时拒绝并且不自动启用", async () => {
  const noLinger = host("linux", 1000, { "loginctl show-user 1000": { stdout: "no\n" } });
  const refused = await hostingCheck(noLinger.facts);
  expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("未启用 linger") });
  expect(noLinger.calls.some(call => call.includes("enable-linger"))).toBe(false);

  const noManager = host("linux", 1000, { "loginctl show-user 1000": { stdout: "yes\n" }, "systemctl --user is-system-running": { code: 1, stderr: "Failed to connect to bus" } });
  expect(await hostingCheck(noManager.facts)).toMatchObject({ ok: false, reason: expect.stringContaining("用户级 systemd 管理器不可用") });

  const ok = host("linux", 1000, { "loginctl show-user 1000": { stdout: "yes\n" }, "systemctl --user is-system-running": { stdout: "running\n" } });
  expect(await hostingCheck(ok.facts)).toMatchObject({ ok: true, mechanism: "systemd-user" });
});

test("systemd-run 创建 service（不是 scope），结束后回收，只传入指定环境变量", () => {
  const argv = systemdRunArgv("systemd-user", "mixin-console-task-1", "/srv/bot dir", ["/usr/bin/bun", "executor.js", "--task", "task-1"], { DOCKER_HOST: "unix:///run/user/1000/docker.sock" });
  expect(argv).toEqual(["systemd-run", "--user", "--unit=mixin-console-task-1", "--collect", "--service-type=exec", "--quiet",
    "--working-directory=/srv/bot dir", "--setenv=DOCKER_HOST=unix:///run/user/1000/docker.sock", "--", "/usr/bin/bun", "executor.js", "--task", "task-1"]);
  expect(argv).not.toContain("--scope");
  expect(systemdRunArgv("systemd-system", "u", "/p", ["x"], {})).toEqual(["systemd-run", "--unit=u", "--collect", "--service-type=exec", "--quiet", "--working-directory=/p", "--", "x"]);
});

test("计划任务参数逐个加引号", () => {
  expect(windowsArguments(["C:\\Program Files\\bot\\executor.js", "--task", "task-0123"]))
    .toBe('"C:\\Program Files\\bot\\executor.js" "--task" "task-0123"');
  expect(() => windowsArguments(['a"b'])).toThrow("引号");
});

test("SSH 转发提示：主机取自本次 SSH 连接，sudo 时用登录用户；取不到时保留占位符", () => {
  expect(sshForwardHint(11012, 11012, { SSH_CONNECTION: "203.0.113.9 51234 198.51.100.7 22", SUDO_USER: "ops" }))
    .toEqual({ command: "ssh -N -L 127.0.0.1:11012:127.0.0.1:11012 ops@198.51.100.7", guessed: true });
  expect(sshForwardHint(11012, 18080, { SUDO_USER: "ops" })).toEqual({ command: "ssh -N -L 127.0.0.1:18080:127.0.0.1:11012 ops@<主机>", guessed: false });
});
