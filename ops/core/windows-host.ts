import { join, resolve } from "node:path";
import { runNative, nativePayload, type NativeRunner } from "./native-process.ts";

export interface WindowsService {
  identity: string;
  owned: boolean;
  state: "running" | "stopped" | "absent" | "unsupported";
  rawState: string;
}

/** No shell command strings: only a base64 JSON request crosses PowerShell's parameter binder. */
export class WindowsPlatform {
  constructor(readonly project: string, readonly source: string, private readonly run: NativeRunner = runNative) {}
  private async call(action: "inspect" | "start" | "stop" | "last-result", expected?: string): Promise<unknown> {
    const request = { action, project: resolve(this.project), task: "mixin-bot", ...(expected ? { expected } : {}) };
    const result = await this.run({ command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(this.source, "ops/core/windows-platform.ps1"), "-RequestBase64", Buffer.from(JSON.stringify(request), "utf8").toString("base64")],
      cwd: this.project, protocol: true, timeoutMs: action === "stop" ? 90_000 : 30_000 });
    return nativePayload(result, action);
  }
  async inspect(): Promise<WindowsService> {
    const value = await this.call("inspect") as Partial<WindowsService> | null;
    if (!value || !/^[a-f0-9]{64}$/.test(String(value.identity)) || typeof value.owned !== "boolean" || typeof value.rawState !== "string"
      || !["running", "stopped", "absent", "unsupported"].includes(String(value.state))) throw new Error("计划任务状态不完整");
    return value as WindowsService;
  }
  /** Diagnostics only: the scheduler's last result code, or null without a task to ask about. */
  async lastResult(): Promise<string | null> {
    const value = await this.call("last-result");
    if (value !== null && typeof value !== "string") throw new Error("计划任务结果不完整");
    return value;
  }
  async start(identity: string): Promise<void> { await this.call("start", identity); }
  async stop(identity: string): Promise<void> { await this.call("stop", identity); }
}
