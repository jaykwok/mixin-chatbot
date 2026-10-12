import { afterAll, expect, spyOn, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { QueryPool } from "../../scripts/ops/tui/exec-client.ts";
import { ownQueryHost, QueryHandleCleanupError } from "../../scripts/ops/tui/exec-owner.ts";
import { observeQueryProcess } from "../../scripts/ops/tui/exec-observe.ts";
import type { CaptureOptions } from "../../scripts/ops/tui/exec.ts";
import type { FromReaper } from "../../scripts/ops/tui/exec-protocol.ts";
import { tempFixture } from "../helpers/temp.ts";
import { treeFixture, waitFor } from "../helpers/tui-process.ts";

const pool = new QueryPool();
const capture = (command: string, args: string[], options?: CaptureOptions) =>
  pool.capture(command, command === process.execPath ? ["--no-env-file", ...args] : args, options);
afterAll(() => pool.stop());

test("两平台查询都在后台启动，保留并发输出、输入、环境、失败和超时语义", async () => {
  const fixture = await tempFixture("tui-capture-");
  const started = performance.now();
  const phase = (name: string) => console.info("tui capture phase " + JSON.stringify({ name, elapsedMs: Math.round(performance.now() - started) }));
  const previous = process.env.TUI_CAPTURE_INHERITED;
  process.env.TUI_CAPTURE_INHERITED = "before-worker-start";
  // 此 mock 只作用于主线程；后台线程必须能独立启动真实的只读测试进程。
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("查询不应在 UI 线程启动子进程"); });
  try {
    phase("parallel-start");
    const [first, second] = await Promise.all([
      capture(process.execPath, ["-e", "console.error('测试警告'); console.log(JSON.stringify({input:await Bun.stdin.text(),marker:process.env.TUI_CAPTURE_TEST})); process.exit(7)"],
        { input: "中文输入", env: { TUI_CAPTURE_TEST: "first", FORCE_COLOR: "0" } }),
      capture(process.execPath, ["-e", "console.log(process.env.TUI_CAPTURE_TEST)"], { env: { TUI_CAPTURE_TEST: "second" } }),
    ]);
    expect(first.code).toBe(7);
    expect(JSON.parse(first.stdout)).toEqual({ input: "中文输入", marker: "first" });
    expect(first.stderr.trim()).toBe("测试警告");
    expect(second.stdout.trim()).toBe("second");
    expect(second.code).toBe(0);
    phase("parallel-complete");
    // 先 await 再断言：Bun 的 rejects matcher 同步等待时不会派发 Worker 消息。
    const failure = await capture(join(fixture.root, "missing.exe"), []).then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error);
    phase("missing-executable-complete");
    const timeout = await capture(process.execPath, ["-e", "console.log('超时前输出'); console.error('超时诊断'); await Bun.sleep(60000)"],
      { timeout: 1000, env: { FORCE_COLOR: "0" } });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.code).not.toBe(0);
    expect(timeout.stdout.trim()).toBe("超时前输出");
    expect(timeout.stderr.trim()).toBe("超时诊断");
    phase("one-second-timeout-and-reaping-complete");
    delete process.env.TUI_CAPTURE_INHERITED;
    const recovered = await capture(process.execPath, ["-e", "console.log(process.env.TUI_CAPTURE_INHERITED ?? 'still working')"]);
    expect(recovered.stdout.trim()).toBe("still working");
    phase("recovered-query-complete");
    const hosts = [];
    for (let index = 0; index < 3; index++) hosts.push((await capture(process.execPath, ["-e", "console.log(process.ppid)"])).stdout.trim());
    expect(new Set(hosts).size).toBe(1); // 正常的短查询持续复用同一个宿主。
    expect(spawn).not.toHaveBeenCalled();
    phase("host-reuse-verified");
  } finally {
    spawn.mockRestore();
    if (previous === undefined) delete process.env.TUI_CAPTURE_INHERITED;
    else process.env.TUI_CAPTURE_INHERITED = previous;
    await fixture.cleanup();
    phase("cleanup-complete");
  }
