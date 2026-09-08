import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test("real runtime and HTTP scheduling survive lifecycle races", async () => {
  const fixture = await tempFixture("mixin-runtime-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/runtime-harness.ts", import.meta.url))], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_MAX_ACTIVE_REQUESTS: "1", BOT_RUN_TIMEOUT_SECONDS: "10", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "180" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 25000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    const line = stdout.split("\n").find(line => line.startsWith("HARNESS_RESULT="));
    expect(line, stderr).toBeDefined();
    expect(JSON.parse(line!.slice("HARNESS_RESULT=".length))).toHaveLength(10);
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 30000);

test("model inactivity stops stalled streams without cancelling productive work or skipping cleanup", async () => {
  const fixture = await tempFixture("mixin-model-idle-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/runtime-harness.ts", import.meta.url)), "--model-idle"], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_RUN_TIMEOUT_SECONDS: "45", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "10" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 35_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    const line = stdout.split("\n").find(line => line.startsWith("HARNESS_RESULT="));
    expect(line, stderr).toBeDefined();
    expect(JSON.parse(line!.slice("HARNESS_RESULT=".length))).toHaveLength(2);
    const idle = stdout.split("\n").find(line => line.includes("模型无有效进展超时 -") && line.includes("用户: idle-empty,"));
    expect(idle).toBeDefined();
    const stats = JSON.parse(idle!.split("模型流: ")[1]!.split(", 取消原因:")[0]!);
    expect(stats.emptyDeltas).toBeGreaterThan(0);
    expect(stats.whitespaceDeltas).toBeGreaterThan(0);
    expect(stats.effectiveChars).toBeGreaterThan(0);
    expect(stats.idleSeconds).toBeGreaterThanOrEqual(10);
    expect(stats.lastEventSecondsAgo).toBeLessThan(2);
    expect(stats.responseId).toBe("idle-empty-response");
    expect(stats.rawStopReason).toBeNull();
    expect(stdout).toContain('"stopReason":"aborted"');
    expect(stdout).toContain('"rawStopReason":"tool_calls"');
    expect(stdout).toContain("任务取消清理完成");
    for (const content of ["private-tool-argument", "private-thinking", "private-answer", "private-argument", "private-final-answer", "late-output-must-be-ignored", "执行工具 late-tool"]) {
      expect(stdout).not.toContain(content);
    }
    expect(stdout).not.toContain("任务总时限到达");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 40_000);
