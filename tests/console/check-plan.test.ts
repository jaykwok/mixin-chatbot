import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codeDigest } from "../../ops/core/source-runtime.ts";
import { checkTaskPlan } from "../../ops/core/check-plan.ts";
import { PlanStore } from "../../ops/core/plans.ts";
import type { PlanFacts } from "../../ops/core/plans.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { runCore } from "../../ops/core/cli.ts";
import { createServiceHost, type Platform } from "../../ops/core/service-host.ts";
import { tempFixture } from "../helpers/temp.ts";

const repository = resolve(import.meta.dir, "../..");
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
/** Another process tries to take deploy.lock without waiting: true while someone holds it. */
async function heldElsewhere(lock: string): Promise<boolean> {
  const argv = process.platform === "win32"
    ? ["powershell", "-NoProfile", "-Command", "try { $f=[IO.File]::Open($env:FIXTURE_LOCK,'OpenOrCreate','ReadWrite','None'); $f.Dispose(); exit 0 } catch { exit 7 }"]
    : process.platform === "darwin"
      ? [process.execPath, "-e", `const { openSync } = require("node:fs"); const { tryLock } = require(${JSON.stringify(join(repository, "src/lib/darwin.ts"))}); process.exit(tryLock(openSync(process.argv[1], "r+")) ? 0 : 7);`, lock]
      : ["flock", "-n", lock, "true"];
  return await Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", windowsHide: true, env: { ...process.env, FIXTURE_LOCK: lock } }).exited !== 0;
}
async function fixture() {
  const f = await tempFixture("console-lock-plan-");
  for (const name of ["console", "ops", "scripts", "src", "data/state"]) mkdirSync(join(f.root, name), { recursive: true });
  writeFileSync(join(f.root, "src/version.ts"), "export const version = 1;\n");
  const facts: PlanFacts = { project: f.root, platform: process.platform, identity: "fixture", head: "a".repeat(40), protocol: 1, scope: "stop", runState: "running" };
  const plan = await new PlanStore(join(f.root, ".console"), async () => ({ facts, summary: [] })).create("stop", {});
  const task = new TaskStore(join(f.root, ".console")).create({ project: f.root, planId: plan.id, operation: "stop", params: {},
    mechanism: process.platform === "win32" ? "windows-task" : "systemd-system" }, "fixture");
  return { ...f, facts, task, digest: codeDigest(f.root) };
}

test("锁内复核代码和完整计划；复核期间再次改代码也拒绝", async () => {
  const f = await fixture();
  try {
    const observed = async () => ({ facts: f.facts, summary: [] });
    await checkTaskPlan(f.root, f.task.id, f.digest, observed);
    for (const key of ["head", "identity", "scope", "runState"] as const) {
      await expect(checkTaskPlan(f.root, f.task.id, f.digest, async () => ({ facts: { ...f.facts, [key]: "changed" }, summary: [] }))).rejects.toThrow("已变化");
    }
    await expect(checkTaskPlan(f.root, f.task.id, f.digest, async () => {
      writeFileSync(join(f.root, "src/version.ts"), "changed"); return observed();
    })).rejects.toThrow("复核期间");
    await expect(checkTaskPlan(f.root, f.task.id, f.digest, observed)).rejects.toThrow("代码已变化");
  } finally { await f.cleanup(); }
});