// Full Windows runs have taken 44.68 s for these sequential spawns. Keep the actual command timeout at 1 s;
// the outer budget also covers cold Worker/host startup and reaping, whose elapsed phases are logged above.
}, process.platform === "win32" ? 90000 : 45000);

test("发给查询线程的取消和退役消息丢失时，回收线程仍能回收查询父进程和脱离进程组的孙进程", async () => {
  const fixture = await treeFixture();
  const controller = new AbortController();
  const pending = capture(process.execPath, [fixture.script, fixture.root, "wait"], { signal: controller.signal, timeout: 40_000 })
    .then(() => null, error => error);
  let post: ReturnType<typeof spyOn> | undefined;
  try {
    await fixture.pids();
    const worker = pool["worker"]!;
    const original = worker.postMessage.bind(worker);
    post = spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
      if (["cancel", "retire"].includes(message.type)) return;
      original(message, ...rest);
    });
    controller.abort();
    const error = await pending;
    expect(error?.name).toBe("AbortError");
    await fixture.assertStopped();
  } finally {
    post?.mockRestore(); controller.abort(); await pending;
    await fixture.stopLeftovers(); await fixture.cleanup();
  }
}, 45000);

test("超时会终止整棵查询进程树，正常完成的查询也不会遗留后台孙进程", async () => {
  for (const mode of ["timeout", "leave-descendant"] as const) {
    // Warm the reused host first so this test's deadline exercises a running tree.
    expect((await capture(process.execPath, ["-e", "console.log('ready')"])).code).toBe(0);
    const fixture = await treeFixture();
    try {
      const pending = capture(process.execPath, [fixture.script, fixture.root, mode], {
        timeout: mode === "timeout" ? (process.platform === "win32" ? 10_000 : 2000) : 30_000,
      });
      await fixture.pids();
      const result = await pending;
      expect(result.timedOut).toBe(mode === "timeout");
      if (mode === "leave-descendant") expect(result.stdout.trim()).toBe("finished");
      await fixture.assertStopped();
    } finally { await fixture.stopLeftovers(); await fixture.cleanup(); }
  }
}, 60000);

test("启动途中取消、预先取消和关闭后的请求都不会延迟执行", async () => {
  const fixture = await tempFixture("tui-query-startup-");
  const cold = new QueryPool();
  const marker = join(fixture.root, "must-not-run");
  const args = ["--no-env-file", "-e", "await Bun.write(process.argv[1], 'unexpected')", marker];
  try {
    const before = await cold.capture(process.execPath, args, { signal: AbortSignal.abort() }).catch(error => error);
    expect(before.name).toBe("AbortError");
    expect(cold["worker"]).toBeNull();
    const pending = cold.capture(process.execPath, args).catch(error => error);
    const closing = cold.stop();
    expect(cold.stop()).toBe(closing);
    const late = await cold.capture(process.execPath, args).catch(error => error);
    expect(late.name).toBe("AbortError");
    expect((await pending).name).toBe("AbortError");
    await closing;
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await cold.stop(); await fixture.cleanup(); }
}, 30000);

test("查询 Worker 被强制终止时所有请求结束并回收仍在运行的进程树", async () => {
  const fixture = await treeFixture();
  const broken = new QueryPool();
  const pending = broken.capture(process.execPath, ["--no-env-file", fixture.script, fixture.root, "wait"], { timeout: 40_000 })
    .then(() => null, error => error);
  try {
    await fixture.pids();
    await broken["worker"]!.terminate();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("查询线程已退出");
    await fixture.assertStopped();
    const recovered = await broken.capture(process.execPath, ["--no-env-file", "-e", "console.log('recovered')"]);
    expect(recovered).toMatchObject({ code: 0, stdout: "recovered\n", timedOut: false });
  } finally { await broken.stop(); await fixture.stopLeftovers(); await fixture.cleanup(); }
}, 45000);

