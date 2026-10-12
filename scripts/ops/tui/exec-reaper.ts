// Reclaim thread. It owns every query host's termination and never starts a process, so a
// blocking spawn cannot delay a kill, and blocking native calls (OpenProcess under endpoint
// security) never run on the UI thread. Ownership grants go straight to the spawner.
import { parentPort, type MessagePort } from "node:worker_threads";
import { ownQueryHost, QueryHandleCleanupError, type QueryOwner } from "./exec-owner.ts";
import type { FromReaper, HostStopOutcome, ReaperToSpawner, SpawnerToReaper, ToReaper } from "./exec-protocol.ts";

interface Owned { owner: QueryOwner; exited: () => void; stopping?: Promise<HostStopOutcome> }
const hosts = new Map<number, Owned>();
let spawner: MessagePort | undefined;
let closing = false;
const send = (message: FromReaper) => parentPort!.postMessage(message);
const grant = (message: ReaperToSpawner) => spawner!.postMessage(message);

function describe(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}：${error.errors.map(describe).join("；")}`;
  return error instanceof Error ? error.message : String(error);
}

function own(message: Extract<SpawnerToReaper, { type: "own" }>): void {
  // After stop-all nothing new may start; the spawner is shutting down and retires the host.
  if (closing) return grant({ type: "reject", host: message.host, error: "查询正在关闭" });
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  try {
    hosts.set(message.host, { owner: ownQueryHost(message.pid, exit, message.birth), exited });
    grant({ type: "owned", host: message.host });
  } catch (error) { grant({ type: "reject", host: message.host, error: describe(error) }); }
}

/** The spawner observed the exit (Bun's child.exited): the host and, with its job or subreaper, its tree are gone. */
function exited(id: number): void {
  const host = hosts.get(id);
  if (!host) return;
  host.exited();
  if (!host.stopping) hosts.delete(id);
}

function stop(id: number): Promise<HostStopOutcome> {
  const host = hosts.get(id);
  // Unknown: never owned, so it never ran a command, or its exit was already confirmed.
  if (!host) return Promise.resolve({});
  return host.stopping ??= host.owner.stop().then(() => ({}), (error): HostStopOutcome => {
    if (error instanceof QueryHandleCleanupError) return {
      ...(error.reclaimError === undefined ? {} : { error: describe(error.reclaimError) }),
      cleanupError: `${error.message}：${describe(error.cleanupError)}`,
    };
    return { error: describe(error) };
  }).finally(() => { hosts.delete(id); });
}

parentPort!.on("message", (message: ToReaper) => {
  if (message.type === "spawner") {
    spawner = message.port;
    spawner.on("message", (event: SpawnerToReaper) => {
      if (event.type === "own") own(event);
      else exited(event.host);
    });
  } else if (message.type === "stop") {
    void stop(message.host).then(outcome => send({ type: "stopped", host: message.host, ...outcome }));
  } else {
    closing = true;
    const ids = [...hosts.keys()];
    void Promise.all(ids.map(id => stop(id).then(outcome => send({ type: "stopped", host: id, ...outcome }))))
      .then(() => send({ type: "stopped-all" }));
  }
});
