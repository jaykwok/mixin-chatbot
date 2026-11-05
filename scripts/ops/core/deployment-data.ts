import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The bot container is created with this path as its /app/data bind source, so ownership checks compare against it. */
export const deploymentDataPath = (project: string): string => realpathSync(resolve(project, "data"));

/** Whether a container's mounts carry this deployment's data directory as its one writable /app/data bind. */
export function ownsDataMount(project: string, mounts: unknown): boolean {
  const data = Array.isArray(mounts) ? mounts.filter(mount => mount?.Destination === "/app/data") : [];
  if (data.length !== 1 || data[0].Type !== "bind" || data[0].RW !== true) return false;
  try { return data[0].Source === deploymentDataPath(project); } catch { return false; }
}
