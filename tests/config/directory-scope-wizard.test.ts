// The directory-scope terminal wizard (ops/config/directory-scope-wizard.ts): shared by the deployment's choice and the
// change after deployment (directory-admin.ts scope without a value), which reads, checks and saves through the running service.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scopeLabels, serviceWizard } from "../../ops/config/directory-scope-wizard.ts";
import { SCOPE_APPLY_NOTE, SCOPE_PROGRESS_HINT, type DepartmentSource } from "../../ops/tools/directory-admin.ts";
import type { DepartmentDetail, DepartmentInfo } from "../../src/integrations/open-platform/directory.ts";
import { type DirectoryScope, WHOLE_DIRECTORY } from "../../src/integrations/open-platform/directory-scope.ts";
import { tempFixture } from "../helpers/temp.ts";

// 1 → 总部(100) → 研发中心(110) → 平台组(111)；1 → 华东分公司(200)。
const tree: Record<string, DepartmentInfo[]> = {
  "1": [{ id: "100", name: "总部", count: 30 }, { id: "200", name: "华东分公司", count: 12 }],
  "100": [{ id: "110", name: "研发中心", count: 20 }],
};
const known: Record<string, DepartmentDetail> = {
  "111": { id: "111", name: "平台组", count: 8, ancestors: [{ id: "100", name: "总部" }, { id: "110", name: "研发中心" }] },
  "200": { id: "200", name: "华东分公司", count: 12, ancestors: [] },
};
const depts = (...departments: string[]): DirectoryScope => ({ kind: "departments", departments });

test("the service-backed check refuses a department the platform refused or the service did not return, and gives the others their paths", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const source: DepartmentSource = {
    scope: async () => ({ scope: undefined, settled: false, effective: null }),
    children: async (parent, signal) => { signals.push(signal); return tree[parent] ?? []; },
    describe: async (ids, signal) => {
      signals.push(signal);
      return { departments: ids.flatMap(id => known[id] ? [known[id]] : []), unavailable: ids.filter(id => id === "999").map(id => ({ id, message: "部门不存在" })) };
    },
    save: async () => { throw new Error("the wizard never saves"); },
  };
  const wizard = serviceWizard(source);
  const signal = new AbortController().signal;
  expect(await wizard.childDepartments("1", signal)).toEqual(tree["1"]!);
  expect(await wizard.verify(["111", "200"], signal)).toEqual([{ ...known["111"]!, fullName: "总部 / 研发中心 / 平台组" }, { ...known["200"]!, fullName: "华东分公司" }]);
  await expect(wizard.verify(["111", "999"], signal)).rejects.toThrow("部门 999：部门不存在；范围未改，请移出这个部门");
  await expect(wizard.verify(["111", "555"], signal)).rejects.toThrow("服务没有返回部门 555；范围未改，请稍后重试");
  // The user's Ctrl+C reaches the service's queries.
  expect(signals.every(item => item === signal)).toBe(true);
  expect(scopeLabels({ departments: [known["111"]!], unavailable: [{ id: "999", message: "部门不存在" }] }))
    .toEqual(new Map([["111", "总部 / 研发中心 / 平台组"], ["999", "999（平台拒绝：部门不存在；保存前要移出）"]]));
});

type Scenario = {
  saved: { scope?: DirectoryScope; settled: boolean; effective: DirectoryScope | null };
  /** Prompt answers by message substring; an array answers the same prompt in turn; "CANCEL" cancels it. */
  answers: Record<string, unknown>;
  result?: unknown;
  failScope?: string;
  failSave?: string;
  /** Departments whose children never arrive until the query is aborted. */
  hang?: string[];
  refused?: Record<string, string>;
  /** Ctrl+C during the spinner whose message contains this. */
  cancelSpinner?: string;
};

type Recorded = {
  prompts: { type: string; message: string; initialValue?: unknown; initialValues?: unknown; labels?: string[] }[];
  logs: [string, string][];
  spinners: [string, string | undefined][];
  outros: string[];
  cancels: string[];
};

/**
 * Runs changeScopeInTerminal in a child process with only the prompts replaced (the mock stays out of this process) and a fake
 * service. A prompt without an answer, or whose answers ran out, is cancelled, so a wrong flow ends instead of looping.
 */
