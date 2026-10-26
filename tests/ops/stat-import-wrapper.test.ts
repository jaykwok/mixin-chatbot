// ops.sh stat-import: the old ledger may sit anywhere; the wrapper stages a private copy (with its -wal) under backup/
// for the one-off container, stops and restores the bot around the import and always removes the copy.
import { expect, test } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

const SCENARIOS = ["running", "stopped", "wal", "import-fail", "missing", "guarded", ...(process.platform === "win32" ? [] : ["link"])];

test.skipIf(!bash || !existsSync(bash))("ops.sh stat-import stages a copy of a ledger from anywhere, restores the run state and removes the copy", async () => {
  const source = (await readFile(join(project, "scripts/ops/ops.sh"), "utf8")).replaceAll("\r\n", "\n");
  const from = source.indexOf("stat_import() (\n"), until = source.indexOf("\n)\n", from);
  expect(from).toBeGreaterThan(0); expect(until).toBeGreaterThan(from);
  for (const scenario of SCENARIOS) {
    const fixture = await tempFixture("stat-import-" + scenario + "-");
    try {
      const events = join(fixture.root, "events.txt"), state = join(fixture.root, "state.txt");
      const old = join(fixture.root, "elsewhere", "old", "data", "groups");
      await mkdir(old, { recursive: true });
      await mkdir(join(fixture.root, "project"), { recursive: true });
      await writeFile(join(old, "stats.sqlite"), "synthetic ledger bytes");
      if (scenario === "wal") await writeFile(join(old, "stats.sqlite-wal"), "synthetic wal bytes");
      let ledger = join(old, "stats.sqlite");
      if (scenario === "missing") ledger = join(old, "absent.sqlite");
      if (scenario === "link") { symlinkSync(ledger, join(old, "link.sqlite")); ledger = join(old, "link.sqlite"); }
      await writeFile(events, "");
      await writeFile(state, scenario === "stopped" || scenario === "wal" ? "" : "fixture");
      const runner = join(fixture.root, "run.sh");
      await writeFile(runner, [
        "#!/usr/bin/env bash", "set -uo pipefail",
        'PROJECT_DIR="$FIXTURE_ROOT/project"; CONTAINER=fixture',
        'ER() { printf "%s\\n" "$1" >&2; }',
        'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
        'guard_one_off_container() { record guard; [ "$FIXTURE_SCENARIO" != guarded ]; }',
        'service_container_user() { echo 1234:1234; }',
        'docker() { [ "$1" = ps ] && cat "$FIXTURE_STATE"; }',
        'stop_bot() { record stop; : > "$FIXTURE_STATE"; }',
        'start_bot() { record start; printf fixture > "$FIXTURE_STATE"; }',
        // The one-off container sees backup/ as /app/backup: the copy must be there, byte for byte, with its -wal.
        'data_admin() {',
        '  [ "$1" = scripts/ops/stats-import.ts ] || return 97',
        '  case "$2" in /app/backup/.stat-import-*/stats.sqlite) ;; *) return 98 ;; esac',
        '  local copy="$PROJECT_DIR${2#/app}"',
        '  cmp -s "$copy" "$FIXTURE_OLD/stats.sqlite" || return 96',
        '  if [ -f "$FIXTURE_OLD/stats.sqlite-wal" ]; then cmp -s "$copy-wal" "$FIXTURE_OLD/stats.sqlite-wal" || return 95; record wal; fi',
        '  record "import:$(cat "$FIXTURE_STATE")"',
        '  [ "$FIXTURE_SCENARIO" != import-fail ]',
        '}',
        source.slice(from, until + 3),
        'stat_import "$FIXTURE_LEDGER"',
      ].join("\n") + "\n");
      const child = Bun.spawn([bash!, "--noprofile", "--norc", posixPath(runner)], {
        cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, PWD: fixture.root, FIXTURE_ROOT: posixPath(fixture.root), FIXTURE_EVENTS: posixPath(events),
          FIXTURE_STATE: posixPath(state), FIXTURE_SCENARIO: scenario, FIXTURE_OLD: posixPath(old), FIXTURE_LEDGER: posixPath(ledger) },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const ok = ["running", "stopped", "wal"].includes(scenario);
      expect(code, scenario + "\n" + stdout + stderr).toBe(ok ? 0 : 1);
      const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean);
      expect(recorded, scenario).toEqual(
        scenario === "running" || scenario === "import-fail" ? ["guard", "stop", "import:", "start"]
          : scenario === "stopped" ? ["guard", "import:"]
            : scenario === "wal" ? ["guard", "wal", "import:"]
              : scenario === "guarded" ? ["guard"]
                : []);
      if (scenario === "missing" || scenario === "link") expect(stderr).toContain("找不到旧统计账本");
      // The run state is what it was, the old file is untouched and no copy is left behind.
      expect(await readFile(state, "utf8")).toBe(scenario === "stopped" || scenario === "wal" ? "" : "fixture");
      expect(await readFile(join(old, "stats.sqlite"), "utf8")).toBe("synthetic ledger bytes");
      expect(existsSync(join(fixture.root, "project", "backup")) ? await readdir(join(fixture.root, "project", "backup")) : []).toEqual([]);
    } finally { await fixture.cleanup(); }
  }
}, 60000);
