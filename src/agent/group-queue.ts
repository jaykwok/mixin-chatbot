import { groupSegment } from "./paths.ts";

interface GroupQueueState {
  tail: Promise<void>;
  depth: number;
  active: boolean;
}

export interface GroupQueueStatus {
  active: boolean;
  waiting: number;
}

const queues = new Map<string, GroupQueueState>();

export function getGroupQueueStatus(groupId: string): GroupQueueStatus {
  const state = queues.get(groupSegment(groupId));
  if (!state) return { active: false, waiting: 0 };
  return {
    active: state.active,
    waiting: Math.max(0, state.depth - (state.active ? 1 : 0)),
  };
}

/**
 * Serialize full agent turns that share one group workspace. Commands and steering
 * stay outside this queue so they can still interrupt the active user's session.
 */
export async function runInGroupQueue<T>(
  groupId: string,
  onQueued: (ahead: number) => void | Promise<void>,
  task: () => Promise<T>
): Promise<T> {
  const key = groupSegment(groupId);
  let state = queues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), depth: 0, active: false };
    queues.set(key, state);
  }

  const ahead = state.depth;
  const previous = state.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => gate);
  state.depth++;

  let active = false;

  try {
    if (ahead > 0) await onQueued(ahead);
    await previous;
    state.active = true;
    active = true;
    return await task();
  } finally {
    if (active) state.active = false;
    state.depth--;
    release();
    if (state.depth === 0 && queues.get(key) === state) queues.delete(key);
  }
}
