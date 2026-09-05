import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

type WorkspaceAccess = "file" | "opaque";

interface AccessWaiter {
  mode: WorkspaceAccess;
  start: () => void;
}

interface WorkspaceState {
  activeFiles: number;
  pathWaiters: number;
  opaqueActive: boolean;
  waiters: AccessWaiter[];
}

interface PathQueueState {
  tail: Promise<void>;
  depth: number;
}

export interface WorkspaceCoordinationStatus {
  fileMutations: number;
  opaqueActive: boolean;
  waiting: number;
}

const workspaces = new Map<string, WorkspaceState>();
const pathQueues = new Map<string, PathQueueState>();
let pathRegistrationQueue = Promise.resolve();

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function workspaceKey(workspace: string): string {
  return resolve(workspace);
}

function getWorkspaceState(workspace: string): WorkspaceState {
  const key = workspaceKey(workspace);
  let state = workspaces.get(key);
  if (!state) {
    state = { activeFiles: 0, pathWaiters: 0, opaqueActive: false, waiters: [] };
    workspaces.set(key, state);
  }
  return state;
}

function drainWorkspace(state: WorkspaceState): void {
  if (state.opaqueActive) return;

  if (state.activeFiles > 0) {
    while (state.waiters[0]?.mode === "file") state.waiters.shift()!.start();
    return;
  }

  const first = state.waiters.shift();
  if (!first) return;
  first.start();
  if (first.mode === "file") {
    while (state.waiters[0]?.mode === "file") state.waiters.shift()!.start();
  }
}

function acquireWorkspace(
  workspace: string,
  mode: WorkspaceAccess,
  signal?: AbortSignal
): Promise<() => void> {
  const key = workspaceKey(workspace);
  const state = getWorkspaceState(key);

  return new Promise((resolveAcquire, rejectAcquire) => {
    if (signal?.aborted) {
      if (state.activeFiles === 0 && !state.opaqueActive && state.waiters.length === 0) {
        workspaces.delete(key);
      }
      rejectAcquire(abortError(signal));
      return;
    }

    let released = false;
    let started = false;
    let waiter!: AccessWaiter;
    const cleanup = () => {
      if (
        state.activeFiles === 0 &&
        !state.opaqueActive &&
        state.waiters.length === 0
      ) {
        workspaces.delete(key);
      }
    };
    const onAbort = () => {
      if (started) return;
      const index = state.waiters.indexOf(waiter);
      if (index < 0) return;
      state.waiters.splice(index, 1);
      signal?.removeEventListener("abort", onAbort);
      drainWorkspace(state);
      cleanup();
      rejectAcquire(abortError(signal!));
    };
    const start = () => {
      started = true;
      signal?.removeEventListener("abort", onAbort);
      if (mode === "file") state.activeFiles++;
      else state.opaqueActive = true;

      resolveAcquire(() => {
        if (released) return;
        released = true;
        if (mode === "file") state.activeFiles--;
        else state.opaqueActive = false;
        drainWorkspace(state);
        cleanup();
      });
    };

    waiter = { mode, start };
    signal?.addEventListener("abort", onAbort, { once: true });
    state.waiters.push(waiter);
    drainWorkspace(state);
  });
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

async function mutationKey(filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (isMissingPathError(error)) return absolutePath;
    throw error;
  }
}

async function acquirePaths(
  workspace: WorkspaceState,
  filePaths: string[],
  signal?: AbortSignal
): Promise<() => void> {
  const registration = pathRegistrationQueue.then(async () => {
    throwIfAborted(signal);
    const keys = [
      ...new Set(await Promise.all(filePaths.map((path) => mutationKey(path)))),
    ].sort();
    throwIfAborted(signal);
    return keys.map((key) => {
      let state = pathQueues.get(key);
      if (!state) {
        state = { tail: Promise.resolve(), depth: 0 };
        pathQueues.set(key, state);
      }

      const previous = state.tail;
      const blocked = state.depth > 0;
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      state.tail = previous.then(() => gate);
      state.depth++;
      return { key, state, previous, release, blocked };
    });
  });
  pathRegistrationQueue = registration.then(
    () => undefined,
    () => undefined
  );

  const entries = await registration;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const { key, state, release } of entries) {
      state.depth--;
      release();
      if (state.depth === 0 && pathQueues.get(key) === state) {
        pathQueues.delete(key);
      }
    }
  };

  const blocked = entries.some((entry) => entry.blocked);
  if (blocked) workspace.pathWaiters++;
  try {
    if (!signal) {
      await Promise.all(entries.map(({ previous }) => previous));
      return release;
    }
    if (signal.aborted) {
      release();
      throw abortError(signal);
    }

    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        release();
        rejectReady(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.all(entries.map(({ previous }) => previous)).then(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolveReady();
      });
    });
    return release;
  } finally {
    if (blocked) workspace.pathWaiters--;
  }
}

/**
 * Coordinate one edit/write transaction. Mutations of the same path are FIFO;
 * different paths may proceed together. The whole transaction stays visible to
 * opaque operations so an edit's read-modify-write sequence cannot overlap bash.
 */
export async function runFileMutation<T>(
  workspace: string,
  filePath: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return runFileMutations(workspace, [filePath], task, signal);
}

/** Atomically register all declared paths so overlapping multi-file calls stay FIFO. */
export async function runFileMutations<T>(
  workspace: string,
  filePaths: string[],
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  if (filePaths.length === 0) return task();
  const releaseWorkspace = await acquireWorkspace(workspace, "file", signal);
  try {
    const releasePaths = await acquirePaths(getWorkspaceState(workspace), filePaths, signal);
    try {
      throwIfAborted(signal);
      return await task();
    } finally {
      releasePaths();
    }
  } finally {
    releaseWorkspace();
  }
}

/** A workspace-wide bash declaration excludes instrumented file writes. */
export async function runOpaqueWorkspaceOperation<T>(
  workspace: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  const release = await acquireWorkspace(workspace, "opaque", signal);
  try {
    throwIfAborted(signal);
    return await task();
  } finally {
    release();
  }
}

export function getWorkspaceCoordinationStatus(
  workspace: string
): WorkspaceCoordinationStatus {
  const state = workspaces.get(workspaceKey(workspace));
  if (!state) return { fileMutations: 0, opaqueActive: false, waiting: 0 };
  return {
    fileMutations: state.activeFiles,
    opaqueActive: state.opaqueActive,
    // 包含已登记实际路径、正在等同文件 FIFO 的请求，不只统计整群闸门。
    waiting: state.waiters.length + state.pathWaiters,
  };
}