test("会话中记录过的回收失败不妨碍查询线程恢复，只在退出时报告", async () => {
  const recovering = new QueryPool();
  const run = (text: string) => recovering.capture(process.execPath, ["--no-env-file", "-e", `console.log(${JSON.stringify(text)})`]);
  try {
    expect((await run("first")).stdout.trim()).toBe("first");
    // Stands in for an earlier stop whose exit could not be confirmed.
    recovering["failures"].set("earlier", new Error("earlier reclaim failure"));
    recovering["cleanupFailures"].set("earlier", new Error("earlier handle cleanup failure"));
    await recovering["worker"]!.terminate();
    for (const text of ["recovered", "still recovered"]) expect(await run(text)).toMatchObject({ code: 0, stdout: text + "\n", timedOut: false });
    const error = await recovering.stop().then(() => null, error => error as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error!.errors.map(String)).toEqual(["Error: earlier reclaim failure", "Error: earlier handle cleanup failure"]);
  } finally { await recovering.stop().catch(() => {}); }
}, 45000);

test("恢复之后，旧代次线程迟到的通知不影响编号相同的新宿主", async () => {
  const recovering = new QueryPool();
  const run = (text: string) => recovering.capture(process.execPath, ["--no-env-file", "-e", `console.log(${JSON.stringify(text)})`]);
  try {
    expect((await run("old")).stdout.trim()).toBe("old");
    const oldSpawner = recovering["worker"]!, oldReaper = recovering["reaper"]!;
    await oldSpawner.terminate();
    expect((await run("new")).stdout.trim()).toBe("new");
    expect(recovering["generation"]).toBe(1);
    // Host numbers restart with each spawner: the new generation's host has the same number as the old one.
    const [host] = [...recovering["hosts"].keys()];
    expect(host).toBe(1);
    oldReaper.emit("message", { type: "stopped", host, error: "old generation reclaim failure", cleanupError: "old generation cleanup failure" });
    oldSpawner.emit("message", { type: "retired", host, error: "old generation exit", expected: false });
    oldSpawner.emit("message", { type: "fault", error: "old generation fault" });
    expect(recovering.closed).toBe(false);
    expect(recovering["failures"].size).toBe(0);
    expect(recovering["cleanupFailures"].size).toBe(0);
    // Control: the same report from the current reaper does reach the pool.
    recovering["reaper"]!.emit("message", { type: "stopped", host: 99, error: "current generation reclaim failure", cleanupError: "current generation cleanup failure" });
    expect([...recovering["failures"].keys()]).toEqual(["1:99"]);
    expect([...recovering["cleanupFailures"].keys()]).toEqual(["1:99"]);
    recovering["failures"].clear();
    recovering["cleanupFailures"].clear();
    // The new host is untouched and still reused.
    expect((await run("still")).stdout.trim()).toBe("still");
    expect(recovering["hosts"].get(host!)).toMatchObject({ request: undefined });
    expect(recovering["hosts"].get(host!)?.gone).toBeUndefined();
    await recovering.stop();
  } finally { await recovering.stop().catch(() => {}); }
}, 45000);

