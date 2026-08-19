import type {
  InlineExtension,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export interface TerminalToolBlockState {
  reason?: string;
}

interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

const DETACHED_PROCESS_REASON =
  "禁止启动在 bash 工具返回后仍继续运行的后台进程";

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
 * The only pre-execution policy that remains, and the only one that should.
 *
 * Path containment is not checked here: every tool that takes a path already
 * enforces it canonically in its own execute — AllowedPathGuard for
 * read/edit/write, loadBytes for send_image/send_file — and a violation there
 * surfaces as an ordinary tool error the model can recover from inside the same
 * turn. Duplicating those checks here only added `terminate`, which turns a
 * one-turn self-correction into a dead task.
 *
 * A detached background process is genuinely different. It outlives the tool's
 * AbortSignal, so the damage is in the intent rather than in the arguments, and
 * another model turn just invites a different spawn syntax. That one ends the
 * turn and reports straight back to the user.
 */
export function evaluateToolCallPolicy(
  event: ToolCallLike
): ToolCallEventResult | undefined {
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command;
  if (typeof command !== "string" || !startsDetachedProcess(command)) {
    return undefined;
  }
  return { block: true, reason: DETACHED_PROCESS_REASON, terminate: true };
}

export function createToolPolicyExtension(): {
  extension: InlineExtension;
  state: TerminalToolBlockState;
} {
  const state: TerminalToolBlockState = {};
  const extension: InlineExtension = {
    name: "mixin-tool-policy",
    hidden: true,
    factory: (pi) => {
      // A subsequent turn means the batch was not all-terminating; let the
      // model consume the blocked result and produce the normal final reply.
      pi.on("turn_start", () => {
        state.reason = undefined;
      });
      pi.on("tool_call", (event) => {
        const decision = evaluateToolCallPolicy(event);
        if (decision?.terminate && decision.reason) state.reason = decision.reason;
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
  const reason = state?.reason;
  if (!reason) return undefined;
  state.reason = undefined;
  return `⛔ 已阻止工具调用：${reason}`;
}
