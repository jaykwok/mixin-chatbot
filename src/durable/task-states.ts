// Task states that are unfinished work. Durable 1.4.0 added `sleeping` (a retry backoff, a deferred poll or a
// compaction retry waiting for its time): it holds no invocation but resumes on its own, so every scan that protects or
// discovers work counts it. A parked task (crash-loop guard) keeps its stored state and is covered by the same list.
export const LIVE_TASK_STATES = ["pending", "running", "waiting", "sleeping", "completing"] as const;