test("查询宿主启动即失败时请求带着原因结束，不会无休止地重启宿主", async () => {
  const fixture = await tempFixture("tui-host-start-failure-");
  const starts = join(fixture.root, "starts");
  const preload = join(fixture.root, "fail-host.ts");
  await Bun.write(preload, `import { appendFileSync } from "node:fs";
if (process.argv[1]?.endsWith("exec-host.ts")) { appendFileSync(${JSON.stringify(starts)}, "start\\n"); throw new Error("synthetic host start failure"); }`);
  const failing = new QueryPool();
  const previous = process.env.BUN_OPTIONS;
  try {
    // The spawner copies the environment when it is created, inside the first capture; hosts inherit the preload.
    // BUN_OPTIONS drops backslashes, so the path uses forward slashes.
    process.env.BUN_OPTIONS = `--preload ${preload.replaceAll("\\", "/")}`;
    const pending = failing.capture(process.execPath, ["--no-env-file", "-e", "console.log('unexpected')"]).then(() => null, error => error);
    if (previous === undefined) delete process.env.BUN_OPTIONS; else process.env.BUN_OPTIONS = previous;
    const error = await pending;
    expect(String(error)).toContain("synthetic host start failure");
    const count = async () => (await Bun.file(starts).text().catch(() => "")).split("\n").filter(Boolean).length;
    const settled = await count();
    await Bun.sleep(process.platform === "win32" ? 8000 : 2000);
    // At most one replacement may already be under way when the failure arrives; none after it.
    expect(settled).toBeGreaterThanOrEqual(1);
    expect(await count()).toBeLessThanOrEqual(2);
  } finally {
    if (previous === undefined) delete process.env.BUN_OPTIONS; else process.env.BUN_OPTIONS = previous;
    await failing.stop().catch(() => {});
    await fixture.cleanup();
  }
}, 60000);

test("UI 线程阻塞时新查询宿主照常取得执行许可，查询不会因此失败", async () => {
  // Ownership and exit confirmation travel between the spawner and the reaper; the UI thread never opens a process.
  const client = await Bun.file(join(import.meta.dir, "../../scripts/ops/tui/exec-client.ts")).text();
  expect(client).not.toMatch(/from "(?:bun:ffi|\.\/exec-owner\.ts)"/);
  const blocked = new QueryPool();
  try {
    const pending = blocked.capture(process.execPath, ["--no-env-file", "-e", "console.log('after block')"], { timeout: 30_000 });
    // Longer than a cold host start plus the 5 s grant deadline it used to have, when the grant came from this thread.
    Bun.sleepSync(process.platform === "win32" ? 12_000 : 7_000);
    expect(await pending).toMatchObject({ code: 0, stdout: "after block\n", timedOut: false });
  } finally { await blocked.stop(); }
}, 60000);

test("两个线程的退出通知任意先后、重复到达，确认过的退出都不会变成回收失败或故障", async () => {
  // The spawner (retired) and the reaper (stopped) report on separate channels with no relative order.
  // No workers are started here; only the UI thread's handling of the two reports is exercised.
  type Report = ["retired", boolean] | ["stopped", string?];
  const scenarios: Record<string, { reports: Report[]; failure?: string }> = {
    "退出确认先到，回收错误迟到": { reports: [["retired", true], ["stopped", "late native failure"]] },
    "回收错误先到，退出确认后到": { reports: [["stopped", "early native failure"], ["retired", true]] },
    "回收线程先确认，生成线程迟到且不知道已被要求退出": { reports: [["stopped"], ["retired", false]] },
    "重复且交错": { reports: [["stopped", "first"], ["retired", false], ["stopped", "again"], ["retired", false], ["stopped"]] },
    "只有回收错误": { reports: [["stopped", "never confirmed"]], failure: "never confirmed" },
  };
  for (const [name, { reports, failure }] of Object.entries(scenarios)) {
    const ordered = new QueryPool();
    const done = ordered["stopHost"](1);
    for (const report of reports) {
      if (report[0] === "retired") ordered["receive"]({ type: "retired", host: 1, error: "查询进程已退出", expected: report[1] });
      else ordered["fromReaper"]({ type: "stopped", host: 1, ...(report[1] ? { error: report[1] } : {}) });
    }
    // fail() would close the pool and cancel unrelated queries.
    expect(ordered.closed, name).toBe(false);
    const stopped = await ordered.stop().then(() => null, error => error as AggregateError);
    if (failure) expect(stopped?.errors.map(String), name).toEqual([`Error: ${failure}`]);
    else expect(stopped, name).toBeNull();
    // The stop itself settles with the first verdict; a later confirmation still clears the exit-time failure.
    expect(await done, name).toBe(reports[0]![0] === "stopped" ? reports[0]![1] : undefined);
  }
  // A host that left without being asked, before any query, is still a fault: queued work must not wait for ever.
  const faulty = new QueryPool();
  faulty["receive"]({ type: "retired", host: 7, error: "启动失败", expected: false });
  expect(faulty.closed).toBe(true);
  await faulty.stop();
});

