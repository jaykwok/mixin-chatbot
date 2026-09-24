#!/usr/bin/env bun
import { inspectDataVersion } from "../../src/core/data-version.ts";
import { loadDeployment, PROJECT_DIR } from "./tui/platform.ts";
import { recoveryMenu } from "./tui/recovery.ts";
try {
  process.chdir(PROJECT_DIR);
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("bun run tui — 运维界面；数据未迁移时仅提供升级 / 诊断");
  } else {
    const state = inspectDataVersion(PROJECT_DIR, loadDeployment().groupDataRoot);
    if (!state.current) await recoveryMenu(state.detail);
    else process.exitCode = await (await import("./tui/full.ts")).main(args);
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
