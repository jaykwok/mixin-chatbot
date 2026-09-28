import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, scenarioRunner, ScenarioProcesses } from "../helpers/concurrent-scenarios.ts";
import { tempFixture } from "../helpers/temp.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(file: string) {
  const deadline = Date.now() + 30000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + file);
    await Bun.sleep(20);
  }
}

// A child that marks that it runs, starts a grandchild waiting for two minutes, records both PIDs, and then either
// waits as well, as a hung command would, or exits at once and leaves the grandchild behind, as a command starting a
// background process would. On Windows Bun ends a non-detached child together with its parent, which would hide exactly
// these cases (Git Bash processes do not behave that way), so there the grandchild is detached. On POSIX it stays in
// the child's process group, as the processes of an upgrader run do.
const tree = (pids: string, then: "wait" | "exit" = "wait") => `require("node:fs").writeFileSync(${JSON.stringify(pids + ".started")}, "");
const grandchild = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"], { stdio: ["ignore", "ignore", "ignore"], detached: process.platform === "win32" });
require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, grandchild.pid]));
${then === "wait" ? "setTimeout(() => {}, 120000);" : "grandchild.unref(); process.exit(0);"}`;

/** A scenario fixture that records, when it is cleaned up, which of the tree's processes were still running. */
async function treeFixture(prefix: string) {
  const fixture = await tempFixture(prefix);
  const pids = join(fixture.root, "pids");
  const state = { aliveAtCleanup: [] as boolean[], cleanedUp: false };
  const recorded = () => existsSync(pids) ? JSON.parse(readFileSync(pids, "utf8")) as number[] : [];
  const setup = async (processes: ScenarioProcesses) => ({
    processes, root: fixture.root, pids,
    async cleanup() { state.aliveAtCleanup = recorded().map(alive); state.cleanedUp = true; },
  });
  // Anything a failing test left running is ended here.
  const dispose = async () => {
    for (const pid of recorded()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await fixture.cleanup();
  };
  return { root: fixture.root, pids, state, setup, recorded, dispose };
}

test("a command over its limit has its whole process tree ended and waited for, and says so in its output", async () => {
  const fixture = await treeFixture("concurrent-scenarios-limit-");
  const processes = new ScenarioProcesses();
  try {
    // Room for the grandchild to start first: with some security software a process's first spawn takes seconds.
    const command = runCommand(processes, fixture.root, [process.execPath, "-e", tree(fixture.pids)], {}, undefined, 10000);
    await until(fixture.pids);
    const { text, limited } = await command;
    expect(text).toContain("命令超过 10 秒，已结束其进程树");
    expect(limited).toBe(true);
    expect(fixture.recorded().map(alive)).toEqual([false, false]);
  } finally { await processes.stop(); await fixture.dispose(); }
}, 60000);

test("a command is in its process tree before it runs: a pause right after its creation lets no descendant escape", async () => {
  const fixture = await treeFixture("concurrent-scenarios-created-");
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const duringPause = { ran: false, startedDescendant: false };
  // As if the helper lost its time slice right after creating the command. On Windows the command is still suspended
  // there and must not run at all; on POSIX it already runs, in its own process group since before exec, and is given
  // the time to start its descendant.
  const processes = new ScenarioProcesses({
    afterCreate() {
      const deadline = Date.now() + (process.platform === "win32" ? 2000 : 20000);
      while (!existsSync(fixture.pids) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 20);
      Object.assign(duringPause, { ran: existsSync(fixture.pids + ".started"), startedDescendant: existsSync(fixture.pids) });
    },
  });
  try {
    const command = runCommand(processes, fixture.root, [process.execPath, "-e", tree(fixture.pids)], {}, undefined, 120000);
    await until(fixture.pids);
    await processes.stop();
    await command;
    const runsAtOnce = process.platform !== "win32";
    expect(duringPause).toEqual({ ran: runsAtOnce, startedDescendant: runsAtOnce });
    expect(fixture.recorded().map(alive)).toEqual([false, false]);
  } finally { await processes.stop(); await fixture.dispose(); }
}, 60000);

test("descendants that outlive their command are ended and waited for before the fixture is cleaned up", async () => {
  const fixture = await treeFixture("concurrent-scenarios-orphan-");
  const run = scenarioRunner({ slots: 1, budgetMs: 60000 });
  const seen: { code?: number | null; grandchildAfterExit?: boolean } = {};
  try {
    await run("orphan", fixture.setup, async fx => {
      seen.code = (await runCommand(fx.processes, fx.root, [process.execPath, "-e", tree(fx.pids, "exit")])).code;
      seen.grandchildAfterExit = alive(fixture.recorded()[1]!);
    });
    expect(seen).toEqual({ code: 0, grandchildAfterExit: true });
    expect(fixture.state.aliveAtCleanup).toEqual([false, false]);
  } finally { await fixture.dispose(); }
}, 60000);

test("a scenario over its budget has its whole process tree ended before cleanup and cannot start new processes", async () => {
  const fixture = await treeFixture("concurrent-scenarios-budget-");
  const run = scenarioRunner({ slots: 1, budgetMs: 12000 });
  let late = "";
  try {
    const outcome = await run("hung", fixture.setup, async fx => {
      const command = runCommand(fx.processes, fx.root, [process.execPath, "-e", tree(fx.pids)], {}, undefined, 120000);
      await until(fx.pids);
      await command;
      // The budget ended the tree; the scenario can no longer start anything.
      try { fx.processes.spawn([process.execPath, "-e", ""], { cwd: fx.root, env: process.env }); late = "started"; }
      catch (error) { late = (error as Error).message; }
    }).then(() => "passed", (error: Error) => error.message);
    expect(outcome).toContain("超过 12 秒预算");
    expect(fixture.state.cleanedUp).toBe(true);
    expect(fixture.state.aliveAtCleanup).toEqual([false, false]);
    expect(late).toContain("不再启动新进程");
  } finally { await fixture.dispose(); }
}, 60000);

test("a failed assertion ends the processes a scenario still runs before its fixture is cleaned up", async () => {
  const fixture = await treeFixture("concurrent-scenarios-failure-");
  const run = scenarioRunner({ slots: 1, budgetMs: 60000 });
  try {
    const outcome = await run("failing", fixture.setup, async fx => {
      void runCommand(fx.processes, fx.root, [process.execPath, "-e", tree(fx.pids)], {}, undefined, 120000);
      await until(fx.pids);
      expect("assertion").toBe("failed");
    }).then(() => "passed", (error: Error) => error.message);
    expect(outcome).toContain("failed");
    expect(fixture.state.aliveAtCleanup).toEqual([false, false]);
  } finally { await fixture.dispose(); }
}, 60000);

test("a body that has not settled once its processes ended keeps its fixture and says so", async () => {
  const run = scenarioRunner({ slots: 1, budgetMs: 100, settleMs: 300 });
  let open!: () => void;
  const gate = new Promise<void>(done => { open = done; });
  let cleanedUp = false;
  const outcome = await run("unsettled", async () => ({ cleanup: async () => { cleanedUp = true; } }), () => gate)
    .then(() => "passed", (error: Error) => error.message);
  open();
  expect(outcome).toContain("场景超过 0.1 秒预算");
  expect(outcome).toContain("场景主体在其进程结束 0.3 秒后仍未结束，保留其 fixture 未清理：unsettled");
  expect(cleanedUp).toBe(false);
});

test("no more scenarios run at once than there are slots, and every queued one runs", async () => {
  const run = scenarioRunner({ slots: 2, budgetMs: 60000 });
  let active = 0, most = 0, done = 0;
  await Promise.all(Array.from({ length: 5 }, (_, index) => run(`slot ${index}`, async () => ({ cleanup: async () => {} }), async () => {
    active++; most = Math.max(most, active);
    await Bun.sleep(100);
    active--; done++;
  })));
  expect(most).toBe(2);
  expect(done).toBe(5);
});

test("a failed fixture cleanup still frees the slot, and fails the scenario without hiding its own failure", async () => {
  const run = scenarioRunner({ slots: 1, budgetMs: 60000 });
  const failingCleanup = async () => ({ cleanup: async () => { throw new Error("cleanup failed"); } });
  const outcome = (scenario: Promise<void>) => scenario.then(() => "passed", (error: Error) => error.message);
  const passedBody = outcome(run("passing body", failingCleanup, async () => {}));
  const failedBody = outcome(run("failing body", failingCleanup, async () => { throw new Error("body failed"); }));
  let queued = false;
  await run("queued", async () => ({ cleanup: async () => {} }), async () => { queued = true; });
  expect(await passedBody).toBe("cleanup failed");
  expect(await failedBody).toBe("body failed\n\n结束场景时又出错：cleanup failed");
  expect(queued).toBe(true);
}, 10000);
