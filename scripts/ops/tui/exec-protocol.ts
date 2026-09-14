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
  | { type: "capture"; request: CaptureRequest }
  | { type: "owned"; host: number }
  | { type: "execute"; host: number; id: number }
  | { type: "release"; host: number; id: number }
  | { type: "cancel"; id: number }
  | { type: "retire"; host: number }
  | { type: "shutdown" };

export type FromWorker =
  | { type: "host"; host: number; pid: number; birth?: string }
  | { type: "dispatch"; host: number; id: number }
  | { type: "started"; host: number; id: number; at: number }
  | { type: "output"; host: number; id: number; stream: "stdout" | "stderr"; text: string }
  | { type: "result"; host: number; id: number; outcome: CaptureOutcome; retire?: boolean }
  | { type: "cancelled"; id: number }
  | { type: "retired"; host: number; error: string }
  | { type: "stopped" };

export type ToHost = { type: "owned" } | { type: "capture"; request: Omit<CaptureRequest, "cancelled"> };
export type FromHost = { type: "ready"; birth?: string } | { type: "started"; id: number; at: number }
  | { type: "output"; id: number; stream: "stdout" | "stderr"; text: string }
  | { type: "result"; id: number; outcome: CaptureOutcome; retire?: boolean };
