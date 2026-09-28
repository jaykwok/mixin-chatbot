import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInJob } from "./windows-job.ts";

/** A command a scenario started. */
export interface ScenarioChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  /** stdout and stderr: on POSIX once both pipes have closed, on Windows once the command has exited. */
  output(): Promise<{ out: string; err: string }>;
  /** Signals the command itself (POSIX); on Windows ends it. */
  kill(signal?: NodeJS.Signals): void;
}

/** A command with its process tree: the command and its descendants, those that outlive it included. */
interface Command extends ScenarioChild {
  /** Whether any process of the tree still runs. */
  running(): boolean;
  /** Ends every process of the tree. */
  killTree(): void;
  close(): void;
}

/**
 * POSIX: the command is spawned detached, so it calls setsid before exec and leads a session and process group of its
 * own from its first instruction; its descendants stay in that group unless they start their own. The group ID stays
 * reserved while any member exists. A group is kept after its leader ends only while members remain; for its free ID
 * to name another group within one scenario, the PID counter would have to wrap (pid_max is 4194304 on the test hosts).
 */
function startInGroup(args: string[], options: { cwd: string; env: Record<string, string | undefined>; input?: string; afterCreate?: (pid: number) => void }): Command {
  const child = Bun.spawn(args, { cwd: options.cwd, env: options.env, stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe", stderr: "pipe", detached: true });
  // Read at once, so a command writing more than a pipe holds never blocks.
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([out, err]) => ({ out, err }));
  options.afterCreate?.(child.pid);
  const pgid = child.pid;
  return {
    pid: child.pid, exited: child.exited, output: () => output,
    kill: signal => child.kill(signal),
    running() {
      try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    },
    killTree() { try { process.kill(-pgid, "SIGKILL"); } catch { /* no member left */ } },
    close() {},
  };
}

/**
 * Every process one scenario starts. A command's process tree is kept until none of its processes runs, not just until
 * the command exits: ending a command or the scenario ends that whole tree and waits for it. On Windows each command
 * gets a job object it joins before it runs (see windows-job.ts). `afterCreate` runs right after a command was created
 * and before it joined its tree (on POSIX it joins before exec, so already has); tests use it to pause at that point.
 */
export class ScenarioProcesses {
  private readonly commands = new Map<ScenarioChild, Command>();
  private stopped = false;
  private io: string | undefined;

  constructor(private readonly options: { afterCreate?: (pid: number) => void } = {}) {}

  spawn(args: string[], options: { cwd: string; env: Record<string, string | undefined>; input?: string }): ScenarioChild {
    if (this.stopped) throw new Error("场景已结束，不再启动新进程：" + args.join(" "));
    const command = process.platform === "win32"
      ? startInJob(args, { ...options, ioDir: this.io ??= mkdtempSync(join(tmpdir(), "scenario-io-")), afterCreate: this.options.afterCreate })
      : startInGroup(args, { ...options, afterCreate: this.options.afterCreate });
    this.commands.set(command, command);
    void command.exited.then(() => {
      try { if (!command.running()) this.forget(command); } catch { /* kept: ending the scenario reports it */ }
    });
    return command;
  }

  /** Ends the command's whole tree, descendants that outlived the command included, and waits until none runs. */
  async end(child: ScenarioChild) {
    const command = this.commands.get(child);
    if (command) {
      const deadline = Date.now() + 10000;
      // Repeated while any member runs: on POSIX one may fork while the signal is delivered.
      for (command.killTree(); command.running(); command.killTree()) {
        if (Date.now() > deadline) throw new Error(`命令（进程 ${child.pid}）的进程树 10 秒后仍未结束`);
        await Bun.sleep(20);
      }
      this.forget(command);
    }
    await child.exited;
  }

  async stop() {
    this.stopped = true;
    const ended = await Promise.allSettled([...this.commands.keys()].map(child => this.end(child)));
    const failed = ended.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    if (this.io) rmSync(this.io, { recursive: true, force: true });
  }

  private forget(command: Command) {
    command.close();
    this.commands.delete(command);
  }
}

/**
 * One command of a scenario; after limitMs its whole process tree is ended and waited for, its output says so and
 * `limited` is set.
 */
export async function runCommand(processes: ScenarioProcesses, cwd: string, args: string[], env: Record<string, string> = {}, input?: string, limitMs = 30000) {
  const child = processes.spawn(args, { cwd, env: { ...process.env, ...env }, input });
  let ending: Promise<void> | undefined;
  const timeout = setTimeout(() => { ending = processes.end(child); }, limitMs);
  try {
    const [code, { out, err }] = await Promise.all([child.exited, child.output()]);
    if (ending) await ending;
    return { code, text: out + err + (ending ? `\n[命令超过 ${limitMs / 1000} 秒，已结束其进程树]` : ""), limited: ending !== undefined };
  } finally { clearTimeout(timeout); }
}

/**
 * Runs scenarios with at most `slots` at a time, each with its own fixture and processes. The budget covers one
 * scenario from the moment it gets a slot. On success, a failed assertion or an exceeded budget alike, the scenario's
 * process trees are ended and waited for, then its body must settle within settleMs; only then is its fixture cleaned
 * up. A body still unsettled keeps its fixture. The slot is freed in every case. The scenario's own failure is thrown;
 * one found while ending the scenario is added to its message, or thrown if there was none.
 */
export function scenarioRunner(options: { slots: number; budgetMs: number; settleMs?: number }) {
  const settleMs = options.settleMs ?? 30000;
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (running < options.slots) { running++; return; }
    await new Promise<void>(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else running--;
  };
  return async <F extends { cleanup(): Promise<void> }>(name: string, setup: (processes: ScenarioProcesses) => Promise<F>, body: (fixture: F) => Promise<void>) => {
    await acquire();
    const processes = new ScenarioProcesses();
    let fixture: F | undefined;
    let failure: Error | undefined;
    let budget: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => { fixture = await setup(processes); await body(fixture); })();
    try {
      await Promise.race([work, new Promise<never>((_, reject) => {
        budget = setTimeout(() => reject(new Error(`场景超过 ${options.budgetMs / 1000} 秒预算，已结束其进程：${name}`)), options.budgetMs);
      })]);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally { clearTimeout(budget); }
    try {
      await processes.stop();
      // The body can start no new process now. A body still awaiting something could write into the fixture after it
      // was removed, so the fixture is only cleaned up once the body has settled.
      let settle: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([work.then(() => true, () => true), new Promise<boolean>(done => { settle = setTimeout(done, settleMs, false); })]);
      clearTimeout(settle);
      if (!settled) throw new Error(`场景主体在其进程结束 ${settleMs / 1000} 秒后仍未结束，保留其 fixture 未清理：${name}`);
      await fixture?.cleanup();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failure) failure.message += `\n\n结束场景时又出错：${message}`;
      else failure = error instanceof Error ? error : new Error(message);
    } finally { release(); }
    if (failure) throw failure;
  };
}
