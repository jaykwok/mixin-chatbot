import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { LAUNCHD_LABEL, LaunchdPlatform, parseLaunchctlPrint, SERVICE_ACCOUNT } from "../../ops/core/launchd-host.ts";
import { parseMacosTools, servicePlist } from "../../ops/core/macos-deployment.ts";
import { newMacosTask, recoverMacosTask, runMacosTask } from "../../ops/core/macos-task.ts";
import type { MacosTaskRecord } from "../../src/contracts/ops-writer.ts";
import type { NativeCommand } from "../../ops/core/native-process.ts";

const darwin = process.platform === "darwin";
const PRINT = `system/${LAUNCHD_LABEL} = {\n\tactive count = 1\n\tpath = /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist\n\tstate = running\n\n\tprogram = /opt/homebrew/bin/bun\n\tlast exit code = 1\n}\n`;

/** launchctl, plutil and id as a script of answers; every call is recorded. */
function fakeHost(project: string, plist: string, options: { loaded?: boolean[]; bootstrap?: number[]; leftovers?: number[]; user?: string; directory?: string } = {}) {
  const calls: string[] = [], loaded = [...options.loaded ?? []], bootstrap = [...options.bootstrap ?? []], leftovers = [...options.leftovers ?? []];
  const definition = { Label: LAUNCHD_LABEL, UserName: options.user ?? SERVICE_ACCOUNT, WorkingDirectory: options.directory ?? project, ProgramArguments: ["/opt/homebrew/bin/bun", "run", "x"] };
  const platform = new LaunchdPlatform(project, {
    plist,
    euid: () => 0,
    processes: () => new Map((leftovers[0] ?? 0) ? [[4242, "start"]] : []),
    kill: () => leftovers.length > 1 ? leftovers.shift()! : leftovers[0] ?? 0,
    run: async argv => {
      const line = argv.join(" "); calls.push(line);
      if (argv[0] === "/usr/bin/id") return { code: 0, stdout: argv[1] === "-u" ? "499\n" : "20\n", stderr: "" };
      if (argv[0] === "/usr/bin/plutil") return { code: 0, stdout: JSON.stringify(definition), stderr: "" };
      if (line.endsWith(`print system/${LAUNCHD_LABEL}`)) return (loaded.length > 1 ? loaded.shift() : loaded[0]) ? { code: 0, stdout: PRINT, stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
      if (argv[1] === "bootstrap") { const code = bootstrap.shift() ?? 0; return { code, stdout: "", stderr: code ? "Bootstrap failed: 5: Input/output error" : "" }; }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { platform, calls };
}

test("launchctl print：只读状态和最后退出码，其他字段随版本变化不影响", () => {
  expect(parseLaunchctlPrint(PRINT)).toEqual({ loaded: true, state: "running", lastExit: "1" });
  expect(parseLaunchctlPrint("system/x = {\n\tstate = not running\n}\n")).toEqual({ loaded: true, state: "not running" });
});

test("LaunchDaemon 状态：没有定义为未部署；本项目的定义按加载与否为运行或停止；未加载时服务账户的进程计入残留", async () => {
  const f = await tempFixture("core-launchd-state-");
  try {
    const project = join(f.root, "项目"), plist = join(f.root, "service.plist");
    const absent = await fakeHost(project, plist).platform.inspect();
    expect(absent).toMatchObject({ state: "absent", owned: true, rawState: "absent", leftovers: 0, user: { uid: 499, gid: 20 } });
    await writeFile(plist, "<plist/>");
    expect(await fakeHost(project, plist, { loaded: [true] }).platform.inspect()).toMatchObject({ state: "running", owned: true, rawState: "running", leftovers: 0 });
    const stopped = await fakeHost(project, plist, { loaded: [false], leftovers: [1] }).platform.inspect();
    expect(stopped).toMatchObject({ state: "stopped", rawState: "not-loaded", leftovers: 1 });
    expect(stopped.identity).not.toBe(absent.identity);
    expect((await fakeHost(project, plist, { loaded: [true], directory: join(f.root, "其他") }).platform.inspect()).owned).toBe(false);
    expect((await fakeHost(project, plist, { loaded: [true], user: "someone" }).platform.inspect()).owned).toBe(false);
  } finally { await f.cleanup(); }
});

test("LaunchDaemon 启停：启动先清残留再 enable、bootstrap（EIO 时短暂重试）；停止先 disable 再 bootout，等到真正卸载并清掉服务账户的进程", async () => {
  const f = await tempFixture("core-launchd-control-");
  try {
    const project = join(f.root, "项目"), plist = join(f.root, "service.plist");
    await writeFile(plist, "<plist/>");
    const started = fakeHost(project, plist, { loaded: [false], bootstrap: [5, 5, 0] });
    await started.platform.start((await started.platform.inspect()).identity);
    expect(started.calls.filter(line => line.startsWith("/bin/launchctl") && !line.includes(" print "))).toEqual([
      `/bin/launchctl enable system/${LAUNCHD_LABEL}`, ...Array(3).fill(`/bin/launchctl bootstrap system ${plist}`)]);
    const stopping = fakeHost(project, plist, { loaded: [true, true, true, false], leftovers: [2, 1, 0] });
    await stopping.platform.stop((await stopping.platform.inspect()).identity);
    const control = stopping.calls.filter(line => line.startsWith("/bin/launchctl") && !line.includes(" print "));
    expect(control).toEqual([`/bin/launchctl disable system/${LAUNCHD_LABEL}`, `/bin/launchctl bootout system/${LAUNCHD_LABEL}`]);
    const failing = fakeHost(project, plist, { loaded: [false], bootstrap: [1] });
    await expect(failing.platform.start((await failing.platform.inspect()).identity)).rejects.toThrow("launchctl bootstrap 失败");
    const changed = fakeHost(project, plist, { loaded: [true] });
    await expect(changed.platform.stop("0".repeat(64))).rejects.toThrow("部署身份已变化");
    expect(changed.calls.some(line => line.includes("disable"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("服务定义：服务账户、本项目的 supervisor、记录的工具在 PATH 前面，值经过 XML 转义", async () => {
  const tools = parseMacosTools("format=1\nbun=/opt/homebrew/bin/bun\ngit=/usr/bin/git\nuv=/opt/homebrew/bin/uv\nbash=/opt/homebrew/bin/bash\ncoreutils=/opt/homebrew/opt/coreutils/libexec/gnubin\n");
  expect(() => parseMacosTools("format=1\nbun=bun\ngit=/usr/bin/git\nuv=/u\nbash=/b\ncoreutils=/c\n")).toThrow("部署工具记录无效");
  const project = "/Users/me/a&b <项目>", text = servicePlist(project, tools);
  expect(text).toContain("a&amp;b &lt;项目&gt;</string>");
  expect(text).toContain(`<key>UserName</key>\n  <string>${SERVICE_ACCOUNT}</string>`);
  expect(text).toContain("<string>/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
  if (!darwin) return;
  const f = await tempFixture("core-launchd-plist-");
  try {
    const path = join(f.root, "service.plist"); await writeFile(path, text);
    const child = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", path]);
    expect(child.exitCode).toBe(0);
    const value = JSON.parse(child.stdout.toString());
    expect(value).toMatchObject({ Label: LAUNCHD_LABEL, UserName: SERVICE_ACCOUNT, WorkingDirectory: project, RunAtLoad: true, KeepAlive: { SuccessfulExit: false },
      Umask: 63, ExitTimeOut: 60, EnvironmentVariables: { HOME: project + "/data/runtime/home", GIT_CONFIG_VALUE_0: project, LANG: "C.UTF-8" } });
    expect(value.ProgramArguments).toEqual(["/opt/homebrew/bin/bun", "--no-env-file", "run", project + "/ops/core/launchd-supervisor.ts", "--bun", "/opt/homebrew/bin/bun", "--git", "/usr/bin/git"]);
  } finally { await f.cleanup(); }
});

test.skipIf(!darwin)("macOS 写入者：命令完成后回收；只有以服务账户运行的写入者才清点服务账户；恢复不重跑命令", async () => {
  const f = await tempFixture("core-macos-task-");
  try {
    const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", "-e", 'process.stdout.write(JSON.stringify({message:"正常完成"}))'], cwd: f.root, protocol: true };
    const events: MacosTaskRecord[] = [], save = async (value: MacosTaskRecord) => { events.push(value); };
    let swept = 0;
    const result = await runMacosTask(command, newMacosTask(command, false), save, async () => { swept++; });
    expect(JSON.parse(result.stdout)).toEqual({ message: "正常完成" }); expect(events.map(r => r.phase)).toEqual(["prepared", "reaped"]); expect(swept).toBe(0);
    await runMacosTask(command, newMacosTask(command, true), save, async () => { swept++; });
    expect(swept).toBe(1);
    const stuck = newMacosTask(command, true);
    await expect(runMacosTask(command, stuck, save, async () => { throw new Error("服务账户仍有活动进程"); })).rejects.toThrow("无法确认已回收");
    expect(events.at(-1)).toMatchObject({ id: stuck.id, phase: "prepared" });
    await recoverMacosTask(stuck, save, async () => {}, 0);
    expect(events.at(-1)).toMatchObject({ id: stuck.id, phase: "reaped" });
    const other = { ...command, args: [...command.args, "x"] };
    await expect(runMacosTask(other, newMacosTask(command, false), save, async () => {})).rejects.toThrow("与恢复记录不符");
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(!darwin)("离线删除证明：部署锁无人持有或本账户还有其他进程时拒绝", async () => {
  const { offlineRefusal } = await import("../../src/maintenance/offline.ts");
  const f = await tempFixture("core-macos-offline-");
  try {
    const lock = join(f.root, "deploy.lock"); await writeFile(lock, "");
    // The test account runs other processes (the runner itself), so this is refused before the lock is even looked at.
    expect(offlineRefusal(lock)).toMatch(/其他进程|部署锁/);
    expect(offlineRefusal(join(f.root, "missing.lock"))).not.toBeNull();
  } finally { await f.cleanup(); }
});
