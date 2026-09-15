import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGit, loadUpgrade } from "../../scripts/ops/tui/data.ts";
import * as execution from "../../scripts/ops/tui/exec.ts";
import { tempFixture } from "../helpers/temp.ts";

test("远端连续推送后升级预览取得最新目标和提交列表，检查不修改本地 HEAD 或代码", async () => {
  const fixture = await tempFixture("upgrade-preview-");
  const writer = join(fixture.root, "writer"), origin = join(fixture.root, "origin.git"), deployed = join(fixture.root, "deployed");
  const run = async (cwd: string, args: string[]): Promise<execution.RunResult> => {
    const child = Bun.spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr, timedOut: false };
    } finally { clearTimeout(timer); child.kill(); await child.exited; }
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(cwd, args);
    expect(result.code, args.join(" ") + "\n" + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  let capture: ReturnType<typeof spyOn<typeof execution, "capture">> | undefined;
  try {
    await mkdir(writer);
    await git(writer, "init", "--initial-branch=main");
    await git(writer, "config", "user.name", "Fixture");
    await git(writer, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(writer, "version.txt"), "initial");
    await git(writer, "add", "version.txt"); await git(writer, "commit", "-m", "initial");
    const initial = await git(writer, "rev-parse", "HEAD");
    await git(fixture.root, "init", "--bare", origin);
    await git(writer, "remote", "add", "origin", origin); await git(writer, "push", "origin", "main");
    await git(fixture.root, "clone", "--branch", "main", origin, deployed);
    // Even an unusual fetch mapping must not leave the preview on stale origin/main.
    await git(deployed, "config", "remote.origin.fetch", "+refs/heads/unused:refs/remotes/origin/unused");
    capture = spyOn(execution, "capture").mockImplementation(async (command, args) => {
      expect(command).toBe("git");
      return run(deployed, args);
    });
    expect(await loadGit()).toMatchObject({ sha: initial, behind: 0 });
    const before = await git(deployed, "status", "--porcelain");
    const updates: string[] = [];
    for (const subject of ["first remote update", "second remote update"]) {
      await writeFile(join(writer, "version.txt"), subject);
      await git(writer, "add", "version.txt"); await git(writer, "commit", "-m", subject);
      const target = await git(writer, "rev-parse", "HEAD");
      await git(writer, "push", "origin", "main");
      expect(await git(deployed, "rev-parse", "origin/main")).not.toBe(target);
      updates.unshift(subject);
      const preview = await loadUpgrade();
      expect(preview?.targetSha).toBe(target);
      expect(preview?.git.sha).toBe(initial);
      expect(preview?.git.behind).toBe(updates.length);
      expect(preview?.git.incoming.map(commit => commit.subject)).toEqual(updates);
      expect(await git(deployed, "rev-parse", "HEAD")).toBe(initial);
      expect(await git(deployed, "status", "--porcelain")).toBe(before);
      expect(await Bun.file(join(deployed, "version.txt")).text()).toBe("initial");
    }
  } finally { capture?.mockRestore(); await fixture.cleanup(); }
}, 30000);
