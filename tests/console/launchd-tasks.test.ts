import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExecutor, hostedTask, launchTask, reconcileTasks, unregisterTask } from "../../console/server/task-host.ts";
import { hostingCheck, type HostFacts } from "../../ops/core/hosting.ts";
import { TaskStore, type TaskRequest } from "../../ops/core/tasks.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = resolve(import.meta.dir, "../..");
const input = (root: string): Omit<TaskRequest, "version" | "id" | "createdAt" | "acceptBy"> => ({ project: root, mechanism: "launchd-system", planId: "fixture", operation: "stop", params: {} });
type Reply = { code: number; stdout?: string };
/** launchctl as a script of replies; Windows' executor identity asks PowerShell for the start time. */
function launchctl(reply: (argv: string[]) => Reply | undefined) {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "powershell") return { code: 0, stdout: "638000000000000000\n", stderr: "" };
    const answer = reply(argv) ?? { code: 0 };
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}
const label = (id: string) => `com.mixin-bot.console.${id}`;

test("macOS 后台托管需要 root（sudo），不改用其他身份", async () => {
  const facts = (uid: number): HostFacts => ({ platform: "darwin", uid, run: async () => ({ code: 1, stdout: "", stderr: "" }), systemdBooted: () => false, which: () => null });
  expect(await hostingCheck(facts(0))).toMatchObject({ ok: true, mechanism: "launchd-system" });
  expect(await hostingCheck(facts(501))).toMatchObject({ ok: false, reason: expect.stringContaining("sudo") });
});

test("macOS 任务是 system 域里的一次性 LaunchDaemon：定义在 .console/launchd，按回执等待；结束前不卸载自己", async () => {
  const fixture = await tempFixture("console-launchd-");
  try {
    const dir = join(fixture.root, ".console"), bundle = await buildExecutor(dir, project), store = new TaskStore(dir), { id } = store.create(input(fixture.root), "launchd");
    const plist = join(dir, "launchd", `${label(id)}.plist`);
    const launched = launchctl(argv => { if (argv[1] === "bootstrap") writeFileSync(join(store.dir(id), "claim"), "fixture"); return undefined; });
    await launchTask(store, id, bundle, launched.run);
    expect(launched.calls).toEqual([["/bin/launchctl", "bootstrap", "system", plist]]);
    const definition = readFileSync(plist, "utf8");
    expect(definition).toContain(`<key>Label</key>\n  <string>${label(id)}</string>`);
    expect(definition).toContain(`<string>${bundle.path}</string>`);
    expect(definition).toContain(`<key>WorkingDirectory</key>\n  <string>${fixture.root}</string>`);
    expect(definition).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(definition).not.toContain("KeepAlive");

    const request = store.request(id);
    const state = (text: string, code = 0) => hostedTask(request, { pid: 1, startedAt: "x" }, launchctl(() => ({ code, stdout: text })).run);
    expect(await state("", 113)).toEqual({ state: "ended" });
    expect(await state("\tstate = not running\n\tlast exit code = 0\n")).toEqual({ state: "ended" });
    expect(await state("\tstate = spawn scheduled\n")).toEqual({ state: "unknown" });
    expect(await state("", 1)).toEqual({ state: "unknown" });
    expect(await state(`\tstate = running\n\tpid = ${process.pid}\n`)).toMatchObject({ state: "running", executor: { pid: process.pid } });

    // The executor's own cleanup: the job is its own process, so only the definition goes.
    const own = launchctl(() => ({ code: 0, stdout: `\tstate = running\n\tpid = ${process.pid}\n` }));
    await unregisterTask(request, own.run);
    expect(own.calls.some(argv => argv[1] === "bootout")).toBe(false);
    expect(existsSync(plist)).toBe(false);
    // Anyone else boots an ended job out and checks that it is gone.
    let booted = false;
    const other = launchctl(argv => argv[1] === "bootout" ? (booted = true, { code: 0 }) : booted ? { code: 113 } : { code: 0, stdout: "\tstate = not running\n" });
    await unregisterTask(request, other.run);
    expect(other.calls.map(argv => argv[1])).toEqual(["print", "bootout", "print"]);
    const stuck = launchctl(argv => argv[1] === "bootout" ? { code: 0 } : { code: 0, stdout: "\tstate = not running\n" });
    await expect(unregisterTask(request, stuck.run)).rejects.toThrow("托管项尚未清除");
  } finally { await fixture.cleanup(); }
}, 60_000);

test("macOS 残留清理只卸载本项目已结束的任务，陌生和其他标签不动", async () => {
  const fixture = await tempFixture("console-launchd-reconcile-");
  try {
    const store = new TaskStore(join(fixture.root, ".console")), { id } = store.create(input(fixture.root), "done");
    store.accept(id, { pid: 1234, startedAt: "fixture" }); store.finish(id, { outcome: "success", exitCode: 0, finalState: "stopped", message: "done" });
    const foreign = `task-${"f".repeat(32)}`;
    let booted = false;
    const host = launchctl(argv => {
      if (argv[1] === "list") return { code: 0, stdout: `PID\tStatus\tLabel\n-\t0\t${label(id)}\n-\t0\t${label(foreign)}\n512\t0\tcom.apple.example\n-\t0\tcom.mixin-bot.service\n` };
      if (argv[1] === "bootout") { booted = true; return { code: 0 }; }
      return booted ? { code: 113 } : { code: 0, stdout: "\tstate = not running\n" };
    });
    expect(await reconcileTasks(store, "launchd-system", host.run)).toEqual([id]);
    expect(host.calls.filter(argv => argv[1] === "bootout")).toEqual([["/bin/launchctl", "bootout", `system/${label(id)}`]]);
    expect(host.calls.some(argv => argv.join(" ").includes(foreign))).toBe(false);
  } finally { await fixture.cleanup(); }
});