// ops.sh and deploy.sh still take deploy.lock themselves (acquire_deploy_lock) and run the guard while holding it.
test.skipIf(process.platform !== "linux")("Shell 入口的真实部署锁在复核期间保持独占；拒绝计划后释放锁且不运行操作", async () => {
  const f = await fixture();
  try {
    const helper = join(f.root, "guard.ts"), marker = join(f.root, "action"), lock = join(f.root, "data/state/deploy.lock");
    writeFileSync(helper, [
      `import { checkTaskPlan } from ${JSON.stringify(pathToFileURL(join(repository, "ops/core/check-plan.ts")).href)};`,
      'import { writeFileSync } from "node:fs";',
      'const lock = process.env.FIXTURE_LOCK!;',
      'const code = await Bun.spawn(["flock", "-n", lock, "true"], { stdout: "ignore", stderr: "ignore" }).exited;',
      'if (code === 0) throw new Error("lock not held");',
      'writeFileSync(process.env.FIXTURE_LOCKED!, "yes");',
      `await checkTaskPlan(${JSON.stringify(f.root)}, ${JSON.stringify(f.task.id)}, process.env.MIXIN_OPS_EXPECT_CODE!, async () => ({ facts: JSON.parse(process.env.FIXTURE_FACTS!), summary: [] }));`,
    ].join("\n"));
    const script = join(f.root, "run.sh");
    writeFileSync(script, ['set -uo pipefail', 'PROJECT_DIR="$FIXTURE_PROJECT"',
      `source ${quote(join(repository, "scripts/lib/common.sh"))}`, 'acquire_deploy_lock || exit 3',
      'printf yes > "$FIXTURE_ACTION"', 'acquire_deploy_lock || exit 4',
    ].join("\n"));
    const argv = ["bash", script];
    for (const stale of [true, false]) {
      const child = Bun.spawn(argv, { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, BOT_DEPLOY_LOCK_HELD: "", FIXTURE_PROJECT: f.root, FIXTURE_FACTS: JSON.stringify(f.facts), FIXTURE_ACTION: marker,
          FIXTURE_LOCK: lock, FIXTURE_LOCKED: join(f.root, "locked"), MIXIN_OPS_BUN: process.execPath, MIXIN_OPS_TASK_ID: f.task.id,
          MIXIN_OPS_GUARD: helper, MIXIN_OPS_EXPECT_CODE: stale ? "0".repeat(64) : f.digest } });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(stale ? 3 : 0);
      expect(readFileSync(join(f.root, "locked"), "utf8")).toBe("yes");
      if (stale) expect(() => readFileSync(marker)).toThrow();
      else expect(readFileSync(marker, "utf8")).toBe("yes");
    }
  } finally { await f.cleanup(); }
}, 120_000);

// Service controls (and every maintenance) run in the shared core, which rechecks the plan in-process under the native lock.
test("核心在真实部署锁内复核控制台计划；拒绝后释放锁且不操作实例", async () => {
  const f = await fixture();
  try {
    const lock = join(f.root, "data/state/deploy.lock"), events: string[] = [];
    const platform: Platform = {
      async inspect() { return { identity: "fixture", state: events.includes("stop") ? "stopped" : "running", owned: true }; },
      async start() { events.push("start"); }, async stop() { events.push("stop"); },
    };
    for (const changed of [true, false]) {
      events.length = 0;
      const { result } = await runCore(["service", "stop", "--project", f.root], {
        source: f.root, env: { MIXIN_OPS_TASK_ID: f.task.id, MIXIN_OPS_EXPECT_CODE: f.digest },
        host: options => createServiceHost({ ...options, platform: async () => platform }),
        async checkPlan(project, task, expected) {
          events.push(await heldElsewhere(lock) ? "locked" : "free");
          await checkTaskPlan(project, task, expected, async () => ({ facts: changed ? { ...f.facts, head: "b".repeat(40) } : f.facts, summary: [] }));
        },
      });
      // A rejected plan is a refusal: it is checked under the lock before anything changes.
      expect(result, JSON.stringify(result)).toMatchObject(changed ? { command: "stop", outcome: "refused", exitCode: 1, message: expect.stringContaining("请重新预览") }
        : { command: "stop", outcome: "success", exitCode: 0 });
      expect(events).toEqual(changed ? ["locked"] : ["locked", "stop"]);
      expect(await heldElsewhere(lock)).toBe(false);
    }
  } finally { await f.cleanup(); }
}, 60_000);

// Deployments and recoveries recheck the console plan inside the shared core, under deploy.lock (core-deployment-cli.test.ts).
