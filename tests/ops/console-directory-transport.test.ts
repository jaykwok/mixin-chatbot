import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

test.skipIf(process.platform === "win32")("部署和升级共用的 Docker 部门入口传递完整选择，stdin 关闭时不分配终端；部署可指定暂存的应用凭据", async () => {
  const f = await tempFixture("directory-transport-");
  try {
    const repo = resolve(import.meta.dir, "../.."); mkdirSync(join(f.root, "preview"));
    const source = readFileSync(join(repo, "scripts/lib/core-handoff.sh"), "utf8");
    const start = source.indexOf("\nchoose_directory_scope() {") + 1; expect(start).toBeGreaterThan(0);
    const fn = source.slice(start, source.indexOf("\n}", start) + 2), script = join(f.root, "run.sh");
    writeFileSync(script, ["set -euo pipefail", fn,
      'PROJECT_DIR="$FIXTURE_ROOT"; PREVIEW_DIR="$PROJECT_DIR/preview"; SERVICE_USER=1001:1001; IMAGE_ID=sha256:fixture; UNCHANGED=fixture',
      'print_status() { :; }; print_error() { echo "$*" >&2; }; print_warning() { echo "$*" >&2; }',
      'docker() { printf "%s\\n" "$@" > "$FIXTURE_ROOT/argv.txt"; printf fixture > "$PREVIEW_DIR/directory-scope-plan.json"; }',
      'choose_directory_scope "$@"',
    ].join("\n"));
    for (const extra of [[], ["--app", "/preview/configuration-app.json"]]) {
      rmSync(join(f.root, "preview/directory-scope-plan.json"), { force: true });
      const child = Bun.spawn(["bash", script, ...extra], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, FIXTURE_ROOT: f.root, BOT_DIRECTORY_SCOPE: "", MIXIN_OPS_CONSOLE: "1", MIXIN_OPS_DIRECTORY: "selected" } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, out + err).toBe(0);
      const args = readFileSync(join(f.root, "argv.txt"), "utf8").trim().split("\n");
      expect(args).toContain("-i"); expect(args).not.toContain("-it");
      for (const key of ["MIXIN_OPS_CONSOLE", "MIXIN_OPS_TASK_ID", "MIXIN_OPS_DIRECTORY", "MIXIN_OPS_DIRECTORY_INPUT", "MIXIN_OPS_DIRECTORY_APP"]) {
        expect(args[args.indexOf(key) - 1], key).toBe("-e");
      }
      expect(args.slice(args.indexOf("--plan"))).toEqual(["--plan", "/preview/directory-scope-plan.json", "--project", "/app", ...extra]);
    }
  } finally { await f.cleanup(); }
});
