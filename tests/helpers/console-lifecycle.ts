// Real loopback HTTP client for opt-in, synthetic Docker deployments. No browser or production credentials.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskResult, TaskView } from "../../scripts/ops/console/tasks.ts";

export type WebTask = Pick<TaskView, "id" | "state" | "needsRecovery" | "result" | "reason">;
const safe = (text: string) => text.replace(/#login=[A-Za-z0-9_-]+/g, "#login=[redacted]");

export class LifecycleConsole {
  private output = "";
  private cookie = "";
  private exit: { code: number | null; signal: string | null } | undefined;
  private readonly ended: Promise<void>;
  private readonly child: ChildProcess;
  readonly origin: string;

  constructor(readonly work: string, port: number, private readonly log: string, env: NodeJS.ProcessEnv) {
    if (!work.startsWith("/var/tmp/mixin-real-docker-") || process.platform !== "linux") throw new Error("not an isolated Docker fixture");
    this.origin = `http://127.0.0.1:${port}`;
    this.child = spawn(process.execPath, ["--no-env-file", "scripts/ops/console.ts", "--port", String(port), "--no-open"], {
      cwd: work, env, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => { this.output += chunk; });
    }
    this.ended = new Promise(resolve => {
      this.child.on("error", error => { this.output += String(error); });
      this.child.on("close", (code, signal) => {
        this.exit = { code, signal }; writeFileSync(log, safe(this.output)); resolve();
      });
    });
  }

  async login(): Promise<void> {
    const deadline = Date.now() + 45_000;
    let token: string | undefined;
    while (!(token = /#login=([A-Za-z0-9_-]{43})/.exec(this.output)?.[1])) {
      if (this.exit || Date.now() > deadline) throw new Error(`console did not start: ${safe(this.output)}`);
      await Bun.sleep(100);
    }
    const response = await this.request("/api/session/exchange", { token });
    if (response.status !== 200) throw new Error(`console login failed (${response.status}): ${await response.text()}`);
    this.cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (!this.cookie || !response.headers.get("set-cookie")?.includes("HttpOnly")) throw new Error("missing session cookie");
    await response.arrayBuffer();
  }

  request(path: string, body?: unknown): Promise<Response> {
    if (!path.startsWith("/api/")) throw new Error("API path required");
    return fetch(this.origin + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(120_000),
      headers: { Origin: this.origin, "X-Console-Request": "1", "X-Console-Intent": "user", "Content-Type": "application/json", Cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async json<T>(path: string, body?: unknown, status = 200): Promise<T> {
    const response = await this.request(path, body), text = await response.text();
    if (response.status !== status) throw new Error(`${path}: expected ${status}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  async submit(operation: string, params: Record<string, unknown>): Promise<string> {
    const plan = await this.json<{ id: string; summary: string[] }>("/api/plans", { operation, params });
    if (!/^plan-[a-f0-9]{32}$/.test(plan.id) || !plan.summary.length) throw new Error("missing operation preview");
    const task = await this.json<WebTask>("/api/tasks", { plan: plan.id, key: crypto.randomUUID() }, 202);
    if (!/^task-[a-f0-9]{32}$/.test(task.id)) throw new Error("missing durable task id");
    return task.id;
  }

  async wait(id: string, timeout = 900_000): Promise<WebTask> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const task = await this.json<WebTask>(`/api/tasks/${id}`);
      if (!["queued", "running"].includes(task.state)) return task;
      if (Date.now() > deadline) throw new Error(`task did not finish: ${JSON.stringify(task)}`);
      await Bun.sleep(1000);
    }
  }

  async close(): Promise<void> {
    if (!this.exit) this.child.kill("SIGTERM");
    const exited = await Promise.race([this.ended.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!exited) { this.child.kill("SIGKILL"); await this.ended; throw new Error(`console needed SIGKILL; see ${this.log}`); }
  }
}

export function taskResult(work: string, id: string): TaskResult | undefined {
  if (!/^task-[a-f0-9]{32}$/.test(id)) throw new Error("invalid task id");
  try { return JSON.parse(readFileSync(join(work, ".console/tasks", id, "result.json"), "utf8")) as TaskResult; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
