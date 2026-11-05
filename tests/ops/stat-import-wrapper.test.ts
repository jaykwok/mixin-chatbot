// The seven old staging/run-state scenarios moved to core-stats-import: the real shared host and durable stages now
// own that policy. This wrapper preserves opaque argv and exit status, leaving strict validation to that same core.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opsShellFunctions } from "../helpers/ops-shell.ts";
import { tempFixture } from "../helpers/temp.ts";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

test.skipIf(!bash || !existsSync(bash))("stat-import 薄入口完整转发路径和参数，不吞掉未知选项或改变核心退出码", async () => {
  const f = await tempFixture("stat-import-entry-");
  try {
    const runner = join(f.root, "run.sh"), capture = join(f.root, "argv");
    await writeFile(runner, ['#!/usr/bin/env bash', 'set -uo pipefail',
      'ops_core() { printf "%s\\0" "$@" > "$FIXTURE_CAPTURE"; return "$FIXTURE_EXIT"; }',
      await opsShellFunctions("stat_import"), 'stat_import "$@"'].join("\n") + "\n");
    for (const args of [["/old deployment/中文.sqlite"], ["somewhere.sqlite", "--expect", "a".repeat(64)], ["snapshot", "--expects", "wrong"], []]) {
      const child = Bun.spawn([bash!, "--noprofile", "--norc", posixPath(runner), ...args], {
        cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, PWD: f.root, FIXTURE_CAPTURE: posixPath(capture), FIXTURE_EXIT: "17" },
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(17);
      expect((await readFile(capture, "utf8")).split("\0").slice(0, -1)).toEqual(["maintenance", "stat-import", ...args]);
    }
  } finally { await f.cleanup(); }
});