test("句柄关闭失败经回收线程传到 UI，任意顺序的退出确认都只清除进程回收错误", async () => {
  const fixture = await tempFixture("tui-reaper-cleanup-");
  const workerFile = join(fixture.root, "reaper.ts");
  // Only the native owner is substituted, inside an isolated Worker. The real reaper must classify its
  // failure and send the protocol message; the UI must retain cleanup failures through confirmed exit.
  await Bun.write(workerFile, `
import { mock } from "bun:test";
import { workerData } from "node:worker_threads";
import * as owner from ${JSON.stringify(new URL("../../scripts/ops/tui/exec-owner.ts", import.meta.url).href)};
const CleanupError = owner.QueryHandleCleanupError;
mock.module(${JSON.stringify(new URL("../../scripts/ops/tui/exec-owner.ts", import.meta.url).href)}, () => ({
  ...owner, ownQueryHost: () => ({ stop: async () => {
    throw new CleanupError(new Error("synthetic handle cleanup failure"),
      workerData.unconfirmed ? new Error("synthetic unconfirmed exit") : undefined);
  } }),
}));
await import(${JSON.stringify(new URL("../../scripts/ops/tui/exec-reaper.ts", import.meta.url).href)});
`);
  try {
    for (const scenario of [
      { name: "exit before cleanup error", unconfirmed: false, exit: "before" },
      { name: "both errors before exit", unconfirmed: true, exit: "after" },
      { name: "only reaper confirms exit", unconfirmed: false, exit: "none" },
      { name: "exit stays unconfirmed", unconfirmed: true, exit: "none" },
    ]) {
      const ordered = new QueryPool();
      const worker = new Worker(workerFile, { workerData: { unconfirmed: scenario.unconfirmed } });
      const { port1, port2 } = new MessageChannel();
      let ready!: () => void;
      const owned = new Promise<void>(resolve => { ready = resolve; });
      port1.on("message", message => { if (message.type === "owned") ready(); });
      const reported = new Promise<Extract<FromReaper, { type: "stopped" }>>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message: FromReaper) => {
          ordered["fromReaper"](message);
          if (message.type === "stopped") resolve(message);
        });
      });
      // Attach rejection handling before waiting for ownership, so a failed worker cannot leak a rejection.
      void reported.catch(() => {});
      try {
        worker.postMessage({ type: "spawner", port: port2 }, [port2]);
        port1.postMessage({ type: "own", host: 1, pid: 1, birth: "1" });
        await Promise.race([owned, reported.then(() => { throw new Error("reaper stopped before ownership"); })]);
        const waiting = ordered["stopHost"](1);
        const confirm = () => ordered["receive"]({ type: "retired", host: 1, error: "host exited", expected: true });
        if (scenario.exit === "before") confirm();
        worker.postMessage({ type: "stop", host: 1 });
        const message = await reported;
        expect(message.cleanupError, scenario.name).toContain("synthetic handle cleanup failure");
        expect(message.error, scenario.name).toBe(scenario.unconfirmed ? "synthetic unconfirmed exit" : undefined);
        if (scenario.exit === "after") confirm();
        // Duplicate and late reports must not restore an obsolete reclaim failure or duplicate cleanup errors.
        ordered["fromReaper"](message);
        const unknown = scenario.unconfirmed && scenario.exit === "none";
        expect(ordered["failures"].size, scenario.name).toBe(unknown ? 1 : 0);
        expect(ordered["cleanupFailures"].size, scenario.name).toBe(1);
        expect(ordered["hosts"].get(1)?.gone === true, scenario.name).toBe(!unknown);
        const error = await ordered.stop().then(() => null, error => error as AggregateError);
        expect(error, scenario.name).toBeInstanceOf(AggregateError);
        expect(error!.errors, scenario.name).toHaveLength(unknown ? 2 : 1);
        expect(error!.errors.map(String).join("\n"), scenario.name).toContain("查询进程句柄关闭失败");
        await waiting;
      } finally {
        await worker.terminate();
        port1.close(); port2.close();
        await ordered.stop().catch(() => {});
      }
    }
  } finally { await fixture.cleanup(); }
}, 30000);

