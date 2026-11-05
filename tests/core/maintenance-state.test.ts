// The maintenance state (src/core/maintenance-state.ts, revision-chain plan §8.4): which actions each state of the
// revision cleanup journal and the shrink record allows, read from the top of those files only; a file this version cannot read refuses everything, the rollback and
// the restore included.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLocalConfigurationWrite, assessMaintenanceAction, MAINTENANCE_INTENTS, readMaintenanceState, type MaintenanceIntent, type MaintenanceState } from "../../src/core/maintenance-state.ts";
import { JOURNAL_VERSION } from "../../src/durable/revision-cleanup/journal.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("maintenance-state-");
afterAll(() => fixture.cleanup());
let counter = 0;

const allowed = (state: MaintenanceState) =>
  MAINTENANCE_INTENTS.filter(intent => assessMaintenanceAction(state, intent).allowed);
const reasons = (state: MaintenanceState, intent: MaintenanceIntent) => {
  const assessment = assessMaintenanceAction(state, intent);
  return assessment.allowed ? "" : assessment.reasons.join("；");
};

const absent = { status: "absent" } as const;
const run = (fields: Partial<Extract<MaintenanceState["cleanup"], { status: "present" }>>): MaintenanceState["cleanup"] =>
  ({ status: "present", run: "r1", state: "running", ...fields });

test("各状态允许的动作：在途文档挡住服务与写会话库的维护；已停止的整理只能跳过或回滚；待恢复时只能恢复；收缩未完成时只能再次收缩", () => {
  const without = (...intents: MaintenanceIntent[]) => MAINTENANCE_INTENTS.filter(intent => intent !== "configuration-restore" && !intents.includes(intent));
  expect(allowed({ cleanup: absent, shrink: absent })).toEqual(without("restore"));
  expect(reasons({ cleanup: absent, shrink: absent }, "restore")).toBe("没有需要从备份恢复的会话库");

  // Ended runs, and an open one between documents (the service may start; it supersedes the run).
  for (const state of ["finished", "skipped", "abandoned", "running"] as const) {
    expect(allowed({ cleanup: run({ state }), shrink: absent })).toEqual(without("restore"));
  }
  const inFlight = run({ inFlight: { space: "direct" } });
  expect(allowed({ cleanup: inFlight, shrink: absent })).toEqual(["resume", "cleanup", "skip", "rollback"]);
  expect(reasons({ cleanup: inFlight, shrink: absent }, "service")).toContain("有一份文档尚未收尾（direct）");

  const stopped = run({ state: "stopped", stop: "原因" });
  expect(allowed({ cleanup: stopped, shrink: absent })).toEqual(without("resume", "cleanup", "restore"));
  expect(reasons({ cleanup: stopped, shrink: absent }, "resume")).toContain("已停止：原因。只能跳过剩余整理或回滚");
  expect(allowed({ cleanup: run({ state: "stopped", stop: "原因", inFlight: { space: "direct" } }), shrink: absent })).toEqual(["skip", "rollback"]);

  for (const restore of ["required", "replacing"] as const) {
    const pending = { cleanup: run({ state: "stopped", restore: { space: "groups/g1", state: restore } }), shrink: absent };
    expect(allowed(pending)).toEqual(["restore"]);
    expect(reasons(pending, "rollback")).toContain(restore === "required" ? "这个库需要从备份恢复（revision-cleanup restore --space groups/g1）"
      : "从备份恢复 groups/g1 尚未完成，请再次运行 revision-cleanup restore --space groups/g1");
  }
  // A finished restore no longer blocks; the run stays stopped.
  expect(allowed({ cleanup: run({ state: "stopped", restore: { space: "direct", state: "done" } }), shrink: absent })).toEqual(without("resume", "cleanup", "restore"));

  const shrinking = { cleanup: absent, shrink: { status: "present", run: "s1", unfinished: { space: "direct", state: "old-kept" } } } as const;
  expect(allowed(shrinking)).toEqual(["shrink"]);
  expect(reasons(shrinking, "service")).toContain("会话库收缩（运行 s1）有一个库尚未替换完成（direct，阶段 old-kept）");
  expect(allowed({ cleanup: absent, shrink: { status: "present", run: "s1" } })).toEqual(without("restore"));

  // Unreadable: nothing at all, the rollback and the restore included; the restore names only that reason.
  for (const key of ["cleanup", "shrink"] as const) {
    const unreadable = { cleanup: absent, shrink: absent, [key]: { status: "unreadable", reason: "读不了" } } as MaintenanceState;
    expect(allowed(unreadable)).toEqual([]);
    expect(reasons(unreadable, key === "cleanup" ? "restore" : "rollback")).toBe("读不了；在它处理之前不能继续");
  }
});

