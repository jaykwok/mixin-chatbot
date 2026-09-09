import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

test("real runtime and HTTP scheduling survive lifecycle races", async () => {
  const fixture = await tempFixture("mixin-runtime-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/runtime-harness.ts", import.meta.url))], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_MAX_ACTIVE_REQUESTS: "1", BOT_RUN_TIMEOUT_SECONDS: "10",
      BOT_MODEL_IDLE_TIMEOUT_SECONDS: "180", BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: "600" },
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
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_RUN_TIMEOUT_SECONDS: "45",
      BOT_MODEL_IDLE_TIMEOUT_SECONDS: "10", BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: "600" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 35_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    const line = stdout.split("\n").find(line => line.startsWith("HARNESS_RESULT="));
    expect(line, stderr).toBeDefined();
    expect(JSON.parse(line!.slice("HARNESS_RESULT=".length))).toHaveLength(3);
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
    const stable = stdout.split("\n").find(line => line.includes("模型无有效进展超时 -") && line.includes("用户: idle-stable-args,"));
    expect(stable).toBeDefined();
    const parsed = JSON.parse(stable!.split("模型流: ")[1]!.split(", 取消原因:")[0]!);
    expect(parsed.toolArgsChars).toBeGreaterThan(1000);
    expect(parsed.parsedToolArgsChars).toBeLessThan(100);
    expect(parsed.toolArgsChanges).toBe(1);
    expect(parsed.toolArgsLastChangeSecondsAgo).toBeGreaterThanOrEqual(10);
    expect(parsed.lastEventSecondsAgo).toBeLessThan(2);
    expect(parsed.tools[0].name).toBe("bash");
    expect(stdout).toContain('"stopReason":"aborted"');
    expect(stdout).toContain('"rawStopReason":"tool_calls"');
    expect(stdout).toContain("任务取消清理完成");
    for (const content of ["private-", "late-output-must-be-ignored", "执行工具 late-tool"]) {
      expect(stdout).not.toContain(content);
    }
    expect(stdout).not.toContain("任务总时限到达");
    expect(stdout).not.toContain("单次模型响应超时");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 40_000);

test("each model response has a hard deadline even while parsed arguments keep changing", async () => {
  const fixture = await tempFixture("mixin-model-response-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/runtime-harness.ts", import.meta.url)), "--model-response"], {
    cwd: fixture.root, env: { ...process.env, GROUP_DATA_ROOT: "data/groups", BOT_RUN_TIMEOUT_SECONDS: "45",
      BOT_MODEL_IDLE_TIMEOUT_SECONDS: "180", BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: "10" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    const result = stdout.split("\n").find(line => line.startsWith("HARNESS_RESULT="));
    expect(result, stderr).toBeDefined();
    expect(JSON.parse(result!.slice("HARNESS_RESULT=".length))).toHaveLength(2);
    const timeout = stdout.split("\n").find(line => line.includes("单次模型响应超时 -") && line.includes("用户: response-growing,"));
    expect(timeout).toBeDefined();
    expect(timeout).toContain("取消原因: model_response_timeout");
    const stats = JSON.parse(timeout!.split("模型流: ")[1]!.split(", 取消原因:")[0]!);
    expect(stats.elapsedSeconds).toBeGreaterThanOrEqual(10);
    expect(stats.idleSeconds).toBeLessThan(2);
    expect(stats.toolArgsChanges).toBeGreaterThan(3);
    expect(stats.responseId).toBe("response-growing-id");
    expect(stats.stopReason).toBe("pending");
    const reset = stdout.split("\n").find(line => line.includes("模型流结束 -") && line.includes('"responseId":"response-reset-second"'));
    expect(reset).toContain('"response":2');
    expect(stdout).toContain('"stopReason":"aborted"');
    expect(stdout).toContain("任务取消清理完成");
    for (const content of ["private-", "late-response-must-be-ignored", "late-output-must-be-ignored", "执行工具 late-tool",
      "模型无有效进展超时", "任务总时限到达"]) expect(stdout).not.toContain(content);
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 35_000);
