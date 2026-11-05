// bun run console as a real process, from a copy of the sources (no node_modules, no data, no .env).
import { expect, test } from "bun:test";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { prepareConsoleDir } from "../../scripts/ops/console/state.ts";

const project = resolve(import.meta.dir, "../..");

/** A port that was free a moment ago. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

test("绑定端口后保存端口失败：关闭端口、不打印登录链接、不留实例记录、以非零状态退出", async () => {
  const fixture = await tempFixture("console-entry-");
  try {
    await Promise.all(["scripts", "src", "ui", "package.json"].map(name => cp(join(project, name), join(fixture.root, name), { recursive: true })));
    // A directory where the port file goes: the port is saved only after the bind succeeded, so this fails after it.
    // Apply the same initial security descriptor as a real startup (0700 / protected Windows DACL).
    prepareConsoleDir(join(fixture.root, ".console"));
    await mkdir(join(fixture.root, ".console", "port"));
    const port = freePort();
    const child = Bun.spawn([process.execPath, join(fixture.root, "scripts/ops/console.ts"), "--port", String(port), "--no-open"], {
      cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, BOT_PORT: "1011" },
    });
    const [stdout, stderr] = [new Response(child.stdout).text(), new Response(child.stderr).text()];
    // Before the fix the listener kept the process alive and serving: it never exited on its own.
    const code = await Promise.race([child.exited, Bun.sleep(30_000).then(() => "still running" as const)]);
    if (code === "still running") { child.kill(); await child.exited; }
    expect(code, await stderr).toBe(1);
    expect(await stderr).toContain(`控制台未能完成启动，已关闭端口 ${port}`);
    expect(await stdout).not.toContain("#login=");
    // Runtime/tasks are prepared before binding; no instance record or temporary files survive the failed startup.
    expect((await readdir(join(fixture.root, ".console"))).sort()).toEqual(process.platform === "win32"
      ? ["config-drafts", "owner.json", "port", "runtime", "tasks", "uploads"] : ["config-drafts", "port", "runtime", "tasks", "uploads"]);
    const rebind = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    rebind.stop(true);
  } finally { await fixture.cleanup(); }
}, 60_000);

test("真实控制台进程固定页面和后端：替换源文件后继续显示任务，拒绝旧适配器与管理写入", async () => {
  const fixture = await tempFixture("console-replaced-");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await Promise.all(["scripts", "src", "ui", "package.json"].map(name => cp(join(project, name), join(fixture.root, name), { recursive: true })));
    const port = freePort(), origin = "http://127.0.0.1:" + port;
    child = Bun.spawn([process.execPath, "--no-env-file", join(fixture.root, "scripts/ops/console.ts"), "--port", String(port), "--no-open"], {
      cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, BOT_PORT: "1011" },
    });
    const errors = new Response(child.stderr as ReadableStream<Uint8Array>).text(), reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let log = "", token: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) throw new Error("控制台在登录前退出：" + await errors);
          log += new TextDecoder().decode(chunk.value); token = /#login=([A-Za-z0-9_-]{43})/.exec(log)?.[1]; if (token) break;
        }
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("控制台没有就绪")), 20000); })]);
    } finally { clearTimeout(timer); reader.releaseLock(); }
    const headers = { Origin: origin, "X-Console-Request": "1", "Content-Type": "application/json" };
    const login = await fetch(origin + "/api/session/exchange", { method: "POST", headers, body: JSON.stringify({ token }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!, page = await (await fetch(origin)).text();
    const call = (path: string, body?: unknown) => fetch(origin + path, { headers: { ...headers, cookie }, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    expect(await (await call("/api/runtime")).json()).toEqual({ current: true });
    await writeFile(join(fixture.root, "src/core/version.ts"), "/* synthetic code replacement */");
    expect(await (await call("/api/runtime")).json()).toEqual({ current: false });
    expect(await (await fetch(origin)).text()).toBe(page);
    expect((await call("/api/overview")).status).toBe(409);
    expect((await call("/api/plans", { operation: "stop", params: {} })).status).toBe(409);
    expect(await (await call("/api/tasks")).json()).toEqual({ tasks: [] });
    expect((await call("/api/session")).status).toBe(200);
  } finally {
    if (child) { child.kill(); await child.exited; }
    await fixture.cleanup();
  }
}, 45_000);