test("被取消查询的宿主由回收线程先确认退出、生成线程的退出通知迟到时，另一条查询照常完成", async () => {
  const fixture = await tempFixture("tui-query-late-retired-");
  const ordered = new QueryPool();
  const marker = (name: string) => join(fixture.root, name);
  const script = "const [ready,go,name]=process.argv.slice(1); await Bun.write(ready,name); while(!await Bun.file(go).exists()) await Bun.sleep(20); console.log(name)";
  const run = (name: string, signal?: AbortSignal) => ordered.capture(process.execPath, ["--no-env-file", "-e", script, marker(name), marker("go"), name], { signal, timeout: 60_000 })
    .then(result => ({ result }), error => ({ error }));
  const controller = new AbortController();
  const send = ordered["send"].bind(ordered), receive = ordered["receive"].bind(ordered);
  let held: Parameters<typeof receive>[0] | undefined;
  const first = run("first", controller.signal);
  let second: ReturnType<typeof run> | undefined;
  try {
    await waitFor(() => Bun.file(marker("first")).exists(), "第一条查询运行", 40_000);
    const host = [...ordered["hosts"].keys()][0]!;
    second = run("second");
    await waitFor(() => Bun.file(marker("second")).exists(), "第二条查询运行", 40_000);
    // The spawner does not learn of the stop (as if its messages were still queued behind a spawn), and its
    // exit notice is held until the reaper has confirmed the exit.
    ordered["send"] = (message, ...rest) => {
      if (message.type === "cancel" || (message.type === "retire" && message.host === host)) return;
      send(message, ...rest);
    };
    ordered["receive"] = message => {
      if (message.type === "retired" && message.host === host) held = message;
      else receive(message);
    };
    controller.abort();
    expect(String((await first as { error?: unknown }).error)).toContain("AbortError");
    await waitFor(() => held !== undefined, "生成线程看到宿主退出", 20_000);
    expect(held).toMatchObject({ expected: false });
    receive(held!);
    expect(ordered.closed).toBe(false);
    await Bun.write(marker("go"), "go");
    expect(await second).toMatchObject({ result: { code: 0, stdout: "second\n", timedOut: false } });
    await ordered.stop();
  } finally {
    ordered["send"] = send; ordered["receive"] = receive;
    controller.abort();
    await Bun.write(marker("go"), "go");
    await ordered.stop().catch(() => {});
    await Promise.allSettled([first, second]);
    await fixture.cleanup();
  }
}, 90000);

