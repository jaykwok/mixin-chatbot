#!/usr/bin/env bun
// What the LaunchDaemon runs, and what `ops foreground` runs in a terminal: a nonzero exit restarts a fresh process after the old
// leases can expire, and every start names the build of the code it runs. launchd's own KeepAlive only restarts this process.
import { resolve } from "node:path";
import { cliArgs } from "../lib/cli.ts";

const RESTART_DELAY_MS = 60_000, RESTART_LIMIT = 999;
const { values } = cliArgs(process.argv.slice(2), { bun: { type: "string" }, git: { type: "string" } });
const bun = values.bun ?? process.execPath, project = process.cwd();

async function output(argv: string[]): Promise<string | null> {
  try {
    const child = Bun.spawn(argv, { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 ? text : null;
  } catch { return null; }
}
/** The commit, -dirty with tracked changes; empty without Git (src/core/version.ts APP_BUILD). */
async function checkoutBuild(): Promise<string> {
  if (!values.git) return "";
  const head = (await output([values.git, "-C", project, "rev-parse", "HEAD"]))?.trim();
  if (!head || !/^[0-9a-f]{12,}$/.test(head)) return "";
  const changes = await output([values.git, "-C", project, "status", "--porcelain", "--untracked-files=no"]);
  return head.slice(0, 12) + (changes ? "-dirty" : "");
}

let child: ReturnType<typeof Bun.spawn> | undefined, stopping = false, wake = () => {};
for (const name of ["SIGTERM", "SIGINT"] as const) process.on(name, () => { stopping = true; child?.kill(name); wake(); });

for (let attempt = 0; ; attempt++) {
  child = Bun.spawn([bun, "--no-env-file", "run", resolve(project, "src/server/index.ts")], { cwd: project, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, APP_BUILD: await checkoutBuild() } });
  const code = await child.exited;
  if (stopping || code === 0 || attempt >= RESTART_LIMIT) process.exit(code);
  console.error(`Bot exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000} seconds (retry ${attempt + 1}/${RESTART_LIMIT}).`);
  await new Promise<void>(done => { const timer = setTimeout(done, RESTART_DELAY_MS); wake = () => { clearTimeout(timer); done(); }; });
  if (stopping) process.exit(code);
}
