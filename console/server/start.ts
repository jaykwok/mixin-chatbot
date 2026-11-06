#!/usr/bin/env bun
// The bootstrap finishes before serving; every subsequent lazy import/worker comes from the fixed private package.
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareConsoleDir, consoleDir } from "../../ops/core/console-state.ts";
import { freezeRuntime } from "../../ops/core/source-runtime.ts";

try {
  const project = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const dir = consoleDir(project); prepareConsoleDir(dir);
  const runtime = freezeRuntime(dir, project);
  process.env.MIXIN_CONSOLE_PROJECT_ROOT = project;
  process.env.MIXIN_CONSOLE_SOURCE_ROOT = runtime.root;
  process.env.MIXIN_CONSOLE_CODE_DIGEST = runtime.digest;
  await import(pathToFileURL(join(runtime.root, "console/server/main.ts")).href);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
