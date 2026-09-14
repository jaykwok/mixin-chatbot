import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { PROJECT_DIR } from "./platform.ts";
import type { CaptureRequest, FromWorker, ToHost, ToWorker } from "./exec-protocol.ts";
import { observeQueryProcess } from "./exec-observe.ts";

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
  request?: CaptureRequest;
}
const hosts = new Map<number, Host>();
let hostId = 0;
let growth: ReturnType<typeof setTimeout> | undefined;
const stopping = () => Atomics.load(shutdown, 0) !== 0;
const cancelled = (request: CaptureRequest) => stopping() || Atomics.load(new Int32Array(request.cancelled), 0) !== 0;
const send = (message: FromWorker) => parentPort!.postMessage(message);
function write(host: Host, message: ToHost): void { host.child.stdin.write(JSON.stringify(message) + "\n"); }

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
  const host: Host = { id: ++hostId, child, owned: false, ready: false, initialized: false, retiring: false };
  hosts.set(host.id, host);
  if (process.platform !== "win32") send({ type: "host", host: host.id, pid: child.pid });
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
        if (process.platform === "win32") send({ type: "host", host: host.id, pid: host.child.pid, birth: message.birth });
        host.ready = true;
        pump();
      } else if (host.request?.id === message.id) {
        if (message.type === "started") {
          host.initialized = true;
          send({ ...message, host: host.id });
          pump();
        } else {
          if (message.type === "result") { clearTimeout(growth); growth = undefined; }
          send({ ...message, host: host.id });
        }
      }
    }, () => retire(host));
  } catch (cause) { error = String(cause); }
  finally {
    hosts.delete(host.id);
    send({ type: "retired", host: host.id, error });
    pump();
  }
}
parentPort!.on("message", (message: ToWorker) => {
  if (message.type === "capture") queue.push(message.request);
  else if (message.type === "shutdown") Atomics.store(shutdown, 0, 1);
  else if (message.type === "cancel") {
    for (const host of hosts.values()) if (host.request?.id === message.id) retire(host);
  } else {
    const host = hosts.get(message.host);
    if (!host) return;
    if (message.type === "retire") retire(host);
    else if (message.type === "owned") {
      if (!host.retiring && !stopping()) { host.owned = true; write(host, { type: "owned" }); }
    } else if (host.request?.id === message.id) {
      if (message.type === "release") host.request = undefined;
      else if (cancelled(host.request) || host.retiring) {
        send({ type: "cancelled", id: message.id });
        retire(host);
      } else {
        const { cancelled: _flag, ...request } = host.request;
        write(host, { type: "capture", request });
      }
    }
  }
  pump();
});
