import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const sh = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

// The process, its signals and the clock are stubbed: each scenario decides when the recorded connector goes away.
// A connector that is gone before, between or right after the waits has stopped; only a live one is a failure.
const scenarios = {
  "exit-in-last-term-second": { code: 0, signals: ["TERM"], sleeps: 10 },
  "exit-in-last-kill-second": { code: 0, signals: ["TERM", "KILL"], sleeps: 15 },
  "gone-before-term": { code: 0, signals: ["TERM"], sleeps: 0 },
  "gone-before-kill": { code: 0, signals: ["TERM", "KILL"], sleeps: 10 },
  "gone-before-stop": { code: 0, signals: [], sleeps: 0 },
  "term-denied": { code: 1, signals: ["TERM"], sleeps: 0 },
  "replaced-before-kill": { code: 1, signals: ["TERM"], sleeps: 10 },
  "never-exits": { code: 1, signals: ["TERM", "KILL"], sleeps: 15 },
} as const;

test.skipIf(!bash || !existsSync(bash))("stopping the recorded cloudflared counts an exit at any point as stopped", async () => {
  for (const [scenario, expected] of Object.entries(scenarios)) {
    const fixture = await tempFixture("cloudflared-stop-");
    try {
      await mkdir(join(fixture.root, "data", "state"), { recursive: true });
      await writeFile(join(fixture.root, "data", "state", "cloudflared.pid"), "4242 1 boot\n");
      if (scenario !== "gone-before-stop") await writeFile(join(fixture.root, "alive"), "4242");
      const runner = join(fixture.root, "stop.sh");
      await writeFile(runner, [
        "#!/usr/bin/env bash", "set -uo pipefail",
        'PROJECT_DIR="$(realpath -ms "$FIXTURE_ROOT")"; TUNNEL_PID_FILE="$PROJECT_DIR/data/state/cloudflared.pid"',
        ". " + sh(posix(join(project, "scripts/lib/lifecycle.sh"))),
        // The real check reads /proc; here the recorded process lives while the file "alive" names it.
        'managed_cloudflared_pid() { [ -f "$PROJECT_DIR/alive" ] && cat "$PROJECT_DIR/alive"; }',
        'gone() { rm -f -- "$PROJECT_DIR/alive"; }',
        // Signals are sent from command substitutions, so every record lives in a file.
        'kill() {',
        '  printf "%s\\n" "${1#-}" >> "$PROJECT_DIR/signals"',
        '  case "$FIXTURE_SCENARIO:$1" in',
        '    gone-before-term:-TERM|gone-before-kill:-KILL) gone; echo "kill: ($2) - No such process" >&2; return 1 ;;',
        '    term-denied:-TERM) echo "kill: ($2) - Operation not permitted" >&2; return 1 ;;',
        '  esac',
        '}',
        'sleep() {',
        '  local count; count=$(( $(cat "$PROJECT_DIR/sleeps" 2>/dev/null || echo 0) + 1 )); printf "%s" "$count" > "$PROJECT_DIR/sleeps"',
        '  case "$FIXTURE_SCENARIO:$count" in',
        '    exit-in-last-term-second:10|exit-in-last-kill-second:15) gone ;;',
        '    replaced-before-kill:10) printf 5151 > "$PROJECT_DIR/alive" ;;',
        '  esac',
        '}',
        "stop_managed_cloudflared",
      ].join("\n") + "\n");
      const child = Bun.spawn([bash!, "--noprofile", "--norc", posix(runner)], {
        cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, FIXTURE_ROOT: posix(fixture.root), FIXTURE_SCENARIO: scenario },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const read = (name: string) => readFile(join(fixture.root, name), "utf8").catch(() => "");
      const signals = (await read("signals")).split(/\r?\n/).filter(Boolean);
      const sleeps = Number(await read("sleeps") || 0);
      const detail = `${scenario}: signals ${signals.join(",")} sleeps ${sleeps}\n${stdout}${stderr}`;
      expect(code, detail).toBe(expected.code);
      expect(signals, detail).toEqual([...expected.signals]);
      expect(sleeps, detail).toBe(expected.sleeps);
      // A completed stop archives the PID file; a failed one keeps it for the next attempt.
      const archived = existsSync(join(fixture.root, "backup", "rm")) ? await readdir(join(fixture.root, "backup", "rm")) : [];
      expect(existsSync(join(fixture.root, "data", "state", "cloudflared.pid")), detail).toBe(expected.code !== 0);
      expect(archived.filter(name => name.endsWith("-cloudflared.pid")), detail).toHaveLength(expected.code === 0 ? 1 : 0);
      if (scenario === "term-denied") expect(stderr).toContain("Operation not permitted");
      else expect(stderr, detail).not.toContain("No such process");
    } finally { await fixture.cleanup(); }
  }
}, 60_000);
