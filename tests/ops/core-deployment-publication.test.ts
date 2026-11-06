// The publication of a new transaction, before any lifecycle step: a fake platform session, the real shared host, lock,
// pinned runtime and journal. Nothing here stops, builds or switches anything.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeRuntime } from "../../ops/core/source-runtime.ts";
import { consoleDir, prepareConsoleDir } from "../../ops/core/console-state.ts";
import { runDeploymentHost, validUpgradeInput, type DeploymentContext, type DeploymentPlatform, type UpgradeInput } from "../../ops/core/deployment-host.ts";
import { loadDeploymentState } from "../../ops/core/deployment-state.ts";
import { MaintenanceRefused } from "../../ops/core/maintenance.ts";
import type { OpsResult } from "../../ops/core/result.ts";
import { serializeTransactionRecord } from "../../ops/core/transaction-record.ts";
import { tempFixture } from "../helpers/temp.ts";

type Hooks = { start?(context: DeploymentContext<UpgradeInput>): void; capture?(context: DeploymentContext<UpgradeInput>): void };
const other = { format: "2", operation: "upgrade", snapshot: "deploy-other", target_sha: "c".repeat(40), original_sha: "d".repeat(40), original_branch: "main",
  original_workspace_root: "", target_workspace_root: "", was_running: "0", bot_port: "2022", reconfigure_ai: "0" } as const;

function platform(hooks: Hooks): DeploymentPlatform<UpgradeInput> {
  return {
    label: "测试 ", noun: "实例", upgradePointer: "upgrade-transaction", module: "unused.ts", entry: "unused", valid: validUpgradeInput,
    async open(context) {
      return {
        writer: async () => { throw new Error("fixture: no native writer"); },
        tools: { project: context.project, file: name => join(context.snapshot, name), workspace: () => undefined },
        async recover() {},
        async start() { hooks.start?.(context); return { wasRunning: false }; },
        async prepare() {},
        // Like the platforms: a new directory of copies, never moved originals.
        async capture() { mkdirSync(context.snapshot, { recursive: true }); writeFileSync(join(context.snapshot, "captured"), "copy"); hooks.capture?.(context); return { wasRunning: false }; },
        async confirm() {},
        async tool() { throw new Error("fixture: no tool"); },
        available: () => true,
        async inspect() { return { state: "stopped", ready: false, role: "original", owned: true }; },
        // Stops the published transaction before any Git or service effect.
        async preflight() { throw new MaintenanceRefused("fixture: stop after publication"); },
        async effect() { throw new Error("fixture: no effect"); },
        async ready() { return false; },
        async cleanup() {},
      };
    },
  };
}

test("新事务发布：名称已被占用时拒绝且不动原有内容；发布前失败删除本次快照，已发布的快照保留", async () => {
  const f = await tempFixture("core-publication-");
  try {
    const source = join(f.root, "source");
    // The pinned runtime copies files only: each tree needs one.
    for (const tree of ["console", "ops", "scripts", "src"]) { mkdirSync(join(source, tree), { recursive: true }); writeFileSync(join(source, tree, "fixture.ts"), "export {};\n"); }
    let n = 0;
    const run = async (hooks: Hooks) => {
      const project = join(f.root, `项目 ${++n}`);
      mkdirSync(join(project, "data/config"), { recursive: true }); writeFileSync(join(project, "data/config/directory.json"), "{}\n");
      const plan = join(f.root, `plan-${n}.json`); writeFileSync(plan, "{}\n");
      prepareConsoleDir(consoleDir(project));
      const pinned = freezeRuntime(consoleDir(project), source), results: OpsResult[] = [];
      const input: UpgradeInput = { operation: "upgrade", original: "a".repeat(40), target: "b".repeat(40), branch: "main", plan, command: "update" };
      const result = await runDeploymentHost(input, { project, source: pinned.root, async verify() {}, async finish(value) { results.push(value); },
        output: () => {} }, platform(hooks));
      const snapshots = existsSync(join(project, "backup/snapshots")) ? readdirSync(join(project, "backup/snapshots")) : [];
      return { project, result, results, snapshots };
    };

    let name = "";
    let value = await run({ start: context => { name = context.name; mkdirSync(join(context.project, "backup/rm", context.name), { recursive: true }); } });
    expect(value.result).toMatchObject({ outcome: "refused", message: "事务名称已有归档，未采用此快照名称" });
    expect(value.snapshots).toEqual([]); expect(existsSync(join(value.project, "backup/rm", name))).toBe(true);

    value = await run({ start: context => { name = context.name; mkdirSync(context.snapshot, { recursive: true }); writeFileSync(join(context.snapshot, "someone"), "keep"); } });
    expect(value.result).toMatchObject({ outcome: "refused", message: "事务名称已有快照，未采用此快照名称" });
    expect(readFileSync(join(value.project, "backup/snapshots", name, "someone"), "utf8")).toBe("keep");

    // Another transaction published its pointer while this one captured: the copy is no transaction's material and goes.
    value = await run({ capture: context => {
      mkdirSync(join(context.project, "backup/snapshots", other.snapshot), { recursive: true });
      writeFileSync(join(context.project, "backup/snapshots", other.snapshot, "transaction"), serializeTransactionRecord(other));
      mkdirSync(join(context.project, "data/state"), { recursive: true }); writeFileSync(join(context.project, "data/state/upgrade-transaction"), other.snapshot + "\n");
    } });
    expect(value.result).toMatchObject({ outcome: "refused", message: "准备期间出现另一事务，未发布本次快照" });
    expect(value.snapshots).toEqual([other.snapshot]); expect(loadDeploymentState(value.project)?.snapshot).toBe(other.snapshot);

    value = await run({ capture: () => { throw new Error("fixture: capture failed half way"); } });
    expect(value.result).toMatchObject({ outcome: "failed", message: "fixture: capture failed half way" });
    expect(value.snapshots).toEqual([]); expect(existsSync(join(value.project, "data/state/upgrade-transaction"))).toBe(false);

    // Once the pointer names it, the snapshot is the transaction's recovery material, whatever happens next.
    value = await run({});
    expect(value.result).toMatchObject({ command: "update", outcome: "refused", message: "fixture: stop after publication", finalState: "stopped" });
    expect(value.snapshots).toHaveLength(1); expect(loadDeploymentState(value.project)?.snapshot).toBe(value.snapshots[0]);
    expect(value.results).toEqual([value.result]);
  } finally { await f.cleanup(); }
}, 60_000);
