// Task states that are unfinished work. `sleeping` (a retry backoff, a deferred poll or a compaction retry waiting for
// its time) holds no invocation but resumes on its own, so every scan that protects or discovers work counts it.
export const LIVE_TASK_STATES = ["pending", "running", "waiting", "sleeping", "completing"] as const;
