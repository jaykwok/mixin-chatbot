#!/usr/bin/env bun
// Docker deployments check the workspace boundary in host path space: inside the service container an external
// workspace is renamed to /app/workspace, which hides where it lies on the host. deploy.sh/upgrade.sh mount the host's
// resolved data, backup, logs and workspace read-only at their own paths (no network) and run this with those paths.
// Same rule as the service start (checkProjectLayout); read-only, nothing is created or logged.
import { checkProjectLayout } from "../../src/core/layout.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const project = option("--project"), data = option("--data"), workspace = option("--workspace");
try {
  if (!project || !data || !workspace) throw new Error("usage: layout-check.ts --project PATH --data PATH --workspace PATH [--backup PATH] [--logs PATH]");
  const backup = option("--backup"), logs = option("--logs");
  checkProjectLayout(project, workspace, { data, ...(backup ? { backup } : {}), ...(logs ? { logs } : {}) });
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
