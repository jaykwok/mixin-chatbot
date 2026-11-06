// The maintenance state (src/core/maintenance-state.ts): which actions the configuration, ops-task and deployment records
// allow, read without touching a conversation database; a file this version cannot read refuses everything it guards.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLocalConfigurationWrite, assessMaintenanceAction, MAINTENANCE_INTENTS, readMaintenanceState, type MaintenanceIntent, type MaintenanceState } from "../../src/core/maintenance-state.ts";
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

test("没有记录时只有恢复配置不适用；无法读取的记录挡住它守护的一切", () => {
  const without = (...intents: MaintenanceIntent[]) => MAINTENANCE_INTENTS.filter(intent => !intents.includes(intent));
  expect(allowed({ configuration: absent })).toEqual(without("configuration-restore"));
  expect(reasons({ configuration: absent }, "configuration-restore")).toBe("没有需要恢复的配置事务");

  for (const key of ["configuration", "orchestration", "deployment"] as const) {
    const unreadable = { configuration: absent, [key]: { status: "unreadable", reason: "读不了" } } as MaintenanceState;
    for (const intent of MAINTENANCE_INTENTS) {
      if (key === "configuration" || intent !== "configuration-restore") expect(reasons(unreadable, intent), `${key} ${intent}`).toContain("读不了");
    }
  }
});

test("未完成的部署挡住改配置；本机写配置的入口还拒绝未收尾的运维任务", () => {
  const deployment = { status: "present", id: "deploy-1", pending: true, service: true, verify: true, release: true } as const;
  expect(reasons({ configuration: absent, deployment }, "configuration")).toContain("部署事务 deploy-1 尚未完成");
  expect(assessMaintenanceAction({ configuration: absent, deployment: { ...deployment, pending: false } }, "configuration").allowed).toBe(true);
  // The core's own configuration step runs inside its ops task: the intent alone does not refuse it.
  const orchestration = { status: "present", id: "ops-1", blocksStartup: true, pending: true } as const;
  expect(assessMaintenanceAction({ configuration: absent, orchestration }, "configuration").allowed).toBe(true);
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

test("读取：无法解析的运维记录记为无法读取；没有记录时只报告配置事务不存在", () => {
  expect(readMaintenanceState(project())).toEqual({ configuration: absent });
  for (const [file, key] of [["ops-maintenance.json", "orchestration"], ["ops-deployment.json", "deployment"], ["configuration-change.json", "configuration"]] as const) {
    const root = project();
    write(root, file, "{");
    expect(readMaintenanceState(root)[key]?.status, file).toBe("unreadable");
  }
});

test.skipIf(process.platform !== "linux")("断开的运维记录链接不能伪装成没有记录而放行启动", () => {
  const root = project(); symlinkSync(join(root, "missing-target.json"), join(root, "data/state", "ops-maintenance.json"));
  const state = readMaintenanceState(root);
  expect(state.orchestration?.status).toBe("unreadable");
  expect(assessMaintenanceAction(state, "service").allowed).toBe(false);
});
