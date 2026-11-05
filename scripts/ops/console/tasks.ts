// Disk is the task protocol. Neither a live PID nor a successful launcher means an operation succeeded.
import { appendFileSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { redactSecrets } from "../../lib/redact.ts";
import type { Mechanism } from "./hosting.ts";
import { writeAtomic } from "./state.ts";

const ID = /^task-[a-f0-9]{32}$/;
const DAY = 86_400_000;
const EVENT_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = EVENT_LIMIT - 64 * 1024;
const json = (value: unknown) => JSON.stringify(value) + "\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length < 4096;

export interface TaskRequest {
  version: 1;
  id: string;
  planId: string;
  operation: string;
  params: Record<string, unknown>;
  project: string;
  mechanism: Mechanism;
  createdAt: number;
  acceptBy: number;
}
export interface ExecutorIdentity { pid: number; startedAt: string }
type Claim = { version: 1; kind: "executor"; at: number; executor: ExecutorIdentity }
  | { version: 1; kind: "abandoned"; at: number };
export interface TaskResult {
  version: 1;
  id: string;
  outcome: "success" | "refused" | "failed";
  exitCode: number;
  finalState: "running" | "stopped" | "start-requested" | "unknown";
  message: string;
  finishedAt: number;
  /** A failed task whose executor still saw unfinished maintenance state when it wrote this result. */
  leftRecovery?: boolean;
}
export type HostedState = { state: "running"; executor: ExecutorIdentity } | { state: "ended" | "unknown" };
export interface TaskObservers {
  hosting(request: TaskRequest, executor: ExecutorIdentity): Promise<HostedState>;
  /** Unknown/unreadable maintenance state must return true (or throw), never clear the warning. */
  needsRecovery(request: TaskRequest): Promise<boolean>;
}
export interface TaskView {
  id: string;
  request?: TaskRequest;
  result?: TaskResult;
  state: "queued" | "not-accepted" | "running" | "interrupted" | "succeeded" | "failed" | "unknown";
  needsRecovery: boolean;
  reason?: string;
}
export interface TaskEvent { seq: number; at: number; kind: "output" | "phase" | "error" | "truncated"; text: string }

/** Publish a complete file exactly once. A killed writer leaves only an unpublished temporary file. */
function publish(path: string, value: unknown): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  } finally { rmSync(temporary, { force: true }); }
}

function read(path: string, max = 256 * 1024): unknown | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("记录类型或大小无效");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function identity(value: unknown): value is ExecutorIdentity {
  return object(value) && number(value.pid) && value.pid > 0 && text(value.startedAt);
}
function validRequest(value: unknown, id: string): value is TaskRequest {
  return object(value) && value.version === 1 && value.id === id && text(value.planId) && text(value.operation)
    && object(value.params) && text(value.project) && ["windows-task", "systemd-system", "systemd-user"].includes(String(value.mechanism))
    && number(value.createdAt) && number(value.acceptBy) && value.acceptBy > value.createdAt;
}
function validClaim(value: unknown): value is Claim {
  return object(value) && value.version === 1 && number(value.at)
    && (value.kind === "abandoned" || (value.kind === "executor" && identity(value.executor)));
}
function validResult(value: unknown, id: string): value is TaskResult {
  return object(value) && value.version === 1 && value.id === id && number(value.finishedAt) && number(value.exitCode)
    && ["success", "refused", "failed"].includes(String(value.outcome)) && typeof value.message === "string"
    && ["running", "stopped", "start-requested", "unknown"].includes(String(value.finalState))
    && (value.outcome !== "success" || value.exitCode === 0)
    && (value.leftRecovery === undefined || (typeof value.leftRecovery === "boolean" && value.outcome === "failed"));
}

export class TaskStore {
  readonly root: string;
  constructor(consoleDir: string, readonly now: () => number = Date.now) {
    this.root = resolve(consoleDir, "tasks");
    mkdirSync(join(this.root, "keys"), { recursive: true, mode: 0o700 });
  }

