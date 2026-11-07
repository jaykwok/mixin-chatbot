// Opt-in, macOS as root (GitHub's macOS runners have passwordless sudo): a real LaunchDaemon for a fixture service, run as
// the service account, and its stop; the entry's account, identity switch and access checks; a console task as a one-shot
// LaunchDaemon. Run: sudo env MIXIN_TEST_REAL_LAUNCHD=1 bun test tests/ops/core-real-launchd.test.ts
// (MIXIN_TEST_MACOS_TOOLS=1 when Homebrew's bun, bash, coreutils and uv are installed; MIXIN_TEST_OFFICE_PYTHON with LibreOffice in
// /Applications for the Office preview.)
// Creates the service account when it is missing and deletes it again; always removes its definition and the fixture.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountIdentity, LAUNCHD_PLIST, LaunchdPlatform, SERVICE_ACCOUNT } from "../../ops/core/launchd-host.ts";
import { ensureServiceAccount } from "../../ops/core/macos-account.ts";
import { checkProjectAccess, findMacosTools } from "../../ops/core/macos-deploy.ts";
import { parseMacosTools, servicePlist } from "../../ops/core/macos-deployment.ts";
import { captured } from "../../ops/core/macos-terminal.ts";
import { hostedTask, launchTask, unregisterTask } from "../../console/server/task-host.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { executeProcess } from "../../src/lib/process.ts";
import { accountProcesses } from "../../src/lib/darwin.ts";

