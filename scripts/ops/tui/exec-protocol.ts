import type { MessagePort } from "node:worker_threads";
import type { RunResult } from "./exec.ts";

export interface CaptureRequest {
  id: number;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input?: string;
  /** AbortSignal cannot be transferred to a Worker. This flag also covers a blocked spawn. */
  cancelled: SharedArrayBuffer;
}

export type CaptureOutcome = { result: RunResult } | { error: string };
export type ToWorker =
  | { type: "reaper"; port: MessagePort }
  | { type: "capture"; request: CaptureRequest }
  | { type: "execute"; host: number; id: number }
  /** `requeue`: the UI declined a dispatch before execution; the request goes back to the queue. */
  | { type: "release"; host: number; id: number; requeue?: boolean }
  | { type: "cancel"; id: number }
  | { type: "retire"; host: number }
  | { type: "shutdown" };

export type FromWorker =
  | { type: "dispatch"; host: number; id: number }
  | { type: "started"; host: number; id: number; at: number }
  | { type: "output"; host: number; id: number; stream: "stdout" | "stderr"; text: string }
  | { type: "result"; host: number; id: number; outcome: CaptureOutcome; retire?: boolean }
  | { type: "cancelled"; id: number }
  /** `expected`: the host was asked to exit (retire, shutdown, refused ownership); otherwise it failed on its own. */
  | { type: "retired"; host: number; error: string; expected: boolean }
  | { type: "fault"; error: string }
  | { type: "stopped" };

/**
 * Spawner ⇄ reaper, over their own MessagePort. Ownership grants and exit acknowledgements never wait
 * for the UI thread, which may itself be busy (a synchronous spawn for an operation, a long render).
 */
export type SpawnerToReaper = { type: "own"; host: number; pid: number; birth?: string } | { type: "exited"; host: number };
export type ReaperToSpawner = { type: "owned"; host: number } | { type: "reject"; host: number; error: string };

/** `error` means exit is unconfirmed; `cleanupError` remains a failure even after exit is confirmed. */
export interface HostStopOutcome { error?: string; cleanupError?: string }

/** UI ⇄ reaper. `stopped` without `error` confirms exit, even when independent resource cleanup failed. */
export type ToReaper = { type: "spawner"; port: MessagePort } | { type: "stop"; host: number } | { type: "stop-all" };
export type FromReaper = ({ type: "stopped"; host: number } & HostStopOutcome) | { type: "stopped-all" };

export type ToHost = { type: "owned" } | { type: "capture"; request: Omit<CaptureRequest, "cancelled"> };
export type FromHost = { type: "ready"; birth?: string } | { type: "started"; id: number; at: number }
  | { type: "output"; id: number; stream: "stdout" | "stderr"; text: string }
  | { type: "result"; id: number; outcome: CaptureOutcome; retire?: boolean };
