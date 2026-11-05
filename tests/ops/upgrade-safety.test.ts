import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { windowsUpgradeFixture } from "../helpers/windows-upgrade.ts";

async function execute(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout + stderr, stdout };
}
async function repository(root: string) {
  await mkdir(root);
  const git = async (...args: string[]) => {
    const result = await execute(["git", "-c", "core.autocrlf=false", ...args], root);
    if (result.code) throw new Error(result.output);
    return result.output.trim();
  };
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  const commit = async (name: string) => { await git("add", "."); await git("commit", "--quiet", "-m", name); return git("rev-parse", "HEAD"); };
  return { git, commit };
}

test.skipIf(process.platform !== "win32")("Windows shared host rechecks HEAD, branch and main before stopping, against a real Git repository", async () => {
  const fixture = await tempFixture("upgrade-identity-");
  try {
    for (const change of ["head", "branch", "main", "none"]) {
      const repo = join(fixture.root, change), { git, commit } = await repository(repo);
      await writeFile(join(repo, "version.txt"), "original"); const original = await commit("original");
      await writeFile(join(repo, "version.txt"), "concurrent"); const concurrent = await commit("concurrent");
      await writeFile(join(repo, "version.txt"), "target"); const target = await commit("target");
      await git("checkout", "--quiet", "--detach", original); await git("branch", "--force", "main", original);
      await git("checkout", "--quiet", "-B", "operator-work", original);
      let before: { head: string; branch: string; main: string; index: Buffer } | undefined;
      const host = await windowsUpgradeFixture(false, {
        checkout: { project: repo, original, target, branch: "operator-work", run: async command => {
          const result = await execute([command.command, ...command.args], command.cwd); return { code: result.code, stdout: result.stdout };
        } },
        beforePreflight: async () => {
          if (change === "head") await git("reset", "--quiet", "--hard", concurrent);
          if (change === "branch") await git("checkout", "--quiet", "-B", "other-work", original);
          if (change === "main") await git("branch", "--force", "main", concurrent);
          before = { head: await git("rev-parse", "HEAD"), branch: await git("rev-parse", "--abbrev-ref", "HEAD"),
            main: await git("rev-parse", "main"), index: await readFile(join(repo, ".git/index")) };
        },
      });
      try {
        const result = await host.run(); expect(before).toBeDefined();
        if (change === "none") {
          expect(result, result.message).toMatchObject({ exitCode: 0, finalState: "stopped" });
          expect(host.events).toContain("effect:stop"); expect(await git("rev-parse", "HEAD")).toBe(target);
        } else {
          expect(result.exitCode, result.message).toBe(1); expect(result.message).toContain("变化");
          expect(host.events).not.toContain("effect:stop"); expect(host.events).not.toContain("git:effect");
          expect(await git("rev-parse", "HEAD")).toBe(before!.head); expect(await git("rev-parse", "--abbrev-ref", "HEAD")).toBe(before!.branch);
          expect(await git("rev-parse", "main")).toBe(before!.main); expect(await readFile(join(repo, ".git/index"))).toEqual(before!.index);
          expect(existsSync(join(repo, ".git/index.lock"))).toBe(false);
        }
      } finally { await host.cleanup(); }
    }
  } finally { await fixture.cleanup(); }
}, 120000);
