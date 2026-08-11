import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  consumeTerminalToolBlockReply,
  createToolPolicyExtension,
  evaluateToolCallPolicy,
  startsDetachedProcess,
} from "../../src/agent/tool-policy.ts";

const workspaceDir = resolve("data/groups/group/workspace");
const tempDir = resolve("data/groups/group/users/user/tmp");
const options = { workspaceDir, tempDir };

describe("tool call policy", () => {
  test("allows file operations inside the workspace or caller temp directory", () => {
    expect(
      evaluateToolCallPolicy(
        { toolName: "read", input: { path: "report.md" } },
        options
      )
    ).toBeUndefined();
    expect(
      evaluateToolCallPolicy(
        { toolName: "write", input: { path: resolve(tempDir, "draft.md") } },
        options
      )
    ).toBeUndefined();
  });

  test("terminates file and attachment calls that are lexically outside allowed roots", () => {
    expect(
      evaluateToolCallPolicy(
        { toolName: "read", input: { path: "../../../config/models.json" } },
        options
      )
    ).toEqual({
      block: true,
      reason: "read 只能访问本群 workspace 或当前用户 tmp",
      terminate: true,
    });
    expect(
      evaluateToolCallPolicy(
        { toolName: "send_file", input: { source: resolve("secrets.txt") } },
        options
      )
    ).toMatchObject({ block: true, terminate: true });
    expect(
      evaluateToolCallPolicy(
        { toolName: "send_image", input: { source: "https://example.com/a.png" } },
        options
      )
    ).toBeUndefined();
  });

  test("terminates bash calls that declare mutations outside the group workspace", () => {
    expect(
      evaluateToolCallPolicy(
        {
          toolName: "bash",
          input: { command: "touch ../other.txt", mutates: ["../other.txt"] },
        },
        options
      )
    ).toEqual({
      block: true,
      reason: "bash.mutates 只能声明本群 workspace 内的路径",
      terminate: true,
    });
    expect(
      evaluateToolCallPolicy(
        {
          toolName: "bash",
          input: { command: "touch output.txt", mutates: ["output.txt"] },
        },
        options
      )
    ).toBeUndefined();
  });

  test("detects detached processes without confusing normal shell operators", () => {
    expect(startsDetachedProcess("nohup bun run worker &")).toBe(true);
    expect(startsDetachedProcess("bun run worker &\necho started")).toBe(true);
    expect(startsDetachedProcess("docker run --detach image")).toBe(true);
    expect(startsDetachedProcess("echo ok && echo done 2>&1")).toBe(false);
  });

  test("keeps terminal reasons only when no subsequent model turn starts", async () => {
    const { extension, state } = createToolPolicyExtension(options);
    if (typeof extension === "function") throw new Error("expected named inline extension");

    const handlers = new Map<string, (event: any) => unknown>();
    await extension.factory({
      on: (name: string, handler: (event: any) => unknown) => {
        handlers.set(name, handler);
      },
    } as never);

    handlers.get("turn_start")?.({ type: "turn_start" });
    const decision = handlers.get("tool_call")?.({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "../../../config/models.json" },
    });
    expect(decision).toMatchObject({ block: true, terminate: true });
    expect(consumeTerminalToolBlockReply(state)).toBe(
      "⛔ 已阻止工具调用：read 只能访问本群 workspace 或当前用户 tmp"
    );
    expect(consumeTerminalToolBlockReply(state)).toBeUndefined();

    handlers.get("tool_call")?.({
      type: "tool_call",
      toolCallId: "call-2",
      toolName: "read",
      input: { path: "../../../config/models.json" },
    });
    handlers.get("turn_start")?.({ type: "turn_start" });
    expect(consumeTerminalToolBlockReply(state)).toBeUndefined();
  });
});
