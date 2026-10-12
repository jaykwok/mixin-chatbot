import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { PROJECT_DIR } from "./platform.ts";
import type { CaptureRequest, FromWorker, ReaperToSpawner, SpawnerToReaper, ToHost, ToWorker } from "./exec-protocol.ts";
import { observeQueryProcess } from "./exec-observe.ts";

// Spawner thread. Bun.spawn blocks this thread, for seconds under endpoint security, so nothing time-critical
// depends on it: the reclaim thread grants ownership and can terminate any host while a spawn is in progress.
const shutdown = new Int32Array(workerData.shutdown as SharedArrayBuffer);
const queue: CaptureRequest[] = [];
type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;
interface Host {
  id: number;
  child: Child;
  owned: boolean;
  ready: boolean;
  initialized: boolean;
  retiring: boolean;
  /** Asked to exit. A host that leaves otherwise (failed start, broken channel, lost grant) is a fault. */
  dismissed: boolean;
  request?: CaptureRequest;
  /** The command was sent to the host; only then can a cancellation leave a process tree behind. */
  executing: boolean;
}
const hosts = new Map<number, Host>();
let hostId = 0;
let growth: ReturnType<typeof setTimeout> | undefined;
let reaper: MessagePort | undefined;
const stopping = () => Atomics.load(shutdown, 0) !== 0;
const cancelled = (request: CaptureRequest) => stopping() || Atomics.load(new Int32Array(request.cancelled), 0) !== 0;
const send = (message: FromWorker) => parentPort!.postMessage(message);
const toReaper = (message: SpawnerToReaper) => reaper!.postMessage(message);
function write(host: Host, message: ToHost): void { host.child.stdin.write(JSON.stringify(message) + "\n"); }

function dismiss(host: Host): void {
  host.dismissed = true;
  retire(host);
}
function retire(host: Host): void {
  if (host.retiring) return;
  host.retiring = true;
  // EOF also reaches the host when the UI is forcibly killed. Hosts never inherit
  // this pipe into commands; its lifetime stays tied to the UI/Worker alone.
  try { host.child.stdin.end(); } catch { host.child.kill("SIGTERM"); }
}
function pump(): void {
  for (let index = queue.length - 1; index >= 0; index--) {
    if (!cancelled(queue[index]!)) continue;
    send({ type: "cancelled", id: queue.splice(index, 1)[0]!.id });
  }
  if (stopping()) {
    clearTimeout(growth);
    growth = undefined;
    for (const host of hosts.values()) retire(host);
    if (!hosts.size) send({ type: "stopped" });
    return;
  }
  for (const host of hosts.values()) {
    if (!queue.length) break;
    if (!host.owned || !host.ready || host.retiring || host.request) continue;
    host.request = queue.shift()!;
    // The UI records the host/request association BEFORE granting execution.
    send({ type: "dispatch", host: host.id, id: host.request.id });
  }
  const available = [...hosts.values()].filter(host => !host.request && !host.retiring).length;
  if (queue.length && !hosts.size) createHost();
  else if (queue.length > available && hosts.size < 2 && !growth && [...hosts.values()].some(host => host.initialized)) {
    // Let short Git reads reuse the first warm host. A second cold Windows spawn
    // must not stall delivery of the first host's results; grow only for queued work.
    growth = setTimeout(() => {
      growth = undefined;
      if (!stopping() && queue.length && hosts.size < 2 && [...hosts.values()].every(host => host.request || host.retiring)) createHost();
    }, process.platform === "win32" ? 150 : 10);
  }
}
function createHost(): void {
  const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./exec-host.ts", import.meta.url)), String(process.pid)], {
    cwd: PROJECT_DIR, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    windowsHide: true, detached: process.platform !== "win32",
  });
  const host: Host = { id: ++hostId, child, owned: false, ready: false, initialized: false, retiring: false, dismissed: false, executing: false };
  hosts.set(host.id, host);
  // spawn can block. Recheck the shared flag before doing anything with its result.
  if (stopping()) retire(host);
  void observe(host).catch(() => { parentPort!.close(); });
  pump();
}
async function observe(host: Host): Promise<void> {
  let error = "查询进程已退出";
  try {
    error = await observeQueryProcess(host.child, message => {
      if (message.type === "ready") {
        host.ready = true;
        // The reclaim thread records the host (and can terminate it) before it may execute anything.
        if (!host.retiring && !stopping()) toReaper({ type: "own", host: host.id, pid: host.child.pid, birth: message.birth });
      } else if (host.request?.id === message.id) {
        if (message.type === "started") {
          host.initialized = true;
          send({ ...message, host: host.id });
          pump();
        } else {
          if (message.type === "result") { clearTimeout(growth); growth = undefined; host.executing = false; }
          send({ ...message, host: host.id });
        }
      }
    }, () => retire(host));
  } catch (cause) { error = String(cause); }
  finally {
    hosts.delete(host.id);
    toReaper({ type: "exited", host: host.id });
    send({ type: "retired", host: host.id, error, expected: host.dismissed || stopping() });
    pump();
  }
}
function fromReaper(message: ReaperToSpawner): void {
  const host = hosts.get(message.host);
  if (!host) return;
  if (message.type === "owned") {
    if (!host.retiring && !stopping()) { host.owned = true; write(host, { type: "owned" }); }
  } else {
    dismiss(host);
    // Refused ownership while running normally: no host can ever execute, so fail the queued work.
    if (!stopping()) send({ type: "fault", error: message.error });
  }
  pump();
}
parentPort!.on("message", (message: ToWorker) => {
  if (message.type === "reaper") {
    reaper = message.port;
    reaper.on("message", (event: ReaperToSpawner) => fromReaper(event));
    return;
  }
  if (message.type === "capture") queue.push(message.request);
  else if (message.type === "shutdown") Atomics.store(shutdown, 0, 1);
  else if (message.type === "cancel") {
    for (const host of hosts.values()) {
      if (host.request?.id !== message.id) continue;
      if (host.executing) dismiss(host);
      else { host.request = undefined; send({ type: "cancelled", id: message.id }); }
    }
  } else {
    const host = hosts.get(message.host);
    if (!host) return;
    if (message.type === "retire") dismiss(host);
    else if (host.request?.id === message.id) {
      if (message.type === "release") {
        if (message.requeue && !host.executing && !cancelled(host.request)) queue.unshift(host.request);
        host.request = undefined;
      } else if (cancelled(host.request) || host.retiring) {
        send({ type: "cancelled", id: message.id });
        host.request = undefined;
      } else {
        const { cancelled: _flag, ...request } = host.request;
        host.executing = true;
        write(host, { type: "capture", request });
      }
    }
  }
  pump();
});