  dir(id: string): string {
    if (!ID.test(id)) throw new Error("任务编号无效");
    const dir = join(this.root, id);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("任务目录无效");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return dir;
  }

  request(id: string): TaskRequest {
    const value = read(join(this.dir(id), "request.json"));
    if (!validRequest(value, id)) throw new Error("任务请求缺失或损坏");
    return value;
  }

  /** Additional submission keys may name the same plan task, but may never move to another task. */
  bindKey(key: string, id: string): void {
    if (!text(key)) throw new Error("幂等键无效");
    this.request(id);
    const path = join(this.root, "keys", hash(`submission:${key}`));
    if (!publish(path, { version: 1, id })) {
      const value = read(path);
      if (!object(value) || value.version !== 1 || value.id !== id) throw new Error("幂等键已用于其他任务或记录损坏");
    }
  }

  lookupSubmission(key: string): string | undefined {
    if (!text(key)) throw new Error("幂等键无效");
    const value = read(join(this.root, "keys", hash(`submission:${key}`)));
    if (value === undefined) return;
    if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !ID.test(value.id)) throw new Error("幂等记录损坏");
    return value.id;
  }

  lookupPlan(planId: string): string | undefined {
    const value = read(join(this.root, "keys", hash(`plan:${planId}`)));
    if (value === undefined) return;
    if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !ID.test(value.id)) throw new Error("计划任务映射损坏");
    return value.id;
  }

  create(input: Omit<TaskRequest, "version" | "id" | "createdAt" | "acceptBy">, key: string, acceptMs = 20_000): { id: string; created: boolean } {
    if (!text(key) || !Number.isSafeInteger(acceptMs) || acceptMs < 1 || acceptMs > 60_000) throw new Error("提交参数无效");
    // A plan is immutable. Binding its id and project prevents a key from authorising a different operation.
    const fingerprint = hash(json([input.project, input.planId, input.operation, input.params, input.mechanism]));
    const path = join(this.root, "keys", hash(key));
    const existing = (): { id: string; created: false } | undefined => {
      const value = read(path);
      if (value === undefined) return;
      if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !ID.test(value.id) || value.fingerprint !== fingerprint) {
        throw new Error("幂等键已用于其他计划或记录损坏");
      }
      // Keys outlive pruned records: old submissions must never become new operations.
      this.request(value.id);
      return { id: value.id, created: false };
    };
    const previous = existing();
    if (previous) return previous;
    const id = `task-${randomUUID().replaceAll("-", "")}`, at = this.now();
    const request: TaskRequest = { ...input, version: 1, id, createdAt: at, acceptBy: at + acceptMs };
    if (!validRequest(request, id)) throw new Error("任务请求无效");
    const dir = this.dir(id);
    mkdirSync(dir, { mode: 0o700 });
    let published = false;
    try {
      publish(join(dir, "request.json"), request);
      published = publish(path, { version: 1, id, fingerprint });
      if (published) return { id, created: true };
      const winner = existing();
      if (!winner) throw new Error("幂等键记录丢失");
      return winner;
    } finally {
      if (!published) rmSync(dir, { recursive: true }); // our unpublished candidate only
    }
  }

  accept(id: string, executor: ExecutorIdentity): boolean {
    if (!identity(executor)) throw new Error("执行者身份无效");
    const request = this.request(id), at = this.now();
    if (at >= request.acceptBy) { this.abandon(id); return false; }
    if (!publish(join(this.dir(id), "claim"), { version: 1, kind: "executor", at, executor } satisfies Claim)) return false;
    // The link may itself have been delayed by I/O. Do not start an operation after the deadline.
    if (this.now() >= request.acceptBy) {
      this.finish(id, { outcome: "refused", exitCode: 1, finalState: "unknown", message: "接单期限已过，未执行" });
      return false;
    }
    return true;
  }

  abandon(id: string): boolean {
    const request = this.request(id), at = this.now(), path = join(this.dir(id), "claim");
    if (at < request.acceptBy) return false;
    // A claim, once published, is final. Views of old tasks run every few seconds: they must not write (and remove) a
    // temporary file each time, since every task's private-directory check walks these directories.
    try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return publish(path, { version: 1, kind: "abandoned", at } satisfies Claim);
  }

  heartbeat(id: string, executor: ExecutorIdentity): void {
    const claim = read(join(this.dir(id), "claim"));
    if (!validClaim(claim) || claim.kind !== "executor" || claim.executor.pid !== executor.pid || claim.executor.startedAt !== executor.startedAt) {
      throw new Error("执行者与接单记录不符");
    }
    writeAtomic(join(this.dir(id), "heartbeat"), json({ version: 1, at: this.now(), executor }));
  }

  finish(id: string, result: Omit<TaskResult, "version" | "id" | "finishedAt">): void {
    const claim = read(join(this.dir(id), "claim"));
    if (!validClaim(claim) || claim.kind !== "executor") throw new Error("尚未接单，不能写执行结果");
    const record: TaskResult = { ...result, message: this.redactor(id)(result.message), version: 1, id, finishedAt: this.now() };
    if (!validResult(record, id)) throw new Error("任务结果不完整或相互矛盾");
    if (!publish(join(this.dir(id), "result.json"), record)) throw new Error("任务结果已经写入");
  }

  async view(id: string, observers: TaskObservers): Promise<TaskView> {
    const view: TaskView = { id, state: "unknown", needsRecovery: false };
    try {
      const request = this.request(id);
      view.request = request;
      this.abandon(id); // expiry and a late executor arbitrate through the same exclusive publication
      const resultPath = join(this.dir(id), "result.json");
      const claim = read(join(this.dir(id), "claim")), result = read(resultPath);
      const finished = (value: unknown, acceptedAt: number) => {
        if (!validResult(value, id) || value.finishedAt < acceptedAt) throw new Error("结果记录损坏或不完整");
        view.result = value;
        view.state = value.outcome === "success" ? "succeeded" : "failed";
      };
      if (claim === undefined) {
        if (result !== undefined) throw new Error("结果缺少接单记录");
        view.state = "queued";
      } else {
        if (!validClaim(claim)) throw new Error("接单记录损坏");
        if (claim.kind === "abandoned") {
          if (result !== undefined) throw new Error("未接单任务出现执行结果");
          view.state = "not-accepted";
        } else if (result !== undefined) finished(result, claim.at);
        else {
          let hosted: HostedState;
          try { hosted = await observers.hosting(request, claim.executor); } catch { hosted = { state: "unknown" }; }
          // The executor publishes its result before it exits: one published during the hosting query decides,
          // or a task that just finished would flash as unknown or interrupted.
          const late = hosted.state === "running" ? undefined : read(resultPath);
          if (late !== undefined) finished(late, claim.at);
          else if (hosted.state === "running") {
            view.state = hosted.executor.pid === claim.executor.pid && hosted.executor.startedAt === claim.executor.startedAt ? "running" : "interrupted";
          } else if (hosted.state === "ended") view.state = "interrupted";
          else {
            const beat = read(join(this.dir(id), "heartbeat"));
            if (beat !== undefined && (!object(beat) || beat.version !== 1 || !number(beat.at) || !identity(beat.executor)
              || beat.executor.pid !== claim.executor.pid || beat.executor.startedAt !== claim.executor.startedAt)) throw new Error("心跳记录损坏");
            const last = object(beat) && number(beat.at) ? beat.at : claim.at;
            view.state = this.now() - last > 60_000 ? "interrupted" : "unknown";
          }
        }
      }
      // Unfinished maintenance belongs to the tasks that may have left it: unfinished ones, and failures whose
      // executor still saw it when writing the result. Finished, running and never-run tasks are not flagged;
      // the maintenance page shows the deployment-wide state on its own.
      if (view.state === "interrupted" || view.state === "unknown" || view.result?.leftRecovery) {
        try { view.needsRecovery = await observers.needsRecovery(request); }
        catch { view.needsRecovery = true; }
      }
    } catch {
      view.state = "unknown";
      view.reason = "任务记录无法完整读取；请检查记录和维护状态";
      view.needsRecovery = true;
    }
    return view;
  }

  async list(observers: TaskObservers): Promise<TaskView[]> {
    const views: TaskView[] = [];
    for (const id of readdirSync(this.root).filter(id => ID.test(id))) views.push(await this.view(id, observers));
    return views.sort((a, b) => (b.request?.createdAt ?? 0) - (a.request?.createdAt ?? 0) || a.id.localeCompare(b.id));
  }

  async prune(observers: TaskObservers): Promise<string[]> {
    const removed: string[] = [];
    const views = await this.list(observers);
    for (const view of views.slice(50)) {
      if (view.needsRecovery || !["succeeded", "failed", "not-accepted"].includes(view.state)) continue;
      const endedAt = view.result?.finishedAt ?? view.request?.acceptBy;
      if (endedAt === undefined || this.now() - endedAt <= 30 * DAY) continue;
      rmSync(this.dir(view.id), { recursive: true });
      removed.push(view.id);
    }
    return removed;
  }

  events(id: string, after = 0): TaskEvent[] {
    if (!number(after)) throw new Error("事件序号无效");
    const path = join(this.dir(id), "events.jsonl");
    let source: string;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > EVENT_LIMIT) throw new Error("事件文件无效");
      source = readFileSync(path, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const events: TaskEvent[] = [];
    let seq = 0;
    // The last append may still be in flight. An incomplete tail is never emitted.
    for (const line of source.slice(0, source.lastIndexOf("\n") + 1).split("\n").filter(Boolean)) {
      const event: unknown = JSON.parse(line);
      if (!object(event) || event.seq !== ++seq || !number(event.at) || typeof event.text !== "string"
        || !["output", "phase", "error", "truncated"].includes(String(event.kind))) throw new Error("事件记录损坏");
      if (event.seq > after) events.push(event as unknown as TaskEvent);
    }
    return events;
  }

  /** Single writer: only the winning executor opens this after acceptance. */
  eventWriter(id: string): (kind: "output" | "phase" | "error", message: string) => void {
    const claim = read(join(this.dir(id), "claim"));
    if (!validClaim(claim) || claim.kind !== "executor") throw new Error("未接单，不能写任务日志");
    const path = join(this.dir(id), "events.jsonl"), prior = this.events(id), redact = this.redactor(id);
    let seq = prior.at(-1)?.seq ?? 0, truncated = prior.some(event => event.kind === "truncated"), bytes = 0;
    try { bytes = lstatSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const append = (kind: TaskEvent["kind"], message: string): boolean => {
      const line = json({ seq: seq + 1, at: this.now(), kind, text: message });
      const size = Buffer.byteLength(line);
      if (bytes + size > EVENT_LIMIT) return false;
      appendFileSync(path, line, { mode: 0o600 });
      bytes += size; seq++;
      return true;
    };
    return (kind, message) => {
      const safe = redact(message);
      for (const line of safe.split(/\r?\n/)) {
        const clipped = line.slice(0, 8192);
        if (kind === "output" && (truncated || bytes + Buffer.byteLength(json({ seq: seq + 1, at: this.now(), kind, text: clipped })) > OUTPUT_LIMIT)) {
          if (!truncated) { append("truncated", "输出已截断，后续只记录阶段和错误"); truncated = true; }
          continue;
        }
        append(kind, clipped);
      }
    };
  }

  /** One task's redaction (secrets, the member phone the task names, any mobile number); its request is read once. */
  private redactor(id: string): (message: string) => string {
    const phone = this.request(id).params.phone;
    return message => {
      let text = redactSecrets(message);
      if (typeof phone === "string" && phone.length >= 5) text = text.replaceAll(phone, `${phone.slice(0, 3)}****${phone.slice(-2)}`);
      return text.replace(/\b1[3-9]\d{9}\b/g, value => `${value.slice(0, 3)}****${value.slice(-4)}`);
    };
  }
}
