import { resolve } from "node:path";
import type {
  InlineExtension,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isPathInside } from "./paths.ts";

export interface TerminalToolBlockState {
  reasons: string[];
}

export interface ToolPolicyOptions {
  workspaceDir: string;
  tempDir: string;
}

interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

const PATH_TOOLS = new Set(["read", "edit", "write"]);

function terminatingBlock(reason: string): ToolCallEventResult {
  return { block: true, reason, terminate: true };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Detect commands deliberately detached from the bash tool lifecycle. This is
 * intentionally conservative rather than a shell parser; the tool's AbortSignal
 * can only supervise children that remain attached to the spawned command.
 */
export function startsDetachedProcess(command: string): boolean {
  if (/(?:^|[;&|\n]\s*)(?:nohup|setsid|disown|start-process)\b/im.test(command)) {
    return true;
  }
  if (/(?:^|[;&|\n]\s*)tmux\s+(?:new|new-session|new-window)\b[^\n;]*\s-d\b/im.test(command)) {
    return true;
  }
  if (/(?:^|[;&|\n]\s*)screen\s+-(?:\w*d\w*m|dm)\b/im.test(command)) {
    return true;
  }
  if (/(?:^|[;&|\n]\s*)docker\s+run\b[^\n;]*(?:\s-d\b|\s--detach\b)/im.test(command)) {
    return true;
  }
  // A single trailing '&' starts a background job. Avoid matching && and 2>&1.
  return /(^|[^&])&(?![&=])\s*(?:$|\n)/m.test(command);
}

/**
 * Cheap, pre-execution checks for policy violations that should not be repaired
 * by another model turn. Canonical/symlink validation remains in each tool's
 * execute implementation as the authoritative boundary.
 */
export function evaluateToolCallPolicy(
  event: ToolCallLike,
  options: ToolPolicyOptions
): ToolCallEventResult | undefined {
  const workspaceDir = resolve(options.workspaceDir);
  const tempDir = resolve(options.tempDir);

  if (PATH_TOOLS.has(event.toolName)) {
    const path = event.input.path;
    if (typeof path !== "string") return undefined;
    const target = resolve(workspaceDir, path);
    if (!isPathInside(target, workspaceDir) && !isPathInside(target, tempDir)) {
      return terminatingBlock(
        `${event.toolName} 只能访问本群 workspace 或当前用户 tmp`
      );
    }
    return undefined;
  }

  if (event.toolName === "send_image" || event.toolName === "send_file") {
    const source = event.input.source;
    if (typeof source !== "string" || isHttpUrl(source)) return undefined;
    const target = resolve(workspaceDir, source);
    if (!isPathInside(target, workspaceDir) && !isPathInside(target, tempDir)) {
      return terminatingBlock(
        `${event.toolName} 只能发送本群 workspace 或当前用户 tmp 内的文件`
      );
    }
    return undefined;
  }

  if (event.toolName === "bash") {
    const mutates = event.input.mutates;
    if (Array.isArray(mutates)) {
      const outsideWorkspace = mutates.some(
        (path) =>
          typeof path === "string" &&
          !isPathInside(resolve(workspaceDir, path), workspaceDir)
      );
      if (outsideWorkspace) {
        return terminatingBlock(
          "bash.mutates 只能声明本群 workspace 内的路径"
        );
      }
    }

    const command = event.input.command;
    if (typeof command === "string" && startsDetachedProcess(command)) {
      return terminatingBlock(
        "禁止启动在 bash 工具返回后仍继续运行的后台进程"
      );
    }
  }

  return undefined;
}

export function createToolPolicyExtension(options: ToolPolicyOptions): {
  extension: InlineExtension;
  state: TerminalToolBlockState;
} {
  const state: TerminalToolBlockState = { reasons: [] };
  const extension: InlineExtension = {
    name: "mixin-tool-policy",
    hidden: true,
    factory: (pi) => {
      // A subsequent turn means the batch was not all-terminating; let the
      // model consume the blocked result and produce the normal final reply.
      pi.on("turn_start", () => {
        state.reasons.length = 0;
      });
      pi.on("tool_call", (event) => {
        const decision = evaluateToolCallPolicy(event, options);
        if (decision?.terminate && decision.reason) {
          state.reasons.push(decision.reason);
        }
        return decision;
      });
    },
  };
  return { extension, state };
}

/** Consume the direct user reply for an all-terminating blocked tool batch. */
export function consumeTerminalToolBlockReply(
  state: TerminalToolBlockState | undefined
): string | undefined {
  if (!state || state.reasons.length === 0) return undefined;
  const reasons = [...new Set(state.reasons)];
  state.reasons.length = 0;
  return reasons.length === 1
    ? `⛔ 已阻止工具调用：${reasons[0]}`
    : `⛔ 已阻止以下工具调用：\n${reasons.map((reason) => `- ${reason}`).join("\n")}`;
}
