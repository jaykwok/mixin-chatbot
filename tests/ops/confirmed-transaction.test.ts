import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfirmedTransaction, confirmTransaction, readTransaction } from "../../ops/lib/confirmed-transaction.ts";
import { opsCommand } from "../../ops/core/platform.ts";
import { operationPreparer } from "../../console/server/prepare-operation.ts";
import { operationArgs, operationScope } from "../../ops/core/operations.ts";
import { Views } from "../../console/server/views.ts";
import { tempFixture } from "../helpers/temp.ts";
import { opsShellFunctions } from "../helpers/ops-shell.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const first = "deploy-" + "a".repeat(32), second = "deploy-" + "b".repeat(32);

async function synthetic(root: string) {
  const state = join(root, "data/state");
  await mkdir(state, { recursive: true });
  for (const [name, sha] of [[first, "1".repeat(40)], [second, "2".repeat(40)]]) {
    const directory = join(root, "backup/snapshots", name!);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "transaction"), Object.entries({
      format: "2", operation: "deploy", snapshot: name!, target_sha: sha!, original_sha: "", original_branch: "",
      original_workspace_root: "", target_workspace_root: "", was_running: "0", bot_port: "2022", reconfigure_ai: "0",
    }).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  }
  await writeFile(join(state, "deploy-transaction"), first);
}

for (const action of ["continue", "rollback"] as const) test(`confirmation binds ${action} to identity, bytes and action, for current release records`, async () => {
  const fixture = await tempFixture("confirmed-state-");
  try {
    await synthetic(fixture.root);
    const capture = readTransaction(fixture.root)!, token = confirmTransaction(capture, action);
    expect(() => assertConfirmedTransaction(fixture.root, action, token)).not.toThrow();
    expect(() => assertConfirmedTransaction(fixture.root, action === "continue" ? "rollback" : "continue", token)).toThrow();
    for (const change of ["pointer", "same-id", "missing", "committed", "plan"] as const) {
      const state = join(fixture.root, "data/state"), directory = join(fixture.root, "backup/snapshots", first);
      await synthetic(fixture.root);
      if (change === "pointer") await writeFile(join(state, "deploy-transaction"), second);
      if (change === "same-id") await writeFile(join(directory, "transaction"), (await readFile(join(directory, "transaction"), "utf8")).replace("1".repeat(40), "3".repeat(40)));
      if (change === "missing") await rm(join(state, "deploy-transaction"));
      if (change === "committed") await writeFile(join(state, "release-data.json"), '{"phase":"committed"}');
      if (change === "plan") await writeFile(join(directory, "data-plan.json"), "{}\n");
      expect(() => assertConfirmedTransaction(fixture.root, action, token), change).toThrow("变化");
      await rm(join(state, "release-data.json"), { force: true }); await rm(join(directory, "data-plan.json"), { force: true });
    }
  } finally { await fixture.cleanup(); }
});

for (const action of ["resume", "rollback"] as const) test(`console ${action} carries the exact previewed transaction after confirmation swaps the pointer`, async () => {
  const fixture = await tempFixture("confirmed-console-");
  try {
    await synthetic(fixture.root);
    const params = await operationPreparer(fixture.root, new Views())(action, {}, "fixture");
    const preview = await operationScope(fixture.root, action, params);
    expect(preview.summary.join("\n")).toContain("1111111");
    await writeFile(join(fixture.root, "data/state/deploy-transaction"), second);
    const args = operationArgs(action, params);
    expect(args.slice(0, 2)).toEqual([action, "--confirmed-transaction"]);
    const token = args[2]!;
    expect(JSON.parse(Buffer.from(token, "base64").toString()).id).toBe(first);
    await expect(operationScope(fixture.root, action, params)).rejects.toThrow("变化");
    expect(() => assertConfirmedTransaction(fixture.root, action === "resume" ? "continue" : "rollback", token)).toThrow("变化");
    const command = opsCommand("windows", args);
    expect(JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString()).ConfirmedTransaction).toBe(token);
  } finally { await fixture.cleanup(); }
});

// The shared core checks a console confirmation under deploy.lock before any write (deployment-host.ts); the refusal of a
// changed transaction is covered by core-windows-deploy.test.ts and core-deployment-cli.test.ts.

// The check runs with the ops runtime (ops_bun): the console's Bun when it names one, never a bare `bun` from PATH.
test.skipIf(!bash)("Bash ops rejects a changed confirmation under its deployment lock before dispatch", async () => {
  const fixture = await tempFixture("confirmed-bash-");
  const root = join(fixture.root, "project"), lib = join(root, "ops/lib");
  await synthetic(root); await mkdir(lib, { recursive: true });
  await copyFile(join(project, "ops/lib/confirmed-transaction.ts"), join(lib, "confirmed-transaction.ts"));
  const ops = await readFile(join(project, "scripts/ops.sh"), "utf8");
  const update = ops.match(/^update\(\) \{[\s\S]*?^\}/m)![0];
  const command = ops.match(/^transaction_command\(\) \{[\s\S]*?^\}/m)![0];
  const driver = join(fixture.root, "check.sh");
  await writeFile(driver, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_DIR="$1"; STATE_DIR="$PROJECT_DIR/data/state"; OPS_SOURCE_DIR="$PROJECT_DIR"
. "$2/scripts/lib/common.sh"
. "$2/scripts/lib/ops-runtime.sh"
operation_start() { :; }; operation_finish() { :; }; remove_upgrade_stage() { :; }
ER() { echo "$*" >&2; }; WA() { :; }
load_pending_transaction() { echo 'unexpected dispatch'; return 9; }
${await opsShellFunctions("core_reported", "finish_update", "finish_lifecycle_result")}
${update}
${command}
transaction_command "$3" --confirmed-transaction "$4"
`);
  try {
    for (const action of ["continue", "rollback"] as const) for (const named of [false, true]) {
      await synthetic(root); const token = confirmTransaction(readTransaction(root)!, action);
      await writeFile(join(root, "data/state/deploy-transaction"), second);
      const env: Record<string, string | undefined> = { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""), MIXIN_OPS_BUN: "" };
      // A function named bun shadows every bare `bun`; the named runtime is an absolute path and is not affected.
      if (named) Object.assign(env, { MIXIN_OPS_BUN: process.execPath, "BASH_FUNC_bun%%": "() { echo 'bare bun' >&2; return 99;\n}" });
      delete env.MSYS_NO_PATHCONV; delete env.MSYS2_ARG_CONV_EXCL;
      // Ordinary Windows ops tests use a flock stub; Linux runs the real exclusive lock.
      if (process.platform === "win32") Object.assign(env, { "BASH_FUNC_flock%%": "() { return 0;\n}" });
      const child = Bun.spawn([bash!, driver, posix(root), posix(project), action, token], { env, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(1); expect(stderr).toContain("变化"); expect(stdout).not.toContain("unexpected dispatch");
      expect(stderr).not.toContain("bare bun");
    }
  } finally { await fixture.cleanup(); }
}, 60_000);
