// `ops update` of every release before 2.0.0 (webhook, 1.0.x, 1.1.0) exports a fixed set of paths from the target commit
// and runs scripts/deploy/upgrade.{sh,ps1} from it. 2.0.0 needs a fresh deployment: those entries only say so and stop.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const powershell = process.platform === "win32" ? Bun.which("powershell.exe") : null;
const NOTICE = "2.0.0 起需要全新部署，不能从 2.0 以前的版本升级";

test("every path the earlier upgraders export still exists, so the export reaches the notice", () => {
  // UPGRADER_EXPORT_PATHS of the webhook release and of 1.0.0–1.1.0: git archive fails when any of them matches nothing.
  const releases = [["scripts/deploy/upgrade.sh", "scripts/lib", "scripts/runtime", "src/core/data-version.ts", "Dockerfile"],
    ["scripts/deploy/upgrade.sh", "scripts/lib", "scripts/runtime", "Dockerfile"]];
  for (const paths of releases) for (const path of paths) {
    const listed = Bun.spawnSync(["git", "-C", project, "ls-files", "--", path], { stdout: "pipe" }).stdout.toString().trim();
    expect(listed, path).not.toBe("");
  }
  // The earlier web console checks the target's lifecycle protocol file before it starts the update.
  expect(Bun.spawnSync(["git", "-C", project, "ls-files", "--", "scripts/lib/console-lifecycle.json"], { stdout: "pipe" }).stdout.toString().trim()).not.toBe("");
});

test.skipIf(!bash)("the Linux entry prints the notice and fails without touching anything", () => {
  const child = Bun.spawnSync([bash!, join(project, "scripts/deploy/upgrade.sh"), "/nonexistent/project", "0".repeat(40)],
    { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toContain(NOTICE);
  expect(child.stderr.toString()).toContain("没有停止服务");
});

test.skipIf(!powershell)("the Windows entry accepts the earlier upgraders' arguments, prints the notice and fails", () => {
  const script = join(project, "scripts/deploy/upgrade.ps1");
  expect([...readFileSync(script).subarray(0, 3)]).toEqual([239, 187, 191]);
  const quoted = `'${script.replaceAll("'", "''")}'`;
  const child = Bun.spawnSync([powershell!, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & ${quoted} -Project X -OriginalSha a -TargetSha b -OriginalBranch main -BunPath bun -GitPath git -Rollback; exit $LASTEXITCODE`],
  { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stdout.toString() + child.stderr.toString()).toContain(NOTICE);
}, 20_000);
