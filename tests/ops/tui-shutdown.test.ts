import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alive, treeFixture, waitFor } from "../helpers/tui-process.ts";

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../scripts/ops/tui/${name}.ts`, import.meta.url).href);

test("q、重复退出信号和致命错误回收查询并等待维护；强制杀死 UI 也不会遗留查询进程", async () => {
  for (const mode of ["quit", "signal", "fatal", "hardkill"] as const) {
    const fixture = await treeFixture();
    const harness = join(fixture.root, "ui.ts");
    await writeFile(harness, `
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from ${moduleUrl("app")};
import { Screen } from ${moduleUrl("render/screen")};
import { capture, trackMaintenance } from ${moduleUrl("exec")};
const [root, mode, script] = process.argv.slice(2);
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(raw) {
  if (!raw) writeFileSync(join(root, "terminal-restored"), "yes");
  return this;
} });
const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
output.resume();
const screen = new Screen(output, input);
const app = new App([{ id: "test", label: "test", render: () => [], hints: () => [] }], { screen, deployment: {
  platform: process.platform === "win32" ? "windows" : "linux", runtime: "native", mode: "direct",
  port: 1, domain: "", groupDataRoot: root, groupDataRootIsCustom: true,
} });
app["refreshChrome"] = async () => { await capture(process.execPath, ["--no-env-file", script, root, "wait"], { timeout: 40000 }); };
const running = app.start();
while (!await Bun.file(join(root, "grandchild")).exists()) await Bun.sleep(10);
await Bun.write(join(root, "ui-ready"), "yes");
if (mode === "hardkill") await Bun.sleep(60000);
else {
  trackMaintenance((async () => { await Bun.sleep(150); await Bun.write(join(root, "maintenance-restored"), "yes"); return 0; })());
  if (mode === "quit") input.write("q");
  else if (mode === "signal") { process.emit("SIGTERM"); process.emit("SIGINT"); process.emit("SIGHUP"); }
  else process.emit("uncaughtException", new Error("fixture fatal error"));
  await running;
  input.destroy(); output.destroy();
}
`);
    const child = Bun.spawn([process.execPath, "--no-env-file", harness, fixture.root, mode, fixture.script], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await waitFor(() => Bun.file(join(fixture.root, "ui-ready")).exists(), `${mode} 查询树就绪`);
      if (mode === "hardkill") child.kill("SIGKILL");
      const code = await child.exited;
      const detail = (await stdout) + (await stderr);
      if (mode !== "hardkill") {
        expect(code, detail).toBe(mode === "quit" ? 0 : mode === "signal" ? 130 : 1);
        expect(await Bun.file(join(fixture.root, "terminal-restored")).exists()).toBe(true);
        expect(await Bun.file(join(fixture.root, "maintenance-restored")).exists()).toBe(true);
      }
      await fixture.assertStopped();
      const { host } = await fixture.pids();
      await waitFor(async () => !await alive(host), `${mode} 查询宿主退出`, 5000);
    } finally {
      try { child.kill("SIGKILL"); } catch {}
      await child.exited;
      await fixture.stopLeftovers(); await fixture.cleanup();
    }
  }
}, 120000);