test("未完成的部署挡住改配置；本机写配置的入口还拒绝未收尾的运维任务", () => {
  const deployment = { status: "present", id: "deploy-1", pending: true, service: true, verify: true, release: true } as const;
  expect(reasons({ cleanup: absent, shrink: absent, deployment }, "configuration")).toContain("部署事务 deploy-1 尚未完成");
  expect(assessMaintenanceAction({ cleanup: absent, shrink: absent, deployment: { ...deployment, pending: false } }, "configuration").allowed).toBe(true);
  // The core's own configuration step runs inside its ops task: the intent alone does not refuse it.
  const orchestration = { status: "present", id: "ops-1", blocksStartup: true, pending: true } as const;
  expect(assessMaintenanceAction({ cleanup: absent, shrink: absent, orchestration }, "configuration").allowed).toBe(true);
  const checkpoint = { version: 1, request: { id: "a".repeat(32), runtime: "d".repeat(64), command: "history-clear", label: "清空会话", intent: "conversation-write" },
    phase: "acting", original: { identity: "c".repeat(64), state: "running", ready: true, owned: true, pending: false } };
  const finished = { protocol: "mixin-ops", version: 1, command: "history-clear", outcome: "success", exitCode: 0, wasRunning: true, finalState: "running", message: "完成" };
  const root = project();
  expect(() => assertLocalConfigurationWrite(root)).not.toThrow();
  write(root, "ops-maintenance.json", { version: 1, checkpoint });
  expect(() => assertLocalConfigurationWrite(root)).toThrow(`运维任务 ${"a".repeat(32)} 尚未收尾`);
  write(root, "ops-maintenance.json", { version: 1, checkpoint, result: finished });
  expect(() => assertLocalConfigurationWrite(root)).not.toThrow();
  write(root, "configuration-change.json", { version: 1, id: "config-" + "e".repeat(32), kind: "relay", phase: "ready", binding: null,
    rows: [{ key: "relay", before: null, after: "f".repeat(64) }] });
  expect(() => assertLocalConfigurationWrite(root)).toThrow("尚未结束（ready）");
});

const project = () => {
  const root = join(fixture.root, `project-${++counter}`);
  mkdirSync(join(root, "data", "state"), { recursive: true });
  return root;
};
const write = (root: string, name: string, value: unknown) =>
  writeFileSync(join(root, "data", "state", name), typeof value === "string" ? value : JSON.stringify(value));

test("读取：只看日志与收缩记录的顶层；旧格式、无法解析或无法识别的文件记为无法读取", () => {
  expect(readMaintenanceState(project())).toEqual({ cleanup: absent, shrink: absent, configuration: absent });

  const root = project();
  write(root, "revision-cleanup.json", { version: JOURNAL_VERSION, run: "r1", state: "stopped", stop: { at: "t", reason: "原因" }, databases: [],
    current: { space: "direct" }, restore: { space: "direct", state: "required" } });
  write(root, "shrink.json", { version: 1, run: "s1", startedAt: "t", done: [], current: { space: "groups/g1", state: "verified" } });
  expect(readMaintenanceState(root)).toEqual({
    cleanup: { status: "present", run: "r1", state: "stopped", stop: "原因", inFlight: { space: "direct" }, restore: { space: "direct", state: "required" } },
    shrink: { status: "present", run: "s1", unfinished: { space: "groups/g1", state: "verified" } },
    configuration: absent,
  });

  const cases: [string, string, unknown, string][] = [
    ["revision-cleanup.json", "cleanup", { run: "dev", state: "running", databases: [] }, "格式不受支持（格式 null"],
    ["revision-cleanup.json", "cleanup", { version: 1, run: "dev", state: "running", databases: [] }, "格式不受支持（格式 1"],
    ["revision-cleanup.json", "cleanup", "{", "修订整理日志无法解析"],
    ["revision-cleanup.json", "cleanup", { version: JOURNAL_VERSION, run: "r1", state: "running" }, "修订整理日志无法识别"],
    ["shrink.json", "shrink", { version: 2, run: "s1", done: [] }, "会话库收缩记录无法识别"],
    ["shrink.json", "shrink", "[", "JSON"],
  ];
  for (const [file, key, value, reason] of cases) {
    const root = project();
    write(root, file, value);
    const state = readMaintenanceState(root);
    expect(state[key as "cleanup"]).toEqual({ status: "unreadable", reason: expect.stringContaining(reason) });
  }
});

test.skipIf(process.platform !== "linux")("断开的整理/收缩记录链接不能伪装成没有记录而放行启动", () => {
  for (const [file, key] of [["revision-cleanup.json", "cleanup"], ["shrink.json", "shrink"]] as const) {
    const root = project(); symlinkSync(join(root, "missing-target.json"), join(root, "data/state", file));
    const state = readMaintenanceState(root);
    expect(state[key].status).toBe("unreadable");
    expect(assessMaintenanceAction(state, "service").allowed).toBe(false);
  }
});
