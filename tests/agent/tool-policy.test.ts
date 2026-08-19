import { describe, expect, test } from "bun:test";
import {
  consumeTerminalToolBlockReply,
  createToolPolicyExtension,
  evaluateToolCallPolicy,
  startsDetachedProcess,
} from "../../src/agent/tool-policy.ts";

const DETACHED_REASON = "禁止启动在 bash 工具返回后仍继续运行的后台进程";

describe("tool call policy", () => {
  test("leaves path containment to each tool's own canonical guard", () => {
    // read/edit/write go through AllowedPathGuard and send_* through loadBytes,
    // both of which reject canonically. Re-checking here would only add
    // `terminate`, ending a turn the model could have repaired by itself.
    const events = [
      { toolName: "read", input: { path: "../../../config/models.json" } },
      { toolName: "edit", input: { path: "/etc/hosts" } },
      { toolName: "write", input: { path: "../escape.txt" } },
      { toolName: "send_file", input: { source: "/etc/passwd" } },
      { toolName: "send_image", input: { source: "https://example.com/a.png" } },
    ];
    for (const event of events) {
      expect(evaluateToolCallPolicy(event)).toBeUndefined();
    }
  });

  test("accepts bash mutation declarations wherever they point", () => {
    // Declaring a private tmp path is honest and useful; it must never cost the
    // user a turn. Out-of-workspace paths are dropped at lock time instead.
    expect(
      evaluateToolCallPolicy({
        toolName: "bash",
        input: {
          command: 'unzip data.zip -d "$PI_USER_TMP"',
          mutates: ["/data/groups/g/users/u/tmp/data"],
        },
      })
    ).toBeUndefined();
    expect(
      evaluateToolCallPolicy({
        toolName: "bash",
        input: { command: "touch output.txt", mutates: ["output.txt"] },
      })
    ).toBeUndefined();
    expect(
      evaluateToolCallPolicy({ toolName: "bash", input: { command: "pwd" } })
    ).toBeUndefined();
  });

  test("terminates only genuinely unrepairable intent", () => {
    expect(
      evaluateToolCallPolicy({
        toolName: "bash",
        input: { command: "nohup bun run worker &", mutates: ["."] },
      })
    ).toEqual({ block: true, reason: DETACHED_REASON, terminate: true });
  });

  test("detects detached processes without confusing normal shell operators", () => {
    expect(startsDetachedProcess("nohup bun run worker &")).toBe(true);
    expect(startsDetachedProcess("bun run worker &\necho started")).toBe(true);
    expect(startsDetachedProcess("docker run --detach image")).toBe(true);
    expect(startsDetachedProcess("echo ok && echo done 2>&1")).toBe(false);
  });

  test("keeps terminal reasons only when no subsequent model turn starts", async () => {
    const { extension, state } = createToolPolicyExtension();
    if (typeof extension === "function") throw new Error("expected named inline extension");

    const handlers = new Map<string, (event: any) => unknown>();
    await extension.factory({
      on: (name: string, handler: (event: any) => unknown) => {
        handlers.set(name, handler);
      },
    } as never);

    const detachedCall = {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "setsid ./writer.sh", mutates: ["."] },
    };

    handlers.get("turn_start")?.({ type: "turn_start" });
    expect(handlers.get("tool_call")?.(detachedCall)).toMatchObject({
      block: true,
      terminate: true,
    });
    expect(consumeTerminalToolBlockReply(state)).toBe(
      `⛔ 已阻止工具调用：${DETACHED_REASON}`
    );
    expect(consumeTerminalToolBlockReply(state)).toBeUndefined();

    handlers.get("tool_call")?.({ ...detachedCall, toolCallId: "call-2" });
    handlers.get("turn_start")?.({ type: "turn_start" });
    expect(consumeTerminalToolBlockReply(state)).toBeUndefined();
  });
});