async function runTerminal(scenario: Scenario): Promise<{ code: number; calls: { children: string[]; describe: string[][]; saves: DirectoryScope[] };
  record: Recorded }> {
  const fixture = await tempFixture("directory-scope-wizard-");
  try {
    const driver = join(fixture.root, "driver.ts");
    await writeFile(driver, `
      import { mock } from "bun:test";
      const scenario = ${JSON.stringify({ ...scenario, tree, known })};
      const record = { prompts: [], logs: [], spinners: [], outros: [], cancels: [] };
      const cancelled = Symbol("cancelled");
      const answer = (type, options) => {
        record.prompts.push({ type, message: options.message, initialValue: options.initialValue, initialValues: options.initialValues,
          labels: options.options?.map(option => option.label) });
        for (const [key, value] of Object.entries(scenario.answers)) {
          if (!String(options.message).includes(key)) continue;
          const next = Array.isArray(value) ? value.shift() : value;
          return next === undefined || next === "CANCEL" ? cancelled : next;
        }
        return cancelled;
      };
      const log = level => message => { record.logs.push([level, message]); };
      mock.module(${JSON.stringify(import.meta.resolve("@clack/prompts"))}, () => ({
        intro: () => {}, outro: message => { record.outros.push(message); }, cancel: message => { record.cancels.push(message); },
        isCancel: value => value === cancelled,
        log: { info: log("info"), warn: log("warn"), message: log("message"), error: log("error"), step: log("step"), success: log("success") },
        select: async options => answer("select", options),
        multiselect: async options => answer("multiselect", options),
        confirm: async options => answer("confirm", options),
        spinner: (options = {}) => ({
          start(message) {
            record.spinners.push(["start", message]);
            if (scenario.cancelSpinner && message.includes(scenario.cancelSpinner)) { record.spinners.push(["cancel", options.cancelMessage]); options.onCancel?.(); }
          },
          stop(message) { record.spinners.push(["stop", message]); },
          error(message) { record.spinners.push(["error", message]); },
          message() {},
        }),
      }));
      const { changeScopeInTerminal } = await import(${JSON.stringify(import.meta.resolve("../../ops/config/directory-scope-wizard.ts"))});
      const calls = { children: [], describe: [], saves: [] };
      const pending = signal => new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const source = {
        async scope() { if (scenario.failScope) throw new Error(scenario.failScope); return scenario.saved; },
        async children(parent, signal) { calls.children.push(parent); return scenario.hang?.includes(parent) ? pending(signal) : scenario.tree[parent] ?? []; },
        async describe(ids) {
          calls.describe.push([...ids]);
          return { departments: ids.filter(id => scenario.known[id]).map(id => scenario.known[id]),
            unavailable: ids.filter(id => scenario.refused?.[id]).map(id => ({ id, message: scenario.refused[id] })) };
        },
        async save(scope) { calls.saves.push(scope); if (scenario.failSave) throw new Error(scenario.failSave); return scenario.result; },
      };
      const code = await changeScopeInTerminal(source);
      console.log("RESULT " + JSON.stringify({ code, calls, record }));
    `);
    const proc = Bun.spawn([process.execPath, driver], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" } });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const line = stdout.split("\n").find(item => item.startsWith("RESULT "));
    if (!line) throw new Error(`driver exited ${exit} without a result:\n${stdout}\n${stderr}`);
    return JSON.parse(line.slice("RESULT ".length));
  } finally { await fixture.cleanup(); }
}

const NOTE = `保存即开始应用：${SCOPE_APPLY_NOTE}。`;

test("terminal: the saved departments are preselected with their paths; ticking another and confirming saves both through the service", async () => {
  const result = await runTerminal({
    saved: { scope: depts("111"), settled: true, effective: depts("111") },
    answers: { "通讯录同步范围": "departments", "位置：": ["review", "check", "done"], "已选部门": [["111"]], "勾选「一级部门」": [["200"]], "保存这": true },
    result: { status: "started", departments: [{ id: "111", name: "平台组", count: 8 }, { id: "200", name: "华东分公司", count: 12 }] },
  });
  expect(result.code).toBe(0);
  expect(result.calls.saves).toEqual([depts("111", "200")]);
  // The names of the saved departments, then the check before saving.
  expect(result.calls.describe).toEqual([["111"], ["111", "200"]]);
  const prompts = result.record.prompts;
  expect(prompts[0]).toMatchObject({ type: "select", message: "通讯录同步范围", initialValue: "departments" });
  expect(prompts.find(item => item.message.startsWith("已选部门"))!.labels).toEqual(["总部 / 研发中心 / 平台组"]);
  expect(prompts.find(item => item.message.startsWith("保存这"))!.message).toBe("保存这 2 个部门为同步范围？");
  const logs = result.record.logs.map(([, message]) => message);
  expect(logs).toContain(NOTE);
  expect(logs.find(message => message.startsWith("只同步以下部门"))).toContain("111\t8\t总部 / 研发中心 / 平台组");
  expect(logs.find(message => message.startsWith("已保存，服务正在应用新范围"))).toContain("200\t12\t华东分公司");
  expect(logs).toContain(SCOPE_PROGRESS_HINT);
  expect(result.record.outros).toEqual(["已保存，正在应用新范围（完成前之前的名单仍然生效）"]);
});

test("terminal: cancelling saves nothing and exits 130", async () => {
  const result = await runTerminal({ saved: { scope: WHOLE_DIRECTORY, settled: true, effective: WHOLE_DIRECTORY }, answers: { "通讯录同步范围": "CANCEL" } });
  expect({ code: result.code, saves: result.calls.saves, cancels: result.record.cancels }).toEqual({ code: 130, saves: [], cancels: ["已取消，同步范围未改"] });
  expect(result.record.prompts[0]!.initialValue).toBe("all");
});

test("terminal: the saved scope in effect, chosen again, sends nothing; not yet in effect, it is saved again to restart the apply", async () => {
  const same = await runTerminal({ saved: { scope: WHOLE_DIRECTORY, settled: true, effective: WHOLE_DIRECTORY },
    answers: { "通讯录同步范围": "all", "确认同步整个通讯录": true } });
  expect({ code: same.code, saves: same.calls.saves, outros: same.record.outros }).toEqual({ code: 0, saves: [], outros: ["同步范围没有变化，已经生效"] });
  // The whole directory needs its own confirmation, after the note on when it takes effect.
  expect(same.record.logs.map(([, message]) => message)).toContain(NOTE);
  const retry = await runTerminal({ saved: { scope: WHOLE_DIRECTORY, settled: false, effective: depts("111") },
    answers: { "通讯录同步范围": "all", "确认同步整个通讯录": true }, result: { status: "started", departments: [] } });
  expect({ code: retry.code, saves: retry.calls.saves, outros: retry.record.outros })
    .toEqual({ code: 0, saves: [WHOLE_DIRECTORY], outros: ["已重新开始应用同步范围（完成前之前的名单仍然生效）"] });
  expect(retry.record.logs).toContainEqual(["warn", "保存的范围还没有生效（正在应用或应用失败），之前的名单仍然生效；按同一范围再保存一次可立即重新应用"]);
});

test("terminal: without a saved scope the first save starts the sync; a refused save exits 1", async () => {
  const unset = { saved: { settled: false, effective: null }, answers: { "通讯录同步范围": "all", "确认同步整个通讯录": true } };
  const first = await runTerminal({ ...unset, answers: { ...unset.answers }, result: { status: "started", departments: [] } });
  expect({ code: first.code, saves: first.calls.saves, outros: first.record.outros })
    .toEqual({ code: 0, saves: [WHOLE_DIRECTORY], outros: ["已保存，服务开始按这个范围同步通讯录"] });
  expect(first.record.prompts[0]!.initialValue).toBeUndefined();
  expect(first.record.logs).toContainEqual(["warn", "当前未设置同步范围，服务不同步通讯录"]);
  const refused = await runTerminal({ ...unset, answers: { ...unset.answers }, failSave: "服务拒绝了修改（HTTP 409）" });
  expect({ code: refused.code, outros: refused.record.outros }).toEqual({ code: 1, outros: ["同步范围没有保存，原因见上"] });
  expect(refused.record.spinners).toContainEqual(["error", "服务拒绝了修改（HTTP 409）"]);
});

test("terminal: a department the platform refuses blocks the save until it is removed", async () => {
  const result = await runTerminal({
    saved: { scope: depts("999"), settled: true, effective: depts("999") }, refused: { "999": "部门不存在" },
    answers: { "通讯录同步范围": "departments", "位置：": ["done", "review"], "已选部门": [[]] },
  });
  // The answers run out at the next prompt, which cancels: nothing was saved.
  expect({ code: result.code, saves: result.calls.saves }).toEqual({ code: 130, saves: [] });
  expect(result.record.spinners).toContainEqual(["error", "部门 999：部门不存在；范围未改，请移出这个部门"]);
  expect(result.record.prompts.find(item => item.message.startsWith("已选部门"))!.labels).toEqual(["999（平台拒绝：部门不存在；保存前要移出）"]);
});

test("terminal: Ctrl+C while a query runs cancels it; while saving it still waits for the service's answer", async () => {
  const reading = await runTerminal({ saved: { settled: false, effective: null }, answers: { "通讯录同步范围": "departments" }, hang: ["1"],
    cancelSpinner: "读取「一级部门」" });
  expect({ code: reading.code, saves: reading.calls.saves, children: reading.calls.children }).toEqual({ code: 130, saves: [], children: ["1"] });
  expect(reading.record.spinners).toContainEqual(["cancel", "已取消，同步范围未改"]);
  const saving = await runTerminal({ saved: { settled: false, effective: null }, answers: { "通讯录同步范围": "all", "确认同步整个通讯录": true },
    result: { status: "started", departments: [] }, cancelSpinner: "保存同步范围" });
  expect({ code: saving.code, saves: saving.calls.saves, outros: saving.record.outros })
    .toEqual({ code: 0, saves: [WHOLE_DIRECTORY], outros: ["已保存，服务开始按这个范围同步通讯录"] });
});

test("directory-admin.ts scope in a terminal loads the wizard (no wait between the two modules) and reads the scope from the service", async () => {
  const fixture = await tempFixture("directory-scope-entry-");
  try {
    // A terminal is claimed and the prompts print what they show; no service runs in the empty directory.
    const preload = join(fixture.root, "terminal.ts");
    await writeFile(preload, `
      import { mock } from "bun:test";
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      const show = label => message => console.log(label + " " + message);
      const unexpected = async options => { throw new Error("unexpected prompt: " + options.message); };
      mock.module(${JSON.stringify(import.meta.resolve("@clack/prompts"))}, () => ({
        intro: show("INTRO"), outro: show("OUTRO"), cancel: show("CANCEL"), isCancel: () => false,
        select: unexpected, multiselect: unexpected, confirm: unexpected,
        log: { info: show("INFO"), warn: show("WARN"), message: show("MESSAGE"), error: show("ERROR") },
        spinner: () => ({ start: show("START"), stop: show("STOP"), error: show("FAILED"), message() {} }),
      }));
    `);
    const proc = Bun.spawn([process.execPath, "--preload", preload, fileURLToPath(new URL("../../ops/tools/directory-admin.ts", import.meta.url)), "scope"],
      { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    expect({ code, stderr }).toEqual({ code: 1, stderr: "" });
    expect(stdout.trim().split(/\r?\n/)).toEqual(["INTRO 通讯录同步范围", "START 读取服务保存的同步范围…",
      "FAILED 读不到当前范围：读不到服务实例记录（data/state/instance.json）；服务可能没有运行", "OUTRO 同步范围未改"]);
  } finally { await fixture.cleanup(); }
});

test("terminal: a service that cannot be read exits 1 before any prompt", async () => {
  const result = await runTerminal({ saved: { settled: false, effective: null }, answers: {}, failScope: "本机端口 1011 无响应；服务可能没有运行" });
  expect({ code: result.code, prompts: result.record.prompts, outros: result.record.outros }).toEqual({ code: 1, prompts: [], outros: ["同步范围未改"] });
  expect(result.record.spinners).toContainEqual(["error", "读不到当前范围：本机端口 1011 无响应；服务可能没有运行"]);
});
