import { afterAll, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { QueryPool } from "../../scripts/ops/tui/exec-client.ts";
import { ownQueryHost } from "../../scripts/ops/tui/exec-owner.ts";
import { observeQueryProcess } from "../../scripts/ops/tui/exec-observe.ts";
import type { CaptureOptions } from "../../scripts/ops/tui/exec.ts";
import { tempFixture } from "../helpers/temp.ts";
import { treeFixture, waitFor } from "../helpers/tui-process.ts";

const pool = new QueryPool();
const capture = (command: string, args: string[], options?: CaptureOptions) =>
  pool.capture(command, command === process.execPath ? ["--no-env-file", ...args] : args, options);
afterAll(() => pool.stop());

test("两平台查询都在后台启动，保留并发输出、输入、环境、失败和超时语义", async () => {
  const fixture = await tempFixture("tui-capture-");
  const previous = process.env.TUI_CAPTURE_INHERITED;
  process.env.TUI_CAPTURE_INHERITED = "before-worker-start";
  // 此 mock 只作用于主线程；后台线程必须能独立启动真实的只读测试进程。
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("查询不应在 UI 线程启动子进程"); });
  try {
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
    // 先 await 再断言：Bun 的 rejects matcher 同步等待时不会派发 Worker 消息。
    const failure = await capture(join(fixture.root, "missing.exe"), []).then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error);
    const timeout = await capture(process.execPath, ["-e", "console.log('超时前输出'); console.error('超时诊断'); await Bun.sleep(60000)"],
      { timeout: 1000, env: { FORCE_COLOR: "0" } });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.code).not.toBe(0);
    expect(timeout.stdout.trim()).toBe("超时前输出");
    expect(timeout.stderr.trim()).toBe("超时诊断");
    delete process.env.TUI_CAPTURE_INHERITED;
    const recovered = await capture(process.execPath, ["-e", "console.log(process.env.TUI_CAPTURE_INHERITED ?? 'still working')"]);
    expect(recovered.stdout.trim()).toBe("still working");
    const hosts = [];
    for (let index = 0; index < 3; index++) hosts.push((await capture(process.execPath, ["-e", "console.log(process.ppid)"])).stdout.trim());
    expect(new Set(hosts).size).toBe(1); // 正常的短查询持续复用同一个宿主。
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    if (previous === undefined) delete process.env.TUI_CAPTURE_INHERITED;
    else process.env.TUI_CAPTURE_INHERITED = previous;
    await fixture.cleanup();
  }
}, 45000);

test("取消消息丢失时主线程仍能回收查询父进程和脱离进程组的孙进程", async () => {
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