const enabled = process.platform === "darwin" && process.env.MIXIN_TEST_REAL_LAUNCHD === "1" && process.geteuid?.() === 0;
const root = resolve(import.meta.dir, "../..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let created = false, project = "";
const fixtures: string[] = [];

async function until<T>(work: () => T | null | Promise<T | null>, ms = 30_000): Promise<T> {
  const limit = performance.now() + ms;
  for (;;) { const value = await work(); if (value !== null) return value; if (performance.now() > limit) throw new Error("timed out"); await Bun.sleep(100); }
}
const report = () => { try { return JSON.parse(readFileSync(join(project, "data/runtime/report.json"), "utf8")); } catch { return null; } };

afterAll(async () => {
  if (!enabled) return;
  Bun.spawnSync(["/bin/launchctl", "bootout", "system/com.mixin-bot.service"]);
  rmSync(LAUNCHD_PLIST, { force: true });
  const user = await accountIdentity(SERVICE_ACCOUNT);
  if (user) for (const pid of accountProcesses(user.uid).keys()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (created) for (const path of [`/Users/${SERVICE_ACCOUNT}`, `/Groups/${SERVICE_ACCOUNT}`]) Bun.spawnSync(["/usr/bin/dscl", ".", "-delete", path]);
  for (const path of [project, ...fixtures]) if (path) rmSync(path, { recursive: true, force: true });
});

/** The service account, created through the deploy entry's own path when missing: a dedicated group, not staff. */
async function account() {
  const made = await ensureServiceAccount();
  created ||= made.created;
  const group = await captured(["/usr/bin/dscl", ".", "-read", `/Groups/${SERVICE_ACCOUNT}`, "PrimaryGroupID"]);
  if (made.created) expect(group.stdout).toContain(String(made.identity.gid));
  expect(made.identity.gid).not.toBe(20);
  return made.identity;
}

test.skipIf(!enabled)("真实 LaunchDaemon：以服务账户运行、环境只来自定义；停止后连 setsid 逃逸的进程也清掉；状态如实反映", async () => {
  const user = await account();
  // /tmp, not the runner's private TMPDIR: the service account must reach the project.
  project = mkdtempSync("/tmp/mixin-real-launchd-"); chmodSync(project, 0o755);
  for (const dir of ["bin", "ops/core"]) mkdirSync(join(project, dir), { recursive: true, mode: 0o755 });
  for (const dir of ["data", "data/runtime", "data/runtime/home", "logs"]) { mkdirSync(join(project, dir), { recursive: true }); chownSync(join(project, dir), user.uid, user.gid); }
  // The runner's Bun lives in its home, which the service account cannot enter: a real deployment names a reachable one.
  copyFileSync(process.execPath, join(project, "bin/bun")); chmodSync(join(project, "bin/bun"), 0o755);
  writeFileSync(join(project, "ops/core/launchd-supervisor.ts"), `import { writeFileSync } from "node:fs";
const escapee = Bun.spawn(["/usr/bin/perl", "-MPOSIX", "-e", "POSIX::setsid(); sleep 600"], { stdio: ["ignore", "ignore", "ignore"] });
writeFileSync("data/runtime/report.json", JSON.stringify({ uid: process.getuid(), gid: process.getgid(), home: process.env.HOME, path: process.env.PATH,
  lang: process.env.LANG, git: process.env.GIT_CONFIG_VALUE_0, sudo: process.env.SUDO_USER ?? null, args: process.argv.slice(2), pid: process.pid, escapee: escapee.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o644 });
  const tools = parseMacosTools(`format=1\nbun=${project}/bin/bun\ngit=/usr/bin/git\nuv=/usr/bin/true\nbash=/bin/bash\ncoreutils=/usr/bin\n`);
  writeFileSync(LAUNCHD_PLIST, servicePlist(project, tools), { mode: 0o644 });
  const service = new LaunchdPlatform(project);
  expect((await service.inspect())).toMatchObject({ state: "stopped", owned: true, leftovers: 0, user });
  expect(await service.serviceDefinition()).toMatchObject({ directory: project, git: "/usr/bin/git", env: { HOME: join(project, "data/runtime/home") } });

  await service.boot();
  const seen = await until(report);
  expect(seen).toMatchObject({ uid: user.uid, gid: user.gid, home: join(project, "data/runtime/home"), lang: "C.UTF-8", git: project, sudo: null,
    args: ["--bun", `${project}/bin/bun`, "--git", "/usr/bin/git"] });
  expect(seen.path.startsWith("/usr/bin:")).toBe(true);
  expect(await service.inspect()).toMatchObject({ state: "running", owned: true, rawState: "running", leftovers: 0 });
  expect(alive(seen.escapee)).toBe(true);

  await service.halt();
  expect(alive(seen.pid)).toBe(false); expect(alive(seen.escapee)).toBe(false);
  expect(await service.inspect()).toMatchObject({ state: "stopped", rawState: "not-loaded", leftovers: 0 });
  // Stopped stays stopped: the disabled job refuses to load behind the core's back.
  expect(Bun.spawnSync(["/bin/launchctl", "bootstrap", "system", LAUNCHD_PLIST]).exitCode).not.toBe(0);

  // A supervised command as the service account: the identity is dropped before the command, and what escaped its session counts as a leftover.
  rmSync(join(project, "data/runtime/report.json"));
  // Real and effective IDs. (id -G would show the directory's default group list, not the groups this process holds.)
  const result = await executeProcess({ command: "/bin/sh", args: ["-c", "id -ru; id -u; id -rg; id -g; /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 600' >/dev/null 2>&1 & sleep 1"],
    cwd: project, identity: user, timeoutMs: 20_000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([user.uid, user.uid, user.gid, user.gid].map(String));
  expect((await service.inspect()).leftovers).toBeGreaterThan(0);
  await service.sweep();
  expect(accountProcesses(user.uid).size).toBe(0);

  await service.boot();
  await until(report);
  await service.halt();
  expect(accountProcesses(user.uid).size).toBe(0);
  expect(existsSync(LAUNCHD_PLIST)).toBe(true);
}, 180_000);

test.skipIf(!enabled)("macOS 入口的真实环境：交互命令以服务账户运行；服务账户进不去的检出被拒绝；工具都按服务账户实测", async () => {
  const user = await account();
  const become = await captured([process.execPath, "--no-env-file", join(root, "ops/core/macos-become.ts"), String(user.uid), String(user.gid), "--", "/bin/sh", "-c", "id -ru; id -u; id -rg; id -g"]);
  expect(become.code).toBe(0);
  expect(become.stdout.trim().split("\n")).toEqual([user.uid, user.uid, user.gid, user.gid].map(String));
  expect((await captured([process.execPath, "--no-env-file", join(root, "ops/core/macos-become.ts"), "x", "1", "--", "/usr/bin/true"])).code).toBe(2);

  const open = mkdtempSync("/tmp/mixin-real-access-"); fixtures.push(open);
  chmodSync(open, 0o755);
  for (const file of ["package.json", "src/server/index.ts"]) { mkdirSync(join(open, file, ".."), { recursive: true, mode: 0o755 }); writeFileSync(join(open, file), "{}", { mode: 0o644 }); }
  await checkProjectAccess(open, user);
  const closed = mkdtempSync("/tmp/mixin-real-private-"); fixtures.push(closed);
  chmodSync(closed, 0o700);
  const inside = join(closed, "checkout");
  for (const file of ["package.json", "src/server/index.ts"]) { mkdirSync(join(inside, file, ".."), { recursive: true, mode: 0o755 }); writeFileSync(join(inside, file), "{}", { mode: 0o644 }); }
  await expect(checkProjectAccess(inside, user)).rejects.toThrow("读不到");

  if (process.env.MIXIN_TEST_MACOS_TOOLS === "1") {
    const tools = await findMacosTools(open, user);
    expect(tools.bash.startsWith("/opt/homebrew/")).toBe(true);
    expect(tools.coreutils).toBe("/opt/homebrew/opt/coreutils/libexec/gnubin");
    for (const path of [tools.bun, tools.git, tools.uv, tools.bash]) expect(existsSync(path)).toBe(true);
  }
}, 120_000);

test.skipIf(!enabled)("控制台任务是真实的一次性 LaunchDaemon：以 root 运行一次、交回执；结束后保持已加载但不运行，清理后不留定义", async () => {
  const fixture = mkdtempSync("/tmp/mixin-real-task-"); fixtures.push(fixture);
  const dir = join(fixture, ".console"); mkdirSync(dir, { mode: 0o711 });
  const store = new TaskStore(dir), { id } = store.create({ project: fixture, mechanism: "launchd-system", planId: "fixture", operation: "stop", params: {} }, "real");
  // A stand-in executor: the claim, then a few seconds of work, then a record of who ran it.
  const executor = join(dir, "executor.js");
  writeFileSync(executor, `const { writeFileSync } = require("node:fs"); const { join } = require("node:path");
const at = name => join(process.argv[3], ".console/tasks", process.argv[5], name);
writeFileSync(at("claim"), "fixture");
setTimeout(() => { writeFileSync(at("done"), JSON.stringify({ uid: process.getuid(), cwd: process.cwd(), ppid: process.ppid })); process.exit(0); }, 3000);
`, { mode: 0o600 });
  const bundle = { path: executor, digest: createHash("sha256").update(readFileSync(executor)).digest("hex") };
  await launchTask(store, id, bundle);
  const request = store.request(id);
  expect(existsSync(join(dir, "launchd", `com.mixin-bot.console.${id}.plist`))).toBe(true);
  const running = await hostedTask(request, { pid: 1, startedAt: "x" });
  expect(running.state).toBe("running");
  await until(async () => (await hostedTask(request, { pid: 1, startedAt: "x" })).state === "ended" ? true : null, 20_000);
  expect(JSON.parse(readFileSync(join(store.dir(id), "done"), "utf8"))).toMatchObject({ uid: 0, cwd: realpathSync(fixture), ppid: 1 }); // /tmp is a link to /private/tmp
  // Ended jobs stay loaded until somebody boots them out.
  expect(Bun.spawnSync(["/bin/launchctl", "print", `system/com.mixin-bot.console.${id}`]).exitCode).toBe(0);
  await unregisterTask(request);
  expect(Bun.spawnSync(["/bin/launchctl", "print", `system/com.mixin-bot.console.${id}`]).exitCode).toBe(113);
  expect(existsSync(join(dir, "launchd", `com.mixin-bot.console.${id}.plist`))).toBe(false);
}, 120_000);

// MIXIN_TEST_OFFICE_PYTHON: a Python with the project's dependencies that the service account can run (not under a home).
const officePython = process.env.MIXIN_TEST_OFFICE_PYTHON;
test.skipIf(!enabled || !officePython)("macOS 的 LibreOffice 预览以服务账户运行：从它进不去的目录启动、只靠标准安装位置，中文不丢", async () => {
  const user = await account();
  const work = mkdtempSync("/tmp/mixin-real-office-"); fixtures.push(work); chmodSync(work, 0o755);
  // The account cannot reach the checkout, so the scripts it runs are copied next to the job.
  const scripts = join(work, "scripts"); mkdirSync(scripts, { mode: 0o755 });
  for (const name of ["document_ops.py", "macos-fonts.conf"]) copyFileSync(join(root, "src/agent/modules/document-work/scripts", name), join(scripts, name));
  writeFileSync(join(scripts, "drive.py"), `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import document_ops
import pypdfium2 as pdfium
from docx import Document
from docx.oxml.ns import qn
work = Path(sys.argv[2])
document = Document()
style = document.styles["Normal"]; style.font.name = "微软雅黑"
style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "微软雅黑")
document.add_paragraph("流程图预览测试：资料与中文字体")
source = work / "中文 文档.docx"; document.save(source)
(work / "job").mkdir(); (work / "profile").mkdir()
pdf = document_ops.convert_office(source, work / "job", work / "profile")
print(json.dumps({"office": document_ops.office_binary(), "text": pdfium.PdfDocument(str(pdf))[0].get_textpage().get_text_range()}, ensure_ascii=False))
`);
  for (const name of ["document_ops.py", "macos-fonts.conf", "drive.py"]) chmodSync(join(scripts, name), 0o644);
  const job = join(work, "job-root"); mkdirSync(job); chownSync(job, user.uid, user.gid);
  const closed = mkdtempSync("/tmp/mixin-real-office-cwd-"); fixtures.push(closed); chmodSync(closed, 0o700);
  const result = await captured([process.execPath, "--no-env-file", join(root, "ops/core/macos-become.ts"), String(user.uid), String(user.gid), "--",
    officePython!, join(scripts, "drive.py"), scripts, job], { cwd: closed, env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
  expect(result.code, result.stderr).toBe(0);
  const seen = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(seen.office).toBe("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  expect(seen.text).toContain("流程图预览测试：资料与中文字体");
}, 240_000);