test("取消排队请求不会延迟执行，也不会终止另一个正在运行的查询", async () => {
  const fixture = await tempFixture("tui-query-queue-");
  const firstController = new AbortController(), secondController = new AbortController();
  const marker = (name: string) => join(fixture.root, name);
  const script = "const [ready,go,name]=process.argv.slice(1); await Bun.write(ready,name); while(!await Bun.file(go).exists()) await Bun.sleep(10); console.log(name)";
  const first = capture(process.execPath, ["-e", script, marker("first-ready"), marker("first-go"), "first"], { signal: firstController.signal, timeout: 40_000 }).catch(error => error);
  const second = capture(process.execPath, ["-e", script, marker("second-ready"), marker("second-go"), "second"], { signal: secondController.signal, timeout: 40_000 }).catch(error => error);
  try {
    await waitFor(async () => await Bun.file(marker("first-ready")).exists() && await Bun.file(marker("second-ready")).exists(), "两个查询并发运行");
    const queuedController = new AbortController();
    const queued = capture(process.execPath, ["-e", "await Bun.write(process.argv[1], 'unexpected')", marker("must-not-run")], { signal: queuedController.signal }).catch(error => error);
    queuedController.abort();
    expect((await queued).name).toBe("AbortError");
    let settled = false;
    const waiting = capture(process.execPath, ["-e", "console.log('queued success')"], { timeout: 1000 })
      .then(result => { settled = true; return result; });
    // Both hosts are occupied for longer than this request's execution budget.
    await Bun.sleep(1200);
    expect(settled).toBe(false);
    firstController.abort();
    expect((await first).name).toBe("AbortError");
    await Bun.write(marker("second-go"), "continue");
    const result = await second;
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("second");
    expect(await waiting).toMatchObject({ code: 0, stdout: "queued success\n", timedOut: false });
    expect(await Bun.file(marker("must-not-run")).exists()).toBe(false);
  } finally {
    firstController.abort(); secondController.abort();
    await Promise.all([first, second]); await fixture.cleanup();
  }
}, 45000);

test("宿主 stdout、stderr 或退出通知失败时仍回收且不遗留未处理拒绝", async () => {
  for (const failed of ["stdout", "stderr", "exit"] as const) {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    let reject!: (reason: unknown) => void;
    let retired = false;
    const messages: unknown[] = [];
    const observed = observeQueryProcess({
      stdout: new ReadableStream({ start(controller) { out = controller; } }),
      stderr: new ReadableStream({ start(controller) { err = controller; } }),
      exited: new Promise<number>((resolve, fail) => { exit = resolve; reject = fail; }),
    }, message => messages.push(message), () => {
      retired = true;
      if (failed !== "stdout") out.close();
      if (failed !== "stderr") err.close();
      if (failed !== "exit") exit(1);
    });
    out.enqueue(new TextEncoder().encode('{"type":"ready"}\n'));
    await Bun.sleep(0);
    const error = new Error(`${failed} fixture failure`);
    if (failed === "exit") reject(error);
    else (failed === "stdout" ? out : err).error(error);
    expect(await observed).toContain(`${failed} fixture failure`);
    expect(retired).toBe(true);
    expect(messages).toEqual([{ type: "ready" }]);
  }
});

test.skipIf(process.platform !== "win32")("Windows 回收忽略被复用 PID 的不同进程身份", async () => {
  // Deliberately use this live test process with another creation time. A bare
  // kill(pid) would terminate the test runner; identity validation must leave it alive.
  const owner = ownQueryHost(process.pid, new Promise(() => {}), "0");
  await owner.stop();
  expect(process.pid).toBeGreaterThan(0);
}, 20000);

test.skipIf(process.platform !== "win32")("Windows 回收句柄打开阻塞数秒后仍等待已终止的查询进程退出", async () => {
  // A blocked Worker cannot deliver EOF or the exit ack. In the TUI a cold OpenProcess then held the
  // UI thread for 5 s; the reclaim deadline must start after termination, not while opening the handle.
  const host = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../scripts/ops/tui/exec-host.ts"), String(process.pid)],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  try {
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("查询宿主未报告身份就退出了");
      text += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const { birth } = JSON.parse(text.slice(0, text.indexOf("\n"))) as { birth: string };
    // Grant ownership so the host does not leave on its own deadline; stdin stays open.
    host.stdin.write('{"type":"owned"}\n');
    host.stdin.flush();
    const { symbols } = dlopen("kernel32.dll", { OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr } });
    const owner = ownQueryHost(host.pid, new Promise(() => {}), birth, {
      OpenProcess: (access, inherit, pid) => { Bun.sleepSync(5500); return symbols.OpenProcess(access, inherit, pid); },
    });
    await owner.stop();
    expect(await host.exited).toBe(130);
  } finally {
    host.kill();
    await host.exited;
  }
}, 40000);

