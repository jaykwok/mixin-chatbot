import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Pi abort() stops foreground work but leaves idle warming scheduled. */
export function cancelCacheWarming(session: AgentSession): void {
  const mode = session.settingsManager.getCacheWarmingMode();
  // These synchronous native calls cancel the existing run, then restore the policy
  // for the next request. Each session has its own read-only settings backend.
  session.setCacheWarmingMode("off");
  session.setCacheWarmingMode(mode);
}
