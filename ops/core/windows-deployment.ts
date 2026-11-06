import { join, resolve } from "node:path";
import { parseRecord, serializeRecord, type Values } from "./key-value-record.ts";
import { nativePayload, runNative, type NativeRunner } from "./native-process.ts";
export interface WindowsSnapshot {
  identity: string;
  wasRunning: boolean;
  hasTask: boolean;
  dependenciesAttempted: boolean;
  dependenciesMoved: boolean;
}
export type WindowsDeploymentEffect = "read" | "stop" | "restore-configuration" | "save-dependencies" | "restore-dependencies" | "restore-task" | "cleanup"
  | "prepare-directories" | "install-task" | "start-task";

// The deploy entry finds these before the stop; the launcher it installs runs exactly them. Absolute, and never a quote: the
// launcher and the task's command line name these paths.
const TOOL_KEYS = ["format", "bun", "git", "uv", "bash"] as const;
export type WindowsTools = Values<typeof TOOL_KEYS[number]>;
const toolPath = /^(?:[A-Za-z]:\\|\\\\)[^\x00-\x1f\x7f"]+$/;
export const parseWindowsTools = (text: string): WindowsTools => parseRecord(text, TOOL_KEYS, { format: /^1$/, bun: toolPath, git: toolPath, uv: toolPath, bash: toolPath }, "部署工具记录");
export const serializeWindowsTools = (tools: WindowsTools) => serializeRecord(tools, TOOL_KEYS);

const WRITERS = ["save-dependencies", "restore-dependencies", "restore-configuration", "restore-task", "prepare-directories", "install-task"];
export class WindowsDeployment {
  /** An upgrade binds every effect to the task it confirmed (expected); a deployment replaces the task and only requires it to be this project's. */
  constructor(readonly project: string, readonly source: string, readonly snapshot: string, readonly expected: string, private readonly run: NativeRunner = runNative,
    private readonly writer = run, readonly operation: "upgrade" | "deploy" = "upgrade") {}
  private async call(action: WindowsDeploymentEffect | "capture", fields: Record<string, unknown> = {}): Promise<unknown> {
    const request = { action, operation: this.operation, project: resolve(this.project), snapshot: this.snapshot, ...(this.operation === "upgrade" ? { expected: this.expected } : {}), ...fields };
    const run = WRITERS.includes(action) ? this.writer : this.run;
    return nativePayload(await run({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(this.source, "ops/core/windows-deployment-platform.ps1"), "-RequestBase64", Buffer.from(JSON.stringify(request)).toString("base64")],
      cwd: this.project, protocol: true, timeoutMs: action === "stop" ? 90_000 : 10 * 60_000 }), action);
  }
  private snapshotValue(value: unknown): WindowsSnapshot {
    const result = value as WindowsSnapshot;
    const service = this.operation === "deploy" ? !!result && /^[a-f0-9]{64}$/.test(String(result.identity)) && typeof result.hasTask === "boolean"
      : !!result && result.identity === this.expected && result.hasTask === true;
    if (!service || typeof result.wasRunning !== "boolean" || typeof result.dependenciesAttempted !== "boolean" || typeof result.dependenciesMoved !== "boolean")
      throw new Error("Windows 部署快照不完整");
    return result;
  }
  async capture(original: string, target: string, branch: string): Promise<WindowsSnapshot> { return this.snapshotValue(await this.call("capture", { original, target, branch })); }
  async read(): Promise<WindowsSnapshot> { return this.snapshotValue(await this.call("read")); }
  async effect(action: Exclude<WindowsDeploymentEffect, "read">, fields?: Record<string, unknown>): Promise<void> {
    if (await this.call(action, fields) !== null) throw new Error("Windows 部署动作没有完整结果");
  }
}