test.skipIf(process.platform !== "win32")("Windows 回收兜底失败时，排在它后面的退出确认仍算回收成功", async () => {
  // The host exits while the reclaim thread is inside a blocked native call that then fails. The exit
  // acknowledgement is queued behind that call; a confirmed exit is final, whatever the fallback reports.
  const host = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../scripts/ops/tui/exec-host.ts"), String(process.pid)],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  try {
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("查询宿主未报告身份就退出了");
      text += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const { birth } = JSON.parse(text.slice(0, text.indexOf("\n"))) as { birth: string };
    host.stdin.write('{"type":"owned"}\n');
    host.stdin.flush();
    let opened = 0;
    const owner = ownQueryHost(host.pid, host.exited.then(() => {}), birth, {
      OpenProcess: () => { opened++; host.kill(); Bun.sleepSync(500); return null; },
      GetLastError: () => 5,
    });
    await owner.stop();
    expect(opened).toBe(1);
    expect(await host.exited).not.toBe(0);
  } finally {
    host.kill();
    await host.exited;
  }
}, 40000);

test.skipIf(process.platform !== "win32")("Windows 回收兜底失败且退出确认始终不到时，在有限时间内报告原错误", async () => {
  // The spawner is gone and will never acknowledge; the wait for a late ack must end and keep the cause.
  const started = performance.now();
  let blocked = 0;
  const owner = ownQueryHost(4, new Promise(() => {}), "1", {
    OpenProcess: () => { const at = performance.now(); Bun.sleepSync(500); blocked += performance.now() - at; return null; },
    GetLastError: () => 5,
  });
  const error = await owner.stop().then(() => null, error => error as Error);
  expect(error?.message).toBe("无法持有查询进程 (5)");
  // 0.3 s for the first ack and 1 s for a late one, plus the injected native block; far below the drain limit.
  expect(performance.now() - started - blocked).toBeLessThan(5000);
}, 20000);

test.skipIf(process.platform !== "win32")("Windows 退出确认只免除进程回收错误，句柄关闭失败仍然报告", async () => {
  const host = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../../scripts/ops/tui/exec-host.ts"), String(process.pid)],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  const { symbols } = dlopen("kernel32.dll", { CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 } });
  try {
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("查询宿主未报告身份就退出了");
      text += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    const { birth } = JSON.parse(text.slice(0, text.indexOf("\n"))) as { birth: string };
    host.stdin.write('{"type":"owned"}\n');
    host.stdin.flush();
    let closed = 0;
    // The handle is opened for real; reading the identity then fails while the host exits, so the exit ack
    // settles the process question. Closing the handle fails afterwards (it is released for real first).
    const owner = ownQueryHost(host.pid, host.exited.then(() => {}), birth, {
      GetProcessTimes: () => { host.kill(); Bun.sleepSync(300); return 0; },
      CloseHandle: handle => { closed++; symbols.CloseHandle(handle); return 0; },
      GetLastError: () => 6,
    });
    const error = await owner.stop().then(() => null, error => error as QueryHandleCleanupError);
    expect(closed).toBe(1);
    expect(error).toBeInstanceOf(QueryHandleCleanupError);
    expect(error!.message).toBe("查询进程句柄关闭失败");
    expect(error!.reclaimError).toBeUndefined();
    expect(error!.cleanupError).toBe(error!.errors[0]);
    expect(error!.errors.map(String).join("\n")).not.toContain("无法读取查询进程身份");
    expect(error!.errors).toHaveLength(1);
  } finally {
    host.kill();
    await host.exited;
  }
}, 40000);
